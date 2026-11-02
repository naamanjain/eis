/* Vendored from ../shared/pipeline/pipeline.js — do not edit here; run `npm run vendor`. */
'use strict';
// The request pipeline. Each stage is a separate exported function so it can be
// tested alone; runRequest() composes them in order and records timings.
//
//   input -> validate -> context -> prompt -> adapter (retry) -> extract
//         -> normalize -> schema validate -> application result + meta

const registry = require('../providers/registry');
const { createAdapter, checkConfiguration } = require('../providers');
const { buildContext, DEFAULT_LIMITS } = require('../context/contextEngine');
const prompts = require('../prompts/tasks');
const { extractJsonObject } = require('../ai/extractJson');
const { normalize, validateExplanation, applyDepthBudget, DEPTHS } = require('../schema/explanation');
const { normalizeCodeChange } = require('../schema/codeChange');
const { validate } = require('../schema/jsonSchema');
const { withRetry } = require('./retry');
const {
  ValidationError,
  ConfigurationError,
  ContextTooLargeError,
  MalformedResponseError,
  CancelledError,
  truncate,
} = require('../errors');

const HARD_MAX_DOCUMENT_CHARS = 200_000;
const CORE_REQUIRED = {
  explanation: ['title', 'simpleExplanation'],
  'code-change': ['title', 'code'],
};

let sequence = 0;

function nextRequestId(prefix = 'req') {
  sequence = (sequence + 1) % 100000;
  return `${prefix}-${Date.now().toString(36)}-${sequence.toString(36)}`;
}

// ---------------------------------------------------------------- stage 1

function validateRequest(config = {}, input = {}) {
  const problems = [];
  const requestId = typeof input.requestId === 'string' && input.requestId ? input.requestId : nextRequestId();
  const task = prompts.getTask(input.task);
  if (!task) {
    problems.push(`Unknown task '${truncate(input.task, 40) || '(none)'}'. Use one of: ${prompts.listTasks().map((t) => t.id).join(', ')}.`);
  }

  const depth = prompts.effectiveDepth(input.task, input.depth || config.depth);
  if (!DEPTHS.includes(depth)) problems.push(`Depth '${input.depth}' is not one of ${DEPTHS.join(', ')}.`);

  const subject = typeof input.subject === 'string' ? input.subject : '';
  if (!subject.trim()) problems.push('There is nothing to explain — select code or type a question.');
  const limits = { ...DEFAULT_LIMITS, ...(config.limits || {}) };
  if (subject.length > limits.maxSubjectChars * 2) {
    throw new ContextTooLargeError(
      `That is ${(subject.length / 1000).toFixed(0)}k characters. Select a function or a smaller part.`,
      { chars: subject.length, limit: limits.maxSubjectChars },
    );
  }

  const providerId = input.providerId || config.providerId;
  const model = input.model || config.model || registry.defaultModelFor(providerId);
  const apiKey = input.apiKey ?? config.apiKey;

  const checked = checkConfiguration({ providerId, model, apiKey });
  if (!checked.provider) {
    throw new ValidationError(`Unknown provider '${providerId}'. Available: ${registry.listProviders().map((p) => p.id).join(', ')}.`);
  }
  if (!apiKey) {
    throw new ConfigurationError(`${checked.provider.name} has no API key. Add it in settings.`);
  }

  const resolvedModel = registry.resolveModel(providerId, model, { allowCustom: config.allowCustomModel !== false });
  if (!resolvedModel) {
    problems.push(`Model '${truncate(model, 60)}' is not accepted for ${checked.provider.name}.`);
  }

  const fullDocument = typeof input.fullDocument === 'string' ? input.fullDocument : '';
  if (fullDocument.length > HARD_MAX_DOCUMENT_CHARS) {
    throw new ContextTooLargeError(
      `The file is ${(fullDocument.length / 1000).toFixed(0)}k characters, which is more than this tool will send. Select the part you want explained.`,
      { chars: fullDocument.length, limit: HARD_MAX_DOCUMENT_CHARS },
    );
  }

  const documentLines = fullDocument ? fullDocument.replace(/\r\n/g, '\n').split('\n').length : 0;
  let cursorLine = Number.isInteger(input.cursorLine) ? input.cursorLine : null;
  if (cursorLine !== null && (cursorLine < 0 || (documentLines && cursorLine >= documentLines))) {
    cursorLine = null; // a stale caret position must not shift the context
  }

  const diagnostics = typeof input.diagnostics === 'string' ? input.diagnostics.slice(0, 2000) : '';

  if (problems.length) throw new ValidationError(problems.join(' '), { problems });

  return {
    id: requestId,
    task: task.id,
    contract: task.contract,
    kind: task.kind,
    depth,
    subject,
    providerId,
    provider: checked.provider,
    model,
    modelInfo: resolvedModel,
    apiKey,
    language: typeof input.language === 'string' ? input.language : '',
    fileName: typeof input.fileName === 'string' ? input.fileName : '',
    fullDocument,
    cursorLine,
    diagnostics,
    proseLanguage: typeof input.proseLanguage === 'string' && input.proseLanguage
      ? input.proseLanguage
      : (config.proseLanguage || 'en'),
    audience: typeof input.audience === 'string' ? input.audience.slice(0, 200) : (config.audience || ''),
    limits,
    signal: input.signal || null,
    onDelta: typeof input.onDelta === 'function' ? input.onDelta : null,
    structured: input.structured !== false && config.structuredOutput !== false,
    isActive: typeof input.isActive === 'function' ? input.isActive : null,
  };
}

