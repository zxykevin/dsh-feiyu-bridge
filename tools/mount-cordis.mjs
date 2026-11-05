/**
 * Isolated Cordis mount smoke test.
 *
 * Runs under `ELECTRON_RUN_AS_NODE=1` so the real Cordis runtime shipped with
 * DSH can be imported from app.asar. It does not start the GUI, does not read
 * the desktop profile, and does not install anything.
 *
 *   $env:ELECTRON_RUN_AS_NODE='1'; & '<DSH_INSTALL>\DeepSeek Harness.exe' tools\mount-cordis.mjs
 *
 * The install directory defaults to the directory containing the running
 * Electron binary. Override it with `DSH_INSTALL_HOME` when needed.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DSH_HOME = process.env.DSH_INSTALL_HOME ?? path.dirname(process.execPath);
const CORDIS = pathToFileURL(path.join(
  DSH_HOME,
  'resources',
  'app.asar',
  'dsh',
  'node_modules',
  '@deepseek-ai',
  'cordis',
  'lib',
  'index.js'
)).href;

const { Context } = await import(CORDIS);
const bridge = await import('../src/index.js');

const logs = [];
const ctx = new Context();
ctx.provide('credentials', {
  async resolve(ref) {
    if (ref === 'FEIYU_ASTRBOT_API_KEY') return { value: 'abk_mount_test_12345678', source: 'test' };
    if (ref === 'FEIYU_BRIDGE_SECRET') return { value: '0123456789abcdef0123456789abcdef', source: 'test' };
    return undefined;
  }
});
ctx.provide('agents', {
  get() {
    return undefined;
  },
  async create() {
    throw new Error('mount test must not create an agent');
  },
  async resume() {
    throw new Error('mount test must not resume an agent');
  }
});
ctx.provide('tools', { restrict: () => () => {} });
ctx.provide('approval', { setPolicy() {} });
ctx.provide('sessionPersistence', {
  async list() {
    return [];
  }
});
ctx.provide('workspaceRegistry', { archivedSessionIds: new Set() });
ctx.provide('agentPresets', {
  async resolve(id) {
    return { id: id ?? 'standard' };
  },
  async mount() {
    return { id: 'standard' };
  }
});
ctx.provide('sessionTitle', { rename() {} });
ctx.provide('permissionPresets', {
  permissionState() {
    return { preset: 'workspace-write', sandbox: 'workspace-write', approval: 'never', seeded: true };
  },
  set() {}
});

ctx.plugin(bridge, {
  server: {
    baseUrl: 'http://127.0.0.1:1/api/v1/plugins/extensions/astrbot_plugin_feiyu_bridge/',
    requestTimeoutMs: 500
  },
  runtime: { heartbeatIntervalMs: 5000, reconnectInitialMs: 1000, reconnectMaxMs: 1000 },
  logging: { level: 'error' }
});

await new Promise((resolve) => setTimeout(resolve, 400));

const effects = typeof ctx.effect === 'function';
console.log(JSON.stringify({ mounted: true, name: bridge.name, inject: bridge.inject, effects }));
process.exit(0);
