/**
 * Dependency-free mock of the AstrBot Feiyu Bridge protocol (`feiyu-bridge/1`).
 *
 * It implements the server side of docs/PROTOCOL_V1.md closely enough to test
 * the Windows client end to end:
 *   - AstrBot OpenAPI key (Bearer / X-API-Key)
 *   - HMAC request signature over the protocol path
 *   - heartbeat, lease long-poll, task lookup, result, cancellation, status
 *   - unsigned `/__mock/*` admin endpoints for tests
 *
 * Usage: node mock/server.js   (env FEIYU_BRIDGE_MOCK_PORT, FEIYU_BRIDGE_SECRET,
 * FEIYU_BRIDGE_API_KEY)
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const PROTOCOL_ID = 'feiyu-bridge/1';
const AUTH_PREFIX = 'FEIYU-BRIDGE-V1';
const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;
const SIGNATURE_RE = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const RETRYABLE = new Set([
  'AUTH_TIMESTAMP_EXPIRED',
  'BODY_OFFLINE',
  'CAPABILITY_UNAVAILABLE',
  'QUEUE_FULL',
  'TASK_TIMEOUT',
  'BRIDGE_SHUTTING_DOWN'
]);

const HTTP_STATUS = {
  AUTH_CLIENT_REJECTED: 401,
  AUTH_INVALID_SIGNATURE: 401,
  AUTH_TIMESTAMP_EXPIRED: 401,
  AUTH_REPLAY: 401,
  AUTH_INVALID_NONCE: 401,
  AUTH_INVALID_TIMESTAMP: 401,
  TASK_NOT_FOUND: 404,
  QUEUE_FULL: 429,
  PAYLOAD_TOO_LARGE: 413,
  INVALID_REQUEST: 400,
  BRIDGE_SHUTTING_DOWN: 503
};

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function canonicalMessage(method, protocolPath, timestamp, nonce, body) {
  return [AUTH_PREFIX, method.toUpperCase(), protocolPath, String(timestamp), nonce, sha256Hex(body)].join('\n');
}

function hmacHex(secret, message) {
  return crypto.createHmac('sha256', secret).update(message).digest('hex');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

class ProtocolError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}

function newTaskId() {
  return crypto.randomUUID();
}

function nowSeconds(now) {
  return Math.floor(now / 1000);
}

export function createMockServer({
  bridgeSecret = 'mock-bridge-secret-0123456789abcdef',
  apiKey = 'abk_mock_openapi_key_1234567890',
  clientId = 'windows-dsh',
  port = 0,
  host = '127.0.0.1',
  basePath = '/feiyu-bridge/',
  maxWaitMs = 5000,
  heartbeatTimeoutSeconds = 25,
  allowedCapabilities = ['dsh.status.read', 'dsh.workflow.run'],
  now = Date.now,
  logger = console
} = {}) {
  if (basePath.startsWith('/') === false) basePath = `/${basePath}`;
  if (!basePath.endsWith('/')) basePath += '/';

  const state = {
    startedAt: now(),
    lastHeartbeatAt: null,
    agentVersion: null,
    clientCapabilities: [],
    allowedCapabilities: [...allowedCapabilities],
    tasks: new Map(),
    queue: [],
    activeTaskId: null,
    unavailable: false,
    shuttingDown: false,
    results: new Map()
  };

  const waiters = new Set();
  const resultWaiters = new Map();

  function notify() {
    for (const waiter of [...waiters]) waiter();
  }

  function notifyResult(taskId, record) {
    const list = resultWaiters.get(taskId) ?? [];
    resultWaiters.delete(taskId);
    for (const resolve of list) resolve(record);
  }

  function taskPublic(task, includeArguments = true) {
    const value = {
      task_id: task.taskId,
      capability: task.capability,
      state: task.state,
      created_at: task.createdAt,
      deadline_at: task.deadlineAt
    };
    if (includeArguments) value.arguments = task.arguments;
    if (task.state === 'succeeded' || task.state === 'failed') {
      if (task.result !== undefined) value.result = task.result;
      if (task.error !== undefined) value.error = task.error;
    }
    return value;
  }

  function setTerminal(task, status, payload) {
    task.state = status === 'succeeded' ? 'succeeded' : 'failed';
    task.result = payload.result;
    task.error = payload.error;
    task.resultDigest = sha256Hex(
      JSON.stringify({ status: payload.status, result: payload.result ?? null, error: payload.error ?? null })
    );
    task.finishedAt = nowSeconds(now());
    if (state.activeTaskId === task.taskId) state.activeTaskId = null;
    const record = taskPublic(task);
    state.results.set(task.taskId, record);
    notifyResult(task.taskId, record);
    notify();
    return record;
  }

  function expireIfNeeded(task) {
    if (task.state === 'leased' && task.deadlineAt <= nowSeconds(now())) {
      task.state = 'timed_out';
      task.finishedAt = nowSeconds(now());
      if (state.activeTaskId === task.taskId) state.activeTaskId = null;
      const record = taskPublic(task);
      state.results.set(task.taskId, record);
      notifyResult(task.taskId, record);
      notify();
    }
  }

  function startNextTask() {
    if (state.activeTaskId) return null;
    while (state.queue.length > 0) {
      const task = state.queue.shift();
      if (task.state !== 'queued') continue;
      if (task.deadlineAt <= nowSeconds(now())) {
        task.state = 'timed_out';
        continue;
      }
      task.state = 'leased';
      state.activeTaskId = task.taskId;
      return task;
    }
    return null;
  }

  function bodyStatus() {
    const ageSeconds =
      state.lastHeartbeatAt === null ? null : Math.max(0, Math.floor((now() - state.lastHeartbeatAt) / 1000));
    const online = ageSeconds !== null && ageSeconds <= heartbeatTimeoutSeconds;
    const active = state.activeTaskId ? state.tasks.get(state.activeTaskId) : null;
    return {
      online,
      state: online ? (active ? 'busy' : 'idle') : 'offline',
      last_heartbeat_age_seconds: ageSeconds,
      capabilities: state.allowedCapabilities.filter((cap) => state.clientCapabilities.includes(cap)),
      agent_version: state.agentVersion,
      active_task: active ? taskPublic(active, false) : null,
      queued_tasks: state.queue.length
    };
  }

  function envelope(data, requestId) {
    return { ok: true, protocol: PROTOCOL_ID, ...(requestId ? { request_id: requestId } : {}), data };
  }

  function errorEnvelope(code, message, requestId) {
    return {
      ok: false,
      protocol: PROTOCOL_ID,
      ...(requestId ? { request_id: requestId } : {}),
      error: { code, message, retryable: RETRYABLE.has(code) }
    };
  }

  function verifyAuth(req, protocolPath, rawBody) {
    const authHeader = req.headers.authorization;
    const providedKey = authHeader?.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length)
      : req.headers['x-api-key'];
    if (!providedKey || !safeEqual(providedKey, apiKey)) {
      throw new ProtocolError('AUTH_CLIENT_REJECTED', 'invalid AstrBot OpenAPI key');
    }

    const headerClientId = String(req.headers['x-feiyu-client-id'] ?? '');
    if (headerClientId !== clientId) {
      throw new ProtocolError('AUTH_CLIENT_REJECTED', 'unknown client id');
    }

    const timestamp = String(req.headers['x-feiyu-timestamp'] ?? '');
    const nonce = String(req.headers['x-feiyu-nonce'] ?? '');
    const signature = String(req.headers['x-feiyu-signature'] ?? '');

    if (!NONCE_RE.test(nonce)) throw new ProtocolError('AUTH_INVALID_NONCE', 'invalid nonce');
    if (!/^\d+$/.test(timestamp)) throw new ProtocolError('AUTH_INVALID_TIMESTAMP', 'invalid timestamp');
    const skew = Math.abs(nowSeconds(now()) - Number(timestamp));
    if (skew > 60) throw new ProtocolError('AUTH_TIMESTAMP_EXPIRED', 'timestamp outside the 60s window');
    if (!SIGNATURE_RE.test(signature)) throw new ProtocolError('AUTH_INVALID_SIGNATURE', 'malformed signature');

    const replayKey = `${headerClientId}:${nonce}`;
    if (mockNonces.has(replayKey)) throw new ProtocolError('AUTH_REPLAY', 'nonce already used');
    const expected = hmacHex(
      bridgeSecret,
      canonicalMessage(req.method, protocolPath, timestamp, nonce, rawBody)
    );
    if (!safeEqual(expected, signature)) throw new ProtocolError('AUTH_INVALID_SIGNATURE', 'signature mismatch');
    mockNonces.add(replayKey);
    if (mockNonces.size > 4096) mockNonces.delete(mockNonces.values().next().value);
  }

  const mockNonces = new Set();

  async function readBody(req, limit = 262144) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw new ProtocolError('PAYLOAD_TOO_LARGE', 'request body too large');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  function send(res, statusCode, payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    res.writeHead(statusCode, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': body.length,
      'cache-control': 'no-store'
    });
    res.end(body);
  }

  async function waitForLease(maxWaitMsValue) {
    const task = startNextTask();
    if (task) return task;
    if (maxWaitMsValue <= 0) return null;
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        waiters.delete(check);
        const next = startNextTask();
        resolve(next);
      };
      const check = () => finish();
      waiters.add(check);
      const timer = setTimeout(() => {
        waiters.delete(check);
        resolve(null);
      }, maxWaitMsValue);
      timer.unref?.();
    });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://mock.local');
    const path = url.pathname;

    try {
      if (path.startsWith('/__mock/')) return await handleAdmin(req, res, path);

      if (!path.startsWith(basePath)) {
        return send(res, 404, errorEnvelope('TASK_NOT_FOUND', 'unknown route'));
      }
      const protocolPath = `/${path.slice(basePath.length)}`;
      const rawBody = await readBody(req);
      const requestId = String(req.headers['x-request-id'] ?? '').slice(0, 128) || undefined;

      if (state.shuttingDown) {
        return send(res, 503, errorEnvelope('BRIDGE_SHUTTING_DOWN', 'shutting down', requestId));
      }

      verifyAuth(req, protocolPath, rawBody);

      if (req.method === 'GET' && protocolPath === '/v1/status') {
        return send(res, 200, envelope({ protocol: PROTOCOL_ID, ...bodyStatus() }, requestId));
      }

      if (req.method === 'POST' && protocolPath === '/v1/heartbeat') {
        if (state.unavailable) {
          return send(res, 503, errorEnvelope('BODY_OFFLINE', 'mock marked unavailable', requestId));
        }
        const body = JSON.parse(rawBody.toString('utf8') || '{}');
        state.lastHeartbeatAt = now();
        state.agentVersion = typeof body.agent_version === 'string' ? body.agent_version : null;
        state.clientCapabilities = Array.isArray(body.capabilities)
          ? body.capabilities.filter((value) => typeof value === 'string')
          : [];
        const active = state.activeTaskId ? state.tasks.get(state.activeTaskId) : null;
        return send(
          res,
          200,
          envelope(
            {
              ...bodyStatus(),
              cancel_requested: active ? active.state === 'cancelled' || active.state === 'timed_out' : false,
              server_time: nowSeconds(now())
            },
            requestId
          )
        );
      }

      if (req.method === 'POST' && protocolPath === '/v1/tasks/lease') {
        if (state.unavailable) {
          return send(res, 503, errorEnvelope('BODY_OFFLINE', 'mock marked unavailable', requestId));
        }
        const body = JSON.parse(rawBody.toString('utf8') || '{}');
        const requested = Number.isFinite(body.wait_seconds) ? Number(body.wait_seconds) : 0;
        const waitMs = Math.max(0, Math.min(maxWaitMs, Math.round(requested * 1000)));
        const task = await waitForLease(waitMs);
        return send(
          res,
          200,
          envelope(
            {
              task: task ? taskPublic(task) : null,
              server_time: nowSeconds(now())
            },
            requestId
          )
        );
      }

      const taskMatch = protocolPath.match(/^\/v1\/tasks\/([^/]+)(?:\/(result|cancelled))?$/);
      if (taskMatch) {
        const taskId = decodeURIComponent(taskMatch[1]);
        const action = taskMatch[2];
        if (!UUID_RE.test(taskId)) throw new ProtocolError('INVALID_REQUEST', 'invalid task id');
        const task = state.tasks.get(taskId);
        if (!task) return send(res, 404, errorEnvelope('TASK_NOT_FOUND', 'task not found', requestId));

        if (req.method === 'GET' && !action) {
          expireIfNeeded(task);
          return send(res, 200, envelope(taskPublic(task, false), requestId));
        }

        if (req.method === 'POST' && action === 'result') {
          if (task.state !== 'leased') {
            if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(task.state)) {
              const body = JSON.parse(rawBody.toString('utf8') || '{}');
              const digest = sha256Hex(
                JSON.stringify({ status: body.status, result: body.result ?? null, error: body.error ?? null })
              );
              if (digest === task.resultDigest) {
                return send(res, 200, envelope(taskPublic(task), requestId));
              }
              return send(res, 409, errorEnvelope('TASK_ALREADY_TERMINAL', 'task is already terminal', requestId));
            }
            return send(res, 409, errorEnvelope('TASK_NOT_LEASED', 'task is not leased', requestId));
          }
          const body = JSON.parse(rawBody.toString('utf8') || '{}');
          if (body.status !== 'succeeded' && body.status !== 'failed') {
            return send(res, 409, errorEnvelope('INVALID_RESULT', 'status must be succeeded or failed', requestId));
          }
          const record = setTerminal(task, body.status, body);
          return send(res, 200, envelope(record, requestId));
        }

        if (req.method === 'POST' && action === 'cancelled') {
          if (!['cancelled', 'timed_out', 'succeeded', 'failed'].includes(task.state)) {
            task.state = 'cancelled';
            task.finishedAt = nowSeconds(now());
          }
          if (state.activeTaskId === task.taskId) state.activeTaskId = null;
          const record = taskPublic(task);
          state.results.set(task.taskId, record);
          notifyResult(task.taskId, record);
          notify();
          return send(res, 200, envelope(record, requestId));
        }
      }

      return send(res, 404, errorEnvelope('TASK_NOT_FOUND', 'unknown route', requestId));
    } catch (error) {
      if (error instanceof ProtocolError) {
        const status = HTTP_STATUS[error.code] ?? 409;
        return send(res, status, errorEnvelope(error.code, error.message));
      }
      logger.error?.('mock server error', error);
      return send(res, 500, errorEnvelope('INTERNAL_ERROR', 'mock server error'));
    }
  }

  async function handleAdmin(req, res, path) {
    const url = new URL(req.url, 'http://mock.local');
    if (req.method === 'GET' && path === '/__mock/state') {
      return send(res, 200, {
        protocol: PROTOCOL_ID,
        base_path: basePath,
        client_id: clientId,
        body: bodyStatus(),
        active_task_id: state.activeTaskId,
        queued: state.queue.length,
        tasks: [...state.tasks.values()].map((task) => taskPublic(task)),
        results: [...state.results.values()]
      });
    }
    if (req.method === 'GET' && path === '/__mock/results') {
      return send(res, 200, { results: [...state.results.values()] });
    }
    if (req.method === 'POST' && path === '/__mock/enqueue') {
      const raw = await readBody(req);
      const input = JSON.parse(raw.toString('utf8') || '{}');
      const taskId = newTaskId();
      const timeoutSeconds = Number.isInteger(input.timeout_seconds)
        ? Math.max(1, Math.min(86400, input.timeout_seconds))
        : 30;
      const createdAt = nowSeconds(now());
      const task = {
        taskId,
        capability: String(input.capability ?? ''),
        arguments: input.arguments ?? {},
        state: 'queued',
        createdAt,
        deadlineAt: createdAt + timeoutSeconds,
        idempotencyKey: input.idempotency_key ?? null
      };
      state.tasks.set(taskId, task);
      state.queue.push(task);
      notify();
      return send(res, 200, { task_id: taskId, task: taskPublic(task) });
    }
    if (req.method === 'POST' && path === '/__mock/cancel') {
      const raw = await readBody(req);
      const input = JSON.parse(raw.toString('utf8') || '{}');
      const task = state.tasks.get(String(input.task_id ?? ''));
      if (!task) return send(res, 404, { ok: false, error: 'task not found' });
      if (!['succeeded', 'failed', 'cancelled', 'timed_out'].includes(task.state)) {
        task.state = 'cancelled';
        task.finishedAt = nowSeconds(now());
      }
      // Keep the task active until the client acknowledges cancellation; that
      // is how /v1/heartbeat reports cancel_requested.
      const record = taskPublic(task);
      state.results.set(task.taskId, record);
      notifyResult(task.taskId, record);
      notify();
      return send(res, 200, { ok: true, task: record });
    }
    if (req.method === 'POST' && path === '/__mock/unavailable') {
      const raw = await readBody(req);
      const input = JSON.parse(raw.toString('utf8') || '{}');
      state.unavailable = input.value !== false;
      return send(res, 200, { ok: true, unavailable: state.unavailable });
    }
    if (req.method === 'POST' && path === '/__mock/reset') {
      state.tasks.clear();
      state.queue.length = 0;
      state.results.clear();
      state.activeTaskId = null;
      state.lastHeartbeatAt = null;
      state.clientCapabilities = [];
      state.unavailable = false;
      notify();
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { ok: false, error: 'unknown admin route' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      logger.error?.('mock unhandled', error);
      if (!res.headersSent) send(res, 500, errorEnvelope('INTERNAL_ERROR', 'mock unhandled error'));
    });
  });

  return {
    server,
    state,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          const address = server.address();
          resolve({
            port: address.port,
            url: `http://${host}:${address.port}${basePath}`,
            apiKey,
            bridgeSecret,
            clientId
          });
        });
      });
    },
    close() {
      for (const waiter of waiters) waiter();
      waiters.clear();
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
    enqueue(input) {
      const taskId = newTaskId();
      const timeoutSeconds = Number.isInteger(input.timeout_seconds)
        ? Math.max(1, Math.min(86400, input.timeout_seconds))
        : 30;
      const createdAt = nowSeconds(now());
      const task = {
        taskId,
        capability: String(input.capability ?? ''),
        arguments: input.arguments ?? {},
        state: 'queued',
        createdAt,
        deadlineAt: createdAt + timeoutSeconds
      };
      state.tasks.set(taskId, task);
      state.queue.push(task);
      notify();
      return taskPublic(task);
    },
    cancel(taskId, reason = 'cancelled') {
      const task = state.tasks.get(taskId);
      if (!task) return null;
      task.state = reason === 'timeout' ? 'timed_out' : 'cancelled';
      task.finishedAt = nowSeconds(now());
      const record = taskPublic(task);
      state.results.set(taskId, record);
      notifyResult(taskId, record);
      notify();
      return record;
    },
    setUnavailable(value) {
      state.unavailable = value !== false;
    },
    lastResult(taskId) {
      return state.results.get(taskId) ?? null;
    },
    waitForResult(taskId, timeoutMs = 5000) {
      const existing = state.results.get(taskId);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const list = (resultWaiters.get(taskId) ?? []).filter((fn) => fn !== onResult);
          if (list.length > 0) resultWaiters.set(taskId, list);
          else resultWaiters.delete(taskId);
          reject(new Error(`timed out waiting for result of ${taskId}`));
        }, timeoutMs);
        timer.unref?.();
        const onResult = (record) => {
          clearTimeout(timer);
          resolve(record);
        };
        const list = resultWaiters.get(taskId) ?? [];
        list.push(onResult);
        resultWaiters.set(taskId, list);
      });
    }
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const mock = createMockServer({
    port: Number(process.env.FEIYU_BRIDGE_MOCK_PORT ?? 6199),
    bridgeSecret: process.env.FEIYU_BRIDGE_SECRET ?? 'mock-bridge-secret-0123456789abcdef',
    apiKey: process.env.FEIYU_BRIDGE_API_KEY ?? 'abk_mock_openapi_key_1234567890'
  });
  mock.listen().then(({ url }) => {
    console.log(`[feiyu-bridge mock] listening at ${url}`);
    console.log('[feiyu-bridge mock] admin: /__mock/state /__mock/enqueue /__mock/cancel /__mock/unavailable /__mock/reset');
  });
}
