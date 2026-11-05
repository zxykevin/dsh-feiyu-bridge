/**
 * Task dispatcher: concurrency-1 queue, per-task deadline (the server's
 * `deadline_at`), cancellation, idempotent replay, and structured outcomes.
 *
 * The dispatcher never talks HTTP. It emits one terminal outcome per task:
 *   {kind:'result', taskId, payload:{status:'succeeded'|'failed', result?, error?}}
 *   {kind:'cancelled', taskId}
 * The runtime owns delivery/retry semantics.
 */

import { BridgeError, ERROR_CODES, asBridgeError } from './errors.js';
import { RESULT_STATUS, jsonByteLength, truncateUtf8 } from './protocol.js';

export class TaskDispatcher {
  /**
   * @param {{
   *   config: object,
   *   logger: object,
   *   capabilities: object,
   *   agent: object,
   *   runtime: object,
   *   onOutcome: (outcome: object) => Promise<void> | void,
   *   now?: () => number
   * }} options
   */
  constructor({ config, logger, capabilities, agent, runtime, onOutcome, now = Date.now }) {
    this.config = config;
    this.logger = logger;
    this.capabilities = capabilities;
    this.agent = agent;
    this.runtime = runtime;
    this.onOutcome = onOutcome;
    this.now = now;
    this.queue = [];
    this.active = new Map();
    this.cache = new Map();
    this.running = false;
    this.stopping = false;
  }

