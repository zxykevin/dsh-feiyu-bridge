import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, endpointUrl, resolveConfig, HIGH_RISK_TOOL_RE } from '../../src/config.js';

test('defaults target the AstrBot extension route through the tunnel', () => {
  const cfg = resolveConfig({});
  assert.equal(
    cfg.server.baseUrl,
    'http://127.0.0.1:6185/api/v1/plugins/extensions/astrbot_plugin_feiyu_bridge/'
  );
  assert.equal(
    endpointUrl(cfg, 'v1/heartbeat'),
    'http://127.0.0.1:6185/api/v1/plugins/extensions/astrbot_plugin_feiyu_bridge/v1/heartbeat'
  );
  assert.equal(cfg.auth.clientId, 'windows-dsh');
  assert.equal(cfg.auth.bridgeSecret, null);
  assert.equal(cfg.auth.apiKey, null);
  assert.deepEqual(cfg.agent.tools, ['read', 'write', 'edit']);
});

test('unknown keys are rejected', () => {
  assert.throws(() => resolveConfig({ nope: true }), /unknown option/);
  assert.throws(() => resolveConfig({ server: { nope: 1 } }), /unknown option/);
  assert.throws(() => resolveConfig({ auth: { token: 'x' } }), /unknown option/);
});

test('non-loopback endpoints require an explicit opt-in', () => {
  assert.throws(() => resolveConfig({ server: { baseUrl: 'http://10.0.0.5:6185/' } }), /not loopback/);
  const cfg = resolveConfig({ server: { baseUrl: 'https://bridge.example.test/', allowNonLoopback: true } });
  assert.equal(cfg.server.baseUrl, 'https://bridge.example.test/');
});

test('base URL rejects credentials, query strings and non-http schemes', () => {
  assert.throws(() => resolveConfig({ server: { baseUrl: 'http://user:pass@127.0.0.1:6185/' } }), /credentials/);
  assert.throws(() => resolveConfig({ server: { baseUrl: 'http://127.0.0.1:6185/?x=1' } }), /query/);
  assert.throws(() => resolveConfig({ server: { baseUrl: 'file:///C:/bridge/' } }), /http\/https/);
});

test('high-risk tools are refused unless explicitly acknowledged', () => {
  assert.match('pwsh', HIGH_RISK_TOOL_RE);
  assert.throws(() => resolveConfig({ agent: { tools: ['pwsh'] } }), /high-risk/);
  const cfg = resolveConfig({ agent: { tools: ['pwsh'], allowHighRiskTools: true } });
  assert.deepEqual(cfg.agent.tools, ['pwsh']);
});

test('workspace-scoped file tools are the default; high-risk tools stay denied', () => {
  assert.deepEqual(DEFAULTS.agent.tools, ['read', 'write', 'edit']);
  assert.equal(DEFAULTS.agent.allowHighRiskTools, false);
  assert.equal(DEFAULTS.capabilities.workflowRun.requireSessionKey, true);
});

test('heartbeat, lease and reconnect boundaries are validated', () => {
  assert.throws(() => resolveConfig({ runtime: { heartbeatIntervalMs: 4999 } }), /5000\.\.10000/);
  assert.throws(() => resolveConfig({ runtime: { heartbeatIntervalMs: 10001 } }), /5000\.\.10000/);
  assert.throws(() => resolveConfig({ server: { leaseWaitSeconds: 26 } }), /0\.\.25/);
  assert.throws(() => resolveConfig({ runtime: { reconnectMaxMs: 500 } }), /1000\.\.600000/);
});

test('prompt and secret limits are validated', () => {
  assert.throws(
    () => resolveConfig({ capabilities: { workflowRun: { maxPromptChars: 0 } } }),
    /1\.\.64000/
  );
  assert.throws(() => resolveConfig({ auth: { bridgeSecret: 'short' } }), /32\.\.4096/);
  assert.throws(() => resolveConfig({ auth: { apiKey: 'tiny' } }), /8\.\.4096/);
  assert.throws(
    () => resolveConfig({ limits: { resultBytes: 4096, responseBytes: 1024 } }),
    /must not exceed responseBytes/
  );
});

test('agent cwd must be absolute or null', () => {
  assert.throws(() => resolveConfig({ agent: { cwd: 'relative/path' } }), /absolute Windows path/);
  assert.equal(resolveConfig({ agent: { cwd: 'C:\\work' } }).agent.cwd, 'C:\\work');
});

test('permission preset defaults to workspace-write and is explicitly validated', () => {
  assert.equal(resolveConfig({}).agent.permissionPreset, 'workspace-write');
  assert.equal(
    resolveConfig({ agent: { permissionPreset: 'danger-full-access' } }).agent.permissionPreset,
    'danger-full-access'
  );
  assert.throws(
    () => resolveConfig({ agent: { permissionPreset: 'read-only' } }),
    /expected one of workspace-write, danger-full-access/
  );
});

test('agent model routing is optional but must be complete', () => {
  assert.equal(resolveConfig({}).agent.provider, null);
  const cfg = resolveConfig({
    agent: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'low' }
  });
  assert.equal(cfg.agent.provider, 'deepseek-account');
  assert.equal(cfg.agent.model, 'deepseek-flash');
  assert.equal(cfg.agent.reasoningEffort, 'low');
  assert.throws(() => resolveConfig({ agent: { provider: 'deepseek-account' } }), /together/);
  assert.throws(() => resolveConfig({ agent: { model: 'deepseek-flash' } }), /together/);
  assert.throws(
    () => resolveConfig({ agent: { reasoningEffort: 'high' } }),
    /requires provider and model/
  );
});
