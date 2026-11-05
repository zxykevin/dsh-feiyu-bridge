/**
 * Real DSH agent adapter.
 *
 * Design decisions:
 * - One dedicated, persistent bridge session per (optional server origin,
 *   session key) hash. `sessionId` is derived from that hash and is namespaced
 *   (`feiyu-bridge-v2-...`) so it can never collide with the old, cwd-less
 *   deployment-test session.
 * - A bridge session always carries an absolute `cwd`, so DSH can index it in a
 *   workspace and it remains visible/resumable after a host restart. A
 *   cwd-less session is refused instead of being recreated silently.
 * - On restart the adapter discovers its own stored sessions by id prefix,
 *   verifies cwd, skips archived/corrupt entries, and only creates a new
 *   generation when the old one is unusable. It never falls through from an
 *   arbitrary resume error to a duplicate session.
 * - Bridge sessions are tool-restricted at setup time (`agentCtx.tools.restrict`)
 *   and their approval policy is forced to `never` (deny everything that would
 *   need a human decision). The session's sandbox is pinned to
 *   `agent.permissionPreset` before every task, so a GUI change cannot silently
 *   widen (or narrow) the boundary for a later remote task. There is no global
 *   change to desktop agents.
 * - A task maps to exactly one `followup` + `whenIdle` cycle; the result is
 *   read from the durable session event log between the pre-task seq and the
 *   end of that turn. A turn that only printed tool-call markup (for example
 *   raw DSML) is a failure, not a successful text result.
 */

import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { BridgeError, ERROR_CODES } from '../core/errors.js';
import { AgentAdapter } from './agent-adapter.js';

const RESULT_GRACE_MS = 15000;
const SESSION_NAMESPACE = 'feiyu-bridge-v2-';
const SESSION_GENERATION_RE = /^(.+)-g(\d+)$/;
const UNPARSED_TOOL_CALL_RE = /[|｜]{2}\s*DSML\s*[|｜]{2}/i;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hashKey(origin, explicit) {
  const originPart =
    typeof origin === 'string'
      ? origin
      : [origin?.platform ?? '', origin?.user_id ?? '', origin?.conversation_id ?? ''].join('\n');
  const raw = [originPart, explicit ?? ''].join('\n');
  return createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

/**
 * Deterministic id for one bridge identity. Generation 0 keeps the short form;
 * rebuilt sessions get a `-gN` suffix so the old log is left untouched.
 * @param {string} key 24 hex chars from {@link hashKey}
 * @param {number} [generation]
 */
export function bridgeSessionId(key, generation = 0) {
  const base = `${SESSION_NAMESPACE}${key}`;
  return generation === 0 ? base : `${base}-g${generation}`;
}

function generationOf(sessionId, key) {
  const base = `${SESSION_NAMESPACE}${key}`;
  if (sessionId === base) return 0;
  if (!sessionId.startsWith(`${base}-g`)) return null;
  const match = SESSION_GENERATION_RE.exec(sessionId);
  if (!match || match[1] !== base) return null;
  const generation = Number(match[2]);
  return Number.isSafeInteger(generation) && generation > 0 ? generation : null;
}

function canonicalCwd(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    return path.win32.resolve(value).replace(/[\\/]+$/, '').toLowerCase();
  } catch {
    return null;
  }
}

function sameCwd(a, b) {
  const left = canonicalCwd(a);
  const right = canonicalCwd(b);
  return left !== null && right !== null && left === right;
}

function titleFor(key, sessionKey) {
  const label = String(sessionKey ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48);
  return `Feiyu Bridge ${label || key.slice(0, 8)}`.slice(0, 72);
}

function textOfMessage(message) {
  const content = message?.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim();
}

function usageOf(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const input = raw.inputTokens ?? raw.input_tokens ?? raw.promptTokens ?? raw.prompt_tokens;
  const output = raw.outputTokens ?? raw.output_tokens ?? raw.completionTokens ?? raw.completion_tokens;
  const out = {};
  if (typeof input === 'number' && Number.isFinite(input)) out.input_tokens = input;
  if (typeof output === 'number' && Number.isFinite(output)) out.output_tokens = output;
  return Object.keys(out).length > 0 ? out : undefined;
}

