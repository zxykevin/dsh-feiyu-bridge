/**
 * `dsh.status.read` capability: report whether this Windows body is online and
 * what it can do. This never invokes the agent, tools, shell, or filesystem.
 */

import { PROTOCOL_ID } from '../core/protocol.js';

export async function statusRead({ runtime }) {
  const startedAt = runtime.startedAt ?? Date.now();
  return {
    online: true,
    protocol: PROTOCOL_ID,
    plugin: { name: 'dsh-feiyu-bridge', version: '0.4.0' },
    client_id: runtime.config.auth.clientId,
    uptime_ms: Date.now() - startedAt,
    started_at: new Date(startedAt).toISOString(),
    transport: runtime.transportStatus(),
    agent: runtime.agent?.status?.() ?? { sessions: 0, running: 0 },
    capabilities: runtime.capabilities.describe().map((entry) => ({ name: entry.name, enabled: true })),
    limits: {
      max_prompt_chars: runtime.config.capabilities.workflowRun.maxPromptChars,
      max_concurrent: 1
    }
  };
}
