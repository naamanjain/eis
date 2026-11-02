'use strict';
// The extension's only door to the AI core. Keeps configuration in sync with
// settings, applies cancellation, classifies failures into recovery actions,
// and records history. It knows nothing about the webview.

const { createCore } = require('../shared/index.js');
const { userHint, ERROR_CODES, CancelledError } = require('../shared/errors.js');
const registry = require('../shared/providers/registry.js');

// Which UI action can fix this class of failure.
const RECOVERY = {
  [ERROR_CODES.CONFIGURATION]: 'setup',
  [ERROR_CODES.AUTHENTICATION]: 'setup',
  [ERROR_CODES.MALFORMED_RESPONSE]: 'retry',
  [ERROR_CODES.RATE_LIMIT]: 'retry',
  [ERROR_CODES.TIMEOUT]: 'retry',
  [ERROR_CODES.NETWORK]: 'retry',
  [ERROR_CODES.CONTEXT_TOO_LARGE]: 'reduce-context',
  [ERROR_CODES.PROVIDER]: 'change-model',
  [ERROR_CODES.VALIDATION]: 'none',
  [ERROR_CODES.CANCELLED]: 'none',
  [ERROR_CODES.UNKNOWN]: 'retry',
};

class ExplainService {
  constructor({ settings, history, logger }) {
    this._settings = settings;
    this._history = history;
    this._logger = logger;
    this._core = createCore({
      logSink: (line) => this._logger.appendLine(line),
      errorSink: (line) => this._logger.appendLine(line),
    });
  }

  get core() {
    return this._core;
  }

  async _configure() {
    const config = await this._settings.requireReady();
    this._core.setConfig({
      providerId: config.providerId,
      model: config.model,
      apiKey: config.apiKey,
      // Without this the core builds a pool of one and failover never happens.
      apiKeys: config.apiKeys,
      depth: config.depth,
      proseLanguage: config.proseLanguage,
      timeoutMs: config.timeoutMs,
      retries: config.retries,
      structuredOutput: config.structuredOutput,
      limits: config.limits,
    });
    return config;
  }

  async catalog() {
    const publicConfig = this._core.catalog();
    const preferences = this._settings.preferences;
    const keysConfiguredFor = [];
    for (const provider of publicConfig.providers) {
      if (await this._settings.getApiKey(provider.id)) keysConfiguredFor.push(provider.id);
    }
    return {
      ...publicConfig,
      selected: {
        providerId: preferences.providerId,
        model: preferences.model || registry.defaultModelFor(preferences.providerId),
        depth: preferences.depth,
        proseLanguage: preferences.proseLanguage,
      },
      keysConfiguredFor,
      isConfigured: this._settings.isConfigured(),
      tasks: this._core.tasks(),
      advanced: this._settings.advanced,
    };
  }

  /**
   * Runs one explanation.
   * @param {Object} params
   * @param {'explain-topic'|'explain-code'|'explain-error'|'find-issues'|'simplify'|'optimize'|'add-comments'|'generate-test'|'give-example'|'teach-me'} params.task
   * @param {Object} params.input        editor context from services/editorContext
   * @param {string} [params.depth]
   * @param {Object} params.token        ledger token (signal + isCurrent)
   * @param {Function} [params.onDelta]
   */
  async explain({ task, input, depth, token, onDelta }) {
    const startedAt = Date.now();
    let config;
    try {
      config = await this._configure();
    } catch (error) {
      return { ok: false, error: this._toFailure(error, config) };
    }

    const request = {
      task,
      subject: input.subject,
      language: input.language,
      fileName: input.fileName,
      fullDocument: this._settings.advanced.includeCurrentFile ? input.fullDocument : undefined,
      cursorLine: input.cursorLine,
      diagnostics: input.diagnostics,
      depth: depth || config.depth,
      signal: token.signal,
      isActive: token.isCurrent,
      onDelta,
    };

    try {
      const { result, meta } = await this._core.explain(request);
      if (!token.isCurrent()) {
        this._logger.appendLine(`explain.dropped requestId=${meta.requestId} reason=superseded`);
        return { ok: false, cancelled: true };
      }
      const entry = await this._history.add({ request, result, meta, input });
      this._logger.appendLine(
        `explain.ok requestId=${meta.requestId} task=${task} provider=${meta.provider} model=${meta.model} `
        + `latencyMs=${meta.latencyMs} retries=${meta.retries} contextChars=${meta.context.chars} shortfalls=${meta.missingFields.length}`,
      );
      return { ok: true, result, meta, historyId: entry ? entry.id : null, durationMs: Date.now() - startedAt };
    } catch (error) {
      if (error instanceof CancelledError || (error && error.code === ERROR_CODES.CANCELLED)) {
        return { ok: false, cancelled: true };
      }
      return { ok: false, error: this._toFailure(error, config) };
    }
  }

  _toFailure(error, config) {
    const code = error && error.code ? error.code : ERROR_CODES.UNKNOWN;
    const raw = error && error.message ? error.message : 'Something went wrong.';
    return {
      code,
      message: this._core.errors.redactSecrets(raw, [config ? config.apiKey : '']),
      hint: userHint({ code }),
      recovery: RECOVERY[code] || 'retry',
      provider: (error && error.providerId) || (config ? config.providerId : null),
      model: config ? config.model : null,
    };
  }

  // Setup screen: authenticate the key and confirm the model actually exists.
  async probeConfiguration({ providerId, model, apiKey }) {
    try {
      const result = await this._core.probeConfiguration({
        providerId,
        model,
        apiKey: apiKey || await this._settings.getApiKey(providerId),
      });
      return { ok: true, ...result };
    } catch (error) {
      return { ok: false, ...this._toFailure(error, { apiKey, providerId, model }) };
    }
  }

  async refreshModels(providerId) {
    const target = providerId || this._settings.preferences.providerId;
    try {
      const result = await this._core.listLiveModels({
        providerId: target,
        apiKey: await this._settings.getApiKey(target),
      });
      return { ok: true, ...result };
    } catch (error) {
      return { ok: false, models: registry.listModels(target), ...this._toFailure(error, { providerId: target }) };
    }
  }

  async saveSettings(patch) {
    const saved = await this._settings.saveSettings(patch);
    if (patch.providerId && patch.model) await this._settings.rememberChoice(patch.providerId, patch.model);
    return saved;
  }
}

module.exports = { ExplainService, RECOVERY };
