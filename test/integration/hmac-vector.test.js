import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { canonicalMessage, hmacSha256Hex, sha256Hex, signHeaders } from '../../src/core/auth.js';
import { createMockServer } from '../../mock/server.js';

const vectorPath = new URL('../fixtures/hmac_v1.json', import.meta.url);
const vector = existsSync(vectorPath)
  ? JSON.parse(readFileSync(vectorPath, 'utf8'))
  : {
      secret: 'feiyu-bridge-test-secret-32-bytes!!',
      client_id: 'windows-dsh-test',
      method: 'POST',
      protocol_path: '/v1/heartbeat',
      timestamp: '1793790000',
      nonce: '0123456789abcdefABCDEF_-',
      body_utf8:
        '{"active_task_id":null,"agent_version":"0.1.0-test","capabilities":["dsh.workflow.run"]}',
      body_sha256: '7a6ee344d1ccec198bb7bbb9a66dbf2602191609affffcc2340b704ed19c9a42',
      canonical_message_utf8:
        'FEIYU-BRIDGE-V1\nPOST\n/v1/heartbeat\n1793790000\n0123456789abcdefABCDEF_-\n7a6ee344d1ccec198bb7bbb9a66dbf2602191609affffcc2340b704ed19c9a42',
      signature_hex: '503f9a83b2a8fabdfa39b7bcec14e3a80d5c353d1bec69340701930f625ce2ac'
    };

const timestampSeconds = Number(vector.timestamp);

function sign(body, { timestamp = timestampSeconds, nonce = vector.nonce } = {}) {
  return signHeaders({
    method: vector.method,
    protocolPath: vector.protocol_path,
    body,
    secret: vector.secret,
    clientId: vector.client_id,
    now: timestamp * 1000,
    nonce: () => nonce
  });
}

async function startMock() {
  const mock = createMockServer({
    bridgeSecret: vector.secret,
    apiKey: 'abk_mock_openapi_key_1234567890',
    clientId: vector.client_id,
    maxWaitMs: 100,
    now: () => timestampSeconds * 1000
  });
  const { url } = await mock.listen();
  const endpoint = `${url}v1/heartbeat`;
  return { mock, endpoint };
}

async function post(endpoint, headers, body) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-api-key': 'abk_mock_openapi_key_1234567890',
      ...headers
    },
    body
  });
  return { status: res.status, json: await res.json() };
}

test('client HMAC implementation matches the authoritative fixed vector', () => {
  assert.equal(sha256Hex(Buffer.from(vector.body_utf8, 'utf8')), vector.body_sha256);
  assert.equal(
    canonicalMessage({
      method: vector.method,
      protocolPath: vector.protocol_path,
      timestamp: timestampSeconds,
      nonce: vector.nonce,
      body: vector.body_utf8
    }),
    vector.canonical_message_utf8
  );
  assert.equal(
    hmacSha256Hex(
      vector.secret,
      canonicalMessage({
        method: vector.method,
        protocolPath: vector.protocol_path,
        timestamp: timestampSeconds,
        nonce: vector.nonce,
        body: vector.body_utf8
      })
    ),
    vector.signature_hex
  );
  assert.equal(sign(vector.body_utf8)['x-feiyu-signature'], vector.signature_hex);
});

test('fixed vector cases are enforced by a Bridge-style verifier', async (t) => {
  const { mock, endpoint } = await startMock();
  t.after(() => mock.close());

  const valid = await post(endpoint, sign(vector.body_utf8), vector.body_utf8);
  assert.equal(valid.status, 200);
  assert.equal(valid.json.ok, true);

  const tamperedBody = vector.body_utf8.replace('dsh.workflow.run', 'dsh.workflow.run,dsh.status.read');
  const tampered = await post(
    endpoint,
    sign(vector.body_utf8, { nonce: 'tamperedNonce0123456789' }),
    tamperedBody
  );
  assert.equal(tampered.status, 401);
  assert.equal(tampered.json.error.code, 'AUTH_INVALID_SIGNATURE');

  const expiredHeaders = sign(vector.body_utf8, {
    timestamp: timestampSeconds - 61,
    nonce: 'expiredNonce0123456789'
  });
  const expired = await post(endpoint, expiredHeaders, vector.body_utf8);
  assert.equal(expired.status, 401);
  assert.equal(expired.json.error.code, 'AUTH_TIMESTAMP_EXPIRED');

  const replayHeaders = sign(vector.body_utf8, { nonce: 'replayNonce0123456789' });
  const first = await post(endpoint, replayHeaders, vector.body_utf8);
  assert.equal(first.status, 200);
  const second = await post(endpoint, replayHeaders, vector.body_utf8);
  assert.equal(second.status, 401);
  assert.equal(second.json.error.code, 'AUTH_REPLAY');
});

test('server is reachable through a loopback HTTP listener', async (t) => {
  const mock = createMockServer({ maxWaitMs: 100 });
  const { url } = await mock.listen();
  t.after(() => mock.close());
  const res = await fetch(`${new URL(url).origin}/__mock/state`);
  assert.equal(res.status, 200);
  const state = await res.json();
  assert.equal(state.protocol, 'feiyu-bridge/1');
});
