'use strict';
// Bounded retry policy. Only errors explicitly marked retryable are retried:
// invalid input, bad keys, unavailable models and unreadable replies fail fast,
// because repeating them produces the same answer at the user's cost.

const { CancelledError, ERROR_CODES } = require('../errors');

const DEFAULTS = {
  attempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8000,
  rateLimitCapMs: 20_000,
};

const NEVER_RETRY = new Set([
  ERROR_CODES.VALIDATION,
  ERROR_CODES.CONFIGURATION,
  ERROR_CODES.CONTEXT_TOO_LARGE,
  ERROR_CODES.AUTHENTICATION,
  ERROR_CODES.MALFORMED_RESPONSE,
  ERROR_CODES.CANCELLED,
  ERROR_CODES.UNKNOWN,
]);

function isRetryable(error) {
  if (!error) return false;
  if (error instanceof CancelledError) return false;
  if (NEVER_RETRY.has(error.code)) return false;
  return !!error.retryable;
}

// Exponential backoff with full jitter; honours a provider's Retry-After.
function delayFor(attempt, error, options) {
  if (error && error.code === ERROR_CODES.RATE_LIMIT && error.retryAfterMs != null) {
    return Math.min(Math.max(0, error.retryAfterMs), options.rateLimitCapMs);
  }
  const exponential = options.baseDelayMs * (2 ** (attempt - 1));
  const capped = Math.min(exponential, options.maxDelayMs);
  return Math.round(capped * (0.5 + options.random() * 0.5));
}

async function withRetry(operation, options = {}) {
  const settings = {
    attempts: options.attempts ?? DEFAULTS.attempts,
    baseDelayMs: options.baseDelayMs ?? DEFAULTS.baseDelayMs,
    maxDelayMs: options.maxDelayMs ?? DEFAULTS.maxDelayMs,
    rateLimitCapMs: options.rateLimitCapMs ?? DEFAULTS.rateLimitCapMs,
    random: options.random || Math.random,
    sleep: options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    signal: options.signal || null,
    onRetry: options.onRetry || null,
    // With several keys, a 429 is not worth waiting out on the key that got it: give up
    // on this attempt so the caller can fail over instead of sleeping first.
    rotateRateLimit: options.rotateRateLimit === true,
  };
  if (settings.attempts < 1) settings.attempts = 1;

  let lastError = null;
  for (let attempt = 1; attempt <= settings.attempts; attempt += 1) {
    if (settings.signal && settings.signal.aborted) throw new CancelledError();
    try {
      // The operation is told which attempt this is, so it can mark its own
      // metadata and refuse to replay after a partial stream.
      const result = await operation({ attempt, retriesLeft: settings.attempts - attempt });
      if (result && typeof result === 'object') {
        return { ...result, retries: attempt - 1 };
      }
      return result;
    } catch (error) {
      lastError = error;
      if (error instanceof CancelledError) throw error;
      if (!isRetryable(error)) throw error;
      if (settings.rotateRateLimit && error && error.code === ERROR_CODES.RATE_LIMIT) throw error;
      if (attempt >= settings.attempts) break;
      const delayMs = delayFor(attempt, error, settings);
      if (settings.onRetry) {
        settings.onRetry({ attempt, delayMs, error });
      }
      await sleepWithAbort(delayMs, settings);
    }
  }
  throw lastError;
}

async function sleepWithAbort(ms, settings) {
  if (ms <= 0) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new CancelledError());
    };
    if (settings.signal) {
      if (settings.signal.aborted) {
        abort();
        return;
      }
      settings.signal.addEventListener('abort', abort, { once: true });
    }
  });
}

module.exports = { DEFAULTS, NEVER_RETRY, isRetryable, delayFor, withRetry };
