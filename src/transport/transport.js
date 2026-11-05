/**
 * Transport abstraction. V1 ships HTTP long-polling over the existing SSH
 * tunnel; WebSocket can be added later behind the same interface.
 *
 * A transport owns HTTP concerns (signing, timeouts, body limits, envelope
 * parsing) but not scheduling, retries, or task execution.
 */

export class Transport {
  /** @returns {string} */
  get name() {
    throw new Error('not implemented');
  }

  /**
   * Lease at most one task. The server allows a single active task.
   * @param {{waitSeconds: number, signal?: AbortSignal}} request
   * @returns {Promise<{task: object|null, serverTime?: number}>}
   */
  async lease(request) {
    throw new Error('not implemented');
  }

  /**
   * Report liveness and current state.
   * @param {{agentVersion: string, capabilities: string[], activeTaskId: string|null, pendingTaskIds?: string[], signal?: AbortSignal}} state
   * @returns {Promise<object>} server body status + cancel_requested
   */
  async heartbeat(state) {
    throw new Error('not implemented');
  }

  /**
   * Deliver the terminal result of a leased task.
   * @param {string} taskId
   * @param {{status: string, result?: unknown, error?: unknown}} payload
   * @param {{signal?: AbortSignal}} [options]
   * @returns {Promise<object>}
   */
  async submitResult(taskId, payload, options) {
    throw new Error('not implemented');
  }

  /**
   * Acknowledge a cancellation/timeout so the server can release its slot.
   * @param {string} taskId
   * @param {{signal?: AbortSignal}} [options]
   * @returns {Promise<object>}
   */
  async acknowledgeCancelled(taskId, options) {
    throw new Error('not implemented');
  }

  /**
   * Read server-side body status (authenticated read-only probe).
   * @param {{signal?: AbortSignal}} [options]
   * @returns {Promise<object>}
   */
  async getStatus(options) {
    throw new Error('not implemented');
  }

  /**
   * Read one task (without arguments) for diagnostics.
   * @param {string} taskId
   * @param {{signal?: AbortSignal}} [options]
   * @returns {Promise<object>}
   */
  async getTask(taskId, options) {
    throw new Error('not implemented');
  }

  /** Release resources. */
  async close() {}
}