// ---------------------------------------------------------------- stage 2

function buildRequestContext(request) {
  return buildContext({
    subject: request.subject,
    language: request.language,
    fileName: request.fileName,
    fullDocument: request.fullDocument,
    cursorLine: request.cursorLine,
    diagnostics: request.diagnostics,
    limits: request.limits,
  });
}

// ---------------------------------------------------------------- stage 3

function buildPrompt(request, context) {
  return prompts.buildMessages({
    task: request.task,
    depth: request.depth,
    context,
    language: request.proseLanguage,
    audience: request.audience,
  });
}

// ---------------------------------------------------------------- stage 4

function callAdapter(request, prompt, options = {}) {
  const adapter = options.adapter || createAdapter({
    providerId: request.providerId,
    apiKey: request.apiKey,
    model: request.model,
    timeoutMs: options.timeoutMs ?? request.timeoutMs,
    transport: options.transport,
    structuredOutput: options.structuredOutput ?? request.structured,
  });

  // Once a byte of a stream has reached the UI a retry would duplicate text the
  // user already read, so streaming only replays while nothing was sent.
  let deltasSent = false;

  const invoke = () => {
    if (deltasSent) {
      throw new MalformedResponseError('The answer was interrupted mid-stream.', request.providerId);
    }
    const payload = {
      ...prompt,
      expectJson: true,
      // Whether native structured output may be attached; carried to the adapter
      // because the prompt object alone does not express it.
      structured: request.structured,
      contract: request.contract,
      signal: request.signal,
    };
    if (!request.onDelta) return adapter.generate(payload);
    return adapter.stream({
      ...payload,
      onDelta: (piece) => {
        deltasSent = true;
        request.onDelta(piece);
      },
    });
  };

  return withRetry(
    async () => {
      if (request.signal && request.signal.aborted) throw new CancelledError();
      return invoke();
    },
    {
      attempts: options.retries ?? request.retries ?? 3,
      signal: request.signal,
      sleep: options.sleep,
      random: options.random,
      onRetry: options.onRetry,
      rotateRateLimit: options.rotateRateLimit,
    },
  );
}

// ---------------------------------------------------------------- stages 5-7

