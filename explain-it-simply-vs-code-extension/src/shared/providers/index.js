/* Vendored from ../shared/providers/index.js — do not edit here; run `npm run vendor`. */
'use strict';
// Adapter factory. The rest of the app asks for a provider by id and gets an
// object with generate/stream/listModels/validate; nothing else knows which API
// dialect is spoken.

const registry = require('./registry');
const {
  ValidationError,
  ConfigurationError,
  ProviderError,
} = require('../errors');

const ADAPTERS = {
  [registry.API_STYLES.OPENAI_CHAT]: () => require('./openaiCompatible'),
  [registry.API_STYLES.ANTHROPIC_MESSAGES]: () => require('./anthropic'),
  [registry.API_STYLES.GOOGLE_GENERATE]: () => require('./google'),
};

// Pure checks: no network, cheap enough to run on every keystroke of a settings
// screen.
function checkConfiguration({ providerId, model, apiKey }) {
  const problems = [];
  const provider = registry.getProvider(providerId);
  if (!provider) {
    problems.push(`Unknown provider '${providerId}'. Available: ${registry.listProviders().map((p) => p.id).join(', ')}.`);
    return { ok: false, problems, provider: null };
  }
  if (!apiKey || !String(apiKey).trim()) {
    problems.push(`No API key set for ${provider.name}. Create one at ${provider.keyUrl}.`);
  }
  if (!model || !String(model).trim()) {
    problems.push('No model selected.');
  } else if (!registry.isKnownModel(provider.id, model)) {
    const retired = registry.retirementReason(model);
    problems.push(retired
      ? `Model '${model}' is no longer available (${retired}). Choose another model.`
      : `Model '${model}' is not in the built-in list for ${provider.name}; it will be sent as typed.`);
  }
  if (!ADAPTERS[provider.style]) {
    problems.push(`No adapter implements '${provider.style}' yet.`);
  }
  return { ok: !problems.some((p) => !/not in the built-in list/.test(p)), problems, provider };
}

function createAdapter(options) {
  const { providerId, apiKey, model } = options;
  const checked = checkConfiguration({ providerId, model, apiKey });
  const provider = checked.provider;
  if (!provider) throw new ValidationError(checked.problems[0] || `Unknown provider '${providerId}'.`);
  if (!apiKey) {
    // A provider that publishes a catalogue without credentials can still be listed
    // before the reader has a key — that is when they are choosing what to paste. The
    // adapter keeps refusing to generate, so nothing else becomes keyless.
    const publicList = !!(provider.capabilities || {}).listModelsPublic;
    if (!publicList) throw new ConfigurationError(`${provider.name} has no API key configured. Add one in settings.`);
  }
  const factory = ADAPTERS[provider.style];
  if (!factory) {
    throw new ProviderError(`${provider.name} is not supported by this build.`, provider.id, false);
  }
  // Adapters receive the resolved provider object, never a bare id.
  return factory().create({ ...options, provider });
}

function adapterSupports(providerId, capability) {
  const provider = registry.getProvider(providerId);
  if (!provider) return false;
  if (capability === 'adapter') return !!ADAPTERS[provider.style];
  return !!provider.capabilities[capability];
}

module.exports = {
  ADAPTERS,
  createAdapter,
  checkConfiguration,
  adapterSupports,
  registry,
};
