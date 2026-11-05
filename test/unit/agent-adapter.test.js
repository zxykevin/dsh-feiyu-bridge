import test from 'node:test';
import assert from 'node:assert/strict';
import { DshAgentAdapter } from '../../src/agent/dsh-agent-adapter.js';
import { resolveConfig } from '../../src/config.js';
import { silentLogger, deferred, waitFor } from '../helpers.js';

const DEFAULT_CWD = 'C:/work/feiyu-bridge';

function makeFakeCtx({
  onAgent,
  injectMessageFactory = true,
  agentConfig = {},
  storedHeaders = [],
  archived = [],
  resumeError = null,
  presetService = null,
  titleService = null
} = {}) {
  const created = [];
  const resumed = [];
  const restrictions = [];
  const policies = [];
  const mounts = [];
  const titles = [];
  const permissionSets = [];
  const permissionState = { preset: 'workspace-write', sandbox: 'workspace-write', approval: 'never', seeded: true };
  const live = new Map();
  const headers = [...storedHeaders];

  const buildHandle = async (sessionId, options) => {
    const session = {
      id: sessionId,
      seq: 0,
      events: [],
      snapshotEvents(from = 0) {
        return this.events.slice(from);
      },
      append(event) {
        this.events.push(event);
        this.seq = this.events.length;
      }
    };
    const idle = deferred();
    let currentTurn = 0;
    const agent = {
      session,
      followup(message) {
        agent.lastMessage = message;
        currentTurn += 1;
        const turnNo = currentTurn;
        session.append({ type: 'turn/start', data: { turn: turnNo } });
        const behaviour = agent.behaviour ?? 'complete';
        if (behaviour === 'complete') {
          session.append({
            type: 'assistant/message',
            data: {
              turn: turnNo,
              step: 1,
              message: { content: [{ type: 'text', text: agent.reply ?? 'agent reply' }] },
              usage: { inputTokens: 10, outputTokens: 5 }
            }
          });
          session.append({ type: 'turn/end', data: { turn: turnNo, reason: { kind: 'completed' } } });
          idle.resolve();
        } else if (behaviour === 'blocked') {
          session.append({
            type: 'turn/end',
            data: {
              turn: turnNo,
              reason: { kind: 'blocked', error: { message: 'approval required' } }
            }
          });
          idle.resolve();
        } else if (behaviour === 'custom') {
          for (const event of agent.events ?? []) {
            session.append(typeof event === 'function' ? event(turnNo) : event);
          }
          session.append({
            type: 'turn/end',
            data: { turn: turnNo, reason: agent.reason ?? { kind: 'completed' } }
          });
          idle.resolve();
        }
      },
      whenIdle() {
        return idle.promise;
      },
      cancel() {
        agent.cancelled = true;
        idle.resolve();
      }
    };
    const effects = [];
    const agentCtx = {
      tools: {
        restrict(filter) {
          restrictions.push(filter);
          return () => {};
        }
      },
      effect(callback, label) {
        effects.push(label);
        callback();
      }
    };
    if (options.setup) await options.setup(agentCtx, agent);
    const handle = {
      agent,
      async dispose() {
        handle.disposed = true;
        if (live.get(sessionId) === handle) live.delete(sessionId);
      }
    };
    live.set(sessionId, handle);
    onAgent?.(agent);
    return { handle, effects };
  };

  const ctx = {
    agents: {
      get(sessionId) {
        return live.get(sessionId)?.agent;
      },
      async resume(options) {
        if (resumeError) throw resumeError;
        const sessionId = options.resumeSessionId;
        const header = headers.find((candidate) => candidate.id === sessionId);
        if (!header) {
          const error = new Error(`session "${sessionId}" not found`);
          error.name = 'SessionPersistenceNotFoundError';
          throw error;
        }
        if (live.has(sessionId)) {
          const error = new Error('already registered');
          error.name = 'SessionAlreadyOwnedError';
          throw error;
        }
        const { handle, effects } = await buildHandle(sessionId, options);
        resumed.push({ sessionId, handle, effects, options, header });
        return handle;
      },
      async create(options) {
        const { sessionId } = options;
        if (headers.some((candidate) => candidate.id === sessionId)) {
          const error = new Error('session already exists');
          error.name = 'SessionAlreadyExistsError';
          throw error;
        }
        const { handle, effects } = await buildHandle(sessionId, options);
        const header = {
          version: 4,
          id: sessionId,
          createdAt: Date.now(),
          ...(options.meta ?? {})
        };
        headers.push(header);
        created.push({ sessionId, handle, effects, options, header });
        return handle;
      }
    },
    sessionPersistence: {
      async list() {
        return headers.map((header) => ({ header }));
      }
    },
    workspaceRegistry: {
      archivedSessionIds: new Set(archived)
    },
    permissionPresets: {
      permissionState() {
        return { ...permissionState };
      },
      set(session, name) {
        permissionSets.push({ sessionId: session.id, name });
        permissionState.sandbox = name;
        permissionState.approval = 'ask';
      }
    },
    ...(presetService
      ? {
          agentPresets: {
            async resolve(id) {
              return { id: id ?? presetService.defaultId ?? 'standard' };
            },
            async mount(agentCtx, id) {
              mounts.push({ id, agentCtx });
              return { id };
            }
          }
        }
      : {}),
    ...(titleService
      ? {
          sessionTitle: {
            rename(session, title) {
              titles.push({ sessionId: session.id, title });
              return titleService.rename?.(session, title);
            }
          }
        }
      : {})
  };

  const adapterConfig = resolveConfig({ agent: { cwd: DEFAULT_CWD, ...agentConfig } });
  const adapter = new DshAgentAdapter({
    ctx,
    config: adapterConfig,
    cwd: adapterConfig.agent.cwd,
    logger: silentLogger(),
    setApprovalPolicy: (session, policy) => policies.push({ sessionId: session.id, policy }),
    ...(injectMessageFactory
      ? { createUserMessage: (input) => ({ id: 'msg-1', role: 'user', ...input }) }
      : {})
  });
  return { ctx, adapter, created, resumed, restrictions, policies, mounts, titles, permissionSets, permissionState, headers, live };
}

