import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { TaskDispatcher } from '../../src/core/dispatcher.js';
import { resolveConfig } from '../../src/config.js';
import { silentLogger, deferred, waitFor } from '../helpers.js';
import { BridgeError, ERROR_CODES } from '../../src/core/errors.js';

function task({ capability = 'dsh.workflow.run', deadlineMs = Date.now() + 5000 } = {}) {
  return {
    taskId: crypto.randomUUID(),
    capability,
    arguments: { prompt: 'hi', session_key: 'qq:1' },
    state: 'leased',
    createdAt: Date.now(),
    deadlineAt: deadlineMs
  };
}

function harness({ handlers, config = resolveConfig({}) } = {}) {
  const outcomes = [];
  const cancels = [];
  const started = [];
  const capabilities = {
    names: () => Object.keys(handlers),
    describe: () => Object.keys(handlers).map((name) => ({ name })),
    has: (name) => Object.prototype.hasOwnProperty.call(handlers, name),
    execute: async (name, input, context) => {
      started.push(input.taskId);
      return handlers[name](input, context);
    }
  };
  const agent = {
    cancel(taskId, reason) {
      cancels.push({ taskId, reason });
    },
    status: () => ({ sessions: 0, running: 0 })
  };
  const dispatcher = new TaskDispatcher({
    config,
    logger: silentLogger(),
    capabilities,
    agent,
    runtime: {},
    onOutcome: (outcome) => {
      outcomes.push(outcome);
    }
  });
  return { dispatcher, outcomes, cancels, started, agent, config };
}

test('concurrency is 1 and tasks run FIFO', async () => {
  const gate = deferred();
  const order = [];
  const { dispatcher, outcomes, started } = harness({
    handlers: {
      'dsh.workflow.run': async (input) => {
        order.push(input.taskId);
        if (order.length === 1) await gate.promise;
        return { value: input.taskId };
      }
    }
  });
  const first = task();
  const second = task();
  dispatcher.submit(first);
  dispatcher.submit(second);
  await waitFor(() => started.length === 1);
  assert.deepEqual(started, [first.taskId]);
  assert.equal(dispatcher.status().queue_depth, 1);
  gate.resolve();
  await waitFor(() => outcomes.length === 2);
  assert.deepEqual(order, [first.taskId, second.taskId]);
  assert.deepEqual(
    outcomes.map((outcome) => outcome.payload.status),
    ['succeeded', 'succeeded']
  );
});

test('a repeated task id replays the cached outcome without re-running', async () => {
  const { dispatcher, outcomes, started } = harness({
    handlers: { 'dsh.workflow.run': async () => ({ value: 'once' }) }
  });
  const input = task();
  dispatcher.submit(input);
  await waitFor(() => outcomes.length === 1);
  dispatcher.submit(input);
  await waitFor(() => outcomes.length === 2);
  assert.equal(started.length, 1);
  assert.deepEqual(outcomes[1], outcomes[0]);
});

test('expired tasks are acknowledged as cancelled, not executed', async () => {
  const { dispatcher, outcomes, started } = harness({
    handlers: { 'dsh.workflow.run': async () => ({ value: 'no' }) }
  });
  const expired = task({ deadlineMs: Date.now() - 1 });
  dispatcher.submit(expired);
  await waitFor(() => outcomes.length === 1);
  assert.deepEqual(outcomes[0], { kind: 'cancelled', taskId: expired.taskId });
  assert.equal(started.length, 0);
});

test('unsupported capabilities fail with CAPABILITY_DENIED', async () => {
  const { dispatcher, outcomes } = harness({ handlers: {} });
  const input = task({ capability: 'dsh.unknown.capability' });
  dispatcher.submit(input);
  await waitFor(() => outcomes.length === 1);
  assert.equal(outcomes[0].payload.status, 'failed');
  assert.equal(outcomes[0].payload.error.code, 'CAPABILITY_DENIED');
});

