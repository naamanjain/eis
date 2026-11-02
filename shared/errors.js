'use strict';
// Error taxonomy for the AI core. Every failure that can leave the pipeline is
// one of these classes, so callers branch on `code`/`retryable` instead of
// parsing provider strings. Provider internals are summarised, never forwarded.

const REDACTION = '[redacted]';

const ERROR_CODES = {
  VALIDATION: 'VALIDATION_ERROR',
  CONFIGURATION: 'CONFIGURATION_ERROR',
  CONTEXT_TOO_LARGE: 'CONTEXT_TOO_LARGE',
  AUTHENTICATION: 'AUTHENTICATION_ERROR',
  RATE_LIMIT: 'RATE_LIMIT_ERROR',
  TIMEOUT: 'TIMEOUT_ERROR',
  NETWORK: 'NETWORK_ERROR',
  PROVIDER: 'PROVIDER_ERROR',
  MALFORMED_RESPONSE: 'MALFORMED_RESPONSE',
  CANCELLED: 'CANCELLED',
  UNKNOWN: 'UNKNOWN_ERROR',
};

// HTTP status the server uses when this error crosses the API boundary.
const STATUS_BY_CODE = {
  [ERROR_CODES.VALIDATION]: 400,
  [ERROR_CODES.CONFIGURATION]: 503,
  [ERROR_CODES.CONTEXT_TOO_LARGE]: 413,
  [ERROR_CODES.AUTHENTICATION]: 502,
  [ERROR_CODES.RATE_LIMIT]: 429,
  [ERROR_CODES.TIMEOUT]: 504,
  [ERROR_CODES.NETWORK]: 502,
  [ERROR_CODES.PROVIDER]: 502,
  [ERROR_CODES.MALFORMED_RESPONSE]: 502,
  [ERROR_CODES.CANCELLED]: 499,
  [ERROR_CODES.UNKNOWN]: 500,
};

class AppError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.retryable = !!options.retryable;
    this.status = options.status || STATUS_BY_CODE[code] || 500;
    this.providerId = options.providerId || null;
    this.cause = options.cause || undefined;
    this.details = options.details || null;
  }

  // Safe to send to a browser or a webview: no keys, no raw provider bodies.
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      provider: this.providerId || undefined,
    };
  }
}

class ValidationError extends AppError {
  constructor(message, details) {
    super(ERROR_CODES.VALIDATION, message, { retryable: false, details });
  }
}

class ConfigurationError extends AppError {
  constructor(message, options = {}) {
    super(ERROR_CODES.CONFIGURATION, message, { retryable: false, ...options });
  }
}

class ContextTooLargeError extends AppError {
  constructor(message, details) {
    super(ERROR_CODES.CONTEXT_TOO_LARGE, message, { retryable: false, details });
  }
}

class AuthenticationError extends AppError {
  constructor(message, providerId) {
    super(ERROR_CODES.AUTHENTICATION, message, { retryable: false, providerId });
  }
}

class RateLimitError extends AppError {
  constructor(message, providerId, details = {}) {
    super(ERROR_CODES.RATE_LIMIT, message, {
      retryable: true,
      providerId,
      details: { retryAfterMs: details.retryAfterMs ?? null },
    });
    this.retryAfterMs = details.retryAfterMs ?? null;
  }
}

class TimeoutError extends AppError {
  constructor(message, providerId, retryable = true) {
    super(ERROR_CODES.TIMEOUT, message, { retryable, providerId });
  }
}

class NetworkError extends AppError {
  constructor(message, providerId) {
    super(ERROR_CODES.NETWORK, message, { retryable: true, providerId });
  }
}

class ProviderError extends AppError {
  constructor(message, providerId, retryable = false) {
    super(ERROR_CODES.PROVIDER, message, { retryable, providerId });
  }
}

class MalformedResponseError extends AppError {
  constructor(message, providerId) {
    super(ERROR_CODES.MALFORMED_RESPONSE, message, { retryable: false, providerId });
  }
}

class CancelledError extends AppError {
  constructor(message = 'The request was cancelled.', providerId = null) {
    super(ERROR_CODES.CANCELLED, message, { retryable: false, providerId });
  }
}

