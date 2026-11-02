'use strict';
// Google Gemini adapter. The API key travels in the query string, which is why
// every error leaving this module is scrubbed before display.

const { requestJson, requestStream } = require('../http/client');
const { classifyResponse, parseJson, usageOf, expectContentText } = require('./base');
const { toGoogleSchema } = require('../schema/jsonSchema');
const {
  ProviderError,
  MalformedResponseError,
  ValidationError,
  truncate,
  redactSecrets,
} = require('../errors');

const TEMPERATURE = 0.4;
const MAX_OUTPUT_TOKENS = 2000;
const BLOCKED_REASONS = ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'MODEL_ARREST'];

function endpoint(provider, model, { stream, apiKey }) {
  const action = stream ? 'streamGenerateContent' : 'generateContent';
  const suffix = stream ? '&alt=sse' : '';
  return `/v1beta/models/${encodeURIComponent(model)}:${action}?key=${encodeURIComponent(apiKey)}${suffix}`;
}

function joinParts(body) {
  const parts = body?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((part) => (typeof part.text === 'string' ? part.text : '')).join('');
}

function checkBlocked(body, providerId) {
  const reason = body?.promptFeedback?.blockReason || body?.candidates?.[0]?.finishReason;
  if (BLOCKED_REASONS.includes(reason)) {
    throw new ProviderError(
      `${providerId} refused to answer this request (${reason}). Rephrase the question or explain a smaller part of the code.`,
      providerId,
      false,
    );
  }
  if (reason === 'MAX_TOKENS') {
    throw new MalformedResponseError(
      `${providerId} cut the answer short at its token limit. Try a smaller selection or a faster model.`,
      providerId,
    );
  }
}

function create({ provider, apiKey, model, timeoutMs, transport, structuredOutput = true }) {
  const send = transport || { json: requestJson, sse: requestStream };
  if (!apiKey) throw new ValidationError(`${provider.id}: no API key configured.`);

  const base = (stream) => ({
    hostname: provider.hostname,
    path: endpoint(provider, model, { stream, apiKey }),
    protocol: provider.protocol || 'https:',
    headers: {},
    timeoutMs,
  });

  function bodyFor({ system, user, structured, schema }) {
    const body = {
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { temperature: TEMPERATURE, maxOutputTokens: MAX_OUTPUT_TOKENS },
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    // Classic field names for this API. `structuredOutput: false` disables them
    // entirely and relies on the prompt plus schema validation, which is the
    // documented portable path when a provider rejects the extra fields.
    if (structuredOutput && structured && schema && provider.capabilities.structuredOutput === 'response-schema') {
      body.generationConfig.responseMimeType = 'application/json';
      body.generationConfig.responseSchema = toGoogleSchema(schema);
    }
    return body;
  }

  return {
    providerId: provider.id,
    model,
    capabilities: provider.capabilities,

    async generate(request) {
      const response = await send.json({
        ...base(false),
        body: bodyFor(request),
        signal: request.signal,
      });
      if (response.status < 200 || response.status >= 300) {
        throw classifyResponse({
          providerId: provider.id, status: response.status, headers: response.headers,
          text: response.text, secrets: [apiKey], model,
        });
      }
      const body = parseJson(response.text);
      if (!body) {
        throw new MalformedResponseError(
          `${provider.id} replied with something that is not JSON: ${truncate(redactSecrets(response.text, [apiKey]))}`,
          provider.id,
        );
      }
      checkBlocked(body, provider.id);
      return {
        text: expectContentText({ providerId: provider.id, text: joinParts(body), secrets: [apiKey] }),
        usage: usageOf(body) || usageOf(body?.usageMetadata),
      };
    },

    async stream(request) {
      if (!provider.capabilities.streaming) {
        throw new ProviderError(`${provider.id} has no streaming support here.`, provider.id, false);
      }
      let received = '';
      let usage = null;
      let inStreamError = null;
      let finishReason = null;

      const response = await send.sse(
        { ...base(true), body: bodyFor(request), signal: request.signal },
        (event) => {
          if (inStreamError) return;
          const data = event.data.trim();
          if (!data) return;
          let parsed = null;
          try {
            parsed = JSON.parse(data);
          } catch (error) {
            return;
          }
          if (parsed.error) {
            inStreamError = classifyResponse({
              providerId: provider.id, status: parsed.error.status || 502, headers: {},
              text: JSON.stringify(parsed.error), secrets: [apiKey], model,
            });
            return;
          }
          if (parsed.usageMetadata) usage = usageOf(parsed);
          const reason = parsed?.candidates?.[0]?.finishReason;
          if (reason) finishReason = reason;
          const piece = joinParts(parsed);
          if (piece) {
            received += piece;
            if (request.onDelta) request.onDelta(piece);
          }
        },
      );
      if (inStreamError) throw inStreamError;
      if (response.status < 200 || response.status >= 300) {
        throw classifyResponse({
          providerId: provider.id, status: response.status, headers: response.headers,
          text: response.text, secrets: [apiKey], model,
        });
      }
      if (finishReason && BLOCKED_REASONS.includes(finishReason)) {
        throw new ProviderError(`${provider.id} blocked this request (${finishReason}).`, provider.id, false);
      }
      if (!received.trim()) {
        throw new MalformedResponseError(`${provider.id} streamed no text.`, provider.id);
      }
      return { text: received, usage, done: true };
    },

    /** @param {{ signal?: AbortSignal }} [options] */
    async listModels({ signal } = {}) {
      if (!provider.listPath) {
        throw new ProviderError(`${provider.id} does not publish a model list.`, provider.id, false);
      }
      const response = await send.json({
        hostname: provider.hostname,
        path: `${provider.listPath}?pageSize=200&key=${encodeURIComponent(apiKey)}`,
        method: 'GET',
        protocol: provider.protocol || 'https:',
        headers: {},
        body: undefined,
        timeoutMs,
        signal,
      });
      if (response.status < 200 || response.status >= 300) {
        throw classifyResponse({
          providerId: provider.id, status: response.status, headers: response.headers,
          text: response.text, secrets: [apiKey], model,
        });
      }
      const body = parseJson(response.text);
      return (Array.isArray(body?.models) ? body.models : [])
        .map((entry) => {
          if (typeof entry?.name !== 'string') return null;
          const id = entry.name.replace(/^models\//, '');
          return {
            id,
            name: typeof entry.displayName === 'string' && entry.displayName ? entry.displayName : id,
            contextLength: Number(entry.inputTokenLimit) || 0,
            // Google's list carries no pricing, so nothing here is claimed as free.
            free: false,
          };
        })
        .filter(Boolean);
    },

    async validate(request = {}) {
      const models = await this.listModels({ signal: request.signal });
      return {
        ok: true,
        modelExists: models.some((entry) => entry.id === model),
        liveModels: models.map((entry) => entry.id),
      };
    },
  };
}

module.exports = { create, endpoint, joinParts, checkBlocked, BLOCKED_REASONS, MAX_OUTPUT_TOKENS };
