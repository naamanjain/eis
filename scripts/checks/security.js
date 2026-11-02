'use strict';
// Security gate group: key-pool failover, proxy-trust-aware bucketing, concurrency
// ceiling and the daily spend guard. Each of these can fail on its own behaviour,
// not just on the code being present.

const fs = require('fs');
const path = require('path');

function run(ctx) {
  const {
    check, fail, assert, setGroup, SHARED, WEB_DIR, FAKE_KEY, makeTransport, googleReply,
    EXPLANATION_JSON, QUIET, loadExtension, makeVscodeStub, freshState, makeContext, configStub,
  } = ctx;
  setGroup('security');

  const { KeyPool, parseKeyList } = require(path.join(SHARED, 'providers/keyPool.js'));
  const { createInflightLimiter, createDailyBudget, clientAddress, rateKey } = require(path.join(WEB_DIR, 'src/middleware/security.js'));
  const { createCore } = require(path.join(SHARED, 'index.js'));

  return (async () => {
    await check('a rejected key is failed over to the next key, same request', async () => {
      const keys = ['poolKeyOneForLocalChecks-01', 'poolKeyTwoForLocalChecks-02', 'poolKeyThreeForLocal-03'];
      const used = [];
      const transport = {
        json: async (options) => {
          const sentKey = /key=([^&]+)/.exec(options.path)[1];
          used.push(sentKey);
          if (sentKey === keys[0]) {
            return { status: 401, headers: {}, text: JSON.stringify({ error: { message: 'API key not valid' } }) };
          }
          return googleReply(EXPLANATION_JSON);
        },
      };
      const core = createCore({
        providerId: 'google', model: 'gemini-3.8-flash', apiKeys: keys, retries: 1, logger: QUIET, transport,
      });
      const { result, meta } = await core.explain({ task: 'explain-topic', subject: 'recursion' });
      assert.strictEqual(result.title, 'Recursion');
      assert.strictEqual(used.length, 2, `expected 2 upstream attempts, saw ${used.length}`);
      assert.strictEqual(used[0], encodeURIComponent(keys[0]), 'the first key was not the one tried first');
      assert.strictEqual(used[1], encodeURIComponent(keys[1]), 'failover did not advance to the next key');
      assert.strictEqual(meta.keysConfigured, 3);
      assert.strictEqual(meta.keyIndex, 1);
      assert.strictEqual(meta.keysTried, 2);
    });

    await check('cooldown keeps a rejected key out of the next request', async () => {
      const keys = ['poolKeyOneForLocalChecks-01', 'poolKeyTwoForLocalChecks-02'];
      const used = [];
      const transport = {
        json: async (options) => {
          const sentKey = decodeURIComponent(/key=([^&]+)/.exec(options.path)[1]);
          used.push(sentKey);
          // key one always rate-limits, key two always succeeds
          if (sentKey === keys[0]) return { status: 429, headers: { 'retry-after': '0' }, text: '{"error":{"message":"quota exhausted"}}' };
          return googleReply(EXPLANATION_JSON);
        },
      };
      const core = createCore({ providerId: 'google', model: 'gemini-3.8-flash', apiKeys: keys, retries: 1, logger: QUIET, transport });
      await core.explain({ task: 'explain-topic', subject: 'a' });
      const firstLen = used.length;
      await core.explain({ task: 'explain-topic', subject: 'b' });
      assert.ok(used.slice(firstLen).every((key) => key === keys[1]), `the cooled-down key was reused: ${used.slice(firstLen).join(', ')}`);
      const status = core.keyPoolStatus();
      assert.ok(status[0].blocked, 'key one should still be cooling down');
      assert.strictEqual(status[0].reason, 'RATE_LIMIT_ERROR');
      assert.ok(!JSON.stringify(status).includes('poolKeyOne'), 'health status exposed a key prefix');
    });

    await check('every key on cooldown surfaces as one clear configuration error', async () => {
      const keys = ['poolKeyOnlyForLocalChecks-x1'];
      const transport = {
        json: async () => ({ status: 429, headers: {}, text: '{"error":{"message":"quota exhausted"}}' }),
      };
      const core = createCore({ providerId: 'google', model: 'gemini-3.8-flash', apiKeys: keys, retries: 1, logger: QUIET, transport });
      await core.explain({ task: 'explain-topic', subject: 'a' }).catch(() => {});
      let caught = null;
      try {
        await core.explain({ task: 'explain-topic', subject: 'b' });
      } catch (error) {
        caught = error;
      }
      assert.ok(caught, 'the exhausted pool was not reported');
      assert.ok(['RATE_LIMIT_ERROR', 'CONFIGURATION_ERROR', 'AUTHENTICATION_ERROR'].includes(caught.code), `unexpected code ${caught.code}`);
    });

    await check('a bad model does NOT burn the key pool', async () => {
      const keys = ['poolKeyOneForLocalChecks-01', 'poolKeyTwoForLocalChecks-02'];
      const used = [];
      const transport = {
        json: async (options) => {
          used.push(/key=([^&]+)/.exec(options.path)[1]);
          return { status: 404, headers: {}, text: '{"error":{"message":"model not found"}}' };
        },
      };
      const core = createCore({ providerId: 'google', model: 'gemini-9-never-exists', apiKeys: keys, retries: 1, logger: QUIET, transport });
      let caught = null;
      try {
        await core.explain({ task: 'explain-topic', subject: 'a' });
      } catch (error) {
        caught = error;
      }
      assert.ok(caught, 'expected a failure');
      assert.strictEqual(used.length, 1, `rotated ${used.length} keys for a model error`);
      assert.ok(core.keyPoolStatus().every((entry) => !entry.blocked), 'a model error cooled down keys');
    });

    await check('malformed replies do not rotate keys', async () => {
      const keys = ['poolKeyOneForLocalChecks-01', 'poolKeyTwoForLocalChecks-02'];
      let attempts = 0;
      const core = createCore({
        providerId: 'google',
        model: 'gemini-3.8-flash',
        apiKeys: keys,
        retries: 1,
        logger: QUIET,
        transport: {
          json: async () => {
            attempts += 1;
            return googleReply('this is not JSON at all');
          },
        },
      });
      await expectError(core, 'MALFORMED_RESPONSE');
      assert.strictEqual(attempts, 1, `a malformed reply caused ${attempts} upstream attempts`);
    });

    await check('single-key deployments behave exactly as before', async () => {
      const core = createCore({
        providerId: 'google', model: 'gemini-3.8-flash', apiKey: FAKE_KEY, retries: 1, logger: QUIET,
        transport: makeTransport(() => googleReply(EXPLANATION_JSON)),
      });
      const { meta } = await core.explain({ task: 'explain-topic', subject: 'a' });
      assert.strictEqual(meta.keysConfigured, 1);
      assert.strictEqual(meta.keyIndex, 0);
    });

    await check('parseKeyList merges, splits and de-duplicates', () => {
      const merged = parseKeyList(' a ', 'b, c\n d , a');
      assert.deepStrictEqual(merged, ['a', 'b', 'c', 'd']);
      assert.deepStrictEqual(parseKeyList('', ''), []);
      assert.deepStrictEqual(parseKeyList('only', undefined), ['only']);
      const pool = new KeyPool(['', '   ', 'real-key']);
      assert.deepStrictEqual(pool.keys, ['real-key'], 'blank entries must be dropped, not counted');
      assert.strictEqual(new KeyPool([]).size, 0);
    });

    await check('X-Forwarded-For is ignored unless a proxy is trusted', () => {
      const req = (headers) => ({ headers, socket: { remoteAddress: '203.0.113.9' } });
      const spoofed = req({ 'x-forwarded-for': '1.1.1.1' });
      assert.strictEqual(clientAddress(spoofed, 0), '203.0.113.9', 'an untrusted header was believed');
      assert.strictEqual(clientAddress(req({ 'x-forwarded-for': '1.1.1.1, 203.0.113.9' }), 1), '203.0.113.9', 'the proxy hop was mis-read');
      assert.strictEqual(clientAddress(req({ 'x-forwarded-for': '1.1.1.1, 10.0.0.2, 198.51.100.7' }), 2), '10.0.0.2');
      assert.strictEqual(clientAddress(req({}), 1), '203.0.113.9', 'missing header must fall back to the socket');
      assert.doesNotMatch(rateKey(spoofed, 0), /\|/, 'the bucket key still encodes the HTTP method');
    });

    await check('the in-flight ceiling sheds load and always releases', async () => {
      const limiter = createInflightLimiter({ maxInflight: 2 });
      const hold = () => new Promise((resolve) => {
        const res = emitter();
        limiter({ method: 'POST', headers: {} }, res, (error) => resolve({ error, res }));
      });
      const first = await hold();
      const second = await hold();
      assert.ok(!first.error && !second.error, 'the first two requests should pass');
      const third = await hold();
      assert.ok(third.error, 'the third concurrent request was allowed');
      assert.strictEqual(third.error.code, 'RATE_LIMIT_ERROR');
      assert.strictEqual(third.error.status, 429);
      assert.strictEqual(third.res.headers['Retry-After'], '2');
      first.res.emit('finish');
      second.res.emit('finish');
      const fourth = await hold();
      assert.ok(!fourth.error, 'slots were not released when responses completed');
      fourth.res.emit('close');
    });

    await check('the daily budget stops after the cap and resets next day', async () => {
      let clock = 0;
      const realDate = Date;
      const day1 = new Date('2026-10-11T12:00:00Z');
      const day2 = new Date('2026-10-12T12:00:00Z');
      global.Date = class extends realDate {
        constructor(...args) {
          if (args.length) return new realDate(...args);
          return new realDate(clock === 0 ? day1 : day2);
        }

        static now() {
          return (clock === 0 ? day1 : day2).getTime();
        }
      };
      try {
        const budget = createDailyBudget({ dailyRequestCap: 3 });
        const run = () => new Promise((resolve) => budget({ headers: {} }, emitter(), (error) => resolve(error)));
        assert.ok(!(await run()));
        assert.ok(!(await run()));
        assert.ok(!(await run()));
        const blocked = await run();
        assert.ok(blocked, 'the cap never fired');
        assert.strictEqual(blocked.code, 'RATE_LIMIT_ERROR');
        assert.match(blocked.message, /daily budget of 3/);
        clock = 1;
        assert.ok(!(await run()), 'the budget did not roll over to the next day');
      } finally {
        global.Date = realDate;
      }
    });

    await check('a cap of zero means unlimited, not blocked', async () => {
      const budget = createDailyBudget({ dailyRequestCap: 0 });
      for (let i = 0; i < 5; i += 1) {
        const error = await new Promise((resolve) => budget({ headers: {} }, emitter(), resolve));
        assert.ok(!error, 'unlimited budget blocked a request');
      }
      const inflight = createInflightLimiter({ maxInflight: 0 });
      const error = await new Promise((resolve) => inflight({ headers: {} }, emitter(), resolve));
      assert.ok(!error, 'maxInflight=0 should mean no ceiling');
    });

    await check('the extension itself can fail over between stored keys', async () => {
      // The pool was website-only in practice: settings stored one key and the core was
      // never handed a list, so "rotate to the next key on a 429" could not happen in VS Code.
      const state = freshState();
      const stub = makeVscodeStub(state);
      const loaded = loadExtension(stub);
      const { value, store } = makeContext(stub);
      const first = 'poolKeyOneForLocalChecks-01';
      const second = 'poolKeyTwoForLocalChecks-02';
      store.set('eis.apiKey.google', `${first}, ${second}`);
      const settings = new loaded.settings.SettingsManager(value, configStub({}));
      const keys = await settings.getApiKeys('google');
      assert.deepStrictEqual(keys, [first, second], `stored list parsed as ${JSON.stringify(keys)}`);
      assert.strictEqual(await settings.getApiKey('google'), first, 'the primary key changed');

      const history = new loaded.historyService.HistoryService(value, settings);
      const ai = new loaded.aiService.ExplainService({ settings, history, logger: { appendLine: () => {} } });
      const used = [];
      const transport = {
        json: async (options) => {
          const sent = decodeURIComponent(/key=([^&]+)/.exec(options.path)[1]);
          used.push(sent);
          if (sent === first) {
            return { status: 429, headers: {}, text: JSON.stringify({ error: { message: 'Resource has been exhausted (quota).' } }) };
          }
          return ctx.googleReply(ctx.EXPLANATION_JSON);
        },
      };
      ai.core.setConfig({ transport, retries: 3 });
      const outcome = await ai.explain({
        task: 'explain-topic',
        input: { subject: 'recursion', language: 'javascript' },
        token: { signal: new AbortController().signal, isCurrent: () => true },
      });
      assert.strictEqual(outcome.ok, true, `explain failed: ${JSON.stringify(outcome.error)}`);
      assert.deepStrictEqual(used, [first, second], `key order was ${used.join(',')}`);
      assert.strictEqual(outcome.meta.keysConfigured, 2, 'the answer does not say two keys were configured');
      assert.strictEqual(outcome.meta.keyIndex, 1, 'the answer does not say which key answered');
    });

    await check('a rate limit rotates immediately instead of sleeping on the exhausted key', async () => {
      const keys = ['poolKeyOneForLocalChecks-01', 'poolKeyTwoForLocalChecks-02'];
      const used = [];
      let slept = 0;
      const transport = {
        json: async (options) => {
          const sent = decodeURIComponent(/key=([^&]+)/.exec(options.path)[1]);
          used.push(sent);
          if (sent === keys[0]) {
            return { status: 429, headers: { 'retry-after': '30' }, text: JSON.stringify({ error: { message: 'quota exceeded' } }) };
          }
          return ctx.googleReply(ctx.EXPLANATION_JSON);
        },
      };
      const core = createCore({
        providerId: 'google', model: 'gemini-3.8-flash', apiKeys: keys, retries: 3, logger: QUIET, transport,
        sleep: async () => { slept += 1; },
      });
      const { meta } = await core.explain({ task: 'explain-topic', subject: 'recursion' });
      assert.strictEqual(used.length, 2, `upstream attempts: ${used.length}`);
      assert.strictEqual(slept, 0, 'the exhausted key was retried in place before rotating');
      assert.strictEqual(meta.retries, 0, 'rotation should not count as a retry of the same key');
    });

    await check('the website scrubs every key it could have signed with', () => {
      const { readConfig } = require(path.join(WEB_DIR, 'src/config.js'));
      const { redactSecrets } = require(path.join(SHARED, 'errors.js'));
      const primary = 'poolKeyOneForLocalChecks-01';
      const spare = 'poolKeyTwoForLocalChecks-02';
      const config = readConfig({
        EIS_PROVIDER: 'google',
        GOOGLE_API_KEY: primary,
        GOOGLE_API_KEYS: `${primary}, ${spare}`,
        EIS_ACCESS_TOKEN: 'accessTokenValue-123',
      });
      assert.ok(config.secretValues.includes(primary) && config.secretValues.includes(spare),
        'a pool key is missing from the scrub list');
      assert.ok(config.secretValues.includes('accessTokenValue-123'), 'the access token is not scrubbed');
      // Google carries the key in the URL, and gateways echo request data into errors.
      const leaked = redactSecrets(`failed: GET https://generativelanguage.googleapis.com/v1beta/models/x?key=${spare}`, config.secretValues);
      assert.ok(!leaked.includes(spare) && !leaked.includes(primary), `a key survived redaction: ${leaked}`);
    });

    await check('a provider reply that is not JSON never quotes the request key back', async () => {
      // Every adapter answers "replied with something that is not JSON" by quoting the
      // raw body, and gateways, proxies and error pages echo request data into that body.
      // Google redacted it while Anthropic and the OpenAI-compatible path — which also
      // serves OpenRouter, Groq and Kimi — did not, so one provider was enough to leak a
      // key into a log, an API error body and the panel. All dialects are asserted here
      // because the bug class is the message, not the provider.
      const { createAdapter } = require(path.join(SHARED, 'providers/index.js'));
      const cases = [
        { providerId: 'google', apiKey: 'localFixtureSecretAlpha-0123456789', model: 'gemini-3.8-flash' },
        { providerId: 'anthropic', apiKey: 'localFixtureSecretBeta-0123456789', model: 'claude-sonnet-5-5' },
        { providerId: 'openrouter', apiKey: 'localFixtureSecretGamma-0123456789', model: 'anthropic/claude-sonnet-5.5' },
      ];
      for (const item of cases) {
        const echo = `<html>gateway error: authorization was ${item.apiKey}</html>`;
        const adapter = createAdapter({
          providerId: item.providerId,
          apiKey: item.apiKey,
          model: item.model,
          timeoutMs: 5000,
          transport: { json: async () => ({ status: 200, headers: {}, text: echo }), sse: async () => ({ status: 200, headers: {}, text: '' }) },
        });
        let caught = null;
        try {
          await adapter.generate({ system: 's', user: 'u', expectJson: true, signal: new AbortController().signal });
        } catch (error) {
          caught = error;
        }
        assert.ok(caught, `${item.providerId}: a non-JSON 200 reply was accepted`);
        assert.match(caught.message, /not JSON/, `${item.providerId}: unexpected failure ${caught.message}`);
        assert.ok(!caught.message.includes(item.apiKey),
          `${item.providerId} put the API key into the error message: ${caught.message}`);
        assert.ok(!String(caught.stack || '').includes(item.apiKey),
          `${item.providerId} kept the key in the error stack`);
      }
    });

    await check('a malformed answer quotes the reply only after scrubbing the key', async () => {
      // The snippet in this message is the one part of a bad reply the user is shown.
      const { extractJsonObject } = require(path.join(SHARED, 'ai/extractJson.js'));
      const key = 'localFixtureSecretDelta-0123456789';
      let caught = null;
      try {
        extractJsonObject(`Sure! My key is ${key} and here is no object at all.`, { providerId: 'openrouter', secrets: [key] });
      } catch (error) {
        caught = error;
      }
      assert.ok(caught, 'a reply with no JSON object was accepted');
      assert.ok(!caught.message.includes(key), `the key survived into the message: ${caught.message}`);
      // Truncation alone is not redaction: a cut-off prefix of the key would still pass
      // the check above, so assert no part of the secret remains.
      assert.ok(!/localFixtureSecretDelta/.test(caught.message), `a key fragment was left in the message: ${caught.message}`);
    });

    await check('the access token is never accepted in a URL and never logged', async () => {
      const { createAccessGate } = require(path.join(WEB_DIR, 'src/middleware/security.js'));
      const gate = createAccessGate({ accessToken: 'secretTokenValue-123' });
      const queryAttempt = await new Promise((resolve) => {
        gate(
          { headers: {}, query: { token: 'secretTokenValue-123' }, path: '/api/explain' },
          { setHeader() {}, getHeader() { return undefined; } },
          (error) => resolve(error || 'passed'),
        );
      });
      assert.ok(queryAttempt !== 'passed', 'a token in the query string was accepted');
      assert.ok(String(queryAttempt.message || '').includes('access token'), 'the rejection reason is unclear');

      const { createErrorHandler } = require(path.join(WEB_DIR, 'src/middleware/errorHandler.js'));
      const lines = [];
      const handler = createErrorHandler(() => ['secretTokenValue-123'], { error: (name, fields) => lines.push(`${name} ${JSON.stringify(fields)}`) });
      const error = Object.assign(new Error('boom'), { code: 'PROVIDER_ERROR', status: 500, toJSON: () => ({ code: 'PROVIDER_ERROR' }) });
      handler(
        error,
        { method: 'POST', path: '/api/explain', originalUrl: '/api/explain?token=secretTokenValue-123' },
        { headersSent: false, status: () => ({ json: () => {} }) },
        () => {},
      );
      const logged = lines.join('\n');
      assert.ok(!logged.includes('secretTokenValue-123'), `the logged route carried the token: ${logged}`);
      assert.ok(logged.includes('/api/explain'), 'the route was not logged at all');
    });

    await check('a provider that stalls mid-response cannot hang the client', async () => {
      // Regression: the request deadline used to be cleared as soon as response
      // headers arrived, so a server (or a rambling model) that sent a few bytes and
      // then went quiet held the request open forever — and on the website, held an
      // in-flight slot with it. This runs the real socket path, not a stub transport.
      const { requestJson } = require(path.join(SHARED, 'http/client.js'));
      const http2 = require('http');
      const sockets = new Set();
      const server = http2.createServer((req, res) => {
        if (req.url === '/stall-after-headers') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.write('{"partial":');
          // deliberately never ends
        } else {
          // accept the connection, send nothing at all
        }
      });
      server.on('connection', (socket) => sockets.add(socket));
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();

      try {
        const started = Date.now();
        let caught = null;
        try {
          await requestJson({
            hostname: '127.0.0.1', port, protocol: 'http:', path: '/stall-after-headers', timeoutMs: 4000, idleMs: 400,
          });
        } catch (error) {
          caught = error;
        }
        const elapsed = Date.now() - started;
        assert.ok(caught, 'a stalled response body never timed out');
        assert.strictEqual(caught.code, 'TIMEOUT_ERROR', `stall classified as ${caught.code}`);
        assert.ok(elapsed < 2500, `the stall took ${elapsed}ms to notice`);

        const started2 = Date.now();
        let caught2 = null;
        try {
          await requestJson({ hostname: '127.0.0.1', port, protocol: 'http:', path: '/silent', timeoutMs: 500, idleMs: 500 });
        } catch (error) {
          caught2 = error;
        }
        assert.ok(caught2, 'a server that never sent headers never timed out');
        assert.strictEqual(caught2.code, 'TIMEOUT_ERROR', `silence classified as ${caught2.code}`);
        assert.ok(Date.now() - started2 < 3000, 'the header timeout fired too late');
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => server.close(resolve));
      }
    });

    await check('health reports pool state without any key material', async () => {
      const text = fs.readFileSync(path.join(WEB_DIR, 'src/app.js'), 'utf8');
      assert.match(text, /keysConfigured/, 'health does not report how many keys are pooled');
      assert.ok(!/entry\.hint/.test(text), 'health should not even expose key prefixes');
      assert.match(text, /blocked: entry\.blocked/, 'cooldown state should be reported');
    });

  })();

  function emitter() {
    const handlers = {};
    return {
      headers: {},
      setHeader(name, value) {
        this.headers[name] = String(value);
      },
      on(event, fn) {
        handlers[event] = fn;
      },
      emit(event) {
        if (handlers[event]) handlers[event]();
      },
    };
  }

  async function expectError(core, code) {
    let caught = null;
    try {
      await core.explain({ task: 'explain-topic', subject: 'a' });
    } catch (error) {
      caught = error;
    }
    if (!caught) fail(`expected ${code}, got a result`);
    if (caught.code !== code) fail(`expected ${code}, got ${caught.code}`);
  }
}

module.exports = { run };
