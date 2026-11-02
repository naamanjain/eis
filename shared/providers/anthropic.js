'use strict';
// Anthropic Messages adapter. This API has no native JSON mode, so structured
// output is achieved by prefilling the assistant turn with '{' — the reply is
// then the continuation and the '{' is put back before parsing.

const { requestJson, requestStream } = require('../http/client');
const { classifyResponse, parseJson, usageOf, expectContentText } = require('./base');
const { ProviderError, MalformedResponseError, truncate, redactSecrets } = require('../errors');

const TEMPERATURE = 0.4;
const MAX_TOKENS = 2000;
const PREFILL = '{';

function joinText(body, providerId) {
  const parts = Array.isArray(body?.content) ? body.content : [];
  const text = parts
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
  if (!text.trim()) {
    throw new MalformedResponseError(`${providerId} returned no text content.`, providerId);
  }
  return text;
}

function create({ provider, apiKey, model, timeoutMs, transport }) {
  const send = transport || { json: requestJson, sse: requestStream };
  if (!apiKey) throw new ProviderError(`${provider.id}: no API key configured.`, provider.id, false);

  const base = {
    hostname: provider.hostname,
    path: provider.path || '/v1/messages',
    protocol: provider.protocol || 'https:',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': provider.version || '2023-06-01',
    },
    timeoutMs,
  };

  function bodyFor({ system, user, stream, prefill }) {
    const messages = [{ role: 'user', content: user }];
    if (prefill) messages.push({ role: 'assistant', content: PREFILL });
    const body = {
      model,
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE,
      messages,
    };
    if (system) body.system = system;
    if (stream) body.stream = true;
    return body;
  }

  // This API has no JSON mode; when the pipeline wants JSON, the assistant turn
  // is prefilled with '{' so the model continues an object instead of chatting.
  const wantsPrefill = (request) => request.expectJson === true;

  return {
    providerId: provider.id,
    model,
    capabilities: provider.capabilities,

    async generate(request) {
      const prefill = wantsPrefill(request);
      const response = await send.json({
        ...base,
        body: bodyFor({ ...request, prefill, stream: false }),
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
      const continuation = expectContentText({ providerId: provider.id, text: joinText(body, provider.id), secrets: [apiKey] });
      return {
        text: prefill ? PREFILL + continuation : continuation,
        usage: usageOf(body),
        stopReason: body.stop_reason || null,
      };
    },

    async stream(request) {
      if (!provider.capabilities.streaming) {
        throw new ProviderError(`${provider.id} has no streaming support here.`, provider.id, false);
      }
      const prefill = wantsPrefill(request);
      let received = prefill ? PREFILL : '';
      let usage = null;
      let inStreamError = null;
      if (prefill && request.onDelta) request.onDelta(PREFILL);

      const response = await send.sse(
        { ...base, body: bodyFor({ ...request, prefill, stream: true }), signal: request.signal },
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
          if (event.event === 'error' || parsed.type === 'error') {
            inStreamError = classifyResponse({
              providerId: provider.id,
              status: parsed.error?.status || 502,
              headers: {},
              text: JSON.stringify(parsed.error || parsed),
              secrets: [apiKey],
              model,
            });
            return;
          }
          if (parsed.type === 'message_delta' && usageOf(parsed)) usage = usageOf(parsed);
          if (parsed.type === 'message_start' && usageOf(parsed.message)) usage = usageOf(parsed.message);
          const delta = parsed.type === 'content_block_delta' ? parsed.delta?.text : '';
          if (typeof delta === 'string' && delta) {
            received += delta;
            if (request.onDelta) request.onDelta(delta);
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
      if (!received.replace(PREFILL, '').trim()) {
        throw new MalformedResponseError(`${provider.id} streamed no text.`, provider.id);
      }
      return { text: received, usage, done: true };
    },

    async listModels() {
      throw new ProviderError(
        `${provider.id} does not publish a model list. Pick from the built-in catalogue or type a model id.`,
        provider.id,
        false,
      );
    },

    // No list endpoint, so validation is one tiny authenticated request.
    async validate(request = {}) {
      const response = await send.json({
        ...base,
        body: { model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] },
        signal: request.signal,
      });
      if (response.status >= 400 && response.status < 500) {
        throw classifyResponse({
          providerId: provider.id, status: response.status, headers: response.headers,
          text: response.text, secrets: [apiKey], model,
        });
      }
      return { ok: true, modelExists: response.status < 300, liveModels: null };
    },
  };
}

module.exports = { create, joinText, PREFILL, MAX_TOKENS, TEMPERATURE };