function customAgent(events, reason = { kind: 'completed' }) {
  return (agent) => {
    agent.behaviour = 'custom';
    agent.events = events;
    agent.reason = reason;
  };
}

function toolCall(turn, callId, name, args = {}) {
  return { type: 'tool/call', data: { turn, step: 1, callId, name, arguments: args } };
}

function toolResult(turn, callId, { isError = false } = {}) {
  return {
    type: 'tool/result',
    data: {
      turn,
      step: 1,
      message: {
        role: 'tool',
        toolCallId: callId,
        isError,
        source: { kind: 'tool', callId },
        content: [{ type: 'text', text: isError ? 'write failed' : 'ok' }]
      },
      ...(isError ? { error: { code: 'EACCES' } } : {})
    }
  };
}

function assistant(turn, text) {
  return {
    type: 'assistant/message',
    data: {
      turn,
      step: 1,
      message: { content: [{ type: 'text', text }] },
      usage: { inputTokens: 10, outputTokens: 5 }
    }
  };
}

test('a bridge session is created, workspace-scoped, tool-restricted, and approval-denied', async () => {
  const { adapter, created, restrictions, policies } = makeFakeCtx();
  const result = await adapter.execute({
    prompt: 'hello',
    sessionKey: 'qq:1',
    timeoutMs: 5000,
    taskId: 'task-1'
  });
  assert.equal(result.text, 'agent reply');
  assert.equal(result.usage.input_tokens, 10);
  assert.equal(created.length, 1);
  assert.match(created[0].sessionId, /^feiyu-bridge-v2-[0-9a-f]{24}$/);
  assert.equal(created[0].header.cwd, DEFAULT_CWD);
  assert.deepEqual(restrictions, [{ allow: ['read', 'write', 'edit'] }]);
  assert.deepEqual(policies, [{ sessionId: created[0].sessionId, policy: 'never' }]);
  assert.deepEqual(created[0].effects, ['feiyu-bridge.tool-restriction']);
});

