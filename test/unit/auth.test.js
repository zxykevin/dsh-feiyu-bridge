import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTH_PREFIX,
  BridgeCredentials,
  canonicalMessage,
  hmacSha256Hex,
  isValidClientId,
  randomNonce,
  safeEqualHex,
  signHeaders
} from '../../src/core/auth.js';
import { resolveConfig } from '../../src/config.js';

const SECRET = 's'.repeat(32);

function recorderLogger() {
  const warnings = [];
  const secrets = [];
  return {
    warnings,
    secrets,
    warn: (message) => warnings.push(String(message)),
    addSecret: (value) => secrets.push(value),
    info() {},
    debug() {},
    error() {}
  };
}

test('canonical message is exactly the six protocol lines', () => {
  const message = canonicalMessage({
    method: 'post',
    protocolPath: '/v1/heartbeat',
    timestamp: 1700000000,
    nonce: 'abcdefghijklmnop',
    body: '{"x":1}'
  });
  const lines = message.split('\n');
  assert.equal(lines.length, 6);
  assert.equal(lines[0], AUTH_PREFIX);
  assert.equal(lines[1], 'POST');
  assert.equal(lines[2], '/v1/heartbeat');
  assert.equal(lines[3], '1700000000');
  assert.equal(lines[4], 'abcdefghijklmnop');
  assert.match(lines[5], /^[0-9a-f]{64}$/);
});

test('signHeaders produces a verifiable second-resolution signature', () => {
  const body = '{"agent_version":"0.1.0"}';
  const headers = signHeaders({
    method: 'post',
    protocolPath: '/v1/heartbeat',
    body,
    secret: SECRET,
    clientId: 'windows-dsh',
    now: 1_700_000_000_999,
    nonce: () => 'abcdefghijklmnop'
  });
  assert.equal(headers['x-feiyu-client-id'], 'windows-dsh');
  assert.equal(headers['x-feiyu-timestamp'], '1700000000');
  assert.equal(headers['x-feiyu-nonce'], 'abcdefghijklmnop');
  assert.equal(
    headers['x-feiyu-signature'],
    hmacSha256Hex(
      SECRET,
      canonicalMessage({
        method: 'POST',
        protocolPath: '/v1/heartbeat',
        timestamp: 1700000000,
        nonce: 'abcdefghijklmnop',
        body
      })
    )
  );
});

test('signing fails closed without a usable secret', () => {
  assert.throws(
    () =>
      signHeaders({
        method: 'POST',
        protocolPath: '/v1/heartbeat',
        body: '{}',
        secret: 'short',
        clientId: 'windows-dsh'
      }),
    /too short/
  );
  assert.throws(
    () =>
      signHeaders({
        method: 'POST',
        protocolPath: '/v1/heartbeat',
        body: '{}',
        secret: SECRET,
        clientId: ' '
      }),
    /client id/
  );
});

test('nonces are URL-safe and long enough for the server', () => {
  const nonce = randomNonce();
  assert.match(nonce, /^[A-Za-z0-9_-]{16,128}$/);
  assert.notEqual(randomNonce(), nonce);
});

test('safeEqualHex and client id validation', () => {
  assert.equal(safeEqualHex('abcd', 'abcd'), true);
  assert.equal(safeEqualHex('abcd', 'abce'), false);
  assert.equal(safeEqualHex('abcd', 'abcde'), false);
  assert.equal(isValidClientId('windows-dsh'), true);
  assert.equal(isValidClientId('bad client'), false);
});

test('BridgeCredentials resolves refs, caches, and redacts', async () => {
  let resolves = 0;
  const logger = recorderLogger();
  const credentials = {
    async resolve(ref) {
      resolves += 1;
      if (ref === 'FEIYU_BRIDGE_SECRET') return { value: SECRET, source: 'file' };
      if (ref === 'FEIYU_ASTRBOT_API_KEY') return { value: 'abk_test_123456', source: 'file' };
      return undefined;
    }
  };
  const config = resolveConfig({});
  const store = new BridgeCredentials({ config, credentials, logger, ttlMs: 1000, now: () => 1000 });

  assert.equal(await store.bridgeSecret(), SECRET);
  assert.equal(await store.bridgeSecret(), SECRET);
  assert.equal(resolves, 1);
  assert.equal(await store.apiKey(), 'abk_test_123456');
  assert.equal(logger.secrets.includes(SECRET), true);

  store.invalidate();
  await store.bridgeSecret();
  assert.equal(resolves, 3);
});

test('BridgeCredentials uses dev config values with a warning', async () => {
  const logger = recorderLogger();
  const credentials = {
    async resolve() {
      throw new Error('must not be called');
    }
  };
  const config = resolveConfig({ auth: { bridgeSecret: SECRET, apiKey: 'abk_dev_12345' } });
  const store = new BridgeCredentials({ config, credentials, logger });
  assert.equal(await store.bridgeSecret(), SECRET);
  assert.equal(await store.apiKey(), 'abk_dev_12345');
  assert.equal(logger.warnings.length, 2);
  assert.equal(logger.secrets.length, 2);
});

test('BridgeCredentials fails closed when a credential is missing', async () => {
  const logger = recorderLogger();
  const credentials = { async resolve() { return undefined; } };
  const config = resolveConfig({});
  const store = new BridgeCredentials({ config, credentials, logger });
  await assert.rejects(() => store.bridgeSecret(), (error) => error.code === 'AUTH_UNAVAILABLE');
  await assert.rejects(() => store.apiKey(), (error) => error.code === 'AUTH_UNAVAILABLE');
});
