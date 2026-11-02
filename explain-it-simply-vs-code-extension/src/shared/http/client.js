/* Vendored from ../shared/http/client.js — do not edit here; run `npm run vendor`. */
'use strict';
// One HTTP client for every provider, so timeouts, cancellation, size caps and
// error classification are implemented once. Node built-ins only: it must run in
// the VS Code extension host as well as in the website server.

const http = require('http');
const https = require('https');
const {
  ERROR_CODES,
  TimeoutError,
  NetworkError,
  CancelledError,
  ProviderError,
  truncate,
  isAbort,
} = require('../errors');

const DEFAULT_TIMEOUT_MS = 45000;
// A stalled stream is worse than a slow one: the reader sees a spinner that never
// resolves. Nothing legitimate goes this long between chunks.
const IDLE_TIMEOUT_MS = 20000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

// Sends a request and buffers the whole response. Non-2xx is returned, not
// thrown: the adapter decides which error class a status means.
function requestJson(options) {
  return runRequest({ ...options, accumulate: 'buffer' });
}

// Sends a streaming request and decodes Server-Sent Events as they arrive.
// Returns the buffered body for non-2xx so the adapter can read the error JSON.
function requestStream(options, onEvent) {
  return runRequest({ ...options, accumulate: 'sse', onEvent });
}

function runRequest({
  hostname,
  path,
  headers = {},
  body,
  method = 'POST',
  protocol = 'https:',
  port,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  idleMs = Math.min(timeoutMs, IDLE_TIMEOUT_MS),
  maxBytes = MAX_RESPONSE_BYTES,
  signal,
  accumulate,
  onEvent,
}) {
  const payload = body === undefined || body === null ? null : JSON.stringify(body);
  const lib = protocol === 'http:' ? http : https;

  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new CancelledError());
      return;
    }

    const request = lib.request(
      {
        protocol,
        hostname,
        port,
        path,
        method,
        headers: {
          ...(payload === null
            ? {}
            : {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload),
            }),
          ...headers,
        },
      },
      (response) => {
        const status = response.statusCode || 0;
        const headersOut = response.headers || {};
        gotResponse = true;
        // Headers arriving is not the response finishing: keep the idle guard running
        // while bytes come in, and reset it on every chunk.
        response.on('data', armIdle);

        // Error bodies are small and always needed for classification, so a
        // failure response is buffered even on the streaming path.
        if (status < 200 || status >= 300) {
          collect(response, maxBytes).then((text) => succeed({ status, headers: headersOut, text }), fail);
          return;
        }

        if (accumulate === 'sse') {
          const { SseDecoder } = require('./sse');
          const decoder = new SseDecoder((event) => {
            if (onEvent) onEvent(event);
          });
          streamText(response, decoder, maxBytes)
            .then(() => {
              decoder.flush();
              succeed({ status, headers: headersOut, text: '' });
            })
            .catch(fail);
          return;
        }

        collect(response, maxBytes).then((text) => succeed({ status, headers: headersOut, text }), fail);
      },
    );

    // Two independent guards, both live until the body is fully read:
    //  - `deadline`: the whole exchange, so a request cannot sit open forever;
    //  - `idleTimer`: a provider that sends a few bytes and then stalls.
    // Clearing the timer on the response event, as this used to, left the body
    // unbounded: a rambling reasoning model could hold a request — and on the
    // website an in-flight slot — open indefinitely.
    let settled = false;
    let gotResponse = false;
    let deadline = null;
    let idleTimer = null;
    const stop = () => {
      if (deadline) clearTimeout(deadline);
      if (idleTimer) clearTimeout(idleTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      stop();
      reject(error instanceof Error ? error : toTransportError(error));
    };
    const succeed = (value) => {
      if (settled) return;
      settled = true;
      stop();
      resolve(value);
    };
    const onAbort = () => {
      const error = new CancelledError();
      request.destroy(error);
      fail(error);
    };
    function armIdle() {
      if (settled) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        const error = new TimeoutError(`The provider went quiet for ${Math.round(idleMs / 1000)}s.`, null, true);
        request.destroy(error);
        fail(error);
      }, idleMs);
      if (idleTimer.unref) idleTimer.unref();
    }

    deadline = setTimeout(() => {
      const error = new TimeoutError(`The provider did not respond within ${Math.round(timeoutMs / 1000)}s.`, null, true);
      request.destroy(error);
      fail(error);
    }, timeoutMs);
    if (deadline.unref) deadline.unref();
    armIdle();

    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    request.on('error', fail);
    request.on('close', () => {
      // Node also emits 'close' after a perfectly good response, so only a close that
      // happens before any response counts as a transport failure.
      if (!settled && !gotResponse) fail(new NetworkError('The connection to the provider closed before the response finished.'));
    });

    if (payload !== null) request.write(payload);
    request.end();
  });
}

function collect(response, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    response.on('data', (chunk) => {
      received += chunk.length;
      if (received > maxBytes) {
        response.destroy();
        reject(new ProviderError('The provider response was too large to process.', null, false));
        return;
      }
      chunks.push(chunk);
    });
    response.on('error', (error) => reject(toTransportError(error)));
    response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function streamText(response, decoder, maxBytes) {
  return new Promise((resolve, reject) => {
    let received = 0;
    response.setEncoding('utf8');
    response.on('data', (chunk) => {
      received += chunk.length;
      if (received > maxBytes) {
        response.destroy();
        reject(new ProviderError('The provider stream exceeded the size limit.', null, false));
        return;
      }
      decoder.push(chunk);
    });
    response.on('error', (error) => reject(toTransportError(error)));
    response.on('end', resolve);
  });
}

function toTransportError(error) {
  if (error instanceof TimeoutError) return error;
  if (error instanceof CancelledError) return error;
  if (isAbort(error)) return new CancelledError();
  if (error && (error.code === 'ETIMEDOUT' || /timed out/i.test(error.message || ''))) {
    return new TimeoutError(error.message, null, true);
  }
  if (error && ['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'ECONNRESET', 'EPIPE'].includes(error.code)) {
    return new NetworkError(`Could not reach the provider (${error.code}).`, null);
  }
  return new NetworkError(truncate(error && error.message ? error.message : error, 160) || 'Network request failed.', null);
}

// Reads Retry-After (seconds or HTTP date) into milliseconds.
function retryAfterMs(headers = {}) {
  const raw = headers['retry-after'];
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

module.exports = {
  requestJson,
  requestStream,
  retryAfterMs,
  toTransportError,
  DEFAULT_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  ERROR_CODES,
};