test('a permission preset widened in the GUI is pinned back before the next bridge task', async () => {
  const { adapter, created, permissionSets, permissionState, policies } = makeFakeCtx();
  await adapter.execute({ prompt: 'one', sessionKey: 'qq:1', timeoutMs: 5000, taskId: 't1' });
  permissionState.sandbox = 'danger-full-access';
  permissionState.approval = 'ask';

  await adapter.execute({ prompt: 'two', sessionKey: 'qq:1', timeoutMs: 5000, taskId: 't2' });

  assert.deepEqual(permissionSets, [{ sessionId: created[0].sessionId, name: 'workspace-write' }]);
  assert.equal(policies.at(-1).policy, 'never');
});

test('a configured danger-full-access sandbox is pinned and cannot be narrowed by the GUI', async () => {
  const { adapter, created, restrictions, permissionSets, permissionState, policies } = makeFakeCtx({
    agentConfig: {
      permissionPreset: 'danger-full-access',
      allowHighRiskTools: true,
      tools: ['read', 'write', 'edit', 'pwsh']
    }
  });
  await adapter.execute({ prompt: 'one', sessionKey: 'qq:1', timeoutMs: 5000, taskId: 't1' });
  assert.deepEqual(permissionSets, [{ sessionId: created[0].sessionId, name: 'danger-full-access' }]);
  assert.deepEqual(restrictions, [{ allow: ['read', 'write', 'edit', 'pwsh'] }]);
  assert.equal(policies.at(-1).policy, 'never');

  permissionState.sandbox = 'workspace-write';
  permissionState.approval = 'ask';
  await adapter.execute({ prompt: 'two', sessionKey: 'qq:1', timeoutMs: 5000, taskId: 't2' });
  assert.deepEqual(permissionSets, [
    { sessionId: created[0].sessionId, name: 'danger-full-access' },
    { sessionId: created[0].sessionId, name: 'danger-full-access' }
  ]);
});

test('different session keys never share an agent session', async () => {
  const { adapter, created } = makeFakeCtx();
  await adapter.execute({ prompt: 'a', sessionKey: 'qq:1', timeoutMs: 5000, taskId: 't1' });
  await adapter.execute({ prompt: 'b', sessionKey: 'qq:2', timeoutMs: 5000, taskId: 't2' });
  await adapter.execute({ prompt: 'c', sessionKey: 'qq:1', timeoutMs: 5000, taskId: 't3' });
  assert.equal(created.length, 2);
  assert.notEqual(created[0].sessionId, created[1].sessionId);
});

test('a restart resumes the newest indexable generation instead of creating a duplicate', async () => {
  const first = makeFakeCtx();
  await first.adapter.execute({ prompt: 'one', sessionKey: 'qq:1', timeoutMs: 5000, taskId: 't1' });
  const header = first.created[0].header;
  assert.equal(header.cwd, DEFAULT_CWD);
  await first.adapter.shutdown();

  const second = makeFakeCtx({ storedHeaders: [header] });
  const result = await second.adapter.execute({
    prompt: 'two',
    sessionKey: 'qq:1',
    timeoutMs: 5000,
    taskId: 't2'
  });
  assert.equal(result.text, 'agent reply');
  assert.equal(second.created.length, 0);
  assert.equal(second.resumed.length, 1);
  assert.equal(second.resumed[0].sessionId, header.id);
  assert.deepEqual(second.restrictions, [{ allow: ['read', 'write', 'edit'] }]);
});

test('an archived session is skipped and rebuilt with the next generation', async () => {
  const first = makeFakeCtx();
  await first.adapter.execute({ prompt: 'one', sessionKey: 'qq:1', timeoutMs: 5000, taskId: 't1' });
  const header = first.created[0].header;
  await first.adapter.shutdown();

  const second = makeFakeCtx({ storedHeaders: [header], archived: [header.id] });
  await second.adapter.execute({ prompt: 'two', sessionKey: 'qq:1', timeoutMs: 5000, taskId: 't2' });
  assert.equal(second.resumed.length, 0);
  assert.equal(second.created.length, 1);
  assert.equal(second.created[0].sessionId, `${header.id}-g1`);
  assert.equal(second.created[0].header.cwd, DEFAULT_CWD);
});

