'use strict';
// Bridges the shared error taxonomy to HTTP: an ApiError is an AppError plus the
// status to answer with. Codes, redaction and hints come from shared/errors.

const shared = require('../../shared/errors');

class ApiError extends Error {
  constructor(code, message, status, cause) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status || shared.STATUS_BY_CODE[code] || 500;
    // A caller may retry a 429 or a server-side failure; 4xx of any other kind is
    // their request being wrong.
    this.retryable = code === shared.ERROR_CODES.RATE_LIMIT || this.status >= 500;
    this.cause = cause;
  }

  toJSON() {
    return { ok: false, error: { code: this.code, message: this.message, retryable: this.retryable } };
  }
}

// Errors raised inside middleware where an express error is wanted.
function toApiError(error, secrets) {
  // body-parser reports malformed JSON as 400 and an oversized body as 413; both
  // are the caller's problem and must not be dressed up as internal failures.
  // Errors that already carry a taxonomy code (including CANCELLED's 499) keep it.
  const upstream = error && (error.status || error.statusCode);
  if (!(error instanceof ApiError) && !error.code && typeof upstream === 'number' && upstream >= 400 && upstream < 500) {
    const message = upstream === 413
      ? 'That request body is larger than this endpoint accepts.'
      : shared.redactSecrets(error.message || 'The request body is not valid JSON.', secrets);
    return new ApiError(shared.ERROR_CODES.VALIDATION, message, upstream, error);
  }

  const classified = shared.classify(error, { secrets });
  if (classified instanceof ApiError) return classified;
  const status = shared.STATUS_BY_CODE[classified.code] || 500;
  const wrapped = new ApiError(classified.code, classified.message, status, classified.cause);
  wrapped.retryable = !!classified.retryable;
  wrapped.providerId = classified.providerId;
  return wrapped;
}

module.exports = {
  ERROR_CODES: shared.ERROR_CODES,
  STATUS_BY_CODE: shared.STATUS_BY_CODE,
  ApiError,
  toApiError,
  shared,
  ...shared,
};
