/**
 * Agent adapter interface. The dispatcher only knows this shape, so tests can
 * swap in a scripted fake and the real implementation can evolve with DSH.
 */

export class AgentAdapter {
  /**
   * @returns {{sessions: number, running: number, idle?: number, tools?: number}}
   */
  status() {
    return { sessions: 0, running: 0 };
  }

  /**
   * @param {{action: string, prompt: string, sessionKey: string, timeoutMs: number, origin: object|null, taskId: string, requestId: string}} request
   * @returns {Promise<{text: string, sessionKey: string, turn: number|null, usage?: object, truncated?: boolean}>}
   */
  async execute(request) {
    throw new Error('not implemented');
  }

  /** @param {string} taskId */
  cancel(taskId) {}

  async shutdown() {}
}
