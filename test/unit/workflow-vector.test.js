import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { resolveConfig } from '../../src/config.js';
import { validateTask } from '../../src/core/protocol.js';
import { workflowRun } from '../../src/capabilities/workflow-run.js';

const vectorPath = fileURLToPath(new URL('../fixtures/workflow_v1.json', import.meta.url));

const taskId = '11111111-1111-4111-8111-111111111111';

function taskFor(argumentsValue) {
  return {
    taskId,
    capability: 'dsh.workflow.run',
    arguments: argumentsValue,
    createdAt: Date.now(),
    deadlineAt: Date.now() + 120_000
  };
}

test('client accepts the server workflow_v1 lease and derives no session identity itself', async () => {
  const vector = JSON.parse(await readFile(vectorPath, 'utf8'));
  assert.equal(vector.protocol, 'feiyu-bridge/1');

  const parsed = validateTask({
    task_id: taskId,
    capability: 'dsh.workflow.run',
    arguments: vector.valid_arguments,
    state: 'leased',
    created_at: Math.floor(Date.now() / 1000),
    deadline_at: Math.floor(Date.now() / 1000) + 120
  });

  assert.deepEqual(parsed.arguments, vector.valid_arguments);
  assert.match(vector.expected_session_key, /^[A-Za-z0-9._:@-]{1,64}$/);
  assert.ok(vector.expected_session_key.length <= 64);

  let captured;
  const config = resolveConfig({});
  const agent = {
    async execute(request) {
      captured = request;
      return { text: 'ok', turn: 1, truncated: false };
    }
  };

  const result = await workflowRun({
    task: taskFor(vector.valid_arguments),
    config,
    agent
  });

  assert.equal(captured.sessionKey, vector.expected_session_key);
  assert.equal(result.session_key, vector.expected_session_key);
  assert.equal(result.value, 'ok');
});

test('client rejects the server workflow_v1 invalid cases', async () => {
  const vector = JSON.parse(await readFile(vectorPath, 'utf8'));
  const config = resolveConfig({});
  const agent = { execute: async () => ({ text: 'must not run', turn: 1 }) };

  for (const invalid of vector.invalid_cases) {
    await assert.rejects(
      () => workflowRun({ task: taskFor(invalid.arguments), config, agent }),
      (error) => error.code === 'INVALID_REQUEST',
      `${invalid.name} must be rejected`
    );
  }
});

test('async workflow timeout can exceed the former 300 second request window', async () => {
  const config = resolveConfig({});
  let captured;
  const agent = {
    async execute(request) {
      captured = request;
      return { text: 'ok', turn: 1, dshSessionId: 'session-1', executionId: null };
    }
  };
  const task = taskFor({
    prompt: 'long but safe task',
    session_key: 'qq:long-task',
    timeout_seconds: 600
  });
  task.deadlineAt = Date.now() + 600_000;

  const result = await workflowRun({ task, config, agent });

  assert.ok(captured.timeoutMs > 300_000);
  assert.equal(result.dsh_session_id, 'session-1');
  assert.equal(result.execution_id, null);
});