test('a cwd-less bridge configuration fails closed before creating a session', async () => {
  const { adapter, created } = makeFakeCtx({ agentConfig: { cwd: null } });
  await assert.rejects(
    () => adapter.execute({ prompt: 'x', sessionKey: 'qq:1', timeoutMs: 5000, taskId: 't-nocwd' }),
    (error) =>
      error.code === 'CONFIG_ERROR' &&
      error.retryable === false &&
      /agent\.cwd is not configured/.test(error.message)
  );
  assert.equal(created.length, 0);
});

test('a transient resume failure is surfaced and never falls back to a new session', async () => {
  const first = makeFakeCtx();
  await first.adapter.execute({ prompt: 'one', sessionKey: 'qq:1', timeoutMs: 5000, taskId: 't1' });
  const header = first.created[0].header;

  const second = makeFakeCtx({ storedHeaders: [header], resumeError: new Error('storage unavailable') });
  await assert.rejects(
    () => second.adapter.execute({ prompt: 'two', sessionKey: 'qq:1', timeoutMs: 5000, taskId: 't2' }),
    (error) => error.code === 'AGENT_ERROR' && /refusing to create a duplicate/.test(error.message)
  );
  assert.equal(second.created.length, 0);
});

test('a session opened elsewhere is reported BUSY without creating a duplicate', async () => {
  const first = makeFakeCtx();
  await first.adapter.execute({ prompt: 'a', sessionKey: 'qq:1', timeoutMs: 5000, taskId: 't1' });
  const sessionId = first.created[0].sessionId;
  const header = first.created[0].header;
  await first.adapter.shutdown();

  const second = makeFakeCtx({ storedHeaders: [header] });
  second.live.set(sessionId, { agent: { session: { id: sessionId } } });

  await assert.rejects(
    () => second.adapter.execute({ prompt: 'b', sessionKey: 'qq:1', timeoutMs: 5000, taskId: 't2' }),
    (error) => error.code === 'BUSY'
  );
  assert.equal(second.created.length, 0);
  assert.equal(second.resumed.length, 0);
});

test('a configured preset is mounted before tools are restricted and recorded in the header', async () => {
  const { adapter, created, restrictions, mounts } = makeFakeCtx({
    presetService: { defaultId: 'standard' },
    agentConfig: { preset: 'standard' }
  });
  await adapter.execute({ prompt: 'hello', sessionKey: 'qq:1', timeoutMs: 5000, taskId: 'task-preset' });
  assert.deepEqual(mounts.map((entry) => entry.id), ['standard']);
  assert.deepEqual(restrictions, [{ allow: ['read', 'write', 'edit'] }]);
  assert.equal(created[0].options.meta.agentPreset, 'standard');
  assert.equal(created[0].header.agentPreset, 'standard');
});

test('a configured preset without a DSH preset service fails closed', async () => {
  const { adapter, created } = makeFakeCtx({ agentConfig: { preset: 'standard' } });
  await assert.rejects(
    () => adapter.execute({ prompt: 'x', sessionKey: 'qq:1', timeoutMs: 5000, taskId: 't-preset' }),
    (error) =>
      error.code === 'CONFIG_ERROR' &&
      error.retryable === false &&
      /no agent preset service/.test(error.message)
  );
  assert.equal(created.length, 0);
});

test('a stored session composed with another preset is replaced, not mutated', async () => {
  const first = makeFakeCtx({
    presetService: { defaultId: 'standard' },
    agentConfig: { preset: 'standard' }
  });
  await first.adapter.execute({ prompt: 'one', sessionKey: 'qq:1', timeoutMs: 5000, taskId: 't1' });
  const header = { ...first.created[0].header, agentPreset: 'minimal' };
  await first.adapter.shutdown();

  const second = makeFakeCtx({
    storedHeaders: [header],
    presetService: { defaultId: 'standard' },
    agentConfig: { preset: 'standard' }
  });
  await second.adapter.execute({ prompt: 'two', sessionKey: 'qq:1', timeoutMs: 5000, taskId: 't2' });
  assert.equal(second.resumed.length, 0);
  assert.equal(second.created.length, 1);
  assert.equal(second.created[0].sessionId, `${header.id}-g1`);
});