class UnknownError extends AppError {
  constructor(message, cause) {
    super(ERROR_CODES.UNKNOWN, message, { retryable: false, cause });
  }
}

const CLASSES = {
  ValidationError,
  ConfigurationError,
  ContextTooLargeError,
  AuthenticationError,
  RateLimitError,
  TimeoutError,
  NetworkError,
  ProviderError,
  MalformedResponseError,
  CancelledError,
  UnknownError,
};

// Anything that is not already an AppError becomes one. Secrets supplied here are
// stripped from the message, because provider errors quote request URLs (Google
// carries the key in one).
function classify(error, options = {}) {
  const { providerId = null, secrets = [] } = options;
  if (error instanceof AppError) {
    error.message = redactSecrets(error.message, secrets);
    if (!error.providerId) error.providerId = providerId;
    return error;
  }
  if (isAbort(error)) {
    return new CancelledError('The request was cancelled.', providerId);
  }
  const raw = error && error.message ? error.message : String(error);
  const message = redactSecrets(truncate(raw), secrets);
  if (isTimeoutLike(error, message)) {
    return new TimeoutError(message, providerId, true);
  }
  if (/ENOTFOUND|ECONNREFUSED|EAI_AGAIN|network|proxy/i.test(message) || ['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN'].includes(error && error.code)) {
    return new NetworkError(message, providerId);
  }
  const wrapped = new UnknownError(message || 'Unexpected internal error.', error);
  wrapped.providerId = providerId;
  // Without the original frame, an internal bug looks like a mystery: keep the
  // cause's stack attached (secrets are scrubbed by the logger on the way out).
  if (error && typeof error.stack === 'string') {
    wrapped.stack = `${wrapped.stack}\nCaused by: ${error.stack}`;
  }
  return wrapped;
}

// Node reports a socket timeout as ETIMEDOUT, and our own client raises
// TimeoutError; both must not be reclassified as a generic network fault.
function isTimeoutLike(error, message) {
  if (error && error.code === 'ETIMEDOUT') return true;
  return /timeout|timed out|socket hang up/i.test(message);
}

function isAbort(error) {
  return !!error && (error.name === 'AbortError' || error.code === 'ABORT_ERR');
}

function redactSecrets(text, secrets = []) {
  let out = String(text == null ? '' : text);
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 6) {
      out = out.split(secret).join(REDACTION);
    }
  }
  return out;
}

function truncate(text, max = 300) {
  const oneLine = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

// Short human hint per error class, used by UIs that want a sentence rather than
// a code. Deliberately free of provider internals.
const USER_HINTS = {
  [ERROR_CODES.VALIDATION]: 'Check the text you sent.',
  [ERROR_CODES.CONFIGURATION]: 'The provider or model is not set up on this machine.',
  [ERROR_CODES.CONTEXT_TOO_LARGE]: 'Too much text for one request — select a smaller part.',
  [ERROR_CODES.AUTHENTICATION]: 'The API key was rejected. Re-check it in settings.',
  [ERROR_CODES.RATE_LIMIT]: 'The provider is rate-limiting. Try again shortly.',
  [ERROR_CODES.TIMEOUT]: 'The provider took too long to answer.',
  [ERROR_CODES.NETWORK]: 'No connection to the provider.',
  [ERROR_CODES.PROVIDER]: 'The provider returned an error.',
  [ERROR_CODES.MALFORMED_RESPONSE]: 'The provider answer could not be read as an explanation.',
  [ERROR_CODES.CANCELLED]: 'Superseded by a newer request.',
  [ERROR_CODES.UNKNOWN]: 'Something went wrong.',
};

function userHint(error) {
  return USER_HINTS[error && error.code] || USER_HINTS[ERROR_CODES.UNKNOWN];
}

module.exports = {
  ERROR_CODES,
  REDACTION,
  STATUS_BY_CODE,
  USER_HINTS,
  AppError,
  CLASSES,
  ValidationError,
  ConfigurationError,
  ContextTooLargeError,
  AuthenticationError,
  RateLimitError,
  TimeoutError,
  NetworkError,
  ProviderError,
  MalformedResponseError,
  CancelledError,
  UnknownError,
  classify,
  isAbort,
  redactSecrets,
  truncate,
  userHint,
};
