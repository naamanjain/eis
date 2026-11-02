/* Vendored from ../shared/observability/logger.js — do not edit here; run `npm run vendor`. */
'use strict';
// Structured logging that cannot leak user content. Values under body-ish keys
// are replaced with their size, so a log line explains what happened without
// carrying the code or the prompt that caused it.

const OMITTED = '[omitted]';
const FORBIDDEN_KEYS = new Set([
  'subject', 'prompt', 'system', 'user', 'code', 'content', 'messages', 'body',
  'text', 'raw', 'rawText', 'contextText', 'diagnostics', 'fullDocument',
  'apikey', 'key', 'token', 'secret', 'authorization',
]);

const LEVELS = { info: 10, warn: 20, error: 30 };

function sanitizeFields(fields, secrets) {
  const out = {};
  for (const [key, value] of Object.entries(fields || {})) {
    const lower = key.toLowerCase();
    if (FORBIDDEN_KEYS.has(lower)) {
      const size = typeof value === 'string' ? value.length : (Array.isArray(value) ? value.length : 0);
      out[`${key}Len`] = size;
      continue;
    }
    if (value === undefined) continue;
    if (typeof value === 'string') {
      let safe = value;
      for (const secret of secrets) {
        if (typeof secret === 'string' && secret.length >= 6) safe = safe.split(secret).join('[redacted]');
      }
      out[key] = safe.length > 200 ? `${safe.slice(0, 200)}…` : safe;
      continue;
    }
    if (typeof value === 'object') {
      out[key] = Array.isArray(value) ? value.map((item) => sanitizeFields({ v: item }, secrets).v) : sanitizeFields(value, secrets);
      continue;
    }
    out[key] = value;
  }
  return out;
}

function formatLine({ name, level, event, fields }) {
  const parts = [`[${name}] ${level} ${event}`];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(`${key}=${typeof value === 'string' && value.includes(' ') ? JSON.stringify(value) : value}`);
  }
  return parts.join(' ');
}

function createLogger(options = {}) {
  const name = options.name || 'eis';
  const threshold = LEVELS[options.level || 'info'] || LEVELS.info;
  const sink = options.sink || ((line) => console.log(line));
  const errorSink = options.errorSink || ((line) => console.error(line));
  const state = { secrets: options.secrets || [] };

  const emit = (level, event, fields) => {
    if (LEVELS[level] < threshold) return;
    const line = formatLine({ name, level, event, fields: sanitizeFields(fields, state.secrets) });
    if (level === 'error') errorSink(line);
    else sink(line);
  };

  return {
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
    // Secrets are registered separately so a caller can add the key it is about
    // to use without ever passing it as a log field.
    setSecrets(secrets) {
      state.secrets = (secrets || []).filter(Boolean);
    },
    sanitize: (fields) => sanitizeFields(fields, state.secrets),
    LEVELS,
  };
}

module.exports = { createLogger, sanitizeFields, formatLine, OMITTED, FORBIDDEN_KEYS, LEVELS };
