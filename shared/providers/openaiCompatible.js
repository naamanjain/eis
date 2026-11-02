'use strict';
// OpenAI-compatible adapter. One implementation serves both api.openai.com and
// api.groq.com, because Groq deliberately mirrors the Chat Completions shape;
// only host, path and the default headers differ (taken from the registry).

const { requestJson, requestStream } = require('../http/client');
const { classifyResponse, parseJson, usageOf, expectContentText } = require('./base');
const { toStrictProviderSchema } = require('../schema/jsonSchema');
const { ValidationError, MalformedResponseError, ProviderError, truncate, redactSecrets } = require('../errors');

// Reasoning models spend part of the budget thinking, so this has to clear the answer
// comfortably while still capping a runaway generation.
const MAX_OUTPUT_TOKENS = 8000;

const TEMPERATURE = 0.4;

function buildMessages({ system, user }) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });
  return messages;
}

function responseFormatFor({ structured, schema }) {
  if (!structured || !schema) return undefined;
  return {
    type: 'json_schema',
    // Strict mode needs every property declared and no extras.
    json_schema: { name: 'explanation', strict: true, schema: toStrictProviderSchema(schema) },
  };
}

function extractText(body, providerId) {
  const choice = Array.isArray(body?.choices) ? body.choices[0] : null;
  const content = choice?.message?.content;
  if (typeof content === 'string' && content.trim()) return content;
  // Some gateways return reasoning_content only when a model refuses to answer.
  const alternative = choice?.delta?.content;
  if (typeof alternative === 'string' && alternative.trim()) return alternative;
  throw new MalformedResponseError(`${providerId} returned no message content.`, providerId);
}

function deltaText(body) {
  const choice = Array.isArray(body?.choices) ? body.choices[0] : null;
  const piece = choice?.delta?.content ?? choice?.message?.content;
  if (typeof piece !== 'string') return '';
  return piece;
}

function create({ provider, apiKey, model, timeoutMs, transport }) {
  const send = transport || { json: requestJson, sse: requestStream };
  // A provider with a public catalogue can be listed before any key exists, which is
  // exactly the moment the reader is deciding what to paste.
  const publicList = !apiKey && !!(provider.capabilities || {}).listModelsPublic;
  if (!apiKey && !publicList) throw new ValidationError(`${provider.id}: no API key configured.`);
  const requireKey = () => {
    if (!apiKey) throw new ValidationError(`${provider.id}: no API key configured.`);
  };

  const base = {
    hostname: provider.hostname,
    path: provider.path,
    protocol: provider.protocol || 'https:',
    headers: {
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      // Some gateways attribute traffic; only sent when the provider declares it.
      ...(provider.attribution || {}),
    },
    timeoutMs,
  };

  function bodyFor({ system, user, structured, schema, stream }) {
    const body = {
      model,
      messages: buildMessages({ system, user }),
      temperature: TEMPERATURE,
      // A cap, not a target. Without it a reasoning model can keep generating against
      // a free tier until the connection is dropped, and nothing bounds the spend.
      max_tokens: MAX_OUTPUT_TOKENS,
    };
    const format = responseFormatFor({ structured, schema });
    if (format) body.response_format = format;
    if (stream) body.stream = true;
    return body;
  }

  return {
    providerId: provider.id,
    model,
    capabilities: provider.capabilities,

    async generate(request) {
      requireKey();
      const response = await send.json({
        ...base,
        body: bodyFor({ ...request, stream: false }),
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
        // Same rule as every other error path: raw provider text is quoted only after
        // key material is stripped. A gateway that reflects the request can otherwise
        // put the Authorization value into a log or the panel.
        throw new MalformedResponseError(
          `${provider.id} replied with something that is not JSON: ${truncate(redactSecrets(response.text, [apiKey]))}`,
          provider.id,
        );
      }
      return {
        text: expectContentText({ providerId: provider.id, text: extractText(body, provider.id), secrets: [apiKey] }),
        usage: usageOf(body),
      };
    },

    async stream(request) {
      requireKey();
      if (!provider.capabilities.streaming) {
        throw new ProviderError(`${provider.id} has no streaming support here.`, provider.id, false);
      }
      let received = '';
      let usage = null;
      let inStreamError = null;
      let sawDone = false;
      const response = await send.sse(
        { ...base, body: bodyFor({ ...request, stream: true }), signal: request.signal },
        (event) => {
          // Throwing inside a data callback would surface as an uncaught
          // exception, so failures are recorded and rethrown after the stream.
          if (inStreamError) return;
          const data = event.data.trim();
          if (!data) return;
          if (data === '[DONE]') {
            sawDone = true;
            return;
          }
          let parsed = null;
          try {
            parsed = JSON.parse(data);
          } catch (error) {
            return; // heartbeat comments and partial frames carry no text
          }
          if (parsed.error) {
            inStreamError = classifyResponse({
              providerId: provider.id, status: parsed.error.status || 502, headers: {},
              text: JSON.stringify(parsed.error), secrets: [apiKey], model,
            });
            return;
          }
          const piece = deltaText(parsed);
          if (piece) {
            received += piece;
            if (request.onDelta) request.onDelta(piece);
          }
          const seenUsage = usageOf(parsed);
          if (seenUsage) usage = seenUsage;
        },
      );
      if (inStreamError) throw inStreamError;
      if (response.status < 200 || response.status >= 300) {
        throw classifyResponse({
          providerId: provider.id, status: response.status, headers: response.headers,
          text: response.text, secrets: [apiKey], model,
        });
      }
      if (!received.trim()) {
        throw new MalformedResponseError(`${provider.id} streamed no text.`, provider.id);
      }
      return { text: received, usage, done: sawDone };
    },

    /** @param {{ signal?: AbortSignal }} [options] */
    async listModels({ signal } = {}) {
      if (!provider.listPath) throw new ProviderError(`${provider.id} does not publish a model list.`, provider.id, false);
      const response = await send.json({
        ...base,
        path: provider.listPath,
        method: 'GET',
        body: undefined,
        signal,
      });
      if (response.status < 200 || response.status >= 300) {
        throw classifyResponse({
          providerId: provider.id, status: response.status, headers: response.headers,
          text: response.text, secrets: [apiKey], model,
        });
      }
      const body = parseJson(response.text);
      const items = Array.isArray(body?.data) ? body.data : [];
      return items
        .filter((item) => item && typeof item.id === 'string')
        .map((item) => ({
          id: item.id,
          name: typeof item.name === 'string' && item.name ? item.name : item.id,
          contextLength: Number(item.context_length) || 0,
          // A free route is either suffixed `:free` or priced at zero for both sides.
          free: /:free$/i.test(item.id) === true
            || (item.pricing && Number(item.pricing.prompt) === 0 && Number(item.pricing.completion) === 0) === true,
        }));
    },

    async validate(request = {}) {
      const models = await this.listModels({ signal: request.signal });
      const known = models.some((entry) => entry.id === model);
      return { ok: true, modelExists: known, liveModels: models.map((entry) => entry.id) };
    },
  };
}

module.exports = { create, extractText, deltaText, buildMessages, TEMPERATURE };
