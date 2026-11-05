/**
 * Structured bridge errors.
 *
 * Codes are split in two groups:
 * - UPPER_SNAKE codes mirror the Feiyu Bridge protocol error codes and may be
 *   sent to the VPS inside `result.error` / `error` envelopes.
 * - Local transport failures are represented by the same type so callers only
 *   have to deal with one error class.
 *
 * A message must never contain prompts, results, API keys or other secrets.
 */

export const ERROR_CODES = Object.freeze({
  // Protocol / server codes we may receive.
  AUTH_CLIENT_REJECTED: 'AUTH_CLIENT_REJECTED',
  AUTH_INVALID_SIGNATURE: 'AUTH_INVALID_SIGNATURE',
  AUTH_TIMESTAMP_EXPIRED: 'AUTH_TIMESTAMP_EXPIRED',
  AUTH_REPLAY: 'AUTH_REPLAY',
  AUTH_INVALID_NONCE: 'AUTH_INVALID_NONCE',
  AUTH_INVALID_TIMESTAMP: 'AUTH_INVALID_TIMESTAMP',
  BODY_OFFLINE: 'BODY_OFFLINE',
  CAPABILITY_DENIED: 'CAPABILITY_DENIED',
  CAPABILITY_UNAVAILABLE: 'CAPABILITY_UNAVAILABLE',
  QUEUE_FULL: 'QUEUE_FULL',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  TASK_NOT_FOUND: 'TASK_NOT_FOUND',
  TASK_NOT_LEASED: 'TASK_NOT_LEASED',
  TASK_NOT_CANCELLED: 'TASK_NOT_CANCELLED',
  TASK_TIMEOUT: 'TASK_TIMEOUT',
  TASK_CANCELLED: 'TASK_CANCELLED',
  TASK_ALREADY_TERMINAL: 'TASK_ALREADY_TERMINAL',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  INVALID_REQUEST: 'INVALID_REQUEST',
  INVALID_TASK_ID: 'INVALID_TASK_ID',
  INVALID_RESULT: 'INVALID_RESULT',
  BRIDGE_NOT_CONFIGURED: 'BRIDGE_NOT_CONFIGURED',
  BRIDGE_SHUTTING_DOWN: 'BRIDGE_SHUTTING_DOWN',

  // Local client codes.
  AUTH_UNAVAILABLE: 'AUTH_UNAVAILABLE',
  CONFIG_ERROR: 'CONFIG_ERROR',
  PROTOCOL_ERROR: 'PROTOCOL_ERROR',
  TRANSPORT_ERROR: 'TRANSPORT_ERROR',
  RESULT_TOO_LARGE: 'RESULT_TOO_LARGE',
  AGENT_ERROR: 'AGENT_ERROR',
  AGENT_UNAVAILABLE: 'AGENT_UNAVAILABLE',
  GUARD_UNAVAILABLE: 'GUARD_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SHUTTING_DOWN: 'SHUTTING_DOWN',
  BUSY: 'BUSY',
  DUPLICATE_REQUEST: 'DUPLICATE_REQUEST'
});

export class BridgeError extends Error {
  /**
   * @param {string} code one of ERROR_CODES
   * @param {string} message safe, non-sensitive message
   * @param {{retryable?: boolean, details?: object, cause?: unknown}} [options]
   */
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'BridgeError';
    this.code = code;
    this.retryable = options.retryable === true;
    this.details = options.details ?? undefined;
  }

  toEnvelope() {
    const error = { code: this.code, message: this.message, retryable: this.retryable };
    if (this.details !== undefined) error.details = this.details;
    return error;
  }
}

/**
 * Coerce anything thrown into a BridgeError without leaking secrets.
 * @param {unknown} error thrown value
 * @param {string} [fallbackMessage] message used for non-Bridge errors
 * @returns {BridgeError}
 */
export function asBridgeError(error, fallbackMessage = 'internal bridge error') {
  if (error instanceof BridgeError) return error;
  // Do not copy the raw error message into the wire envelope: provider and
  // agent errors can echo prompt text. The original is kept as `cause` for
  // local debugging only.
  return new BridgeError(ERROR_CODES.INTERNAL_ERROR, fallbackMessage, { cause: error });
}

export const RETRYABLE_CODES = new Set([
  ERROR_CODES.AUTH_TIMESTAMP_EXPIRED,
  ERROR_CODES.BODY_OFFLINE,
  ERROR_CODES.CAPABILITY_UNAVAILABLE,
  ERROR_CODES.QUEUE_FULL,
  ERROR_CODES.TASK_TIMEOUT,
  ERROR_CODES.BRIDGE_SHUTTING_DOWN,
  ERROR_CODES.TRANSPORT_ERROR,
  ERROR_CODES.AGENT_UNAVAILABLE,
  ERROR_CODES.INTERNAL_ERROR
]);

/**
 * Result delivery failures that mean "stop retrying and forget the outcome":
 * the server already closed or never owned the task.
 */
export const TERMINAL_DELIVERY_CODES = new Set([
  ERROR_CODES.TASK_NOT_FOUND,
  ERROR_CODES.TASK_NOT_LEASED,
  ERROR_CODES.TASK_NOT_CANCELLED,
  ERROR_CODES.TASK_ALREADY_TERMINAL,
  ERROR_CODES.INVALID_TASK_ID,
  ERROR_CODES.INVALID_RESULT
]);
