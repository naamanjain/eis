'use strict';
// HTTP surface for explanations. Streaming uses Server-Sent Events so the site
// can show progress without fake timers; providers that fail mid-stream surface
// an `error` event instead of a truncated answer.

const express = require('express');
const { ApiError, toApiError, ERROR_CODES } = require('../errors');
const { redactSecrets } = require('../../../shared/errors');

const MAX_QUERY_CHARS = 4000;
const ALLOWED_TASKS = new Set([
  'explain-topic', 'explain-code', 'explain-error', 'find-issues',
  'teach-me', 'give-example', 'simplify', 'optimize', 'add-comments', 'generate-test',
]);
const ALLOWED_LANGUAGES = new Set(['', 'javascript', 'typescript', 'python', 'java', 'kotlin', 'go', 'rust', 'c', 'cpp', 'csharp', 'php', 'ruby', 'swift', 'sql', 'shell', 'html', 'css', 'yaml', 'json', 'markdown', 'other']);

function parseRequestBody(raw) {
  let parsed;
  try {
    parsed = typeof raw === 'string' && raw.trim() ? JSON.parse(raw) : (raw || {});
  } catch (error) {
    throw new ApiError(ERROR_CODES.VALIDATION, 'The request body is not valid JSON.', 400);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ApiError(ERROR_CODES.VALIDATION, 'Expected an object with a "subject" or "query".', 400);
  }
  return parsed;
}

function buildRequest(body, config) {
  // Types are checked, not coerced: {"query": 42} is a mistake the caller should
  // hear about instead of getting an answer about "42".
  const given = body.subject !== undefined ? body.subject : body.query;
  if (given !== undefined && typeof given !== 'string') {
    throw new ApiError(ERROR_CODES.VALIDATION, '"subject" must be a string.', 400);
  }
  const subject = String(given || '').trim();
  if (!subject) {
    throw new ApiError(ERROR_CODES.VALIDATION, 'Send a non-empty "subject" (or "query").', 400);
  }
  if (subject.length > MAX_QUERY_CHARS) {
    throw new ApiError(
      ERROR_CODES.VALIDATION,
      `That is ${subject.length} characters; this endpoint answers up to ${MAX_QUERY_CHARS}. Explain a file in the VS Code extension instead.`,
      400,
    );
  }

  const requestedTask = body.task || (body.kind === 'code' || looksLikeCode(subject) ? 'explain-code' : 'explain-topic');
  if (!ALLOWED_TASKS.has(requestedTask)) {
    throw new ApiError(ERROR_CODES.VALIDATION, `Task '${requestedTask}' is not available here.`, 400);
  }

  const depth = ['quick', 'balanced', 'deep'].includes(body.depth) ? body.depth : config.depth;
  const language = typeof body.language === 'string' && ALLOWED_LANGUAGES.has(body.language.toLowerCase())
    ? body.language.toLowerCase()
    : '';

  return {
    task: requestedTask,
    subject,
    depth,
    language,
    fileName: typeof body.fileName === 'string' ? body.fileName.slice(0, 120) : '',
    // The browser has no file system: no surrounding context is mined, and the
    // request states that plainly rather than pretending otherwise.
    fullDocument: '',
    cursorLine: null,
    diagnostics: '',
  };
}

function looksLikeCode(text) {
  return /\n/.test(text) && (/[{};]\s*$/.test(text) || /^\s{2,}\S/m.test(text) || /\b(function|def|class|return|import)\b/.test(text));
}

function createExplainRouter({ core, config, logger }) {
  const router = express.Router();

  // Abandon the provider call only when the client truly went away. `req`'s
  // close event fires as soon as the body has been read, which would cancel a
  // perfectly healthy request in flight; the response is the right signal.
  function watchDisconnect(req, res, controller) {
    res.on('close', () => {
      if (!res.writableEnded && !controller.signal.aborted) {
        controller.abort(new Error('The browser closed the connection.'));
      }
    });
  }

  router.post('/', async (req, res, next) => {
    let request;
    try {
      request = buildRequest(parseRequestBody(req.body), config);
    } catch (error) {
      return next(error);
    }

    const abort = new AbortController();
    watchDisconnect(req, res, abort);

    try {
      const { result, meta } = await core.explain({ ...request, signal: abort.signal });
      logger.info('explain.ok', {
        requestId: meta.requestId,
        task: meta.task,
        depth: meta.depth,
        provider: meta.provider,
        model: meta.model,
        latencyMs: meta.latencyMs,
        chars: meta.context.chars,
        retries: meta.retries,
        shortfalls: meta.missingFields.length,
      });
      return res.json({ ok: true, requestId: meta.requestId, meta, result });
    } catch (error) {
      const apiError = toApiError(error, config.secretValues);
      logger.error('explain.fail', { code: apiError.code, message: apiError.message, route: 'POST /api/explain' });
      return next(apiError);
    }
  });

  // Streaming: `delta` events while the provider talks, then one `result`.
  router.post('/stream', async (req, res) => {
    let request;
    try {
      request = buildRequest(parseRequestBody(req.body), config);
    } catch (error) {
      res.status(error.status || 400).json(toApiError(error, config.secretValues).toJSON());
      return undefined;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const abort = new AbortController();
    watchDisconnect(req, res, abort);
    send('accepted', { task: request.task, depth: request.depth, provider: config.providerId, model: config.model });

    try {
      const { result, meta } = await core.explain({
        ...request,
        signal: abort.signal,
        onDelta: (piece) => send('delta', { text: redactSecrets(piece, config.secretValues) }),
      });
      send('result', { requestId: meta.requestId, meta, result });
    } catch (error) {
      const apiError = toApiError(error, config.secretValues);
      logger.error('stream.fail', { code: apiError.code, message: apiError.message });
      send('error', apiError.toJSON().error);
    } finally {
      res.end();
    }
    return undefined;
  });

  return router;
}

module.exports = { createExplainRouter, buildRequest, parseRequestBody, looksLikeCode, MAX_QUERY_CHARS, ALLOWED_TASKS };
