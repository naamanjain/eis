/* Vendored from ../shared/providers/registry.js — do not edit here; run `npm run vendor`. */
'use strict';
// The single model/provider catalog for both apps.
//
// Verification matters here: scraped documentation is not proof of availability,
// so each model carries a `status` and the live `/models` reconciliation in
// `mergeLiveModels()` can promote or retire entries at runtime. Nothing outside
// this file may contain a model id string.

const API_STYLES = {
  OPENAI_CHAT: 'openai-chat-completions',
  ANTHROPIC_MESSAGES: 'anthropic-messages',
  GOOGLE_GENERATE: 'google-generate-content',
};

const STATUS = {
  VERIFIED: 'verified',
  UNVERIFIED: 'unverified',
};

// Ids the project used before and that documentation now lists as deprecated or
// retired. Kept so we can give a clear recovery message instead of a 404 from
// the provider.
const RETIRED_MODELS = {
  'gpt-3.5-turbo': 'Retired by OpenAI.',
  'gemini-1.5-pro': 'Shut down by Google.',
  'gemini-1.5-flash': 'Shut down by Google.',
  'gemini-2.0-flash': 'Listed as deprecated on the Gemini models page.',
  'gemini-2.0-flash-exp': 'Experimental endpoint removed.',
  'claude-3-5-sonnet-20241022': 'Superseded by Claude 5 generation.',
  'claude-3-haiku-20240307': 'Superseded by Claude 5 generation.',
  'claude-3-opus-20240229': 'Superseded by Claude 5 generation.',
  'mixtral-8x7b-32768': 'No longer listed in Groq\'s model catalogue.',
  'gemma2-9b-it': 'No longer listed in Groq\'s model catalogue.',
};

