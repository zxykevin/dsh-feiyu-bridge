/**
 * Small leveled logger with secret redaction. The bridge deliberately never
 * logs prompts, results, tokens, or request bodies; callers pass only ids,
 * counts, and durations.
 */

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

export function createLogger(level = 'info', sink = console) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const secrets = new Set();

  const emit = (name, args) => {
    if (LEVELS[name] > threshold) return;
    const method = name === 'debug' ? 'log' : name;
    (sink[method] ?? sink.log ?? (() => {})).call(sink, '[feiyu-bridge]', ...args.map(redactValue));
  };

  const logger = {
    level,
    error: (...args) => emit('error', args),
    warn: (...args) => emit('warn', args),
    info: (...args) => emit('info', args),
    debug: (...args) => emit('debug', args),
    /** Register a secret that must never appear in emitted lines. */
    addSecret(secret) {
      if (typeof secret === 'string' && secret.length >= 4) secrets.add(secret);
    },
    /** Redact known secrets from an arbitrary string. */
    redact(text) {
      let out = String(text);
      for (const secret of secrets) out = out.split(secret).join('***');
      out = out.replace(/(X-API-Key\s*[:=]\s*)\S+/gi, '$1***');
      return out.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***');
    }
  };

  function redactValue(value) {
    if (typeof value === 'string') return logger.redact(value);
    if (value instanceof Error) return { name: value.name, message: logger.redact(value.message) };
    return value;
  }

  return logger;
}
