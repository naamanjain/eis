'use strict';
// Extension settings. The API key lives in VS Code secret storage, one entry per
// provider, so switching providers does not lose the other keys. Everything else
// is plain globalState — none of it is sensitive.

const registry = require('../shared/providers/registry');
const { parseKeyList } = require('../shared/providers/keyPool');
const { ValidationError, ConfigurationError } = require('../shared/errors');

const KEYS = {
  apiKeyFor: (providerId) => `eis.apiKey.${providerId}`,
  providerId: 'eis.providerId',
  model: 'eis.model',
  depth: 'eis.depth',
  proseLanguage: 'eis.language',
  configured: 'eis.configured',
  modelChoices: 'eis.modelChoices',
};

const DEPTHS = ['quick', 'balanced', 'deep'];

// Values the user can change from the panel; defaults keep a fresh install useful.
const DEFAULTS = {
  providerId: 'google',
  model: null,
  depth: 'balanced',
  proseLanguage: 'en',
};

// Values that live in VS Code's own settings (package.json contributes), read here
// so the rest of the extension has one place to ask.
const CONFIG_SECTION = 'explainItSimply';

class SettingsManager {
  constructor(context, workspaceConfig) {
    this._secrets = context.secrets;
    this._globalState = context.globalState;
    this._config = workspaceConfig || null;
  }

  static workspaceConfiguration(vscode) {
    return vscode.workspace.getConfiguration(CONFIG_SECTION);
  }

  // ---- advanced (VS Code settings) ----
  get advanced() {
    const read = (key, fallback) => {
      if (!this._config) return fallback;
      const value = this._config.get(key);
      return value === undefined ? fallback : value;
    };
    return {
      includeSurroundingContext: read('context.surrounding', true),
      includeCurrentFile: read('context.currentFile', false),
      contextCharBudget: clampNumber(read('context.maxCharacters', 8000), 500, 60000),
      requestTimeoutMs: clampNumber(read('ai.requestTimeoutSeconds', 45) * 1000, 5000, 180000),
      maxRetries: clampNumber(read('ai.maxRetries', 2), 0, 5),
      nativeStructuredOutput: read('ai.structuredOutput', true),
      historyEnabled: read('privacy.saveHistory', true),
      // 'none' | 'summary' | 'snippet' — how much of the explained code is kept.
      codeRetention: ['none', 'summary', 'snippet'].includes(read('privacy.codeRetention', 'snippet'))
        ? read('privacy.codeRetention', 'snippet')
        : 'snippet',
      historyLimit: clampNumber(read('privacy.historyLimit', 50), 0, 500),
      // ---- project audit ----
      auditMaxFiles: clampNumber(read('audit.maxFiles', 150), 1, 2000),
      auditAiFiles: clampNumber(read('audit.aiFiles', 3), 0, 12),
      auditMaxFileBytes: clampNumber(read('audit.maxFileBytes', 200_000), 2_000, 1_000_000),
      auditMaxSendChars: clampNumber(read('audit.maxSendChars', 40_000), 2_000, 400_000),
      auditExcludeGlobs: asStringArray(read('audit.excludeGlobs', ['**/fixtures/**', '**/snapshots/**'])),
      auditShowDiagnostics: read('audit.showDiagnostics', true) !== false,
    };
  }

  // ---- read / write ----
  get preferences() {
    return {
      providerId: this._globalState.get(KEYS.providerId) || DEFAULTS.providerId,
      model: this._globalState.get(KEYS.model) || null,
      depth: DEPTHS.includes(this._globalState.get(KEYS.depth)) ? this._globalState.get(KEYS.depth) : DEFAULTS.depth,
      proseLanguage: this._globalState.get(KEYS.proseLanguage) || DEFAULTS.proseLanguage,
    };
  }

  isConfigured() {
    return !!this._globalState.get(KEYS.configured);
  }

  // One secret per provider, holding one key or several. The extra keys are what the
  // pool fails over to when a provider rate limits or rejects one.
  async _storedKeys(providerId) {
    const id = providerId || this.preferences.providerId;
    const stored = (await this._secrets.get(KEYS.apiKeyFor(id))) || '';
    return parseKeyList('', stored);
  }

  async getApiKey(providerId) {
    const keys = await this._storedKeys(providerId);
    return keys[0] || '';
  }

  async getApiKeys(providerId) {
    return this._storedKeys(providerId);
  }

