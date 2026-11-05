/**
 * Authentication for Feiyu Bridge v1.
 *
 * Two independent layers are required by the AstrBot plugin:
 * 1. an AstrBot OpenAPI key with the `plugin` scope (X-API-Key),
 * 2. an HMAC-SHA256 signature over the canonical request message.
 *
 * The shared secret never travels over the tunnel. Timestamps are Unix seconds
 * and nonces are 16..128 URL-safe characters, matching the server's checks.
 * Server responses are NOT signed by the server, so the client only verifies
 * the JSON envelope and the protocol id.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { BridgeError, ERROR_CODES } from './errors.js';

export const AUTH_PREFIX = 'FEIYU-BRIDGE-V1';

export const HEADERS = Object.freeze({
  clientId: 'x-feiyu-client-id',
  timestamp: 'x-feiyu-timestamp',
  nonce: 'x-feiyu-nonce',
  signature: 'x-feiyu-signature',
  requestId: 'x-request-id',
  apiKey: 'x-api-key'
});

/**
 * SHA-256 hex digest.
 * @param {string | Buffer} value
 * @returns {string}
 */
export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * HMAC-SHA256 hex digest.
 * @param {string} secret
 * @param {string} message
 * @returns {string}
 */
export function hmacSha256Hex(secret, message) {
  return createHmac('sha256', secret).update(message, 'utf8').digest('hex');
}

/**
 * Canonical message covered by the signature. `protocolPath` excludes the
 * AstrBot mount prefix, e.g. `/v1/heartbeat`.
 * @param {{method: string, protocolPath: string, timestamp: number|string, nonce: string, body: string|Buffer}} input
 * @returns {string}
 */
export function canonicalMessage({ method, protocolPath, timestamp, nonce, body }) {
  return [
    AUTH_PREFIX,
    String(method).toUpperCase(),
    protocolPath,
    String(timestamp),
    nonce,
    sha256Hex(body ?? '')
  ].join('\n');
}

/**
 * Build the HMAC headers for one outbound request.
 * @param {{
 *   method: string, protocolPath: string, body: string, secret: string,
 *   clientId: string, now?: number, nonce?: () => string
 * }} input
 * @returns {Record<string, string>}
 */
export function signHeaders({
  method,
  protocolPath,
  body,
  secret,
  clientId,
  now = Date.now(),
  nonce = randomNonce
}) {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new BridgeError(ERROR_CODES.AUTH_UNAVAILABLE, 'bridge secret is missing or too short', { retryable: false });
  }
  if (typeof clientId !== 'string' || clientId.trim() === '') {
    throw new BridgeError(ERROR_CODES.AUTH_UNAVAILABLE, 'bridge client id is not configured', { retryable: false });
  }
  const timestamp = Math.floor(now / 1000);
  const nonceValue = nonce();
  const signature = hmacSha256Hex(
    secret,
    canonicalMessage({ method, protocolPath, timestamp, nonce: nonceValue, body })
  );
  return {
    [HEADERS.clientId]: clientId,
    [HEADERS.timestamp]: String(timestamp),
    [HEADERS.nonce]: nonceValue,
    [HEADERS.signature]: signature
  };
}

/**
 * Constant-time comparison of two hex strings.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Generate a URL-safe nonce accepted by the server (16..128 chars).
 * @returns {string}
 */
export function randomNonce() {
  return randomBytes(18).toString('base64url');
}

/**
 * Validate the shape of a client id.
 * @param {string} value
 * @returns {boolean}
 */
export function isValidClientId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(value);
}

/**
 * Resolve the bridge secret and the AstrBot API key through ctx.credentials,
 * with short-lived caching. Values are registered with the logger for redaction
 * but never printed.
 */
export class BridgeCredentials {
  /**
   * @param {{
   *   config: object,
   *   credentials: object,
   *   logger: object,
   *   ttlMs?: number,
   *   now?: () => number
   * }} options
   */
  constructor({ config, credentials, logger, ttlMs = 30000, now = Date.now }) {
    this.config = config;
    this.credentials = credentials;
    this.logger = logger;
    this.ttlMs = ttlMs;
    this.now = now;
    this.secretCache = null;
    this.apiKeyCache = null;
    this.warnedDevSecret = false;
    this.warnedDevApiKey = false;
  }

  /** Drop both cached values (e.g. after a 401). */
  invalidate() {
    this.secretCache = null;
    this.apiKeyCache = null;
  }

  /** @returns {Promise<string>} shared HMAC secret */
  async bridgeSecret() {
    return this.#resolve({
      kind: 'bridge secret',
      configValue: this.config.auth.bridgeSecret,
      ref: this.config.auth.bridgeSecretRef,
      minLength: 32,
      cacheKey: 'secretCache',
      warnedKey: 'warnedDevSecret'
    });
  }

  /** @returns {Promise<string>} AstrBot OpenAPI key */
  async apiKey() {
    return this.#resolve({
      kind: 'AstrBot API key',
      configValue: this.config.auth.apiKey,
      ref: this.config.auth.apiKeyRef,
      minLength: 8,
      cacheKey: 'apiKeyCache',
      warnedKey: 'warnedDevApiKey'
    });
  }

  async #resolve({ kind, configValue, ref, minLength, cacheKey, warnedKey }) {
    if (typeof configValue === 'string' && configValue.length > 0) {
      if (!this[warnedKey]) {
        this[warnedKey] = true;
        this.logger.warn(`using ${kind} from plugin config (development only); prefer ${ref} in DSH credentials`);
        this.logger.addSecret(configValue);
      }
      if (configValue.length < minLength) {
        throw new BridgeError(ERROR_CODES.AUTH_UNAVAILABLE, `${kind} is too short`, { retryable: false });
      }
      return configValue;
    }

    const cached = this[cacheKey];
    if (cached && this.now() - cached.at < this.ttlMs) return cached.value;

    let resolved;
    try {
      resolved = await this.credentials.resolve(ref);
    } catch (error) {
      throw new BridgeError(ERROR_CODES.AUTH_UNAVAILABLE, `could not read ${kind} from credentials`, {
        retryable: true,
        cause: error
      });
    }
    if (!resolved || typeof resolved.value !== 'string' || resolved.value.length < minLength) {
      throw new BridgeError(
        ERROR_CODES.AUTH_UNAVAILABLE,
        `${kind} is not configured: set credential "${ref}" (or the matching dev config field)`,
        { retryable: false }
      );
    }
    this.logger.addSecret(resolved.value);
    this[cacheKey] = { value: resolved.value, at: this.now() };
    return resolved.value;
  }
}
