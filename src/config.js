/**
 * Configuration defaults and strict validation for dsh-feiyu-bridge.
 *
 * The bridge is workspace-scoped by default: a bridge agent gets the DSH file
 * tools that operate inside `agent.cwd` (`read`, `write`, `edit`), while shell,
 * network, browser and arbitrary-code tools stay denied unless the operator
 * explicitly opts in. The approval policy is hard-coded to
 * "never" (in DSH that means "reject every approval-requiring action", not
 * "auto-approve").
 *
 * `agent.permissionPreset` is pinned on every task and defaults to
 * `workspace-write`. An operator can explicitly opt the Bridge into
 * `danger-full-access`; that removes the filesystem boundary for the whole
 * Windows account and should only be used when the VPS is fully trusted.
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const PERMISSION_PRESETS = new Set(['workspace-write', 'danger-full-access']);

/**
 * Tools that can execute arbitrary code, touch the filesystem, or leave the
 * machine. They stay disabled unless the operator explicitly opts in with
 * `agent.allowHighRiskTools: true`.
 */
const HIGH_RISK_TOOL_RE =
  /^(run_code|pwsh|bash|shell|terminal|fs|fs_search|fs_write|str_replace_editor|read_file|write_file|subagent|workflow|mcp|schedule|jobs|ssh|cmd|web|browser|computer|screenshot|present)$/i;

export const DEFAULTS = Object.freeze({
  server: {
    // AstrBot's external extension route, reached through the existing SSH
    // tunnel (local 6185 -> VPS AstrBot 6185).
    baseUrl: 'http://127.0.0.1:6185/api/v1/plugins/extensions/astrbot_plugin_feiyu_bridge/',
    allowNonLoopback: false,
    requestTimeoutMs: 15000,
    leaseWaitSeconds: 20
  },
  auth: {
    clientId: 'windows-dsh',
    bridgeSecretRef: 'FEIYU_BRIDGE_SECRET',
    apiKeyRef: 'FEIYU_ASTRBOT_API_KEY',
    // Development-only plaintext fallbacks. Prefer the credential refs above.
    bridgeSecret: null,
    apiKey: null
  },
  runtime: {
    heartbeatIntervalMs: 7000,
    queueSize: 1,
    resultRetryMs: 2000,
    resultRetryMax: 8,
    pendingResultTtlMs: 600000,
    pendingResultMax: 50,
    reconnectInitialMs: 1000,
    reconnectMaxMs: 30000,
    reconnectFactor: 2
  },
  limits: {
    // Server default max_payload_bytes is 262144; keep the client at or below.
    payloadBytes: 262144,
    resultBytes: 262144,
    responseBytes: 1048576
  },
  tasks: {
    defaultTimeoutMs: 30000,
    // Async Bridge tasks may legitimately outlive the old 300-second request
    // window. The server deadline and per-task timeout remain authoritative.
    maxTimeoutMs: 86400000,
    idempotencyTtlMs: 600000
  },
  capabilities: {
    statusRead: true,
    workflowRun: {
      enabled: true,
      maxPromptChars: 8000,
      // A per-QQ-user session key is the only context isolation the protocol
      // offers, so require it rather than silently sharing a default session.
      requireSessionKey: true
    }
  },
  agent: {
    // A bridge session needs a real workspace: a cwd-less session is not
    // indexed by DSH and cannot be reopened from the GUI after a restart.
    cwd: null,
    // Workspace-scoped file tools only. `pwsh`, `bash`, `web`, `mcp` and the
    // other high-risk names remain opt-in via allowHighRiskTools.
    tools: ['read', 'write', 'edit'],
    // DSH file tools live inside an agent preset, not the global tool
    // registry. `null` uses DSH's default preset; set an explicit id when a
    // profile has no default.
    preset: null,
    // Pinned before every task regardless of the GUI's permission selector.
    // `danger-full-access` is an explicit, high-risk opt-in: the agent can
    // then read/write outside `cwd` (and use high-risk tools if allowlisted).
    permissionPreset: 'workspace-write',
    allowHighRiskTools: false,
    provider: null,
    model: null,
    reasoningEffort: null,
    idleDisposeMs: 1800000,
    maxSessions: 64
  },
  logging: {
    level: 'info'
  }
});

const TOP_KEYS = new Set(Object.keys(DEFAULTS));
const LOG_LEVELS = new Set(['silent', 'error', 'warn', 'info', 'debug']);

function fail(path, message) {
  throw new Error(`[dsh-feiyu-bridge] invalid config at ${path}: ${message}`);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function merge(base, patch, path) {
  if (patch === undefined) return clone(base);
  if (!isPlainObject(patch)) fail(path, 'expected an object');
  const out = clone(base);
  for (const key of Object.keys(patch)) {
    if (!(key in base)) fail(`${path}.${key}`, 'unknown option');
    const value = patch[key];
    if (value === undefined) continue;
    const baseValue = base[key];
    if (isPlainObject(baseValue)) {
      out[key] = merge(baseValue, value, `${path}.${key}`);
    } else {
      out[key] = clone(value);
    }
  }
  return out;
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value)) out[key] = clone(value[key]);
    return out;
  }
  return value;
}