test('a stored session without a recorded preset is replaced, not mutated', async () => {
  const first = makeFakeCtx({
    presetService: { defaultId: 'standard' },
    agentConfig: { preset: 'standard' }
  });
  await first.adapter.execute({ prompt: 'one', sessionKey: 'qq:1', timeoutMs: 5000, taskId: 't1' });
  const header = { ...first.created[0].header };
  delete header.agentPreset;
  await first.adapter.shutdown();

  const second = makeFakeCtx({
    storedHeaders: [header],
    presetService: { defaultId: 'standard' },
    agentConfig: { preset: 'standard' }
  });
  await second.adapter.execute({ prompt: 'two', sessionKey: 'qq:1', timeoutMs: 5000, taskId: 't2' });
  assert.equal(second.resumed.length, 0);
  assert.equal(second.created.length, 1);
  assert.equal(second.created[0].sessionId, `${header.id}-g1`);
});

test('a new bridge session gets a stable title instead of the prompt title', async () => {
  const { adapter, created, titles } = makeFakeCtx({
    presetService: { defaultId: 'standard' },
    agentConfig: { preset: 'standard' },
    titleService: {}
  });
  await adapter.execute({ prompt: 'hello', sessionKey: 'qq:42', timeoutMs: 5000, taskId: 't-title' });
  assert.equal(created.length, 1);
  assert.deepEqual(titles, [{ sessionId: created[0].sessionId, title: 'Feiyu Bridge qq:42' }]);
});

test('a successful tool call is executed and its result is returned', async () => {
  const { adapter, created } = makeFakeCtx({
    onAgent: customAgent([
      toolCall(1, 'c1', 'write', { path: 'dafeiyu_first_note.txt', content: 'hello' }),
      toolResult(1, 'c1'),
      assistant(1, 'wrote dafeiyu_first_note.txt')
    ])
  });
  const result = await adapter.execute({
    prompt: 'write the note',
    sessionKey: 'qq:1',
    timeoutMs: 5000,
    taskId: 't-tool'
  });
  assert.equal(result.text, 'wrote dafeiyu_first_note.txt');
  const events = created[0].handle.agent.session.events;
  assert.ok(events.some((event) => event.type === 'tool/call'));
  assert.ok(events.some((event) => event.type === 'tool/result'));
});

test('a failed tool result is surfaced instead of being reported as success', async () => {
  const { adapter } = makeFakeCtx({
    onAgent: customAgent([
      toolCall(1, 'c1', 'write', { path: 'C:/Windows/denied.txt' }),
      toolResult(1, 'c1', { isError: true }),
      assistant(1, 'I could not write the file')
    ])
  });
  await assert.rejects(
    () => adapter.execute({ prompt: 'write', sessionKey: 'qq:1', timeoutMs: 5000, taskId: 't-fail' }),
    (error) =>
      error.code === 'AGENT_ERROR' &&
      error.retryable === true &&
      /tool "write" failed/.test(error.message)
  );
});

test('a tool call without a result is surfaced as an error', async () => {
  const { adapter } = makeFakeCtx({
    onAgent: customAgent([toolCall(1, 'c1', 'write', {}), assistant(1, 'done')])
  });
  await assert.rejects(
    () => adapter.execute({ prompt: 'write', sessionKey: 'qq:1', timeoutMs: 5000, taskId: 't-missing' }),
    (error) => error.code === 'AGENT_ERROR' && /did not return a result/.test(error.message)
  );
});

test('a completed turn with only a successful tool call still reports the call', async () => {
  const { adapter } = makeFakeCtx({
    onAgent: customAgent([toolCall(1, 'c1', 'write', {}), toolResult(1, 'c1')])
  });
  const result = await adapter.execute({
    prompt: 'write silently',
    sessionKey: 'qq:1',
    timeoutMs: 5000,
    taskId: 't-silent'
  });
  assert.equal(result.text, 'Tool call completed: write');
});

test('raw DSML transcript is rejected as a non-executed tool call', async () => {
  const { adapter } = makeFakeCtx({
    onAgent: customAgent([
      assistant(1, '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="bash"><｜｜DSML｜｜ parameter name="command">dir')
    ])
  });
  await assert.rejects(
    () => adapter.execute({ prompt: 'write', sessionKey: 'qq:1', timeoutMs: 5000, taskId: 't-dsml' }),
    (error) =>
      error.code === 'AGENT_ERROR' &&
      error.retryable === false &&
      /unparsed tool-call transcript/.test(error.message)
  );
});

