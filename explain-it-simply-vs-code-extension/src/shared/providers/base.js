/* Vendored from ../shared/providers/base.js — do not edit here; run `npm run vendor`. */
'use strict';
// Shared behaviour for provider adapters: turn an HTTP response into a typed
// error, and read the small amount of metadata every adapter needs.

const {
  ERROR_CODES,
  AuthenticationError,
  RateLimitError,
  ProviderError,
  ValidationError,
  MalformedResponseError,
  truncate,
  redactSecrets,
} = require('../errors');
const { retryAfterMs } = require('../http/client');

/**
 * The contract every adapter honours when an HTTP response has to become an error.
 * Documented here because this is the boundary that sees raw provider text: `secrets`
 * is the list of values that must never survive into `message`, and forgetting it at
 * one call site is the exact defect `npm run typecheck` now catches.
 *
 * @typedef {Object} ResponseFailure
 * @property {string} providerId
 * @property {number} status
 * @property {Record<string, string>} [headers]
 * @property {string} text
 * @property {string[]} [secrets]
 * @property {string} [model]
 *
 * @typedef {Object} ContentText
 * @property {string} providerId
 * @property {string} text
 * @property {string[]} [secrets]
 */

// The key can appear in a provider error body (Google echoes the request), so
// every message is scrubbed here, at the lowest boundary that sees raw text.
// Providers report a bad key in both word orders ("API key not valid", "Invalid API
// key"), and some do it with a 400. The noun has to name a credential: matching a bare
// "key" would cool down a healthy key over a cache key or a sort key.
const BAD_KEY_WORDS = /(?:invalid|expired|revoked|missing|absent|unsupported)[^a-z]{0,6}(?:this |the |your |an |a )?(?:api|access|secret|x-api|auth|developer|service)[ _-]?(?:key|apikey|token)|(?:api|access|secret|x-api|auth|developer|service)[ _-]?(?:key|apikey|token).{0,20}?(?:not valid|invalid|expired|revoked|missing|required)/i;

/** @param {string} text @returns {any} */
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** @param {any} errorBody @returns {string} */
function providerMessage(errorBody) {
  if (!errorBody) return '';
  if (typeof errorBody === 'string') return errorBody;
  const err = errorBody.error;
  if (typeof err === 'string') return err;
  if (err && typeof err.message === 'string') return err.message;
  if (typeof errorBody.message === 'string') return errorBody.message;
  if (err && err.code && typeof err.code === 'string') return err.code;
  return '';
}

// Maps an HTTP failure to the taxonomy. 401/403 -> AuthenticationError,
// 429 -> RateLimitError (carrying Retry-After), 400/404/422 -> usually a bad
// model or a bad request, 5xx -> ProviderError.
/** @param {ResponseFailure} failure @returns {Error} */
function classifyResponse({ providerId, status, headers, text, secrets = [], model }) {
  const body = parseJson(text);
  const detail = truncate(redactSecrets(providerMessage(body) || text || '', secrets), 240);
  const lower = detail.toLowerCase();

  if (status === 401 || status === 403) {
    return new AuthenticationError(
      /key|credential|unauthor/i.test(detail) ? detail : 'The provider rejected this API key.',
      providerId,
    );
  }
  // Some providers report a bad key as 400 rather than 401 (Google does), so the
  // wording is checked too: "API key not valid" must not look like a generic provider
  // failure that a retry could fix. The noun has to name a credential — matching a bare
  // "key" would put a healthy key on a five-minute cooldown over a cache key.
  if (status === 400 && BAD_KEY_WORDS.test(lower)) {
    return new AuthenticationError(detail || 'The provider rejected this API key.', providerId);
  }

  if (status === 429) {
    const retryMs = retryAfterMs(headers || {});
    return new RateLimitError(
      retryMs ? `Rate limited by ${providerId}. Retry in ${Math.ceil(retryMs / 1000)}s.` : `${providerId} is rate-limiting this key.`,
      providerId,
      { retryAfterMs: retryMs },
    );
  }
  if (status === 404 || /model.*(not (found|exist))|unknown model|invalid model/i.test(lower)) {
    return new ProviderError(
      `This model is unavailable${model ? ` ('${truncate(model, 60)}')` : ''}. Choose another model or refresh the model list.`,
      providerId,
      false,
    );
  }
  if (status === 400 || status === 422) {
    // The provider understood us but refused the content: usually context size.
    if (/too long|token|context|maximum|size/i.test(lower)) {
      return new ValidationError(`The provider refused this request: ${detail}`, { providerId });
    }
    return new ProviderError(`${providerId} rejected the request: ${detail}`, providerId, false);
  }
  if (status >= 500) {
    return new ProviderError(`${providerId} is having trouble right now: ${detail || `HTTP ${status}`}`, providerId, true);
  }
  return new ProviderError(`${providerId} returned HTTP ${status}: ${detail}`, providerId, false);
}

/** @param {ContentText} input @returns {string} */
function expectContentText({ providerId, text, secrets }) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new MalformedResponseError(`${providerId} returned no content.`, providerId);
  }
  return redactSecrets(text, secrets);
}

/**
 * Token counts are reported as the provider supplies them. A provider that gives only
 * one side leaves the other `undefined` rather than inventing a zero, so callers must
 * treat each count as possibly absent.
 *
 * @param {any} body
 * @returns {{ inputTokens: number|undefined, outputTokens: number|undefined }|null}
 */
function usageOf(body) {
  if (!body || typeof body !== 'object') return null;
  const raw = body.usage || body.tokenUsage || body.response?.usageMetadata || body.usageMetadata;
  if (!raw) return null;
  const pick = (...keys) => {
    for (const key of keys) {
      const value = raw[key];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return undefined;
  };
  const input = pick('prompt_tokens', 'input_tokens', 'promptTokenCount');
  const output = pick('completion_tokens', 'output_tokens', 'candidatesTokenCount');
  if (input === undefined && output === undefined) return null;
  return { inputTokens: input, outputTokens: output };
}

module.exports = {
  ERROR_CODES,
  parseJson,
  providerMessage,
  classifyResponse,
  expectContentText,
  usageOf,
};