const PROVIDERS = [
  {
    id: 'google',
    name: 'Google Gemini',
    style: API_STYLES.GOOGLE_GENERATE,
    hostname: 'generativelanguage.googleapis.com',
    protocol: 'https:',
    keyEnv: 'GOOGLE_API_KEY',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyPrefix: 'AIza',
    listPath: '/v1beta/models',
    freeTier: true,
    capabilities: {
      streaming: true,
      structuredOutput: 'response-schema',
      listModels: true,
      // The key travels in the query string on this API, so redaction on errors
      // is mandatory rather than defensive.
      keyInQuery: true,
    },
    defaultModel: 'gemini-3.8-flash',
    models: [
      { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', status: STATUS.VERIFIED, note: 'stable', tiers: ['balanced', 'fast'] },
      { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', status: STATUS.VERIFIED, note: 'stable' },
      { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash Lite', status: STATUS.VERIFIED, note: 'stable, cheapest' },
      { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro (preview)', status: STATUS.VERIFIED, note: 'preview' },
    ],
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    style: API_STYLES.ANTHROPIC_MESSAGES,
    hostname: 'api.anthropic.com',
    protocol: 'https:',
    path: '/v1/messages',
    version: '2023-06-01',
    listPath: null,
    keyEnv: 'ANTHROPIC_API_KEY',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyPrefix: 'sk-ant-',
    freeTier: false,
    capabilities: {
      streaming: true,
      // No native JSON mode: the adapter uses a prefilled assistant turn plus
      // strict schema validation instead.
      structuredOutput: 'prefill',
      listModels: false,
    },
    defaultModel: 'claude-sonnet-5-5',
    models: [
      { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', status: STATUS.VERIFIED, contextWindow: '1M' },
      { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', status: STATUS.VERIFIED, contextWindow: '1M' },
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', status: STATUS.VERIFIED, contextWindow: '1M' },
      { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', status: STATUS.VERIFIED, contextWindow: '1M' },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    style: API_STYLES.OPENAI_CHAT,
    hostname: 'api.openai.com',
    protocol: 'https:',
    path: '/v1/chat/completions',
    listPath: '/v1/models',
    keyEnv: 'OPENAI_API_KEY',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyPrefix: 'sk-',
    freeTier: false,
    capabilities: {
      streaming: true,
      structuredOutput: 'json-schema',
      listModels: true,
    },
    defaultModel: 'gpt-4o-mini',
    models: [
      { id: 'gpt-4o-mini', name: 'GPT-4o mini', status: STATUS.VERIFIED, note: 'named in the structured-outputs guide' },
      { id: 'gpt-4o', name: 'GPT-4o', status: STATUS.VERIFIED, note: 'named in the structured-outputs guide' },
      { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', status: STATUS.UNVERIFIED, contextWindow: '1.05M', note: 'listed on the models page; JSON-schema support unconfirmed' },
    ],
  },
  {
    id: 'groq',
    name: 'Groq',
    style: API_STYLES.OPENAI_CHAT,
    hostname: 'api.groq.com',
    protocol: 'https:',
    path: '/openai/v1/chat/completions',
    listPath: '/openai/v1/models',
    keyEnv: 'GROQ_API_KEY',
    keyUrl: 'https://console.groq.com/keys',
    keyPrefix: 'gsk_',
    freeTier: true,
    capabilities: {
      streaming: true,
      structuredOutput: 'json-schema',
      listModels: true,
    },
    defaultModel: 'gpt-oss-120b',
    models: [
      { id: 'gpt-oss-120b', name: 'GPT OSS 120B', status: STATUS.VERIFIED, contextWindow: '131k' },
      { id: 'gpt-oss-20b', name: 'GPT OSS 20B', status: STATUS.VERIFIED, contextWindow: '131k' },
      { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B', status: STATUS.UNVERIFIED, note: 'long-standing Groq id; re-check against the live list' },
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    style: API_STYLES.OPENAI_CHAT,
    hostname: 'openrouter.ai',
    protocol: 'https:',
    path: '/api/v1/chat/completions',
    listPath: '/api/v1/models',
    keyEnv: 'OPENROUTER_API_KEY',
    keyUrl: 'https://openrouter.ai/settings/keys',
    keyPrefix: 'sk-or-',
    // OpenRouter routes to other vendors, so its model ids change often; the live
    // list (462 models when checked on 2026-10-11) is the source of truth at
    // runtime. freeTier is true because 14 ids ended in `:free` in that response —
    // they rotate, so they are found through Refresh rather than pinned here.
    freeTier: true,
    freeRouteSuffix: ':free',
    attribution: {
      'HTTP-Referer': 'https://github.com/naamanjain/eis',
      'X-OpenRouter-Title': 'Explain It Simply',
    },
    capabilities: {
      streaming: true,
      structuredOutput: 'json-schema',
      listModels: true,
      // /api/v1/models answers without credentials, so the free routes can be listed
      // while the reader is still deciding whether to paste a key.
      listModelsPublic: true,
    },
    defaultModel: 'anthropic/claude-sonnet-5.5',
    models: [
      { id: 'anthropic/claude-sonnet-5.5', name: 'Claude Sonnet 5.5 (via OpenRouter)', status: STATUS.VERIFIED, contextWindow: '1M' },
      { id: 'openai/gpt-6.1-sol', name: 'GPT-6.1 Sol (via OpenRouter)', status: STATUS.VERIFIED, contextWindow: '1.05M' },
      { id: 'google/gemini-4-argon', name: 'Gemini 4 Argon (via OpenRouter)', status: STATUS.VERIFIED, contextWindow: '1M' },
    ],
  },
  {
    id: 'kimi',
    name: 'Kimi (Moonshot)',
    style: API_STYLES.OPENAI_CHAT,
    hostname: 'api.moonshot.ai',
    protocol: 'https:',
    path: '/v1/chat/completions',
    listPath: '/v1/models',
    keyEnv: 'MOONSHOT_API_KEY',
    keyUrl: 'https://platform.kimi.ai/account/apiKeys',
    // No documented key prefix, so keys are not shape-checked for this provider.
    keyPrefix: '',
    freeTier: false,
    capabilities: {
      streaming: true,
      // JSON enforcement is not documented for this endpoint, so the prompt and
      // the validator carry the contract instead.
      structuredOutput: 'prompt',
      listModels: true,
    },
    defaultModel: 'kimi-k2.7-code',
    models: [
      { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', status: STATUS.VERIFIED, note: 'tuned for code' },
      { id: 'kimi-k2.7-code-highspeed', name: 'Kimi K2.7 Code Highspeed', status: STATUS.VERIFIED },
      { id: 'kimi-k3', name: 'Kimi K3', status: STATUS.VERIFIED },
      { id: 'kimi-k2.6', name: 'Kimi K2.6', status: STATUS.VERIFIED },
    ],
  },
];

const DEFAULT_PROVIDER_ID = 'google';

const PROVIDER_BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

function getProvider(id) {
  return PROVIDER_BY_ID.get(String(id || '')) || null;
}

function listProviders() {
  return PROVIDERS;
}

// Live ids that a dropdown shows before it tells the user to type an id instead.
const LIVE_DISPLAY_CAP = 40;

function getModel(providerId, modelId) {
  const provider = getProvider(providerId);
  if (!provider || !modelId) return null;
  return provider.models.find((m) => m.id === modelId) || null;
}

function listModels(providerId) {
  const provider = getProvider(providerId);
  return provider ? provider.models : [];
}

function defaultModelFor(providerId) {
  const provider = getProvider(providerId);
  return provider ? provider.defaultModel : null;
}

function isKnownModel(providerId, modelId) {
  return !!getModel(providerId, modelId);
}

function retirementReason(modelId) {
  return RETIRED_MODELS[String(modelId || '')] || null;
}

function supports(providerId, capability) {
  const provider = getProvider(providerId);
  return !!(provider && provider.capabilities[capability]);
}

// A user-entered model id is allowed (documentation can lag reality) but is
// marked so the UI can show it as unconfirmed.
function resolveModel(providerId, modelId, { allowCustom = true } = {}) {
  const known = getModel(providerId, modelId);
  if (known) return { ...known, custom: false };
  const provider = getProvider(providerId);
  if (!provider || !allowCustom || !modelId || !/^[A-Za-z0-9._:@/{}[\]$-]{2,120}$/.test(modelId)) {
    return null;
  }
  return { id: modelId, name: modelId, status: STATUS.UNVERIFIED, custom: true };
}

// Reconciles the curated catalogue with what the provider actually lists.
// An adapter may return bare ids or {id, name, contextLength, free} entries; both are
// accepted so a provider without pricing metadata keeps working.
function liveEntry(entry) {
  if (typeof entry === 'string') {
    const id = entry.trim();
    return id ? { id, name: id, contextLength: 0, free: /:free$/i.test(id) } : null;
  }
  if (!entry || typeof entry.id !== 'string' || !entry.id.trim()) return null;
  const id = entry.id.trim();
  return {
    id,
    name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : id,
    contextLength: Number(entry.contextLength) || 0,
    free: entry.free === true || /:free$/i.test(id),
  };
}

function contextLabel(tokens) {
  if (!tokens) return undefined;
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}K` : String(tokens);
}

function mergeLiveModels(providerId, live) {
  const provider = getProvider(providerId);
  if (!provider) return { models: [], hiddenCount: 0, capped: false, liveCount: 0, freeCount: 0 };
  const seen = new Map();
  for (const entry of live || []) {
    const normalised = liveEntry(entry);
    if (normalised && !seen.has(normalised.id)) seen.set(normalised.id, normalised);
  }
  const curatedIds = new Set(provider.models.map((m) => m.id));
  const curated = provider.models.map((model) => {
    const found = seen.get(model.id);
    return {
      ...model,
      inLiveList: seen.has(model.id),
      status: seen.has(model.id) ? STATUS.VERIFIED : model.status,
      free: found ? found.free : /:free$/i.test(model.id),
      contextWindow: (found && contextLabel(found.contextLength)) || model.contextWindow,
    };
  });
  const extras = [...seen.values()].filter((entry) => !curatedIds.has(entry.id));
  // OpenRouter answers ~470 ids in an order that favours whatever was added last, so a
  // plain slice showed a mostly-paid sample and cut the free routes the reader wants.
  // Free entries are never dropped; only the paid tail is capped.
  const byId = (a, b) => a.id.localeCompare(b.id);
  const free = extras.filter((entry) => entry.free).sort(byId);
  const paid = extras.filter((entry) => !entry.free).sort(byId);
  const shown = [...free, ...paid.slice(0, LIVE_DISPLAY_CAP)];
  return {
    models: [
      ...curated,
      ...shown.map((entry) => ({
        id: entry.id,
        name: entry.name,
        status: STATUS.VERIFIED,
        fromLiveList: true,
        free: entry.free,
        contextWindow: contextLabel(entry.contextLength),
      })),
    ],
    hiddenCount: Math.max(0, paid.length - LIVE_DISPLAY_CAP),
    capped: paid.length > LIVE_DISPLAY_CAP,
    liveCount: seen.size,
    freeCount: free.length + curated.filter((model) => model.free).length,
  };
}

// Safe for a webview or a browser: metadata only, no key values, no env names.
function toPublicConfig() {
  return {
    defaultProvider: DEFAULT_PROVIDER_ID,
    providers: PROVIDERS.map((p) => ({
      id: p.id,
      name: p.name,
      keyUrl: p.keyUrl,
      keyHint: `${p.keyPrefix}…`,
      freeTier: p.freeTier,
      capabilities: {
        streaming: p.capabilities.streaming,
        structuredOutput: p.capabilities.structuredOutput,
        listModels: !!p.capabilities.listModels,
        listModelsPublic: !!p.capabilities.listModelsPublic,
      },
      defaultModel: p.defaultModel,
      models: p.models.map((m) => ({ id: m.id, name: m.name, status: m.status, note: m.note, contextWindow: m.contextWindow })),
    })),
  };
}

module.exports = {
  API_STYLES,
  STATUS,
  LIVE_DISPLAY_CAP,
  DEFAULT_PROVIDER_ID,
  RETIRED_MODELS,
  PROVIDERS,
  getProvider,
  listProviders,
  getModel,
  listModels,
  defaultModelFor,
  isKnownModel,
  retirementReason,
  supports,
  resolveModel,
  mergeLiveModels,
  toPublicConfig,
};
