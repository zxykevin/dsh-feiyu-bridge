import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROTOCOL_ID,
  jsonByteLength,
  parseEnvelope,
  truncateUtf8,
  validateArguments,
  validateCapability,
  validateTask
} from '../../src/core/protocol.js';
import { BridgeError } from '../../src/core/errors.js';

const TASK_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

const baseTask = () => ({
  task_id: TASK_ID,
  capability: 'dsh.workflow.run',
  arguments: { prompt: 'hello', session_key: 'qq:u1' },
  state: 'leased',
  created_at: 1_700_000_000,
  deadline_at: 1_700_000_120
});

test('validateTask normalizes epoch seconds and validates the UUID', () => {
  const task = validateTask(baseTask());
  assert.equal(task.taskId, TASK_ID);
  assert.equal(task.capability, 'dsh.workflow.run');
  assert.equal(task.state, 'leased');
  assert.equal(task.createdAt, 1_700_000_000_000);
  assert.equal(task.deadlineAt, 1_700_000_120_000);
});

test('validateTask rejects malformed ids, capabilities, arguments and states', () => {
  assert.throws(() => validateTask({ ...baseTask(), task_id: '../x' }), /UUID/);
  assert.throws(() => validateTask({ ...baseTask(), capability: 'Bad Cap' }), /capability/);
  assert.throws(() => validateTask({ ...baseTask(), arguments: [] }), /must be an object/);
  assert.throws(() => validateTask({ ...baseTask(), state: 'queued' }), /leased/);
  assert.throws(() => validateTask({ ...baseTask(), deadline_at: undefined }), /deadline_at/);
});

test('capabilities with command-shaped names are denied', () => {
  assert.equal(validateCapability('dsh.status.read'), 'dsh.status.read');
  assert.throws(() => validateCapability('dsh.shell.run'), /permanently denied/);
  assert.throws(() => validateCapability('dsh.pwsh'), /permanently denied/);
  assert.throws(() => validateCapability('Dsh Status Read'), /must match/);
});

test('command-shaped argument keys are denied recursively', () => {
  assert.throws(() => validateArguments({ command: 'whoami' }), /denied/);
  assert.throws(() => validateArguments({ nested: { PowerShell: 'x' } }), /denied/);
  assert.throws(() => validateArguments({ list: [{ argv: [] }] }), /denied/);
  assert.doesNotThrow(() => validateArguments({ prompt: 'hi', session_key: 'qq:1', n: 3, ok: true }));
});

test('argument depth and non-JSON values are rejected', () => {
  let deep = {};
  const root = deep;
  for (let i = 0; i < 18; i += 1) {
    deep.child = {};
    deep = deep.child;
  }
  assert.throws(() => validateArguments(root), /nesting depth/);
  assert.throws(() => validateArguments({ when: new Date() }), /non-JSON/);
});

test('parseEnvelope returns data and maps server errors', () => {
  assert.deepEqual(parseEnvelope({ ok: true, protocol: PROTOCOL_ID, data: { task: null } }), { task: null });
  assert.throws(
    () =>
      parseEnvelope({
        ok: false,
        protocol: PROTOCOL_ID,
        error: { code: 'QUEUE_FULL', message: 'full', retryable: true }
      }),
    (error) => error instanceof BridgeError && error.code === 'QUEUE_FULL' && error.retryable === true
  );
  assert.throws(() => parseEnvelope({ ok: true, protocol: 'v0' }), /not feiyu-bridge\/1/);
  assert.throws(() => parseEnvelope({ ok: 'yes', protocol: PROTOCOL_ID }), /ok flag/);
});

test('truncateUtf8 never splits a code point', () => {
  const text = 'a😀b';
  const { text: cut, truncated } = truncateUtf8(text, 5);
  assert.equal(truncated, true);
  assert.equal(Buffer.byteLength(cut, 'utf8') <= 5, true);
  assert.equal(cut, 'a😀');
  assert.equal(jsonByteLength({ text: 'ok' }) > 0, true);
});
