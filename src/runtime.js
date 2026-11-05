/**
 * Bridge runtime: owns the lease long-poll loop, heartbeat, reconnect backoff,
 * and result delivery. The dispatcher and agent adapter are wired here so the
 * Cordis entry point stays small and the loop is testable under plain Node.
 */

import { BridgeError, ERROR_CODES, TERMINAL_DELIVERY_CODES, asBridgeError } from './core/errors.js';
import { PROTOCOL_ID, validateTask } from './core/protocol.js';
import { TaskDispatcher } from './core/dispatcher.js';

export const PLUGIN_INFO = Object.freeze({ name: 'dsh-feiyu-bridge', version: '0.4.0' });

// These failures cannot be fixed by retrying the same request: the client id,
// secret, signature encoding, clock, or server configuration is wrong. The
// contract says to stop instead of hammering AstrBot with invalid credentials.
const FATAL_CODES = new Set([
  ERROR_CODES.CONFIG_ERROR,
  ERROR_CODES.AUTH_UNAVAILABLE,
  ERROR_CODES.BRIDGE_NOT_CONFIGURED,
  ERROR_CODES.AUTH_CLIENT_REJECTED,
  ERROR_CODES.AUTH_INVALID_SIGNATURE,
  ERROR_CODES.AUTH_INVALID_NONCE,
  ERROR_CODES.AUTH_INVALID_TIMESTAMP,
  ERROR_CODES.INVALID_REQUEST
]);

export class BridgeRuntime {
  /**
   * @param {{
   *   config: object,
   *   logger: object,
   *   transport: object,
   *   agent: object,
   *   capabilities: object,
   *   now?: () => number
   * }} options
   */
  constructor({ config, logger, transport, agent, capabilities, now = Date.now }) {
    this.config = config;
    this.logger = logger;
    this.transport = transport;
    this.agent = agent;
    this.capabilities = capabilities;
    this.now = now;

    this.started = false;
    this.running = false;
    this.abort = null;
    this.heartbeatTimer = null;
    this.heartbeatInFlight = false;
    this.flushTimer = null;
    this.flushPromise = null;
    this.pending = new Map();
    this.connection = 'stopped';
    this.lastError = null;
    this.startedAt = null;
    this.lastPollAt = null;
    this.lastHeartbeatAt = null;
    this.nextRetryAt = null;
    this.leaseInFlight = false;

    this.dispatcher = new TaskDispatcher({
      config,
      logger,
      capabilities,
      agent,
      runtime: this,
      onOutcome: (outcome) => this.queueOutcome(outcome),
      now
    });
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.running = true;
    this.startedAt = this.now();
    this.connection = 'starting';
    this.abort = new AbortController();
    this.logger.info('bridge runtime starting', {
      transport: this.transport.name ?? 'unknown',
      capabilities: this.capabilities.names(),
      clientId: this.config.auth.clientId
    });
    void this.#pollLoop();
    void this.#heartbeatOnce();
    this.#scheduleHeartbeat();
  }

  async stop() {
    if (!this.started) return;
    this.running = false;
    this.connection = 'stopped';
    this.nextRetryAt = null;
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.heartbeatTimer = null;
    this.flushTimer = null;
    this.abort?.abort('shutdown');

    try {
      await this.dispatcher.shutdown();
    } catch (error) {
      this.logger.warn('dispatcher shutdown failed', { reason: String(error?.message ?? error).slice(0, 160) });
    }
    await this.flushPromise?.catch(() => {});
    await this.#flushPending({ force: true, budgetMs: 5000 }).catch(() => {});
    try {
      await this.agent.shutdown();
    } catch (error) {
      this.logger.warn('agent adapter shutdown failed', { reason: String(error?.message ?? error).slice(0, 160) });
    }
    try {
      await this.transport.close();
    } catch (error) {
      this.logger.warn('transport close failed', { reason: String(error?.message ?? error).slice(0, 160) });
    }
    this.started = false;
    this.logger.info('bridge runtime stopped');
  }

  status() {
    return {
      online: this.connection === 'online',
      state: this.connection,
      protocol: PROTOCOL_ID,
      plugin: PLUGIN_INFO,
      client_id: this.config.auth.clientId,
      started_at: this.startedAt === null ? null : new Date(this.startedAt).toISOString(),
      uptime_ms: this.startedAt === null ? 0 : Math.max(0, this.now() - this.startedAt),
      transport: this.transportStatus(),
      agent: this.agent.status(),
      capabilities: this.capabilities.describe(),
      limits: {
        payload_bytes: this.config.limits.payloadBytes,
        result_bytes: this.config.limits.resultBytes,
        max_concurrent: 1
      },
      queue: this.dispatcher.status(),
      pending_results: this.pending.size
    };
  }

  transportStatus() {
    return {
      name: this.transport.name ?? 'unknown',
      last_lease_at: this.lastPollAt === null ? null : new Date(this.lastPollAt).toISOString(),
      last_heartbeat_at:
        this.lastHeartbeatAt === null ? null : new Date(this.lastHeartbeatAt).toISOString(),
      next_retry_at: this.nextRetryAt === null ? null : new Date(this.nextRetryAt).toISOString(),
      last_error: this.lastError
    };
  }