test('an earlier DSML attempt is not hidden by a clean final sentence', async () => {
  const { adapter } = makeFakeCtx({
    onAgent: customAgent([
      assistant(1, '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="write">'),
      assistant(1, 'The note was written.')
    ])
  });
  await assert.rejects(
    () => adapter.execute({ prompt: 'write', sessionKey: 'qq:1', timeoutMs: 5000, taskId: 't-dsml-earlier' }),
    (error) =>
      error.code === 'AGENT_ERROR' &&
      error.retryable === false &&
      /unparsed tool-call transcript/.test(error.message)
  );
});

test('a failed call retried successfully with the same tool is recovered', async () => {
  const { adapter } = makeFakeCtx({
    onAgent: customAgent([
      toolCall(1, 'c1', 'write', {}),
      toolResult(1, 'c1', { isError: true }),
      toolCall(1, 'c2', 'write', {}),
      toolResult(1, 'c2'),
      assistant(1, 'wrote the note on the retry')
    ])
  });
  const result = await adapter.execute({
    prompt: 'retry write',
    sessionKey: 'qq:1',
    timeoutMs: 5000,
    taskId: 't-retry'
  });
  assert.equal(result.text, 'wrote the note on the retry');
});

test('cancelling a running task aborts the bridge agent turn', async () => {
  const idle = deferred();
  const { adapter, created } = makeFakeCtx();
  // Replace followup with one that never completes until cancel() is called.
  const originalCreate = adapter.ctx.agents.create;
  adapter.ctx.agents.create = async (options) => {
    const handle = await originalCreate(options);
    handle.agent.followup = (message) => {
      handle.agent.lastMessage = message;
      handle.agent.whenIdle = () => idle.promise;
      handle.agent.cancel = () => {
        handle.agent.cancelled = true;
        idle.resolve();
      };
    };
    return handle;
  };

  const running = adapter.execute({
    prompt: 'slow',
    sessionKey: 'qq:9',
    timeoutMs: 30000,
    taskId: 'task-cancel'
  });
  await waitFor(() => created.length === 1 && created[0].handle.agent.lastMessage !== undefined, {
    label: 'agent started'
  });
  assert.equal(adapter.cancel('task-cancel', 'cancelled'), true);
  await assert.rejects(running, (error) => error.code === 'TASK_CANCELLED');
  assert.equal(created[0].handle.agent.cancelled, true);
});

test('a blocked turn becomes a non-retryable agent error', async () => {
  const { adapter } = makeFakeCtx({
    onAgent(agent) {
      agent.behaviour = 'blocked';
    }
  });
  await assert.rejects(
    () => adapter.execute({ prompt: 'x', sessionKey: 'qq:3', timeoutMs: 5000, taskId: 't-blocked' }),
    (error) => error.code === 'AGENT_ERROR' && error.retryable === false
  );
});

test('a missing harness import falls back to the documented UserMessage shape', async () => {
  const { adapter, created } = makeFakeCtx({ injectMessageFactory: false });
  const result = await adapter.execute({
    prompt: 'fallback prompt',
    sessionKey: 'qq:7',
    timeoutMs: 5000,
    taskId: 't-fallback'
  });
  const message = created[0].handle.agent.lastMessage;
  assert.match(message.id, /^[0-9a-f-]{36}$/);
  assert.equal(message.role, 'user');
  assert.deepEqual(message.content, [{ type: 'text', text: 'fallback prompt' }]);
  assert.deepEqual(message.source, { kind: 'user' });
  assert.equal(Object.isFrozen(message), true);
  assert.equal(result.text, 'agent reply');
});

test('configured provider/model is passed to agent creation', async () => {
  const { adapter, created } = makeFakeCtx({
    agentConfig: {
      provider: 'deepseek-account',
      model: 'deepseek-flash',
      reasoningEffort: 'low'
    }
  });
  await adapter.execute({ prompt: 'model', sessionKey: 'qq:8', timeoutMs: 5000, taskId: 't-model' });
  assert.deepEqual(created[0].options.agentOptions, {
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    reasoningEffort: 'low'
  });
});
