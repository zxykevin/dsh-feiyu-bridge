/**
 * HTTP transport for Feiyu Bridge v1 (`feiyu-bridge/1`).
 *
 * Every request carries:
 * - `X-API-Key: <AstrBot OpenAPI key>` (plugin scope), as required by
 *   `WINDOWS_DSH_CONTRACT.md` (AstrBot also accepts a Bearer scheme),
 * - `X-Feiyu-*` HMAC headers over the canonical request message,
 * - an optional `X-Request-Id` for server-side tracing.
 *
 * Bodies are size-limited while reading, so a hostile or broken endpoint cannot
 * exhaust memory. The server does not sign responses, so the client verifies
 * the `{ok, protocol, data|error}` envelope instead.
 */

import { randomUUID } from 'node:crypto';
import { BridgeError, ERROR_CODES } from '../core/errors.js';
import { parseEnvelope } from '../core/protocol.js';
import { HEADERS, randomNonce, signHeaders } from '../core/auth.js';
import { Transport } from './transport.js';

const USER_AGENT = 'dsh-feiyu-bridge/0.4.0';

function combineSignals(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return { signal: timeout, cleanup: () => {} };
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason ?? timeout.reason);
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  timeout.addEventListener('abort', abort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      signal.removeEventListener('abort', abort);
      timeout.removeEventListener('abort', abort);
    }
  };
}

async function readTextLimited(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new BridgeError(ERROR_CODES.PROTOCOL_ERROR, `server response is too large (${declared} bytes)`, {
      retryable: false
    });
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new BridgeError(ERROR_CODES.PROTOCOL_ERROR, 'server response exceeded the size limit', { retryable: false });
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new BridgeError(ERROR_CODES.PROTOCOL_ERROR, 'server response exceeded the size limit', {
          retryable: false
        });
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseJson(text, context) {
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new BridgeError(ERROR_CODES.PROTOCOL_ERROR, `${context} returned invalid JSON`, { retryable: true });
  }
}

export class HttpTransport extends Transport {
  /**
   * @param {{
   *   config: object,
   *   credentials: object,
   *   logger: object,
   *   fetchImpl?: typeof fetch,
   *   now?: () => number,
   *   nonce?: () => string,
   *   requestId?: () => string
   * }} options
   */
  constructor({
    config,
    credentials,
    logger,
    fetchImpl = globalThis.fetch,
    now = Date.now,
    nonce = randomNonce,
    requestId = randomUUID
  }) {
    super();
    if (typeof fetchImpl !== 'function') throw new Error('dsh-feiyu-bridge requires a fetch implementation');
    this.config = config;
    this.credentials = credentials;
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.nonce = nonce;
    this.requestId = requestId;
  }

  get name() {
    return 'http-long-poll';
  }

  _url(relativePath) {
    return new URL(relativePath, this.config.server.baseUrl).toString();
  }

  /**
   * @param {{
   *   method: 'GET'|'POST',
   *   relativePath: string,
   *   protocolPath: string,
   *   body?: object,
   *   signal?: AbortSignal,
   *   timeoutMs?: number
   * }} input
   */
  async _request({ method, relativePath, protocolPath, body, signal, timeoutMs = this.config.server.requestTimeoutMs }) {
    const [secret, apiKey] = await Promise.all([this.credentials.bridgeSecret(), this.credentials.apiKey()]);
    const text = body === undefined ? '' : JSON.stringify(body);
    const authHeaders = signHeaders({
      method,
      protocolPath,
      body: text,
      secret,
      clientId: this.config.auth.clientId,
      now: this.now(),
      nonce: this.nonce
    });
    const headers = {
      accept: 'application/json',
      'cache-control': 'no-store',
      'user-agent': USER_AGENT,
      [HEADERS.apiKey]: apiKey,
      [HEADERS.requestId]: this.requestId(),
      ...authHeaders
    };
    if (method === 'POST') headers['content-type'] = 'application/json; charset=utf-8';

    const { signal: requestSignal, cleanup } = combineSignals(signal, timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(this._url(relativePath), {
        method,
        headers,
        body: method === 'POST' ? text : undefined,
        signal: requestSignal,
        redirect: 'error'
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new BridgeError(
        ERROR_CODES.TRANSPORT_ERROR,
        requestSignal.aborted ? `request to ${protocolPath} timed out` : `request to ${protocolPath} failed`,
        { retryable: true, cause: error }
      );
    } finally {
      cleanup();
    }

    const responseText = await readTextLimited(response, this.config.limits.responseBytes);
    const parsed = parseJson(responseText, protocolPath);

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) this.credentials.invalidate();
      throw httpStatusError(response.status, parsed);
    }

    if (parsed === null) {
      throw new BridgeError(ERROR_CODES.PROTOCOL_ERROR, `${protocolPath} returned an empty body`, { retryable: true });
    }
    return parseEnvelope(parsed);
  }

