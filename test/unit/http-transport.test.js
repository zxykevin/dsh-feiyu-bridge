import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { resolveConfig } from '../../src/config.js';
import { HttpTransport } from '../../src/transport/http-longpoll.js';
import { BridgeError } from '../../src/core/errors.js';

function silentLogger() {
  const logger = { error() {}, warn() {}, info() {}, debug() {}, addSecret() {} };
  return logger;
}

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await run(port);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

function transportFor(port) {
  const config = resolveConfig({
    server: {
      baseUrl: `http://127.0.0.1:${port}/api/v1/plugins/extensions/astrbot_plugin_feiyu_bridge/`,
      requestTimeoutMs: 2000
    }
  });
  return new HttpTransport({
    config,
    credentials: {
      async bridgeSecret() {
        return '0123456789abcdef0123456789abcdef';
      },
      async apiKey() {
        return 'abk_test_12345678';
      },
      invalidate() {}
    },
    logger: silentLogger()
  });
}

test('AstrBot middleware 401 is reported as an auth failure with its message', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', message: 'Missing API key' }));
    },
    async (port) => {
      const transport = transportFor(port);
      await assert.rejects(
        () => transport.getStatus(),
        (error) => {
          assert.ok(error instanceof BridgeError);
          assert.equal(error.code, 'AUTH_CLIENT_REJECTED');
          assert.equal(error.message, 'Missing API key');
          assert.equal(error.retryable, false);
          return true;
        }
      );
    }
  );
});

test('bridge error envelopes keep their code, message and retryable flag', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: false,
          protocol: 'feiyu-bridge/1',
          error: { code: 'TASK_NOT_LEASED', message: 'task is not leased', retryable: false }
        })
      );
    },
    async (port) => {
      const transport = transportFor(port);
      await assert.rejects(
        () => transport.getStatus(),
        (error) => {
          assert.ok(error instanceof BridgeError);
          assert.equal(error.code, 'TASK_NOT_LEASED');
          assert.equal(error.message, 'task is not leased');
          assert.equal(error.retryable, false);
          return true;
        }
      );
    }
  );
});

test('requests authenticate with X-API-Key and HMAC headers, never Bearer', async () => {
  let captured;
  await withServer(
    (req, res) => {
      captured = { headers: req.headers, url: req.url };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, protocol: 'feiyu-bridge/1', data: { online: true } }));
    },
    async (port) => {
      const transport = transportFor(port);
      await transport.getStatus();
    }
  );
  assert.equal(captured.url, '/api/v1/plugins/extensions/astrbot_plugin_feiyu_bridge/v1/status');
  assert.equal(captured.headers['x-api-key'], 'abk_test_12345678');
  assert.equal(captured.headers.authorization, undefined);
  assert.equal(captured.headers['x-feiyu-client-id'], 'windows-dsh');
  assert.match(captured.headers['x-feiyu-timestamp'], /^\d{10}$/);
  assert.match(captured.headers['x-feiyu-nonce'], /^[A-Za-z0-9_-]{16,128}$/);
  assert.match(captured.headers['x-feiyu-signature'], /^[0-9a-f]{64}$/);
});