  /**
   * Accept one validated task from the server.
   * @param {object} task
   */
  submit(task) {
    if (this.stopping) {
      void this.#cancelled(task.taskId);
      return;
    }
    const cached = this.#cacheGet(task.taskId);
    if (cached) {
      this.logger.debug('replaying cached outcome for duplicate task', { taskId: task.taskId });
      void this.onOutcome(cached);
      return;
    }
    for (const active of this.active.values()) {
      if (active.task.taskId === task.taskId) return;
    }
    if (task.deadlineAt <= this.now()) {
      void this.#cancelled(task.taskId);
      return;
    }
    if (!this.capabilities.has(task.capability)) {
      void this.#failed(task, new BridgeError(
        ERROR_CODES.CAPABILITY_DENIED,
        `capability "${task.capability}" is not enabled on this device`,
        { retryable: false }
      ));
      return;
    }
    if (this.queue.length >= this.config.runtime.queueSize) {
      void this.#failed(task, new BridgeError(ERROR_CODES.QUEUE_FULL, 'bridge queue is full', { retryable: true }));
      return;
    }
    this.queue.push({ task, enqueuedAt: this.now() });
    this.logger.debug('task queued', { taskId: task.taskId, capability: task.capability, depth: this.queue.length });
    void this.#pump();
  }

  /**
   * Cancel a queued or running task (heartbeat cancel_requested or timeout).
   * @param {string} taskId
   * @param {'cancelled'|'timeout'} [reason]
   * @returns {boolean} whether a queued/in-flight task was found
   */
  cancel(taskId, reason = 'cancelled') {
    const index = this.queue.findIndex((item) => item.task.taskId === taskId);
    if (index !== -1) {
      this.queue.splice(index, 1);
      void this.#cancelled(taskId);
      return true;
    }
    const active = this.active.get(taskId);
    if (!active) return false;
    active.reason = reason;
    active.controller.abort(reason);
    try {
      this.agent.cancel(taskId, reason);
    } catch (error) {
      this.logger.warn('adapter cancel failed', { taskId, reason: String(error?.message ?? error).slice(0, 120) });
    }
    return true;
  }

  inflight() {
    return [...this.active.keys()];
  }

  status() {
    return {
      queue_depth: this.queue.length,
      running: this.active.size,
      concurrency: 1,
      cached_outcomes: this.cache.size,
      active: [...this.active.values()].map((active) => ({
        task_id: active.task.taskId,
        capability: active.task.capability,
        started_at: new Date(active.startedAt).toISOString(),
        elapsed_ms: this.now() - active.startedAt
      }))
    };
  }

  async shutdown() {
    this.stopping = true;
    const queued = this.queue.splice(0);
    for (const { task } of queued) void this.#cancelled(task.taskId);
    for (const active of this.active.values()) {
      active.reason = 'cancelled';
      active.controller.abort('cancelled');
      try {
        this.agent.cancel(active.task.taskId, 'cancelled');
      } catch {
        /* best effort */
      }
    }
    await Promise.allSettled([...this.active.values()].map((active) => active.done));
  }

  async #pump() {
    if (this.running || this.stopping || this.queue.length === 0) return;
    this.running = true;
    const item = this.queue.shift();
    try {
      const done = this.#run(item);
      const record = this.active.get(item.task.taskId);
      if (record) record.done = done;
      await done;
    } finally {
      this.running = false;
      if (!this.stopping && this.queue.length > 0) void this.#pump();
    }
  }

  #cacheGet(taskId) {
    const entry = this.cache.get(taskId);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.cache.delete(taskId);
      return undefined;
    }
    return entry.outcome;
  }

  #cachePut(taskId, outcome) {
    this.cache.set(taskId, {
      outcome,
      expiresAt: this.now() + this.config.tasks.idempotencyTtlMs
    });
    while (this.cache.size > 1024) this.cache.delete(this.cache.keys().next().value);
  }

  async #run({ task, enqueuedAt }) {
    const now = this.now();
    if (task.deadlineAt <= now) {
      await this.#cancelled(task.taskId);
      return;
    }
    const startedAt = now;
    const remaining = task.deadlineAt - now;
    const timeoutMs = Math.min(remaining, this.config.tasks.maxTimeoutMs);
    const controller = new AbortController();
    const active = {
      task,
      controller,
      startedAt,
      reason: null,
      done: null
    };
    this.active.set(task.taskId, active);

    let timer;
    const onTimeout = () => {
      active.reason = 'timeout';
      controller.abort('timeout');
      try {
        this.agent.cancel(task.taskId, 'timeout');
      } catch {
        /* best effort */
      }
    };
    timer = setTimeout(onTimeout, timeoutMs);
    timer.unref?.();

    this.logger.info('task started', {
      taskId: task.taskId,
      capability: task.capability,
      timeoutMs,
      waitedMs: startedAt - enqueuedAt
    });

    try {
      const result = await this.capabilities.execute(task.capability, task, {
        agent: this.agent,
        runtime: this.runtime,
        signal: controller.signal
      });
      this.#succeeded(task, this.#fitResult(result), startedAt);
    } catch (error) {
      const bridgeError = asBridgeError(error, 'bridge task failed');
      if (bridgeError.code === ERROR_CODES.TASK_TIMEOUT || bridgeError.code === ERROR_CODES.TASK_CANCELLED) {
        this.logger.info('task cancelled', { taskId: task.taskId, code: bridgeError.code });
        await this.#cancelled(task.taskId);
      } else {
        this.logger.warn('task failed', {
          taskId: task.taskId,
          capability: task.capability,
          code: bridgeError.code,
          retryable: bridgeError.retryable
        });
        this.#failed(task, bridgeError, startedAt);
      }
    } finally {
      clearTimeout(timer);
      this.active.delete(task.taskId);
    }
  }

  #succeeded(task, result, startedAt) {
    const payload = { status: RESULT_STATUS.SUCCEEDED, result };
    const outcome = { kind: 'result', taskId: task.taskId, payload };
    this.#cachePut(task.taskId, outcome);
    this.logger.debug('task succeeded', { taskId: task.taskId, durationMs: this.now() - startedAt });
    void this.onOutcome(outcome);
  }

  #failed(task, error, startedAt = this.now()) {
    const payload = { status: RESULT_STATUS.FAILED, error: error.toEnvelope() };
    const outcome = { kind: 'result', taskId: task.taskId, payload };
    this.#cachePut(task.taskId, outcome);
    this.logger.debug('task failed outcome', { taskId: task.taskId, durationMs: this.now() - startedAt });
    void this.onOutcome(outcome);
  }

  async #cancelled(taskId) {
    const outcome = { kind: 'cancelled', taskId };
    this.#cachePut(taskId, outcome);
    await this.onOutcome(outcome);
  }

  #fitResult(result) {
    const maxBytes = this.config.limits.resultBytes - 1024;
    if (jsonByteLength(result) <= maxBytes) return result;
    if (result && typeof result === 'object' && typeof result.value === 'string') {
      const overhead = jsonByteLength({ ...result, value: '', truncated: true });
      const budget = Math.max(0, maxBytes - overhead);
      const { text } = truncateUtf8(result.value, budget);
      const fitted = { ...result, value: text, truncated: true };
      if (jsonByteLength(fitted) <= maxBytes) return fitted;
    }
    throw new BridgeError(ERROR_CODES.RESULT_TOO_LARGE, 'capability result exceeds the configured result size limit', {
      retryable: false
    });
  }
}
