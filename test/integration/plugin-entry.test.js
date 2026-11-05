import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../../src/index.js';
import { createMockServer } from '../../mock/server.js';
import { silentLogger, waitFor } from '../helpers.js';

test('the Cordis entry point wires credentials, transport, runtime and cleanup', async () => {
  const mock = createMockServer({ maxWaitMs: 100 });
  const info = await mock.listen();
  let dispose;
  const resolvedRefs = [];
  const ctx = {
    logger: silentLogger(),
    credentials: {
      async resolve(ref) {
        resolvedRefs.push(ref);
        if (ref === 'FEIYU_BRIDGE_SECRET') return { value: info.bridgeSecret, source: 'file' };
        if (ref === 'FEIYU_ASTRBOT_API_KEY') return { value: info.apiKey, source: 'file' };
        return undefined;
      }
    },
    agents: {
      async resume() {
        throw new Error('not configured in this test');
      },
      async create() {
        throw new Error('agent creation is not expected for dsh.status.read');
      }
    },
    effect(callback) {
      dispose = callback();
      return dispose;
    }
  };

  apply(ctx, {
    server: { baseUrl: info.url, leaseWaitSeconds: 1, requestTimeoutMs: 2000 },
    runtime: {
      heartbeatIntervalMs: 5000,
      reconnectInitialMs: 100,
      reconnectMaxMs: 1000,
      resultRetryMs: 100
    }
  });

  try {
    await waitFor(async () => resolvedRefs.length >= 2, { label: 'credentials resolved' });
    // The lease loop retries until the first successful poll; enqueue once the
    // runtime is up and wait for the result.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const task = mock.enqueue({ capability: 'dsh.status.read', arguments: {} });
    const record = await mock.waitForResult(task.task_id, 5000);
    assert.equal(record.state, 'succeeded');
    assert.equal(record.result.online, true);
  } finally {
    await dispose();
    await mock.close();
  }
});
