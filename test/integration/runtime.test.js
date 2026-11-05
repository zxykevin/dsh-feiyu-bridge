import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockServer } from '../../mock/server.js';
import { resolveConfig } from '../../src/config.js';
import { BridgeCredentials } from '../../src/core/auth.js';
import { HttpTransport } from '../../src/transport/http-longpoll.js';
import { BridgeRuntime } from '../../src/runtime.js';
import { createCapabilityRegistry } from '../../src/core/capability-registry.js';
import { BridgeError, ERROR_CODES } from '../../src/core/errors.js';
import { silentLogger, waitFor } from '../helpers.js';

class FakeAgent {
  constructor({ delayMs = 0, text = (prompt) => `echo:${prompt}` } = {}) {
    this.delayMs = delayMs;
    this.text = text;
    this.calls = [];
    this.cancels = [];
    this.active = new Set();
  }

  status() {
    return { sessions: 0, running: this.active.size };
  }

  async execute(request, signal) {
    this.calls.push(request);
    this.active.add(request.taskId);
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, this.delayMs);
        const onAbort = () => {
          clearTimeout(timer);
          reject(new BridgeError(ERROR_CODES.TASK_CANCELLED, 'agent aborted', { retryable: false }));
        };
        if (signal?.aborted) return onAbort();
        signal?.addEventListener('abort', onAbort, { once: true });
      });
      return { text: this.text(request.prompt), turn: 1, truncated: false };
    } finally {
      this.active.delete(request.taskId);
    }
  }

  cancel(taskId, reason) {
    this.cancels.push({ taskId, reason });
  }

  async shutdown() {}
}

async function startHarness({ mockOptions = {}, configPatch = {}, agent } = {}) {
  const logger = silentLogger();
  const mock = createMockServer({ maxWaitMs: 200, ...mockOptions });
  const info = await mock.listen();
  const configInput = {
    server: { baseUrl: info.url, requestTimeoutMs: 3000, leaseWaitSeconds: 1 },
    auth: {
      bridgeSecret: info.bridgeSecret,
      apiKey: info.apiKey,
      clientId: info.clientId
    },
    runtime: {
      heartbeatIntervalMs: 5000,
      reconnectInitialMs: 100,
      reconnectMaxMs: 1000,
      resultRetryMs: 100,
      pendingResultTtlMs: 60000
    },
    tasks: { maxTimeoutMs: 60000 }
  };
  for (const [key, value] of Object.entries(configPatch)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && configInput[key]) {
      Object.assign(configInput[key], value);
    } else {
      configInput[key] = value;
    }
  }
  const config = resolveConfig(configInput);
  const credentials = new BridgeCredentials({ config, credentials: null, logger });
  const transport = new HttpTransport({ config, credentials, logger });
  const fakeAgent = agent ?? new FakeAgent();
  const capabilities = createCapabilityRegistry({ config, logger });
  const runtime = new BridgeRuntime({
    config,
    logger,
    transport,
    agent: fakeAgent,
    capabilities
  });
  runtime.start();
  return {
    mock,
    info,
    config,
    agent: fakeAgent,
    runtime,
    async stop() {
      await runtime.stop();
      await mock.close();
    }
  };
}

test('the device leases dsh.status.read and answers without invoking the agent', async () => {
  const harness = await startHarness();
  try {
    await waitFor(() => harness.runtime.status().online === true, { label: 'online' });
    const task = harness.mock.enqueue({ capability: 'dsh.status.read', arguments: {} });
    const record = await harness.mock.waitForResult(task.task_id, 5000);
    assert.equal(record.state, 'succeeded');
    assert.equal(record.result.online, true);
    assert.equal(record.result.protocol, 'feiyu-bridge/1');
    assert.equal(harness.agent.calls.length, 0);
  } finally {
    await harness.stop();
  }
});