  async getSettings() {
    const { providerId, model, depth, proseLanguage } = this.preferences;
    const apiKeys = await this._storedKeys(providerId);
    return {
      providerId,
      model: model || registry.defaultModelFor(providerId),
      depth,
      proseLanguage,
      apiKey: apiKeys[0] || '',
      apiKeys,
      timeoutMs: this.advanced.requestTimeoutMs,
      retries: this.advanced.maxRetries,
      structuredOutput: this.advanced.nativeStructuredOutput,
      limits: { maxContextChars: this.advanced.contextCharBudget },
    };
  }

  async saveSettings({ providerId, model, apiKey, depth, proseLanguage }) {
    const provider = registry.getProvider(providerId);
    if (!provider) throw new ValidationError(`Unknown provider '${providerId}'.`);

    const resolvedModel = registry.resolveModel(providerId, model, { allowCustom: true });
    if (!resolvedModel) throw new ValidationError(`Model '${model}' is not usable for ${provider.name}.`);

    if (apiKey !== undefined) {
      const trimmed = String(apiKey || '').trim();
      // Check each key separately: a list is legal, and one mistyped key in it would
      // otherwise be stored and fail every request that lands on it.
      const candidates = trimmed ? parseKeyList('', trimmed) : [];
      if (trimmed && !candidates.length) throw new ValidationError('That API key looks too short to be real.');
      for (const candidate of candidates) {
        if (candidate.length < 8) throw new ValidationError('One of those API keys looks too short to be real.');
        if (provider.keyPrefix && !candidate.startsWith(provider.keyPrefix)) {
          throw new ValidationError(
            `One of those keys does not match ${provider.name}: ${provider.name} keys start with '${provider.keyPrefix}'.`,
          );
        }
      }
      if (candidates.length) await this._secrets.store(KEYS.apiKeyFor(providerId), candidates.join(', '));
    }

    await this._globalState.update(KEYS.providerId, providerId);
    await this._globalState.update(KEYS.model, resolvedModel.id);
    if (depth && DEPTHS.includes(depth)) await this._globalState.update(KEYS.depth, depth);
    if (proseLanguage) await this._globalState.update(KEYS.proseLanguage, proseLanguage);
    if (apiKey) await this._globalState.update(KEYS.configured, true);
    return this.preferences;
  }

  // Depth/language/provider choice without touching the key.
  async patch(partial) {
    const allowed = {};
    if (partial.providerId) allowed.providerId = partial.providerId;
    if (partial.model) allowed.model = partial.model;
    if (partial.depth && DEPTHS.includes(partial.depth)) allowed.depth = partial.depth;
    if (partial.proseLanguage) allowed.proseLanguage = partial.proseLanguage;
    for (const [key, value] of Object.entries(allowed)) {
      await this._globalState.update(KEYS[key] || key, value);
    }
    return this.preferences;
  }

  async clear(providerId) {
    if (providerId) {
      await this._secrets.delete(KEYS.apiKeyFor(providerId));
      if (!(await this.hasAnyKey())) await this._globalState.update(KEYS.configured, false);
      return;
    }
    for (const provider of registry.listProviders()) {
      await this._secrets.delete(KEYS.apiKeyFor(provider.id));
    }
    await this._globalState.update(KEYS.configured, false);
    await this._globalState.update(KEYS.providerId, undefined);
    await this._globalState.update(KEYS.model, undefined);
  }

  // Remember which model each provider was last used with, so switching back is
  // not a trip through the setup screen.
  async rememberChoice(providerId, model) {
    const choices = { ...(this._globalState.get(KEYS.modelChoices) || {}), [providerId]: model };
    await this._globalState.update(KEYS.modelChoices, choices);
  }

  lastChoiceFor(providerId) {
    const choices = this._globalState.get(KEYS.modelChoices) || {};
    return choices[providerId] || null;
  }

  async hasAnyKey() {
    for (const provider of registry.listProviders()) {
      if (await this._secrets.get(KEYS.apiKeyFor(provider.id))) return true;
    }
    return false;
  }

  // Refuses to run an explanation when the active provider has no key, with a
  // message that points at the fix instead of a 401 later.
  async requireReady() {
    const settings = await this.getSettings();
    if (!settings.apiKey) {
      const provider = registry.getProvider(settings.providerId);
      throw new ConfigurationError(
        `${provider ? provider.name : settings.providerId} has no API key. Open setup to add one.`,
      );
    }
    return settings;
  }
}

function clampNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function asStringArray(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string' && item.trim());
  if (typeof value === 'string' && value.trim()) return value.split(',').map((item) => item.trim()).filter(Boolean);
  return [];
}

module.exports = { SettingsManager, KEYS, DEFAULTS, DEPTHS, CONFIG_SECTION };