function int(value, path, min, max) {
  if (!Number.isInteger(value)) fail(path, 'expected an integer');
  if (value < min || value > max) fail(path, `expected ${min}..${max}, got ${value}`);
  return value;
}

function num(value, path, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'expected a finite number');
  if (value < min || value > max) fail(path, `expected ${min}..${max}, got ${value}`);
  return value;
}

function bool(value, path) {
  if (typeof value !== 'boolean') fail(path, 'expected a boolean');
  return value;
}

function text(value, path, { min = 1, max = 2048, pattern } = {}) {
  if (typeof value !== 'string') fail(path, 'expected a string');
  if (value.length < min || value.length > max) fail(path, `expected length ${min}..${max}`);
  if (pattern && !pattern.test(value)) fail(path, `invalid value "${value}"`);
  return value;
}

function nullableText(value, path, opts) {
  if (value === null) return null;
  return text(value, path, opts);
}

function normalizeBaseUrl(value, path) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(path, 'not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') fail(path, 'only http/https are allowed');
  if (url.username || url.password) fail(path, 'credentials in the URL are not allowed');
  if (url.search || url.hash) fail(path, 'query/hash are not allowed in the base URL');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.toString();
}

function ensureLoopback(baseUrl, allowNonLoopback, path) {
  const host = new URL(baseUrl).hostname;
  if (!LOOPBACK_HOSTS.has(host) && !allowNonLoopback) {
    fail(
      path,
      `host "${host}" is not loopback; set server.allowNonLoopback=true only if you really intend to talk to a remote endpoint`
    );
  }
}

/**
 * Merge user config over defaults and validate every value that affects
 * security or resource usage.
 * @param {unknown} input raw plugin config
 * @returns {object} normalized config
 */