function toApplicationResult(rawText, request) {
  const parsed = extractJsonObject(rawText, { providerId: request.providerId, secrets: [request.apiKey] });

  if (request.contract === 'code-change') {
    const change = normalizeCodeChange(parsed);
    const core = CORE_REQUIRED['code-change'];
    const missing = core.filter((key) => !change[key]);
    if (missing.length) {
      throw new MalformedResponseError(
        `The answer is missing ${missing.join(', ')} — regenerate, or try a stronger model.`,
        request.providerId,
      );
    }
    const { version, kind, ...content } = change;
    const check = validate(content, prompts.schemaForTask(request.task, request.depth));
    return { payload: change, schemaErrors: check.errors, missingFields: check.errors };
  }

  let explanation = normalize(parsed, request.kind, request.depth);
  explanation = applyDepthBudget(explanation);
  const full = validateExplanation(explanation, request.kind, request.depth);
  if (full.valid) return { payload: explanation, schemaErrors: [], missingFields: [] };

  // Missing optional-but-requested fields are reported, not invented. Only a
  // missing core field is a hard failure.
  const core = CORE_REQUIRED.explanation;
  const missingCore = core.filter((key) => {
    if (key === 'simpleExplanation') return !explanation.simpleExplanation?.body;
    return !explanation[key];
  });
  if (missingCore.length) {
    throw new MalformedResponseError(
      `The answer is incomplete (missing ${missingCore.join(', ')}). Try again or switch model.`,
      request.providerId,
    );
  }
  return { payload: explanation, schemaErrors: full.errors, missingFields: full.errors };
}

// ---------------------------------------------------------------- composed

async function runRequest(config = {}, input = {}, options = {}) {
  const startedAt = Date.now();
  const stages = {};
  const mark = (name, from) => {
    stages[name] = Date.now() - from;
  };

  let t = Date.now();
  const request = validateRequest({ ...config, ...input.config }, input);
  mark('validate', t);
  request.timeoutMs = input.timeoutMs ?? config.timeoutMs;
  request.retries = input.retries ?? config.retries;

  t = Date.now();
  const context = buildRequestContext(request);
  mark('context', t);

  t = Date.now();
  const prompt = buildPrompt(request, context);
  mark('prompt', t);

  t = Date.now();
  const result = await callAdapter(request, prompt, options);
  mark('provider', t);

  t = Date.now();
  if (request.isActive && !request.isActive()) {
    throw new CancelledError('A newer request replaced this one.', request.providerId);
  }
  const { payload, schemaErrors, missingFields } = toApplicationResult(result.text, request);
  mark('normalize', t);

  return {
    result: payload,
    meta: {
      requestId: request.id,
      task: request.task,
      contract: request.contract,
      kind: request.kind,
      depth: request.depth,
      provider: request.providerId,
      providerName: request.provider.name,
      model: request.model,
      modelStatus: request.modelInfo?.status || registry.STATUS.UNVERIFIED,
      customModel: !!request.modelInfo?.custom,
      structuredOutput: prompt.schema && request.structured
        ? (request.provider.capabilities.structuredOutput === 'response-schema' || request.provider.capabilities.structuredOutput === 'json-schema' ? 'native' : 'prompt')
        : 'prompt',
      streaming: !!request.onDelta,
      retries: result.retries || 0,
      usage: result.usage || null,
      latencyMs: Date.now() - startedAt,
      stages,
      context: {
        manifest: context.manifest,
        truncated: context.truncated,
        notices: context.notices,
        chars: context.chars,
        estTokens: context.estTokens,
      },
      schemaErrors,
      missingFields,
    },
  };
}

module.exports = {
  nextRequestId,
  validateRequest,
  buildRequestContext,
  buildPrompt,
  callAdapter,
  toApplicationResult,
  runRequest,
  CORE_REQUIRED,
  HARD_MAX_DOCUMENT_CHARS,
};
