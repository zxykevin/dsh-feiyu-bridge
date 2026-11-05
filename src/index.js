/**
 * Cordis entry point for dsh-feiyu-bridge.
 *
 * The plugin owns one outbound HTTP client to the AstrBot Feiyu Bridge. It
 * never listens on a port and never calls the local GUI. Tasks are executed by
 * dedicated bridge agent sessions created through `ctx.agents`.
 */

import { resolveConfig, describeConfig } from './config.js';
import { createLogger } from './core/log.js';
import { BridgeCredentials } from './core/auth.js';
import { HttpTransport } from './transport/http-longpoll.js';
import { DshAgentAdapter } from './agent/dsh-agent-adapter.js';
import { createCapabilityRegistry } from './core/capability-registry.js';
import { BridgeRuntime } from './runtime.js';

export const name = 'dsh-feiyu-bridge';
export const inject = ['agents', 'tools', 'approval', 'credentials', 'sessionPersistence', 'workspaceRegistry', 'agentPresets', 'sessionTitle', 'permissionPresets'];

let Config;
try {
  const { default: Schema } = await import('@deepseek-ai/schemastery');
  Config = Schema.any().description(
    'Feiyu Bridge client settings. See docs/CONFIGURATION.md; secrets live in .credentials.yaml or the environment, not here.'
  );
} catch {
  // Schemastery is provided by the harness at runtime; when it is unavailable
  // (plain Node tests) the plugin still loads with JSON config.
  Config = undefined;
}
export { Config };

function loggerSink(ctx) {
  const source = ctx.logger ?? console;
  const bind = (method) =>
    typeof source[method] === 'function' ? source[method].bind(source) : console[method].bind(console);
  return {
    error: bind('error'),
    warn: bind('warn'),
    info: bind('info'),
    debug: bind('debug')
  };
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [rawConfig]
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig ?? {});
  const logger = createLogger(config.logging.level, loggerSink(ctx));

  logger.info('feiyu bridge plugin loading', describeConfig(config));

  const credentials = new BridgeCredentials({
    config,
    credentials: ctx.credentials,
    logger
  });

  const transport = new HttpTransport({ config, credentials, logger });

  const agent = new DshAgentAdapter({
    ctx,
    config,
    logger,
    cwd: config.agent.cwd
  });

  const capabilities = createCapabilityRegistry({ config, logger });

  const runtime = new BridgeRuntime({
    config,
    logger,
    transport,
    agent,
    capabilities
  });

  ctx.effect(() => {
    runtime.start();
    return () => runtime.stop();
  }, 'feiyu-bridge.runtime');
}