test('dsh.workflow.run executes the prompt with an isolated session key', async () => {
  const harness = await startHarness();
  try {
    await waitFor(() => harness.runtime.status().online === true);
    const task = harness.mock.enqueue({
      capability: 'dsh.workflow.run',
      arguments: { prompt: 'hello', session_key: 'qq:10001' }
    });
    const record = await harness.mock.waitForResult(task.task_id, 5000);
    assert.equal(record.state, 'succeeded');
    assert.equal(record.result.value, 'echo:hello');
    assert.equal(record.result.session_key, 'qq:10001');
    assert.equal(harness.agent.calls.length, 1);
    assert.equal(harness.agent.calls[0].sessionKey, 'qq:10001');
    assert.equal(harness.agent.calls[0].prompt, 'hello');
  } finally {
    await harness.stop();
  }
});

test('capabilities not enabled on the device are refused', async () => {
  const harness = await startHarness();
  try {
    await waitFor(() => harness.runtime.status().online === true);
    const task = harness.mock.enqueue({ capability: 'dsh.unknown.capability', arguments: {} });
    const record = await harness.mock.waitForResult(task.task_id, 5000);
    assert.equal(record.state, 'failed');
    assert.equal(record.error.code, 'CAPABILITY_DENIED');
  } finally {
    await harness.stop();
  }
});

test('a server cancellation reaches the agent and is acknowledged', async () => {
  const agent = new FakeAgent({ delayMs: 10000 });
  const harness = await startHarness({ agent });
  try {
    await waitFor(() => harness.runtime.status().online === true);
    const task = harness.mock.enqueue({
      capability: 'dsh.workflow.run',
      arguments: { prompt: 'long', session_key: 'qq:20002' },
      timeout_seconds: 30
    });
    await waitFor(() => agent.calls.length === 1, { label: 'agent started' });
    harness.mock.cancel(task.task_id);
    await waitFor(() => harness.mock.state.activeTaskId === null, {
      timeoutMs: 10000,
      label: 'cancellation acknowledged'
    });
    assert.deepEqual(agent.cancels, [{ taskId: task.task_id, reason: 'cancelled' }]);
  } finally {
    await harness.stop();
  }
});

test('the server deadline aborts a slow task', async () => {
  const agent = new FakeAgent({ delayMs: 10000 });
  const harness = await startHarness({ agent });
  try {
    await waitFor(() => harness.runtime.status().online === true);
    const task = harness.mock.enqueue({
      capability: 'dsh.workflow.run',
      arguments: { prompt: 'slow', session_key: 'qq:30003' },
      timeout_seconds: 1
    });
    await waitFor(() => harness.mock.lastResult(task.task_id) !== null, {
      timeoutMs: 5000,
      label: 'timeout result'
    });
    assert.equal(harness.mock.lastResult(task.task_id).state, 'cancelled');
    assert.equal(agent.cancels[0].reason, 'timeout');
  } finally {
    await harness.stop();
  }
});

test('the device reconnects after the server becomes reachable again', async () => {
  const harness = await startHarness();
  try {
    await waitFor(() => harness.runtime.status().online === true);
    harness.mock.setUnavailable(true);
    await waitFor(() => harness.runtime.status().online === false, { label: 'offline' });
    harness.mock.setUnavailable(false);
    await waitFor(() => harness.runtime.status().online === true, {
      timeoutMs: 5000,
      label: 'reconnected'
    });
    const task = harness.mock.enqueue({ capability: 'dsh.status.read', arguments: {} });
    const record = await harness.mock.waitForResult(task.task_id, 5000);
    assert.equal(record.state, 'succeeded');
  } finally {
    await harness.stop();
  }
});

test('a wrong AstrBot API key fails closed and is visible in status', async () => {
  const harness = await startHarness({ configPatch: { auth: { apiKey: 'wrong-api-key-1234' } } });
  try {
    await waitFor(
      () => harness.runtime.transportStatus().last_error?.code === 'AUTH_CLIENT_REJECTED',
      { timeoutMs: 5000, label: 'auth rejection' }
    );
    assert.equal(harness.runtime.status().online, false);
    assert.equal(harness.runtime.status().state, 'failed');
  } finally {
    await harness.stop();
  }
});
