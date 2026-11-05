/**
 * Wire protocol helpers for Feiyu Bridge v1 (`feiyu-bridge/1`).
 *
 * The authoritative server implementation lives in the AstrBot plugin
 * (`astrbot_plugin_feiyu_bridge/docs/PROTOCOL_V1.md`). Keep all field names,
 * capability policy and envelope handling in this module so a future protocol
 * revision only touches one file.
 */

import { BridgeError, ERROR_CODES } from './errors.js';

export const PROTOCOL_ID = 'feiyu-bridge/1';

export const TASK_STATES = Object.freeze({
  QUEUED: 'queued',
  LEASED: 'leased',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  TIMED_OUT: 'timed_out'
});

export const RESULT_STATUS = Object.freeze({
  SUCCEEDED: 'succeeded',
  FAILED: 'failed'
});

export const CAPABILITY_RE = /^[a-z][a-z0-9_.-]{0,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Capability substrings that the server refuses permanently. */
export const DENIED_CAPABILITY_PARTS = Object.freeze([
  'shell',
  'ssh',
  'powershell',
  'pwsh',
  'cmd',
  'terminal',
  'subprocess',
  'process.exec',
  'system.command'
]);

/** Argument keys that would smuggle command execution through a capability. */
export const DENIED_ARGUMENT_KEYS = Object.freeze([
  'argv',
  'cmd',
  'command',
  'executable',
  'powershell',
  'script',
  'shell',
  'ssh',
  'terminal'
]);

const DENIED_ARGUMENT_SET = new Set(DENIED_ARGUMENT_KEYS);
const MAX_ARGUMENT_DEPTH = 16;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalid(message) {
  return new BridgeError(ERROR_CODES.INVALID_REQUEST, message, { retryable: false });
}

/**
 * Validate a capability name against the protocol regex and permanent denylist.
 * @param {unknown} value
 * @returns {string}
 */
export function validateCapability(value) {
  if (typeof value !== 'string') throw invalid('capability must be a string');
  const normalized = value.trim().toLowerCase();
  if (!CAPABILITY_RE.test(normalized)) throw invalid('capability must match [a-z][a-z0-9_.-]{0,63}');
  if (DENIED_CAPABILITY_PARTS.some((part) => normalized.includes(part))) {
    throw invalid('capability is permanently denied by bridge policy');
  }
  return normalized;
}

/**
 * Recursively reject command-shaped argument keys and non-JSON values.
 * @param {unknown} value
 * @param {number} [depth]
 */
export function validateArguments(value, depth = 0) {
  if (depth > MAX_ARGUMENT_DEPTH) throw invalid('arguments exceed maximum nesting depth');
  if (Array.isArray(value)) {
    for (const child of value) validateArguments(child, depth + 1);
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      const normalized = String(key).trim().toLowerCase().replace(/-/g, '_');
      if (DENIED_ARGUMENT_SET.has(normalized)) {
        throw invalid(`argument key "${key}" is denied by bridge policy`);
      }
      validateArguments(child, depth + 1);
    }
    return;
  }
  if (value === null) return;
  if (typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  throw invalid('arguments contain a non-JSON value');
}

function epochMs(value, field, { optional = false } = {}) {
  if (value === undefined || value === null) {
    if (optional) return undefined;
    throw invalid(`${field} is required`);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    // The protocol speaks epoch seconds; tolerate milliseconds defensively.
    return value > 1e12 ? Math.round(value) : Math.round(value * 1000);
  }
  if (typeof value === 'string' && value.length <= 40) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw invalid(`${field} must be an epoch-seconds number`);
}

/**
 * Validate one leased task from the server.
 * @param {unknown} value
 * @returns {{
 *   taskId: string, capability: string, arguments: object, origin?: string,
 *   state: string, createdAt: number|undefined, deadlineAt: number
 * }}
 */
export function validateTask(value) {
  if (!isPlainObject(value)) throw invalid('task must be an object');
  const taskId = typeof value.task_id === 'string' ? value.task_id : '';
  if (!UUID_RE.test(taskId)) throw invalid('task.task_id must be a UUID');
  const capability = validateCapability(value.capability);
  if (!isPlainObject(value.arguments)) throw invalid('task.arguments must be an object');
  validateArguments(value.arguments);
  let origin;
  if (value.origin !== undefined) {
    if (typeof value.origin !== 'string' || value.origin.length === 0 || value.origin.length > 256) {
      throw invalid('task.origin must be a non-empty string of at most 256 characters');
    }
    if (value.origin.includes('\u0000')) throw invalid('task.origin must not contain NUL characters');
    origin = value.origin;
  }
  if (value.state !== undefined && value.state !== TASK_STATES.LEASED) {
    throw invalid(`task.state must be "${TASK_STATES.LEASED}" when leased`);
  }
  return {
    taskId,
    capability,
    arguments: value.arguments,
    origin,
    state: TASK_STATES.LEASED,
    createdAt: epochMs(value.created_at, 'task.created_at', { optional: true }),
    deadlineAt: epochMs(value.deadline_at, 'task.deadline_at')
  };
}

/**
 * Parse the common `{ok, protocol, request_id?, data|error}` envelope.
 * @param {unknown} value
 * @returns {any} envelope data
 */
export function parseEnvelope(value) {
  if (!isPlainObject(value)) {
    throw new BridgeError(ERROR_CODES.PROTOCOL_ERROR, 'server response is not a JSON object', { retryable: true });
  }
  if (value.protocol !== PROTOCOL_ID) {
    throw new BridgeError(
      ERROR_CODES.PROTOCOL_ERROR,
      `server protocol "${String(value.protocol)}" is not ${PROTOCOL_ID}`,
      { retryable: false }
    );
  }
  if (value.ok === true) return value.data ?? null;
  if (value.ok === false) {
    const error = isPlainObject(value.error) ? value.error : {};
    throw new BridgeError(
      typeof error.code === 'string' ? error.code : ERROR_CODES.INTERNAL_ERROR,
      typeof error.message === 'string' ? error.message.slice(0, 300) : 'server rejected the request',
      { retryable: error.retryable === true }
    );
  }
  throw new BridgeError(ERROR_CODES.PROTOCOL_ERROR, 'server response is missing the ok flag', { retryable: true });
}

/**
 * Total UTF-8 byte length of a JSON-serializable value.
 * @param {unknown} value
 * @returns {number}
 */
export function jsonByteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/**
 * Truncate a string to a UTF-8 byte budget without splitting a code point.
 * @param {string} text
 * @param {number} maxBytes
 * @returns {{text: string, truncated: boolean}}
 */
export function truncateUtf8(text, maxBytes) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return { text, truncated: false };
  const cut = buf.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD+$/, '');
  return { text: cut, truncated: true };
}

/**
 * A task is expired once the server-side deadline has passed.
 * @param {{deadlineAt: number}} task
 * @param {number} now epoch ms
 * @returns {boolean}
 */
export function isExpired(task, now) {
  return task.deadlineAt <= now;
}
