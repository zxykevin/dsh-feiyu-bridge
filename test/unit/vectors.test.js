import test from 'node:test';
import assert from 'node:assert/strict';

import { canonicalMessage, sha256Hex, signHeaders } from '../../src/core/auth.js';

// Interoperability vector published by the AstrBot side in
// astrbot_plugin_feiyu_bridge/docs/HMAC_TEST_VECTORS.md. Kept inline so the
// test does not depend on the sibling repository checkout.
const VECTOR = Object.freeze({
  secret: 'feiyu-bridge-test-secret-32-bytes!!',
  clientId: 'windows-dsh-test',
  method: 'POST',
  protocolPath: '/v1/heartbeat',
  timestamp: 1793790000,
  nonce: '0123456789abcdefABCDEF_-',
  body: '{"active_task_id":null,"agent_version":"0.1.0-test","capabilities":["dsh.workflow.run"]}',
  bodySha256: '7a6ee344d1ccec198bb7bbb9a66dbf2602191609affffcc2340b704ed19c9a42',
  canonical:
    'FEIYU-BRIDGE-V1\nPOST\n/v1/heartbeat\n1793790000\n0123456789abcdefABCDEF_-\n7a6ee344d1ccec198bb7bbb9a66dbf2602191609affffcc2340b704ed19c9a42',
  signature: '503f9a83b2a8fabdfa39b7bcec14e3a80d5c353d1bec69340701930f625ce2ac'
});

test('the client matches the AstrBot fixed HMAC interoperability vector', () => {
  assert.equal(sha256Hex(VECTOR.body), VECTOR.bodySha256);
  assert.equal(
    canonicalMessage({
      method: VECTOR.method,
      protocolPath: VECTOR.protocolPath,
      timestamp: VECTOR.timestamp,
      nonce: VECTOR.nonce,
      body: VECTOR.body
    }),
    VECTOR.canonical
  );

  const headers = signHeaders({
    method: VECTOR.method,
    protocolPath: VECTOR.protocolPath,
    body: VECTOR.body,
    secret: VECTOR.secret,
    clientId: VECTOR.clientId,
    now: VECTOR.timestamp * 1000,
    nonce: () => VECTOR.nonce
  });

  assert.equal(headers['x-feiyu-timestamp'], String(VECTOR.timestamp));
  assert.equal(headers['x-feiyu-signature'], VECTOR.signature);
});
