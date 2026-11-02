'use strict';
// Turns any thrown value into one response shape, and logs only what a reader
// needs: a code, a route, and a safe message.

const { ApiError, toApiError } = require('../errors');
const { ERROR_CODES } = require('../../../shared/errors');

function createNotFoundHandler(logger) {
  return (req, res) => {
    res.status(404).json({
      ok: false,
      error: { code: ERROR_CODES.VALIDATION, message: `No route for ${req.method} ${req.path}`, retryable: false },
    });
    if (logger) logger.warn('route.missing', { method: req.method, path: req.path });
  };
}

function createErrorHandler(getSecrets, logger) {
  return (error, req, res, next) => {
    if (res.headersSent) return next(error);

    const secrets = getSecrets ? getSecrets() : [];
    const wrapped = error instanceof ApiError ? error : toApiError(error, secrets);

    // A 5xx is this server's problem and belongs in the log; a 4xx is the
    // caller's, and they already got the message.
    if (wrapped.status >= 500) {
      if (logger) logger.error('http.fail', { code: wrapped.code, message: wrapped.message, route: `${req.method} ${req.path}` });
      else console.error(`[${wrapped.code}] ${req.method} ${req.path} -> ${wrapped.message}`);
    }

    return res.status(wrapped.status).json(wrapped.toJSON());
  };
}

module.exports = { createNotFoundHandler, createErrorHandler };