function errorName(error) {
  return String(error?.name ?? '');
}

function errorMessage(error) {
  return String(error?.message ?? error ?? '');
}

function isNotFound(error) {
  return errorName(error) === 'SessionPersistenceNotFoundError' || /session .* not found/i.test(errorMessage(error));
}

function isCorrupt(error) {
  const name = errorName(error);
  return (
    name === 'SessionPersistenceCorruptionError' ||
    name === 'SessionFormatUnsupportedError' ||
    /corrupt|unsupported session|invalid session header|version must be/i.test(errorMessage(error))
  );
}

function isAlreadyExists(error) {
  return errorName(error) === 'SessionAlreadyExistsError' || /already exists|already registered/i.test(errorMessage(error));
}

function isAlreadyOwned(error) {
  const name = errorName(error);
  return (
    name === 'SessionAlreadyOwnedError' ||
    name === 'SessionReadOnlyError' ||
    /already owned|already registered|writer|read-only/i.test(errorMessage(error))
  );
}

function isUnknownTool(error) {
  return /unknown global tool|tools\.restrict/i.test(errorMessage(error));
}

export class DshAgentAdapter extends AgentAdapter {
  /**
   * @param {{
   *   ctx: object,
   *   config: object,
   *   logger: object,
   *   cwd?: string | null,
   *   createUserMessage?: Function,
   *   setApprovalPolicy?: Function,
   *   now?: () => number
   * }} options
   */
  constructor({ ctx, config, logger, cwd = null, createUserMessage = null, setApprovalPolicy = null, now = Date.now }) {
    super();
    if (!ctx) throw new Error('DshAgentAdapter requires the plugin ctx');
    this.ctx = ctx;
    this.config = config;
    this.logger = logger;
    this.cwd = cwd;
    this.now = now;
    this._createUserMessage = createUserMessage;
    this._setApprovalPolicy = setApprovalPolicy;
    this._toolWarningLogged = false;
    if (config.agent.permissionPreset === 'danger-full-access') {
      logger.warn('bridge agent is configured for danger-full-access; remote tasks can read/write outside agent.cwd', {
        cwd: this.cwd ?? null,
        tools: [...config.agent.tools]
      });
    }
    this.entries = new Map();
    this.pending = new Map();
    this.active = new Map();
    this.disposed = false;
  }

  status() {
    let running = 0;
    for (const entry of this.entries.values()) if (entry.busy) running += 1;
    return {
      sessions: this.entries.size,
      running,
      idle: this.entries.size - running,
      tools: this.config.agent.tools.length,
      tool_names: [...this.config.agent.tools],
      cwd: this.cwd ?? null,
      sandbox: this.config.agent.permissionPreset,
      max_sessions: this.config.agent.maxSessions
    };
  }