export function resolveConfig(input) {
  if (input !== undefined && !isPlainObject(input)) fail('config', 'expected an object');
  const cfg = merge(DEFAULTS, input ?? {}, 'config');

  for (const key of Object.keys(cfg)) if (!TOP_KEYS.has(key)) fail(key, 'unknown option');

  cfg.server.baseUrl = normalizeBaseUrl(cfg.server.baseUrl, 'server.baseUrl');
  ensureLoopback(cfg.server.baseUrl, cfg.server.allowNonLoopback, 'server.baseUrl');
  cfg.server.allowNonLoopback = bool(cfg.server.allowNonLoopback, 'server.allowNonLoopback');
  int(cfg.server.requestTimeoutMs, 'server.requestTimeoutMs', 1000, 120000);
  int(cfg.server.leaseWaitSeconds, 'server.leaseWaitSeconds', 0, 25);

  cfg.auth.clientId = text(cfg.auth.clientId, 'auth.clientId', {
    max: 64,
    pattern: /^[A-Za-z0-9._:-]+$/
  });
  cfg.auth.bridgeSecretRef = text(cfg.auth.bridgeSecretRef, 'auth.bridgeSecretRef', {
    max: 128,
    pattern: /^[A-Za-z_][A-Za-z0-9_.-]*$/
  });
  cfg.auth.apiKeyRef = text(cfg.auth.apiKeyRef, 'auth.apiKeyRef', {
    max: 128,
    pattern: /^[A-Za-z_][A-Za-z0-9_.-]*$/
  });
  cfg.auth.bridgeSecret = nullableText(cfg.auth.bridgeSecret, 'auth.bridgeSecret', { min: 32, max: 4096 });
  cfg.auth.apiKey = nullableText(cfg.auth.apiKey, 'auth.apiKey', { min: 8, max: 4096 });

  int(cfg.runtime.heartbeatIntervalMs, 'runtime.heartbeatIntervalMs', 5000, 10000);
  int(cfg.runtime.queueSize, 'runtime.queueSize', 1, 256);
  int(cfg.runtime.resultRetryMs, 'runtime.resultRetryMs', 100, 60000);
  int(cfg.runtime.resultRetryMax, 'runtime.resultRetryMax', 0, 100);
  int(cfg.runtime.pendingResultTtlMs, 'runtime.pendingResultTtlMs', 1000, 3600000);
  int(cfg.runtime.pendingResultMax, 'runtime.pendingResultMax', 1, 1000);
  int(cfg.runtime.reconnectInitialMs, 'runtime.reconnectInitialMs', 100, 60000);
  int(cfg.runtime.reconnectMaxMs, 'runtime.reconnectMaxMs', 1000, 600000);
  num(cfg.runtime.reconnectFactor, 'runtime.reconnectFactor', 1.1, 10);
  if (cfg.runtime.reconnectInitialMs > cfg.runtime.reconnectMaxMs) {
    fail('runtime.reconnectInitialMs', 'must not exceed reconnectMaxMs');
  }

  int(cfg.limits.payloadBytes, 'limits.payloadBytes', 1024, 8 * 1024 * 1024);
  int(cfg.limits.resultBytes, 'limits.resultBytes', 1024, 8 * 1024 * 1024);
  int(cfg.limits.responseBytes, 'limits.responseBytes', 1024, 32 * 1024 * 1024);
  if (cfg.limits.resultBytes > cfg.limits.responseBytes) fail('limits.resultBytes', 'must not exceed responseBytes');

  int(cfg.tasks.defaultTimeoutMs, 'tasks.defaultTimeoutMs', 1000, 3600000);
  int(cfg.tasks.maxTimeoutMs, 'tasks.maxTimeoutMs', 1000, 86400000);
  if (cfg.tasks.defaultTimeoutMs > cfg.tasks.maxTimeoutMs) fail('tasks.defaultTimeoutMs', 'must not exceed maxTimeoutMs');
  int(cfg.tasks.idempotencyTtlMs, 'tasks.idempotencyTtlMs', 1000, 86400000);

  bool(cfg.capabilities.statusRead, 'capabilities.statusRead');
  bool(cfg.capabilities.workflowRun.enabled, 'capabilities.workflowRun.enabled');
  int(cfg.capabilities.workflowRun.maxPromptChars, 'capabilities.workflowRun.maxPromptChars', 1, 64000);
  bool(cfg.capabilities.workflowRun.requireSessionKey, 'capabilities.workflowRun.requireSessionKey');

  cfg.agent.cwd = nullableText(cfg.agent.cwd, 'agent.cwd', { min: 1, max: 1024 });
  if (cfg.agent.cwd !== null && !/^[A-Za-z]:[\\/]|^\\\\/.test(cfg.agent.cwd)) {
    fail('agent.cwd', 'must be an absolute Windows path or null');
  }
  if (!Array.isArray(cfg.agent.tools)) fail('agent.tools', 'expected an array');
  cfg.agent.tools = cfg.agent.tools.map((tool, i) => text(tool, `agent.tools[${i}]`, { max: 128 }));
  if (new Set(cfg.agent.tools).size !== cfg.agent.tools.length) fail('agent.tools', 'contains duplicates');
  cfg.agent.allowHighRiskTools = bool(cfg.agent.allowHighRiskTools, 'agent.allowHighRiskTools');
  cfg.agent.preset = nullableText(cfg.agent.preset, 'agent.preset', { max: 64 });
  cfg.agent.permissionPreset = text(cfg.agent.permissionPreset, 'agent.permissionPreset', { max: 32 });
  if (!PERMISSION_PRESETS.has(cfg.agent.permissionPreset)) {
    fail('agent.permissionPreset', `expected one of ${[...PERMISSION_PRESETS].join(', ')}`);
  }
  if (!cfg.agent.allowHighRiskTools) {
    for (const tool of cfg.agent.tools) {
      if (HIGH_RISK_TOOL_RE.test(tool) || /sandbox|exec|spawn|process|net/i.test(tool)) {
        fail('agent.tools', `tool "${tool}" is high-risk; set agent.allowHighRiskTools=true to acknowledge the risk`);
      }
    }
  }
  cfg.agent.provider = nullableText(cfg.agent.provider, 'agent.provider', { max: 128 });
  cfg.agent.model = nullableText(cfg.agent.model, 'agent.model', { max: 256 });
  cfg.agent.reasoningEffort = nullableText(cfg.agent.reasoningEffort, 'agent.reasoningEffort', {
    max: 32
  });
  if ((cfg.agent.provider === null) !== (cfg.agent.model === null)) {
    fail('agent.provider', 'provider and model must be configured together');
  }
  if (cfg.agent.reasoningEffort !== null && cfg.agent.provider === null) {
    fail('agent.reasoningEffort', 'reasoningEffort requires provider and model');
  }
  int(cfg.agent.idleDisposeMs, 'agent.idleDisposeMs', 60000, 86400000);
  int(cfg.agent.maxSessions, 'agent.maxSessions', 1, 512);

  if (!LOG_LEVELS.has(cfg.logging.level)) fail('logging.level', `expected one of ${[...LOG_LEVELS].join(', ')}`);

  return cfg;
}

/**
 * Resolve an endpoint URL relative to the configured AstrBot mount.
 * @param {object} cfg normalized config
 * @param {string} relativePath e.g. "v1/heartbeat"
 * @returns {string} absolute URL
 */
export function endpointUrl(cfg, relativePath) {
  return new URL(relativePath, cfg.server.baseUrl).toString();
}

/**
 * Provide a redacted view for diagnostics.
 * @param {object} cfg normalized config
 * @returns {object} config copy without secrets
 */
export function describeConfig(cfg) {
  return {
    ...clone(cfg),
    auth: {
      ...clone(cfg.auth),
      bridgeSecret: cfg.auth.bridgeSecret ? '***' : null,
      apiKey: cfg.auth.apiKey ? '***' : null
    }
  };
}

export { HIGH_RISK_TOOL_RE };