  /**
   * Called by the dispatcher for every terminal task outcome. Outcomes are sent
   * immediately when online and otherwise kept (bounded, with TTL) until the
   * next successful heartbeat/lease.
   * @param {{kind: 'result'|'cancelled', taskId: string, payload?: object}} outcome
   */
  queueOutcome(outcome) {
    if (!outcome || typeof outcome.taskId !== 'string') return;
    if (!this.pending.has(outcome.taskId) && this.pending.size >= this.config.runtime.pendingResultMax) {
      const oldest = this.pending.keys().next().value;
      this.pending.delete(oldest);
      this.logger.warn('pending result queue full; dropping the oldest outcome', { taskId: oldest });
    }
    this.pending.set(outcome.taskId, {
      outcome,
      attempts: 0,
      expiresAt: this.now() + this.config.runtime.pendingResultTtlMs
    });
    void this.#flushPending();
  }

  async #pollLoop() {
    let failures = 0;
    while (this.running && !this.abort.signal.aborted) {
      if (this.dispatcher.inflight().length > 0 || this.dispatcher.status().queue_depth > 0) {
        await this.#sleep(250);
        continue;
      }
      this.leaseInFlight = true;
      try {
        const { task } = await this.transport.lease({
          waitSeconds: this.config.server.leaseWaitSeconds,
          signal: this.abort.signal
        });
        this.lastPollAt = this.now();
        this.#markOnline();
        failures = 0;
        if (task) {
          this.#acceptTask(task);
        } else {
          // A well-behaved server long-polls, but do not spin if a proxy or a
          // broken server answers `null` immediately.
          await this.#sleep(250);
        }
        void this.#flushPending();
      } catch (error) {
        if (!this.running || this.abort.signal.aborted) break;
        failures += 1;
        const bridgeError = asBridgeError(error, 'bridge lease failed');
        this.#markOffline(bridgeError);
        if (FATAL_CODES.has(bridgeError.code)) {
          this.#failFatal(bridgeError);
          break;
        }
        const delayMs = this.#backoff(failures);
        this.nextRetryAt = this.now() + delayMs;
        this.logger.warn('bridge lease failed; reconnecting', {
          code: bridgeError.code,
          retryable: bridgeError.retryable,
          failures,
          delayMs
        });
        await this.#sleep(delayMs);
      } finally {
        this.leaseInFlight = false;
      }
    }
  }

  #acceptTask(rawTask) {
    let task;
    try {
      task = validateTask(rawTask);
    } catch (error) {
      const bridgeError = asBridgeError(error, 'invalid leased task');
      this.logger.warn('server leased an invalid task; ignoring it', {
        code: bridgeError.code,
        reason: String(bridgeError.message).slice(0, 160)
      });
      return;
    }
    this.logger.info('task leased', {
      taskId: task.taskId,
      capability: task.capability,
      remainingMs: Math.max(0, task.deadlineAt - this.now())
    });
    this.dispatcher.submit(task);
  }

  #backoff(failures) {
    const base = this.config.runtime.reconnectInitialMs;
    const max = this.config.runtime.reconnectMaxMs;
    const factor = this.config.runtime.reconnectFactor;
    const raw = Math.min(max, base * factor ** Math.min(failures - 1, 16));
    const jitter = 0.8 + Math.random() * 0.4;
    return Math.max(100, Math.round(raw * jitter));
  }

  #markOnline() {
    const wasOffline = this.connection !== 'online';
    this.connection = 'online';
    this.nextRetryAt = null;
    this.lastError = null;
    if (wasOffline) this.logger.info('bridge online');
  }

  #markOffline(error) {
    const wasOnline = this.connection === 'online';
    this.connection = 'offline';
    this.lastError =
      error instanceof BridgeError
        ? error.toEnvelope()
        : { code: ERROR_CODES.TRANSPORT_ERROR, message: 'transport failure' };
    if (wasOnline) this.logger.warn('bridge offline', { code: this.lastError.code });
  }

  #scheduleHeartbeat() {
    if (!this.running) return;
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = null;
      void this.#heartbeatOnce().finally(() => this.#scheduleHeartbeat());
    }, this.config.runtime.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  async #heartbeatOnce() {
    if (!this.running || this.heartbeatInFlight) return;
    this.heartbeatInFlight = true;
    const activeTaskId = this.dispatcher.inflight()[0] ?? null;
    try {
      const data = await this.transport.heartbeat({
        agentVersion: PLUGIN_INFO.version,
        capabilities: this.capabilities.names(),
        activeTaskId,
        pendingTaskIds: [...this.pending.keys()],
        signal: this.abort.signal
      });
      this.lastHeartbeatAt = this.now();
      this.#markOnline();
      if (data && data.cancel_requested === true && activeTaskId) {
        this.logger.info('server requested cancellation', { taskId: activeTaskId });
        this.dispatcher.cancel(activeTaskId, 'cancelled');
      }
      void this.#flushPending();
    } catch (error) {
      if (!this.running) return;
      const bridgeError = asBridgeError(error, 'bridge heartbeat failed');
      this.#markOffline(bridgeError);
      if (FATAL_CODES.has(bridgeError.code)) {
        this.#failFatal(bridgeError);
        return;
      }
      this.logger.warn('bridge heartbeat failed', { code: bridgeError.code });
    } finally {
      this.heartbeatInFlight = false;
    }
  }

  #failFatal(error) {
    if (!this.running) return;
    this.running = false;
    this.connection = 'failed';
    this.lastError = error.toEnvelope();
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.logger.error('bridge stopped after a non-retryable error', { code: error.code });
    // Stop local work: the link cannot be trusted until an operator fixes the
    // configuration and restarts the plugin.
    void this.dispatcher.shutdown().catch((shutdownError) => {
      this.logger.warn('dispatcher shutdown after fatal error failed', {
        reason: String(shutdownError?.message ?? shutdownError).slice(0, 120)
      });
    });
    // Wake the lease long-poll so it does not wait for the server timeout.
    this.abort?.abort('fatal');
  }

  #flushPending({ force = false, budgetMs = this.config.server.requestTimeoutMs } = {}) {
    if (this.flushPromise) return this.flushPromise;
    this.flushPromise = this.#doFlush({ force, budgetMs }).finally(() => {
      this.flushPromise = null;
    });
    return this.flushPromise;
  }

  async #doFlush({ force, budgetMs }) {
    if (!force && this.connection !== 'online') return;
    const deadline = this.now() + budgetMs;
    for (const [taskId, item] of [...this.pending]) {
      if (item.expiresAt <= this.now()) {
        this.pending.delete(taskId);
        this.logger.warn('dropping expired undelivered outcome', { taskId });
        continue;
      }
      if (!force && this.connection !== 'online') return;
      const remaining = Math.max(250, deadline - this.now());
      try {
        await this.#deliver(item.outcome, Math.min(remaining, this.config.server.requestTimeoutMs));
        this.pending.delete(taskId);
        this.logger.debug('task outcome delivered', { taskId, kind: item.outcome.kind });
      } catch (error) {
        const bridgeError = asBridgeError(error, 'outcome delivery failed');
        item.attempts += 1;
        item.lastError = bridgeError.code;
        if (TERMINAL_DELIVERY_CODES.has(bridgeError.code)) {
          this.pending.delete(taskId);
          this.logger.warn('server already closed the task; dropping outcome', {
            taskId,
            code: bridgeError.code
          });
          continue;
        }
        // The server timed the task out (or cancelled it) while we were still
        // finishing locally. The contract says to stop local work and
        // acknowledge the cancellation so the server releases its slot.
        if (
          item.outcome.kind === 'result' &&
          (bridgeError.code === ERROR_CODES.TASK_TIMEOUT || bridgeError.code === ERROR_CODES.TASK_CANCELLED)
        ) {
          this.pending.delete(taskId);
          try {
            await this.transport.acknowledgeCancelled(taskId, {
              signal: AbortSignal.timeout(Math.min(this.config.server.requestTimeoutMs, 5000))
            });
          } catch (ackError) {
            this.logger.warn('cancellation acknowledgement after a late result failed', {
              taskId,
              code: asBridgeError(ackError, 'ack failed').code
            });
          }
          continue;
        }
        if (bridgeError.code === ERROR_CODES.AUTH_CLIENT_REJECTED || bridgeError.code.startsWith('AUTH_')) {
          this.logger.warn('outcome delivery unauthorized; will retry after reconnect', { taskId });
          this.#markOffline(bridgeError);
          return;
        }
        if (!bridgeError.retryable || item.attempts >= this.config.runtime.resultRetryMax) {
          this.pending.delete(taskId);
          this.logger.warn('dropping undeliverable outcome', {
            taskId,
            code: bridgeError.code,
            attempts: item.attempts
          });
          continue;
        }
        this.#scheduleFlushRetry();
        return;
      }
      if (this.now() >= deadline) return;
    }
  }

  async #deliver(outcome, timeoutMs) {
    const signal = AbortSignal.timeout(timeoutMs);
    if (outcome.kind === 'cancelled') {
      await this.transport.acknowledgeCancelled(outcome.taskId, { signal });
    } else {
      await this.transport.submitResult(outcome.taskId, outcome.payload, { signal });
    }
  }

  #scheduleFlushRetry() {
    if (this.flushTimer || !this.running) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.#flushPending();
    }, this.config.runtime.resultRetryMs);
    this.flushTimer.unref?.();
  }

  #sleep(ms) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.abort?.signal.removeEventListener('abort', onAbort);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      timer.unref?.();
      const onAbort = () => {
        clearTimeout(timer);
        finish();
      };
      if (this.abort?.signal.aborted) return onAbort();
      this.abort?.signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