test('a full queue rejects the extra task without blocking the active one', async () => {
  const gate = deferred();
  const { dispatcher, outcomes } = harness({
    handlers: {
      'dsh.workflow.run': async () => {
        await gate.promise;
        return { value: 'ok' };
      }
    }
  });
  const first = task();
  const second = task();
  const third = task();
  dispatcher.submit(first);
  dispatcher.submit(second);
  dispatcher.submit(third);
  await waitFor(() => outcomes.length === 1);
  assert.equal(outcomes[0].taskId, third.taskId);
  assert.equal(outcomes[0].payload.error.code, 'QUEUE_FULL');
  gate.resolve();
  await waitFor(() => outcomes.length === 3);
});

test('queued tasks can be cancelled before they start', async () => {
  const gate = deferred();
  const { dispatcher, outcomes } = harness({
    handlers: {
      'dsh.workflow.run': async () => {
        await gate.promise;
        return { value: 'ok' };
      }
    }
  });
  const first = task();
  const second = task();
  dispatcher.submit(first);
  dispatcher.submit(second);
  await waitFor(() => outcomes.length === 0 && dispatcher.status().queue_depth === 1);
  assert.equal(dispatcher.cancel(second.taskId, 'cancelled'), true);
  await waitFor(() => outcomes.some((outcome) => outcome.taskId === second.taskId));
  gate.resolve();
  await waitFor(() => outcomes.some((outcome) => outcome.taskId === first.taskId));
});

test('cancelling the active task aborts it and calls the adapter', async () => {
  const { dispatcher, outcomes, cancels } = harness({
    handlers: {
      'dsh.workflow.run': (_input, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new BridgeError(ERROR_CODES.TASK_CANCELLED, 'cancelled', { retryable: false })),
            { once: true }
          );
        })
    }
  });
  const input = task();
  dispatcher.submit(input);
  await waitFor(() => dispatcher.inflight().length === 1);
  assert.equal(dispatcher.cancel(input.taskId, 'cancelled'), true);
  await waitFor(() => outcomes.length === 1);
  assert.deepEqual(outcomes[0], { kind: 'cancelled', taskId: input.taskId });
  assert.deepEqual(cancels, [{ taskId: input.taskId, reason: 'cancelled' }]);
});

test('the server deadline times a task out', async () => {
  const { dispatcher, outcomes, cancels } = harness({
    handlers: {
      'dsh.workflow.run': (_input, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new BridgeError(ERROR_CODES.TASK_CANCELLED, 'aborted', { retryable: false })),
            { once: true }
          );
        })
    }
  });
  const input = task({ deadlineMs: Date.now() + 80 });
  dispatcher.submit(input);
  await waitFor(() => outcomes.length === 1, { timeoutMs: 3000 });
  assert.deepEqual(outcomes[0], { kind: 'cancelled', taskId: input.taskId });
  assert.equal(cancels[0].reason, 'timeout');
});

test('shutdown cancels queued and active work and waits for it', async () => {
  const { dispatcher, outcomes } = harness({
    handlers: {
      'dsh.workflow.run': (_input, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new BridgeError(ERROR_CODES.TASK_CANCELLED, 'aborted', { retryable: false })),
            { once: true }
          );
        })
    }
  });
  const first = task();
  const second = task();
  dispatcher.submit(first);
  dispatcher.submit(second);
  await waitFor(() => dispatcher.inflight().length === 1);
  await dispatcher.shutdown();
  assert.equal(outcomes.length, 2);
  assert.equal(outcomes.every((outcome) => outcome.kind === 'cancelled'), true);
});

test('oversized non-text results fail with RESULT_TOO_LARGE', async () => {
  const { dispatcher, outcomes } = harness({
    config: resolveConfig({ limits: { resultBytes: 1024 } }),
    handlers: {
      'dsh.workflow.run': async () => ({ blob: 'x'.repeat(4000) })
    }
  });
  const input = task();
  dispatcher.submit(input);
  await waitFor(() => outcomes.length === 1);
  assert.equal(outcomes[0].payload.status, 'failed');
  assert.equal(outcomes[0].payload.error.code, 'RESULT_TOO_LARGE');
});