  async #messageFactory() {
    if (this._createUserMessage) return this._createUserMessage;
    try {
      const mod = await import('@deepseek-ai/dsh-llm');
      if (typeof mod.createUserMessage !== 'function') throw new Error('createUserMessage missing');
      this._createUserMessage = mod.createUserMessage;
      return this._createUserMessage;
    } catch (error) {
      // Some embedders do not expose harness packages to plugin bare imports.
      // `createUserMessage` is a pure constructor; the equivalent literal keeps
      // the bridge usable instead of failing every task. The shape is the one
      // documented by dsh-llm: {id, role:'user', content, source}.
      this.logger.warn('@deepseek-ai/dsh-llm is not resolvable; using the documented UserMessage shape', {
        reason: String(error?.message ?? error).slice(0, 120)
      });
      this._createUserMessage = ({ content, source }) =>
        Object.freeze({ id: randomUUID(), role: 'user', content, source });
      return this._createUserMessage;
    }
  }

  async #approvalDeny(entry) {
    const session = entry.session;
    // Prefer the pure session helper: it appends the durable policy without
    // injecting a fake user message. Fall back to the service API.
    if (!this._setApprovalPolicy) {
      try {
        const mod = await import('@deepseek-ai/dsh-user-approval');
        if (typeof mod.setApprovalPolicy === 'function') this._setApprovalPolicy = mod.setApprovalPolicy;
      } catch {
        /* fall through to the service */
      }
    }
    if (this._setApprovalPolicy) {
      this._setApprovalPolicy(session, 'never');
      return;
    }
    if (!this.ctx.approval || typeof this.ctx.approval.setPolicy !== 'function') {
      throw new BridgeError(ERROR_CODES.GUARD_UNAVAILABLE, 'DSH approval service is unavailable; refusing to run a bridge task', {
        retryable: false
      });
    }
    this.ctx.approval.setPolicy(entry.agent, 'never');
  }

  #presetService() {
    try {
      const service = this.ctx.agentPresets ?? this.ctx.get?.('agentPresets');
      return service && typeof service.mount === 'function' ? service : null;
    } catch {
      return null;
    }
  }

  #permissionService() {
    try {
      const service = this.ctx.permissionPresets ?? this.ctx.get?.('permissionPresets');
      return service && typeof service.set === 'function' ? service : null;
    } catch {
      return null;
    }
  }

  /**
   * Re-assert the bridge's configured sandbox before every task. A bridge
   * session may be opened in the GUI, where its permission preset can be
   * changed. Tool-name restriction alone does not control the filesystem
   * boundary, so the configured preset is pinned here. When the pin changed
   * the preset, permissionPresets.set() also reset approval to `ask`; the
   * caller must re-apply `never` before the turn starts.
   * @param {object} entry
   * @returns {boolean} whether approval is already pinned to never
   */
  #pinSandbox(entry) {
    const target = this.config.agent.permissionPreset;
    const permissions = this.#permissionService();
    if (!permissions) {
      throw new BridgeError(
        ERROR_CODES.GUARD_UNAVAILABLE,
        `DSH permission presets are unavailable; the bridge cannot pin its ${target} sandbox and refuses to run the task`,
        { retryable: false }
      );
    }
    let state = null;
    try {
      state = permissions.permissionState?.(entry.session) ?? null;
    } catch {
      state = null;
    }
    if (state?.sandbox === target) return state.approval === 'never';
    try {
      permissions.set(entry.session, target);
    } catch (error) {
      throw new BridgeError(
        ERROR_CODES.GUARD_UNAVAILABLE,
        `DSH could not pin the bridge session to ${target}: ${errorMessage(error).slice(0, 200)}`,
        { retryable: false, cause: error }
      );
    }
    return false;
  }

  /**
   * Resolve the DSH agent preset that supplies this agent's tools. File tools
   * are registered inside a preset composition, so the bridge must mount that
   * composition before it can restrict the tool list. Without DSH presets the
   * bridge falls back to the global registry (where only globally enabled
   * tools are visible).
   * @returns {Promise<string | null>}
   */
  async #resolvePreset() {
    const presets = this.#presetService();
    if (!presets) {
      if (this.config.agent.preset) {
        throw new BridgeError(
          ERROR_CODES.CONFIG_ERROR,
          `agent.preset "${this.config.agent.preset}" is configured but DSH exposes no agent preset service`,
          { retryable: false }
        );
      }
      return null;
    }
    try {
      const resolved = await presets.resolve(this.config.agent.preset ?? undefined);
      const id = resolved?.id;
      if (typeof id !== 'string' || id.length === 0) throw new Error('preset resolution returned no id');
      return id;
    } catch (error) {
      throw new BridgeError(ERROR_CODES.CONFIG_ERROR, `bridge agent preset could not be resolved: ${errorMessage(error).slice(0, 240)}`, {
        retryable: false,
        cause: error
      });
    }
  }

  async #setupAgent(agentCtx, presetId) {
    if (presetId) {
      const presets = this.#presetService();
      if (!presets) throw new Error(`agent preset "${presetId}" requires the DSH agentPresets service`);
      // Mount the composition that owns the tools. A root-level restrict()
      // cannot see preset-scoped tools and fails with "unknown global tool".
      await presets.mount(agentCtx, presetId);
    }
    if (!agentCtx.tools || typeof agentCtx.tools.restrict !== 'function') {
      throw new Error('agent context does not expose tools.restrict');
    }
    const allow = [...this.config.agent.tools];
    const undo = agentCtx.tools.restrict({ allow });
    if (typeof undo !== 'function') {
      throw new Error('agent context tools.restrict did not return an undo function');
    }
    agentCtx.effect(() => undo, 'feiyu-bridge.tool-restriction');
  }

  async #listStoredHeaders() {
    const persistence = this.ctx.sessionPersistence;
    if (!persistence || typeof persistence.list !== 'function') {
      throw new BridgeError(
        ERROR_CODES.AGENT_UNAVAILABLE,
        'DSH session persistence is unavailable; refusing to create a bridge session that cannot be restored',
        { retryable: false }
      );
    }
    let snapshots;
    try {
      snapshots = await persistence.list();
    } catch (error) {
      throw new BridgeError(ERROR_CODES.AGENT_UNAVAILABLE, 'DSH session storage could not be inspected', {
        retryable: true,
        cause: error
      });
    }
    if (!Array.isArray(snapshots)) {
      throw new BridgeError(ERROR_CODES.AGENT_UNAVAILABLE, 'DSH session storage returned an unexpected listing', {
        retryable: false
      });
    }
    return snapshots
      .map((snapshot) => snapshot?.header)
      .filter((header) => header && typeof header.id === 'string');
  }

  #isArchived(sessionId) {
    const registry = this.ctx.workspaceRegistry;
    if (!registry) return false;
    try {
      const ids = registry.archivedSessionIds;
      if (ids instanceof Set) return ids.has(sessionId);
      if (Array.isArray(ids)) return ids.includes(sessionId);
    } catch (error) {
      this.logger.warn('could not inspect the DSH archived-session set', {
        reason: errorMessage(error).slice(0, 120)
      });
    }
    return false;
  }

  #assertNotLive(sessionId) {
    const live = this.ctx.agents?.get?.(sessionId);
    if (live) {
      throw new BridgeError(
        ERROR_CODES.BUSY,
        'the bridge session is currently open in DSH; close that session before running QQ tasks',
        { retryable: true }
      );
    }
  }

  /**
   * Resume one known session. Returns null only when the stored session is
   * provably gone or unreadable; every other failure is propagated so the
   * caller cannot silently create a duplicate.
   */
  async #resume(sessionId, presetId) {
    const agentOptions = this.#agentOptions();
    try {
      const handle = await this.ctx.agents.resume({
        resumeSessionId: sessionId,
        ...(agentOptions ? { agentOptions } : {}),
        setup: (agentCtx) => this.#setupAgent(agentCtx, presetId)
      });
      this.logger.info('bridge agent session resumed', { sessionId, cwd: this.cwd });
      return handle;
    } catch (error) {
      if (isNotFound(error) || isCorrupt(error)) {
        this.logger.warn('stored bridge session is gone or unreadable; a new generation will be created', {
          sessionId,
          reason: errorMessage(error).slice(0, 160)
        });
        return null;
      }
      if (isAlreadyOwned(error)) {
        throw new BridgeError(
          ERROR_CODES.BUSY,
          'the bridge session is owned by another DSH writer; close it before running QQ tasks',
          { retryable: true, cause: error }
        );
      }
      if (isUnknownTool(error)) {
        throw new BridgeError(ERROR_CODES.CONFIG_ERROR, `configured bridge tool could not be resolved: ${errorMessage(error).slice(0, 240)}`, {
          retryable: false,
          cause: error
        });
      }
      throw new BridgeError(ERROR_CODES.AGENT_ERROR, 'the existing bridge session could not be resumed; refusing to create a duplicate', {
        retryable: true,
        cause: error
      });
    }
  }

  async #titleSession(session, key, sessionKey) {
    let titles;
    try {
      titles =
        this.ctx.sessionTitle ??
        this.ctx.get?.('sessionTitle') ??
        this.ctx.sessionTitles ??
        this.ctx.get?.('sessionTitles');
    } catch {
      titles = undefined;
    }
    if (!titles || typeof titles.rename !== 'function') return;
    try {
      await titles.rename(session, titleFor(key, sessionKey));
    } catch (error) {
      this.logger.debug('could not set the bridge session title', {
        reason: errorMessage(error).slice(0, 120)
      });
    }
  }

  async #create(sessionId, key, sessionKey, presetId) {
    this.#assertNotLive(sessionId);
    if (this.config.agent.tools.length === 0 && !this._toolWarningLogged) {
      this._toolWarningLogged = true;
      this.logger.warn('bridge agent has no tools; model tool calls cannot execute', { sessionId });
    }
    const agentOptions = this.#agentOptions();
    try {
      const handle = await this.ctx.agents.create({
        sessionId,
        meta: {
          cwd: this.cwd,
          ...(presetId ? { agentPreset: presetId } : {})
        },
        ...(agentOptions ? { agentOptions } : {}),
        setup: (agentCtx) => this.#setupAgent(agentCtx, presetId)
      });
      await this.#titleSession(handle.agent.session, key, sessionKey);
      this.logger.info('bridge agent session created', {
        sessionId,
        cwd: this.cwd,
        tools: this.config.agent.tools.length
      });
      return handle;
    } catch (error) {
      if (isAlreadyExists(error)) {
        // A concurrent host/UI process won the race. Reuse that exact session;
        // never mint a random id.
        const resumed = await this.#resume(sessionId, presetId);
        if (resumed) return resumed;
      }
      if (isAlreadyOwned(error)) {
        throw new BridgeError(
          ERROR_CODES.BUSY,
          'the bridge session is owned by another DSH writer; close it before running QQ tasks',
          { retryable: true, cause: error }
        );
      }
      if (isUnknownTool(error)) {
        throw new BridgeError(ERROR_CODES.CONFIG_ERROR, `configured bridge tool could not be resolved: ${errorMessage(error).slice(0, 240)}`, {
          retryable: false,
          cause: error
        });
      }
      throw new BridgeError(ERROR_CODES.AGENT_ERROR, 'DSH could not create a bridge session', {
        retryable: true,
        cause: error
      });
    }
  }

  async #createHandle(key, sessionKey) {
    if (!this.cwd) {
      throw new BridgeError(
        ERROR_CODES.CONFIG_ERROR,
        'agent.cwd is not configured; the bridge refuses to create a session that DSH cannot index',
        { retryable: false }
      );
    }
    if (!this.#permissionService()) {
      throw new BridgeError(
        ERROR_CODES.GUARD_UNAVAILABLE,
        `DSH permission presets are unavailable; the bridge cannot pin its ${this.config.agent.permissionPreset} sandbox and refuses to create a session`,
        { retryable: false }
      );
    }

    const presetId = await this.#resolvePreset();
    const headers = await this.#listStoredHeaders();
    const all = [];
    for (const header of headers) {
      const generation = generationOf(header.id, key);
      if (generation === null) continue;
      all.push({ id: header.id, generation, cwd: header.cwd, preset: header.agentPreset });
    }

    const usable = all
      .filter((candidate) => sameCwd(candidate.cwd, this.cwd) && !this.#isArchived(candidate.id))
      .sort((a, b) => b.generation - a.generation);

    for (const candidate of usable) {
      // A session created under a different (or unknown) preset may not have
      // the tools the bridge's allow-list names. Keep it untouched and build a
      // new generation instead of mutating a composition the GUI may reopen.
      if (presetId && candidate.preset !== presetId) {
        this.logger.warn('stored bridge session uses another agent preset; creating a new generation', {
          sessionId: candidate.id,
          storedPreset: candidate.preset,
          configuredPreset: presetId
        });
        continue;
      }
      const handle = await this.#resume(candidate.id, presetId);
      if (handle) return handle;
    }

    const nextGeneration = all.length === 0 ? 0 : Math.max(...all.map((candidate) => candidate.generation)) + 1;
    const sessionId = bridgeSessionId(key, nextGeneration);
    return this.#create(sessionId, key, sessionKey, presetId);
  }

  #agentOptions() {
    const { provider, model, reasoningEffort } = this.config.agent;
    if (!provider || !model) return undefined;
    return {
      provider,
      model,
      ...(reasoningEffort ? { reasoningEffort } : {})
    };
  }

  async #ensureEntry(key, origin, sessionKey) {
    const existing = this.entries.get(key);
    if (existing && !existing.disposed) {
      existing.lastUsed = this.now();
      return existing;
    }
    const pending = this.pending.get(key);
    if (pending) return pending;

    const promise = (async () => {
      if (this.disposed) throw new BridgeError(ERROR_CODES.SHUTTING_DOWN, 'bridge agent adapter is shutting down');
      await this.#makeRoom();
      const handle = await this.#createHandle(key, sessionKey);
      const entry = {
        key,
        sessionId: handle.agent.session.id,
        handle,
        agent: handle.agent,
        session: handle.agent.session,
        createdAt: this.now(),
        lastUsed: this.now(),
        busy: false,
        idleTimer: null,
        disposed: false
      };
      try {
        await this.#approvalDeny(entry);
      } catch (error) {
        entry.disposed = true;
        await handle.dispose().catch(() => {});
        throw error;
      }
      this.entries.set(key, entry);
      this.logger.info('bridge agent session ready', {
        sessionKey: key,
        sessionId: entry.sessionId,
        cwd: this.cwd,
        tools: this.config.agent.tools.length
      });
      return entry;
    })();
    this.pending.set(key, promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(key);
    }
  }

  async #makeRoom() {
    if (this.entries.size < this.config.agent.maxSessions) return;
    const idle = [...this.entries.values()]
      .filter((entry) => !entry.busy && !entry.disposed)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const entry of idle) {
      await this.#disposeEntry(entry);
      if (this.entries.size < this.config.agent.maxSessions) return;
    }
    throw new BridgeError(ERROR_CODES.AGENT_UNAVAILABLE, 'too many bridge sessions are busy', { retryable: true });
  }

  async #disposeEntry(entry) {
    if (entry.disposed) return;
    entry.disposed = true;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    this.entries.delete(entry.key);
    try {
      await entry.handle.dispose();
    } catch (error) {
      this.logger.warn('failed to dispose bridge agent session', { sessionKey: entry.key, reason: String(error?.message ?? error).slice(0, 120) });
    }
  }

  #scheduleIdleDispose(entry) {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (this.disposed || this.config.agent.idleDisposeMs <= 0) return;
    entry.idleTimer = setTimeout(() => {
      if (!entry.busy && !entry.disposed) void this.#disposeEntry(entry);
    }, this.config.agent.idleDisposeMs);
    entry.idleTimer.unref?.();
  }

  /**
   * @param {object} request
   * @param {AbortSignal} [signal]
   */
  async execute({ prompt, sessionKey, timeoutMs, origin, taskId }, signal) {
    if (this.disposed) throw new BridgeError(ERROR_CODES.SHUTTING_DOWN, 'bridge agent adapter is shutting down');
    const key = hashKey(origin, sessionKey);
    const entry = await this.#ensureEntry(key, origin, sessionKey);
    if (entry.busy) {
      throw new BridgeError(ERROR_CODES.BUSY, 'bridge agent session is already running a task', { retryable: true });
    }
    entry.busy = true;
    entry.lastUsed = this.now();
    if (entry.idleTimer) clearTimeout(entry.idleTimer);

    const controller = new AbortController();
    const active = { taskId, entry, controller, reason: 'cancelled' };
    this.active.set(taskId, active);
    const onExternalAbort = () => {
      active.reason = signal?.reason === 'timeout' ? 'timeout' : 'cancelled';
      controller.abort(active.reason);
    };
    if (signal) {
      if (signal.aborted) onExternalAbort();
      else signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    try {
      const approvalPinned = this.#pinSandbox(entry);
      if (!approvalPinned) await this.#approvalDeny(entry);
      const response = await this.#run(entry, { prompt, taskId, timeoutMs, abort: controller.signal, active });
      return {
        ...response,
        dshSessionId: entry.sessionId,
        // DSH persists sessions, but it does not expose a restart-resumable
        // execution/turn identifier. Do not manufacture one from taskId.
        executionId: null
      };
    } finally {
      signal?.removeEventListener('abort', onExternalAbort);
      this.active.delete(taskId);
      entry.busy = false;
      entry.lastUsed = this.now();
      this.#scheduleIdleDispose(entry);
    }
  }

  cancel(taskId, reason = 'cancelled') {
    const active = this.active.get(taskId);
    if (!active) return false;
    active.reason = reason === 'timeout' ? 'timeout' : 'cancelled';
    active.controller.abort(active.reason);
    return true;
  }

  async #run(entry, { prompt, taskId, timeoutMs, abort, active }) {
    const session = entry.session;
    const agent = entry.agent;
    if (abort.aborted) throw cancelledOrTimedOut(active.reason);

    const createUserMessage = await this.#messageFactory();
    const startSeq = session.seq;
    const message = createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' }
    });

    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      try {
        agent.cancel({ kind: 'feiyu-bridge', taskId }, { keepInbox: false });
      } catch (error) {
        this.logger.warn('agent.cancel failed', { taskId, reason: String(error?.message ?? error).slice(0, 120) });
      }
    };
    const onAbort = () => stop();
    abort.addEventListener('abort', onAbort, { once: true });

    let hardTimer;
    const hardDeadline = new Promise((_, reject) => {
      hardTimer = setTimeout(() => {
        stop();
        reject(
          new BridgeError(ERROR_CODES.AGENT_ERROR, 'DSH agent did not become idle after cancellation', { retryable: true })
        );
      }, Math.max(1000, timeoutMs) + RESULT_GRACE_MS);
    });

    try {
      if (abort.aborted) throw cancelledOrTimedOut(active.reason);
      agent.followup(message);
      await Promise.race([agent.whenIdle(), hardDeadline]);
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError(ERROR_CODES.AGENT_ERROR, 'DSH agent failed to run the bridge task', {
        retryable: true,
        cause: error
      });
    } finally {
      clearTimeout(hardTimer);
      abort.removeEventListener('abort', onAbort);
    }

    const events = session.snapshotEvents(startSeq);
    return this.#extract(events, { taskId, active, sessionKey: entry.key });
  }

  #extract(events, { taskId, active, sessionKey }) {
    let text = '';
    let turn = null;
    let usage;
    let reason = null;
    let unparsedToolText = false;
    const toolCalls = new Map();
    const toolResults = [];

    for (const event of events) {
      if (event.type === 'assistant/message') {
        const message = event.data?.message;
        const candidate = textOfMessage(message);
        const eventUsage = usageOf(event.data?.usage);
        if (candidate) {
          if (UNPARSED_TOOL_CALL_RE.test(candidate)) unparsedToolText = true;
          text = candidate;
          turn = event.data?.turn ?? turn;
          if (eventUsage) usage = eventUsage;
        }
      } else if (event.type === 'tool/call') {
        const callId = event.data?.callId;
        if (typeof callId === 'string') {
          toolCalls.set(callId, { name: typeof event.data?.name === 'string' ? event.data.name : 'tool' });
        }
      } else if (event.type === 'tool/result') {
        const message = event.data?.message;
        const callId = message?.toolCallId ?? message?.source?.callId ?? event.data?.callId;
        if (typeof callId === 'string') {
          toolResults.push({
            callId,
            isError: message?.isError === true || event.data?.error !== undefined,
            code: event.data?.error?.code
          });
        }
      } else if (event.type === 'turn/end') {
        reason = event.data?.reason ?? null;
        turn = event.data?.turn ?? turn;
      }
    }

    if (active.controller.signal.aborted) throw cancelledOrTimedOut(active.reason);

    if (unparsedToolText) {
      this.logger.warn('bridge model emitted an unparsed tool-call transcript', { taskId });
      throw new BridgeError(
        ERROR_CODES.AGENT_ERROR,
        'the model emitted an unparsed tool-call transcript; no tool was executed (check the bridge tool allow-list and the provider native tool-call support)',
        { retryable: false }
      );
    }

    const failed = toolResults.filter((result) => result.isError);
    // A failed call that was later retried successfully with the same tool is
    // recovered; an unrecovered failure must never be reported as success just
    // because the model wrote a final sentence.
    const unrecovered = failed.filter((result) => {
      const index = toolResults.indexOf(result);
      const name = toolCalls.get(result.callId)?.name;
      return !toolResults
        .slice(index + 1)
        .some((later) => !later.isError && name !== undefined && toolCalls.get(later.callId)?.name === name);
    });
    const missing = [...toolCalls.keys()].filter(
      (callId) => !toolResults.some((result) => result.callId === callId)
    );
    const failure = () => {
      if (unrecovered.length > 0) {
        const first = unrecovered[0];
        const name = toolCalls.get(first.callId)?.name ?? 'tool';
        const code = first.code ? ` (${String(first.code).slice(0, 40)})` : '';
        return new BridgeError(ERROR_CODES.AGENT_ERROR, `tool "${name}" failed${code}; the task produced no usable answer`, {
          retryable: true
        });
      }
      if (missing.length > 0) {
        const name = toolCalls.get(missing[0])?.name ?? 'tool';
        return new BridgeError(ERROR_CODES.AGENT_ERROR, `tool "${name}" did not return a result`, { retryable: true });
      }
      return new BridgeError(ERROR_CODES.AGENT_ERROR, 'DSH agent produced no text result', { retryable: true });
    };

    if (!reason) {
      if (text) {
        if (unrecovered.length > 0 || missing.length > 0) throw failure();
        return { text, sessionKey, turn, usage, truncated: false };
      }
      throw failure();
    }

    switch (reason.kind) {
      case 'completed':
        if (text) {
          if (unrecovered.length > 0 || missing.length > 0) throw failure();
          return { text, sessionKey, turn, usage, truncated: false };
        }
        if (toolCalls.size > 0 && unrecovered.length === 0 && missing.length === 0) {
          return {
            text: `Tool call completed: ${[...toolCalls.values()].map((call) => call.name).join(', ')}`,
            sessionKey,
            turn,
            usage,
            truncated: false
          };
        }
        throw failure();
      case 'max-tokens':
        if (!text || unrecovered.length > 0 || missing.length > 0) throw failure();
        return { text, sessionKey, turn, usage, truncated: true };
      case 'aborted':
        if (active.controller.signal.aborted) throw cancelledOrTimedOut(active.reason);
        throw new BridgeError(ERROR_CODES.AGENT_ERROR, 'DSH agent turn was aborted', { retryable: true });
      case 'blocked':
        throw new BridgeError(
          ERROR_CODES.AGENT_ERROR,
          'DSH agent turn was blocked: it required an approval that the bridge denies',
          { retryable: false }
        );
      case 'error':
        // Never log the raw provider error: it can echo prompt content.
        this.logger.warn('DSH agent turn ended with an error', {
          taskId,
          code: reason.error?.code ?? undefined
        });
        throw new BridgeError(ERROR_CODES.AGENT_ERROR, 'DSH agent turn failed', { retryable: true });
      default:
        throw new BridgeError(ERROR_CODES.AGENT_ERROR, `DSH agent turn ended with "${String(reason.kind)}"`, {
          retryable: true
        });
    }
  }

  async shutdown() {
    this.disposed = true;
    for (const active of this.active.values()) {
      active.reason = 'cancelled';
      active.controller.abort('cancelled');
    }
    this.active.clear();
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.allSettled(entries.map((entry) => this.#disposeEntry(entry)));
    await sleep(0);
  }
}

function cancelledOrTimedOut(reason) {
  if (reason === 'timeout') {
    return new BridgeError(ERROR_CODES.TASK_TIMEOUT, 'task exceeded its timeout', { retryable: true });
  }
  return new BridgeError(ERROR_CODES.TASK_CANCELLED, 'task was cancelled', { retryable: false });
}
