/**
 * `dsh.workflow.run` capability.
 *
 * The only supported task shape is a plain prompt executed by a dedicated,
 * tool-restricted bridge agent session. There is deliberately no path here for
 * shell, file, browser, SSH, or arbitrary tool invocation.
 *
 * Arguments:
 *   prompt        string, required, <= capabilities.workflowRun.maxPromptChars
 *   session_key   string, required by default: per-QQ-user context isolation
 *   timeout_seconds  optional integer; the server deadline still wins
 */

import { BridgeError, ERROR_CODES } from '../core/errors.js';

const ARGUMENT_KEYS = new Set(['prompt', 'session_key', 'timeout_seconds']);
const SESSION_KEY_RE = /^[A-Za-z0-9._:@-]{1,64}$/;

function bad(message) {
  return new BridgeError(ERROR_CODES.INVALID_REQUEST, message, { retryable: false });
}

/**
 * @param {{task: object, config: object, agent: object, signal?: AbortSignal}} input
 * @returns {Promise<object>} wire result
 */
export async function workflowRun({ task, config, agent, signal }) {
  const args = task.arguments;

  for (const key of Object.keys(args)) {
    if (!ARGUMENT_KEYS.has(key)) throw bad(`dsh.workflow.run argument "${key}" is not supported`);
  }

  if (typeof args.prompt !== 'string' || args.prompt.trim().length === 0) {
    throw bad('dsh.workflow.run argument "prompt" must be a non-empty string');
  }
  if (args.prompt.length > config.capabilities.workflowRun.maxPromptChars) {
    throw new BridgeError(
      ERROR_CODES.PAYLOAD_TOO_LARGE,
      `prompt exceeds ${config.capabilities.workflowRun.maxPromptChars} characters`,
      { retryable: false }
    );
  }
  if (args.prompt.includes('\u0000')) throw bad('prompt must not contain NUL characters');

  let sessionKey;
  if (args.session_key !== undefined) {
    if (typeof args.session_key !== 'string' || !SESSION_KEY_RE.test(args.session_key)) {
      throw bad('argument "session_key" must match [A-Za-z0-9._:@-]{1,64}');
    }
    sessionKey = args.session_key;
  } else if (config.capabilities.workflowRun.requireSessionKey) {
    throw bad('argument "session_key" is required so different QQ users do not share agent context');
  } else {
    sessionKey = 'default';
  }

  if (args.timeout_seconds !== undefined) {
    if (!Number.isInteger(args.timeout_seconds) || args.timeout_seconds < 1 || args.timeout_seconds > 86400) {
      throw bad('argument "timeout_seconds" must be an integer between 1 and 86400');
    }
  }

  if (!agent) {
    throw new BridgeError(ERROR_CODES.AGENT_UNAVAILABLE, 'DSH agent adapter is not available', { retryable: true });
  }

  // The server's deadline is authoritative; never run longer than the task
  // record allows even if the caller asks for more.
  const remainingMs = Math.max(1000, task.deadlineAt - Date.now());
  const requestedMs = args.timeout_seconds === undefined ? remainingMs : args.timeout_seconds * 1000;
  const timeoutMs = Math.min(remainingMs, requestedMs, config.tasks.maxTimeoutMs);

  const response = await agent.execute(
    {
      prompt: args.prompt,
      sessionKey,
      origin: task.origin,
      timeoutMs,
      taskId: task.taskId
    },
    signal
  );

  return {
    value: response.text,
    session_key: sessionKey,
    dsh_session_id: response.dshSessionId,
    execution_id: response.executionId,
    turn: response.turn,
    truncated: response.truncated === true,
    ...(response.usage ? { usage: response.usage } : {})
  };
}
