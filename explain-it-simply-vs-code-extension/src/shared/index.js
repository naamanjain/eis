/* Vendored from ../shared/index.js — do not edit here; run `npm run vendor`. */
'use strict';
// Public surface of the AI core. Both the VS Code extension host and the website
// server talk to this and nothing else; UI code never sees provider internals.

const registry = require('./providers/registry');
const { KeyPool } = require('./providers/keyPool');
const { createAdapter, checkConfiguration, adapterSupports } = require('./providers');
const pipeline = require('./pipeline/pipeline');
const prompts = require('./prompts/tasks');
const errors = require('./errors');
const { Ledger } = require('./pipeline/requestLedger');
const { createLogger } = require('./observability/logger');
const { extractJsonObject } = require('./ai/extractJson');
const { ConfigurationError } = require('./errors');

const DEFAULTS = {
  providerId: 'google',
  model: null,
  apiKey: '',
  depth: 'balanced',
  proseLanguage: 'en',
  timeoutMs: 45000,
  retries: 3,
  structuredOutput: true,
  allowCustomModel: true,
};

function createCore(userConfig = {}) {
  const state = {
    ...DEFAULTS,
    ...userConfig,
    limits: { ...(userConfig.limits || {}) },
  };
  const logger = userConfig.logger || createLogger({
    name: 'eis',
    level: userConfig.logLevel || 'info',
    sink: userConfig.logSink,
    errorSink: userConfig.errorSink,
    secrets: [state.apiKey],
  });

  // The pool must outlive a single request: that is what makes a cooldown mean
  // anything. Rebuilt only when the configured key set changes.
  let sharedPool = null;
  let sharedPoolSignature = null;
  function poolFor() {
    const keys = state.apiKeys && state.apiKeys.length ? state.apiKeys : [state.apiKey];
    const signature = keys.join('|');
    if (!sharedPool || signature !== sharedPoolSignature) {
      sharedPool = state.keyPool || new KeyPool(keys);
      sharedPoolSignature = signature;
    }
    return sharedPool;
  }

  function publicConfig() {
    return {
      providerId: state.providerId,
      model: state.model || registry.defaultModelFor(state.providerId),
      depth: state.depth,
      proseLanguage: state.proseLanguage,
      hasKey: !!state.apiKey,
    };
  }

  function setConfig(patch = {}) {
    Object.assign(state, patch);
    // Every key the pool can sign a request with must be scrubbed, not just the first:
    // provider errors quote the request, and failover moves between keys.
    const secrets = [state.apiKey, ...(state.apiKeys || [])].filter(Boolean);
    if (secrets.length) logger.setSecrets(secrets);
    if (patch.clearApiKey) state.apiKey = '';
    return publicConfig();
  }

  function adapterFor(overrides = {}) {
    const providerId = overrides.providerId || state.providerId;
    const model = overrides.model || state.model || registry.defaultModelFor(providerId);
    const apiKey = overrides.apiKey ?? state.apiKey;
    return createAdapter({
      providerId,
      model,
      apiKey,
      timeoutMs: overrides.timeoutMs ?? state.timeoutMs,
      transport: overrides.transport || userConfig.transport,
      structuredOutput: overrides.structuredOutput ?? state.structuredOutput,
    });
  }

  async function explain(input = {}) {
    const startedAt = Date.now();
    logger.info('explain.start', {
      task: input.task,
      depth: input.depth || state.depth,
      provider: input.providerId || state.providerId,
      subjectChars: (input.subject || '').length,
      contextChars: (input.fullDocument || '').length,
    });
    try {
      const pool = poolFor();
      let lastError = null;
      const tried = [];
      for (let attempt = 0; ; attempt += 1) {
        const index = pool.acquire(tried);
        if (index === -1) {
          const last = tried.length ? lastError : null;
          if (last) throw last;
          throw new ConfigurationError(
            tried.length
              ? 'Every configured key is on cooldown after provider rejections. Wait a minute, or add another key.'
              : 'No API key is configured for this provider.',
          );
        }
        state.apiKey = pool.keys[index];
        tried.push(index);
        let outcome;
        try {
          outcome = await pipeline.runRequest(state, input, {
            // `transport` is the seam tests use to replace the network layer.
            transport: state.transport || userConfig.transport,
            retries: state.retries,
            rotateRateLimit: pool.size > 1,
            timeoutMs: state.timeoutMs,
            sleep: userConfig.sleep,
            random: userConfig.random,
            onRetry: (info) => logger.warn('provider.retry', {
              attempt: info.attempt, delayMs: info.delayMs, errorCode: info.error && info.error.code,
            }),
          });
        } catch (error) {
          lastError = error;
          // Rotate only for credential-shaped failures; a bad model or an
          // unreadable reply would fail identically on the next key.
          if (pool.size > 1 && KeyPool.shouldRotate(error)) {
            pool.penalize(index, error.code);
            logger.warn('key.rotate', { from: index, reason: error.code, remaining: pool.size - tried.length });
            continue;
          }
          throw error;
        }
        if (pool.size > 1) pool.release(index);
        pool.advance();
        const withKeys = {
          ...outcome,
          meta: { ...outcome.meta, keyIndex: index, keysConfigured: pool.size, keysTried: tried.length },
        };
        logger.info('explain.done', {
          requestId: outcome.meta.requestId,
          provider: outcome.meta.provider,
          model: outcome.meta.model,
          latencyMs: outcome.meta.latencyMs,
          retries: outcome.meta.retries,
          keyIndex: index,
          truncated: outcome.meta.context.truncated,
          shortfall: outcome.meta.missingFields.length,
        });
        return withKeys;
      }
    } catch (error) {
      const classified = errors.classify(error, {
        providerId: input.providerId || state.providerId,
        secrets: [state.apiKey],
      });
      logger.error('explain.fail', {
        errorCode: classified.code,
        message: classified.message,
        provider: classified.providerId || 'unknown',
        latencyMs: Date.now() - startedAt,
      });
      throw classified;
    }
  }

  // Streaming variant: identical pipeline, with the UI given text deltas as they
  // arrive. `input.onDelta` receives raw text pieces; the final validated object
  // still comes from the same parser.
  async function explainStream(input = {}) {
    return explain({ ...input, onDelta: input.onDelta });
  }

  function validateConfiguration(overrides = {}) {
    const providerId = overrides.providerId || state.providerId;
    const model = overrides.model || state.model || registry.defaultModelFor(providerId);
    const apiKey = overrides.apiKey ?? state.apiKey;
    return checkConfiguration({ providerId, model, apiKey });
  }

  async function listLiveModels(overrides = {}) {
    const adapter = adapterFor(overrides);
    const providerId = overrides.providerId || state.providerId;
    if (!adapterSupports(providerId, 'listModels')) {
      return { supported: false, providerId, models: registry.listModels(providerId) };
    }
    const listed = await adapter.listModels({ signal: overrides.signal || null });
    const merged = registry.mergeLiveModels(providerId, listed);
    return {
      supported: true,
      providerId,
      models: merged.models,
      hiddenCount: merged.hiddenCount,
      capped: merged.capped,
      liveCount: merged.liveCount,
      freeCount: merged.freeCount,
      ids: merged.models.map((model) => model.id),
    };
  }

  // Used by the setup screen: authenticates the key and confirms the model.
  async function probeConfiguration(overrides = {}) {
    const adapter = adapterFor(overrides);
    const providerId = overrides.providerId || state.providerId;
    const model = overrides.model || state.model || registry.defaultModelFor(providerId);
    const result = await adapter.validate({ signal: overrides.signal || null });
    return {
      providerId,
      model,
      keyAccepted: true,
      modelExists: !!result.modelExists,
      liveModels: result.liveModels || null,
    };
  }

  return {
    version: '2.0.0',
    publicConfig,
    setConfig,
    keyPoolStatus: () => poolFor().status(),
    explain,
    explainStream,
    validateConfiguration,
    listLiveModels,
    probeConfiguration,
    createLedger: () => new Ledger(),
    catalog: () => registry.toPublicConfig(),
    tasks: () => prompts.listTasks(),
    depths: () => require('./schema/explanation').DEPTHS,
    registry,
    prompts,
    pipeline,
    errors,
    extractJsonObject,
    Ledger,
  };
}

module.exports = {
  createCore,
  DEFAULTS,
  registry,
  prompts,
  pipeline,
  errors,
  extractJsonObject,
  Ledger,
};
