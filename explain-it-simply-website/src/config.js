'use strict';
// Reads and validates server configuration. Only this module touches
// process.env. Everything security-related has a conservative default: bind to
// localhost, no cross-origin access, and a rate limit, because this endpoint
// spends the owner's API key.

const path = require('path');
const dotenv = require('dotenv');
const registry = require('../../shared/providers/registry');
const { parseKeyList } = require('../../shared/providers/keyPool');

dotenv.config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const DEFAULTS = {
  port: 3000,
  host: '127.0.0.1',
  timeoutMs: 45000,
  retries: 2,
  rateLimitRequests: 20,
  rateLimitWindowMs: 60000,
  burst: 5,
  maxBodyBytes: 32 * 1024,
  structuredOutput: true,
  trustProxy: 0,
  maxInflight: 2,
  dailyRequestCap: 300,
};

function positiveInt(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`'${value}' is not a valid number between ${min} and ${max}.`);
  }
  return parsed;
}

function readPort(value) {
  if (value === undefined || value === '') return DEFAULTS.port;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`PORT='${value}' is not a valid port number.`);
  }
  return parsed;
}

function readConfig(env = process.env) {
  const providerId = env.EIS_PROVIDER || registry.DEFAULT_PROVIDER_ID;
  const provider = registry.getProvider(providerId);
  if (!provider) {
    throw new Error(`EIS_PROVIDER='${providerId}' is not a known provider. Known: ${registry.listProviders().map((p) => p.id).join(', ')}.`);
  }

  const model = env.EIS_MODEL || provider.defaultModel;
  const resolved = registry.resolveModel(providerId, model, { allowCustom: true });
  if (!resolved) throw new Error(`EIS_MODEL='${model}' is not a usable model id for '${providerId}'.`);
  // Aggregator ids churn faster than a release can track (OpenRouter listed 462
  // models), so an unknown-but-well-formed id boots with a loud notice instead of
  // refusing — refusing would lock out the very routes that cost nothing.
  const modelNotice = registry.isKnownModel(providerId, model)
    ? null
    : `EIS_MODEL='${model}' is not in the built-in catalogue for ${provider.name}; it will be sent as typed. Catalogue: ${provider.models.map((m) => m.id).join(', ')}.`;

  const allowedOrigins = String(env.EIS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return {
    port: readPort(env.PORT),
    // Default loopback only: a dev server holding a paid API key must not be a
    // LAN proxy by accident.
    host: env.EIS_HOST || DEFAULTS.host,
    providerId,
    provider,
    model,
    modelNotice,
    apiKey: String(env[provider.keyEnv] || '').trim(),
    apiKeyEnv: provider.keyEnv,
    // Extra keys of the same provider, used when one is rejected or rate limited.
    apiKeys: parseKeyList(env[provider.keyEnv], env[`${provider.keyEnv}S`] || env.EIS_API_KEYS),
    trustProxy: positiveInt(env.EIS_TRUST_PROXY, DEFAULTS.trustProxy, { min: 0, max: 5 }),
    maxInflight: positiveInt(env.EIS_MAX_INFLIGHT, DEFAULTS.maxInflight, { min: 0, max: 64 }),
    dailyRequestCap: positiveInt(env.EIS_DAILY_REQUEST_CAP, DEFAULTS.dailyRequestCap, { min: 0, max: 1_000_000 }),
    depth: ['quick', 'balanced', 'deep'].includes(env.EIS_DEPTH) ? env.EIS_DEPTH : 'balanced',
    proseLanguage: env.EIS_LANGUAGE || 'en',
    timeoutMs: positiveInt(env.EIS_REQUEST_TIMEOUT_MS, DEFAULTS.timeoutMs, { min: 1000, max: 180000 }),
    retries: positiveInt(env.EIS_MAX_RETRIES, DEFAULTS.retries, { min: 0, max: 5 }),
    structuredOutput: env.EIS_STRUCTURED_OUTPUT !== 'false',
    // Every value that must never appear in a log, an error message or a response.
    // Failover signs with any of the pool keys, so scrubbing only the first one leaks
    // the rest: provider errors quote the request, and Google carries the key in a URL.
    secretValues: [...new Set([
      String(env[provider.keyEnv] || '').trim(),
      ...parseKeyList(env[provider.keyEnv], env[`${provider.keyEnv}S`] || env.EIS_API_KEYS),
      String(env.EIS_ACCESS_TOKEN || '').trim(),
    ].filter(Boolean))],
    allowedOrigins,
    // Empty means the API is open to same-origin callers only (still rate limited).
    accessToken: String(env.EIS_ACCESS_TOKEN || '').trim(),
    rateLimit: {
      requests: positiveInt(env.EIS_RATE_LIMIT, DEFAULTS.rateLimitRequests, { min: 1, max: 100000 }),
      windowMs: positiveInt(env.EIS_RATE_WINDOW_MS, DEFAULTS.rateLimitWindowMs, { min: 1000, max: 3600000 }),
      burst: positiveInt(env.EIS_RATE_BURST, DEFAULTS.burst, { min: 1, max: 1000 }),
    },
    maxBodyBytes: positiveInt(env.EIS_MAX_BODY_BYTES, DEFAULTS.maxBodyBytes, { min: 1024, max: 1024 * 1024 }),
    // SSE off when a reverse proxy buffers event-stream responses.
    streaming: env.EIS_STREAMING !== 'false',
    logLevel: env.EIS_LOG_LEVEL || 'info',
  };
}

function describeStartupProblems(config) {
  const problems = [];
  if (!config.apiKey) {
    problems.push(`No API key: set ${config.apiKeyEnv} in explain-it-simply-website/.env`);
  }
  if (!require('../../shared/providers').adapterSupports(config.providerId, 'adapter')) {
    problems.push(`Provider '${config.providerId}' has no adapter in this build.`);
  }
  if (config.host !== '127.0.0.1' && config.host !== 'localhost' && !config.accessToken) {
    problems.push(
      `EIS_HOST='${config.host}' exposes this endpoint beyond localhost without EIS_ACCESS_TOKEN — anyone reachable on that interface can spend your API key.`,
    );
  }
  return problems;
}

// Startup logging may say only whether a credential exists. A prefix, a suffix, an ellipsis mask or
// a digest is still key material: `sk-o…f6f1`-style masking puts real characters of a live key into
// stdout, and in a hosted deployment stdout is somebody else's log retention. Length is excluded for
// the same reason — it is a property of the value.
function describeKeyState(config) {
  return config.apiKey ? 'configured' : 'not configured';
}

module.exports = { readConfig, describeStartupProblems, describeKeyState, DEFAULTS: Object.freeze(DEFAULTS) };
