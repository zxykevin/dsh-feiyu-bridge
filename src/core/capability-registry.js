/**
 * Capability registry. Capabilities are the only entry points a remote task can
 * reach; anything not registered here is rejected before any agent or tool is
 * touched.
 */

import { BridgeError, ERROR_CODES } from './errors.js';
import { statusRead } from '../capabilities/status-read.js';
import { workflowRun } from '../capabilities/workflow-run.js';

export const CAPABILITY_NAMES = Object.freeze({
  STATUS_READ: 'dsh.status.read',
  WORKFLOW_RUN: 'dsh.workflow.run'
});

export function createCapabilityRegistry({ config, logger }) {
  const handlers = new Map();

  if (config.capabilities.statusRead) {
    handlers.set(CAPABILITY_NAMES.STATUS_READ, {
      description: 'Read DSH online state, agent state, and enabled capabilities (no computer actions)',
      handle: statusRead
    });
  }
  if (config.capabilities.workflowRun.enabled) {
    handlers.set(CAPABILITY_NAMES.WORKFLOW_RUN, {
      description: 'Run a prompt through the dedicated, tool-restricted bridge agent session',
      handle: workflowRun
    });
  }

  return {
    /** @returns {string[]} enabled capability names */
    names() {
      return [...handlers.keys()];
    },
    /** @returns {object[]} descriptors for status output */
    describe() {
      return [...handlers.entries()].map(([name, entry]) => ({ name, description: entry.description }));
    },
    has(name) {
      return handlers.has(name);
    },
    /**
     * @param {string} name
     * @param {object} task validated task
     * @param {object} context execution context
     * @returns {Promise<object>} capability result
     */
    async execute(name, task, context) {
      const entry = handlers.get(name);
      if (!entry) {
        throw new BridgeError(ERROR_CODES.CAPABILITY_DENIED, `capability "${name}" is not enabled on this device`, {
          retryable: false
        });
      }
      const started = Date.now();
      try {
        const result = await entry.handle({ task, config, logger, ...context });
        logger.debug('capability completed', { capability: name, taskId: task.taskId, durationMs: Date.now() - started });
        return result;
      } catch (error) {
        if (error instanceof BridgeError) throw error;
        throw new BridgeError(ERROR_CODES.INTERNAL_ERROR, `capability "${name}" failed`, { retryable: true, cause: error });
      }
    }
  };
}