  async lease({ waitSeconds, signal } = {}) {
    const data = await this._request({
      method: 'POST',
      relativePath: 'v1/tasks/lease',
      protocolPath: '/v1/tasks/lease',
      body: { wait_seconds: waitSeconds },
      signal,
      timeoutMs: Math.max(1000, waitSeconds * 1000) + this.config.server.requestTimeoutMs
    });
    if (!data || typeof data !== 'object') return { task: null };
    return { task: data.task ?? null, serverTime: data.server_time };
  }

  async heartbeat({ agentVersion, capabilities, activeTaskId, pendingTaskIds, signal } = {}) {
    return this._request({
      method: 'POST',
      relativePath: 'v1/heartbeat',
      protocolPath: '/v1/heartbeat',
      body: {
        agent_version: agentVersion,
        capabilities: Array.isArray(capabilities) ? capabilities : [],
        active_task_id: activeTaskId ?? null,
        pending_task_ids: Array.isArray(pendingTaskIds) ? pendingTaskIds.slice(0, 50) : []
      },
      signal
    });
  }

  async submitResult(taskId, payload, { signal } = {}) {
    return this._request({
      method: 'POST',
      relativePath: `v1/tasks/${encodeURIComponent(taskId)}/result`,
      protocolPath: `/v1/tasks/${taskId}/result`,
      body: payload,
      signal
    });
  }

  async acknowledgeCancelled(taskId, { signal } = {}) {
    return this._request({
      method: 'POST',
      relativePath: `v1/tasks/${encodeURIComponent(taskId)}/cancelled`,
      protocolPath: `/v1/tasks/${taskId}/cancelled`,
      body: {},
      signal
    });
  }

  async getStatus({ signal } = {}) {
    return this._request({
      method: 'GET',
      relativePath: 'v1/status',
      protocolPath: '/v1/status',
      signal
    });
  }

  /**
   * Read one task without its arguments. Not used by the lease flow, but part of
   * the v1 contract and useful for diagnostics after a delivery failure.
   */
  async getTask(taskId, { signal } = {}) {
    return this._request({
      method: 'GET',
      relativePath: `v1/tasks/${encodeURIComponent(taskId)}`,
      protocolPath: `/v1/tasks/${taskId}`,
      signal
    });
  }

  async close() {}
}

function httpStatusError(status, parsed) {
  const envelope = parsed && typeof parsed === 'object' && parsed.error && typeof parsed.error === 'object'
    ? parsed.error
    : null;
  const code = typeof envelope?.code === 'string' ? envelope.code : undefined;
  // AstrBot's OpenAPI middleware answers with `{status, message}` rather than a
  // bridge envelope, so surface its message when there is no `error.message`.
  const message =
    typeof envelope?.message === 'string'
      ? envelope.message
      : typeof parsed?.message === 'string'
        ? parsed.message
        : `server responded ${status}`;
  const retryable =
    typeof envelope?.retryable === 'boolean' ? envelope.retryable : status >= 500 || status === 408 || status === 429;
  if (status === 401 || status === 403) {
    return new BridgeError(code ?? ERROR_CODES.AUTH_CLIENT_REJECTED, message, { retryable: false });
  }
  if (status === 413) {
    return new BridgeError(code ?? ERROR_CODES.PAYLOAD_TOO_LARGE, message, { retryable: false });
  }
  if (status === 429) {
    return new BridgeError(code ?? ERROR_CODES.QUEUE_FULL, message, { retryable: true });
  }
  return new BridgeError(code ?? ERROR_CODES.TRANSPORT_ERROR, message, { retryable });
}

export { combineSignals };
