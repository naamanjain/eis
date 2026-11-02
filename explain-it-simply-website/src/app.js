'use strict';
// Express wiring, in order: headers, origin control, access gate, body limit,
// rate limit, API, static files, fallbacks. Only ./public is served — the
// project root is never reachable over HTTP.

const path = require('path');
const express = require('express');
const { createCore } = require('../../shared/index.js');
const registry = require('../../shared/providers/registry');
const prompts = require('../../shared/prompts/tasks');
const { createLogger } = require('../../shared/observability/logger');
const { createSecurityHeaders, createCors, createAccessGate, createRateLimiter, createInflightLimiter, createDailyBudget } = require('./middleware/security');
const { createNotFoundHandler, createErrorHandler } = require('./middleware/errorHandler');
const { createExplainRouter, MAX_QUERY_CHARS, ALLOWED_TASKS } = require('./routes/explain');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function createApp(config, options = {}) {
  const logger = options.logger || createLogger({ name: 'eis-web', level: config.logLevel, secrets: config.secretValues });
  const core = options.core || createCore({
    providerId: config.providerId,
    model: config.model,
    apiKey: config.apiKey,
    apiKeys: config.apiKeys,
    depth: config.depth,
    proseLanguage: config.proseLanguage,
    timeoutMs: config.timeoutMs,
    retries: config.retries,
    structuredOutput: config.structuredOutput,
    logger,
    transport: options.transport,
  });

  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');

  app.use(createSecurityHeaders(config));
  app.use(createCors(config));

  // The API is gated; the static frontend is not, so a visitor can still load
  // the page and be told what is required.
  app.use('/api', createAccessGate(config));
  app.use('/api', createRateLimiter(config));
  // Concurrency and daily spend are charged per process, which is the honest
  // scope for an in-memory guard.
  app.use('/api/explain', createInflightLimiter(config));
  app.use('/api/explain', createDailyBudget(config));

  app.use(express.json({ limit: `${Math.ceil(config.maxBodyBytes / 1024)}kb`, strict: true }));

  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      provider: config.providerId,
      model: config.model,
      keyConfigured: !!config.apiKey,
      keysConfigured: (config.apiKeys || []).length,
      rateLimit: config.rateLimit,
      limits: { maxInflight: config.maxInflight, dailyRequestCap: config.dailyRequestCap },
      // Never a key value or its length: only which slots are cooling down.
      keyPool: typeof core.keyPoolStatus === 'function'
        ? core.keyPoolStatus().map((entry) => ({ index: entry.index, blocked: entry.blocked, reason: entry.reason }))
        : undefined,
    });
  });

  // Everything the UI needs to draw real, working controls. No key values and
  // no environment variable names are exposed here.
  app.get('/api/catalog', (req, res) => {
    const catalog = registry.toPublicConfig();
    res.json({
      ok: true,
      ...catalog,
      selected: { providerId: config.providerId, model: config.model, depth: config.depth },
      depths: ['quick', 'balanced', 'deep'],
      tasks: prompts.listTasks().filter((task) => ALLOWED_TASKS.has(task.id)),
      limits: { maxQueryChars: MAX_QUERY_CHARS },
      // SSE can be switched off for deployments behind a proxy that buffers it.
      streaming: config.streaming !== false,
      requiresToken: !!config.accessToken,
    });
  });

  app.use('/api/explain', createExplainRouter({ core, config, logger }));

  app.use(express.static(PUBLIC_DIR, { index: 'index.html', extensions: false }));

  app.use(createNotFoundHandler(logger));
  app.use(createErrorHandler(() => [config.apiKey, config.accessToken], logger));

  app.set('logger', logger);
  return app;
}

module.exports = { createApp, PUBLIC_DIR };
