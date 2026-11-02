# Explain It Simply — Website

Two things in one folder: the product landing page and the explainer app, served by
an Express backend that keeps the provider key on the server.

## Run

```bash
cp .env.example .env     # set GOOGLE_API_KEY (or another provider) and EIS_MODEL
npm install
npm start                # logs the bound address (default http://127.0.0.1:3000)
```

The server refuses to start when it would be useless or unsafe: no key, an unknown
provider, a malformed model id, no adapter for that provider, or a non-loopback
`EIS_HOST` without an `EIS_ACCESS_TOKEN`. A well-formed model id that is not in the
built-in catalogue (an aggregator route, a `:free` variant) starts and prints a notice
— it is sent as typed.

## Pages

| Route | What it is |
|---|---|
| `/` | `public/index.html` — landing: what the product does, who it is for, how it works. Its only dynamic part is an honest statement about the backend it is pointed at. |
| `/app.html` | the explainer: Concept/Code, depth (Quick/Balanced/Deep dive), language, dictation, real streaming answers, copy, follow-ups, retry, cancel. |

## API

| Route | Behaviour |
|---|---|
| `GET /api/health` | provider, model, `keyConfigured`, rate-limit numbers |
| `GET /api/catalog` | providers, models with `verified`/`unverified` status, tasks, depths, limits — the UI builds its controls from this, so nothing appears that does not work |
| `POST /api/explain` | `{subject, task?, depth?, language?}` → `{ok, requestId, meta, result}` |
| `POST /api/explain/stream` | same payload as Server-Sent Events: `accepted`, `delta`… `result` or `error` |

`result` is the shared Explanation v2 contract: `{version, kind, depth, title,
summary?, simpleExplanation, technicalExplanation?, howItWorks?, examples?,
keyConcepts?, commonMistakes?, whenToUse?, whenNotToUse?, executionFlow?,
importantLines?, dependencies?, potentialIssues?, improvements?, complexity?,
example?, code?, keyTakeaway?, relatedTopics?}`. Code actions
(`simplify`, `optimize`, `add-comments`, `generate-test`, `give-example`) return a
`CodeChange` object instead: `{title, code, language?, summary?, changes[], notes[], risks[]}`.

`meta` carries the audit trail: `requestId`, provider, model, `modelStatus`,
`structuredOutput` (`native` or `prompt`), `streaming`, `retries`, token `usage`,
`latencyMs`, per-stage timings, and `context.manifest` — the exact parts that were
sent with their sizes, plus `truncated` and human-readable `notices`.

Errors are `{ok:false, error:{code, message, retryable}}` with a status that matches
the class: `VALIDATION_ERROR` (400/413), `CONFIGURATION_ERROR` (503),
`AUTHENTICATION_ERROR` (502), `RATE_LIMIT_ERROR` (429 + `Retry-After`),
`TIMEOUT_ERROR` (504), `NETWORK_ERROR` / `PROVIDER_ERROR` / `MALFORMED_RESPONSE`
(502), `CANCELLED` (499).

## Hardening

- **Rate limit**: per-address sliding window (`EIS_RATE_LIMIT`, `EIS_RATE_BURST`,
  `EIS_RATE_WINDOW_MS`) with `X-RateLimit-*` headers, so one visitor cannot drain the
  key. Addresses come from the socket unless `EIS_TRUST_PROXY` says how many proxies
  are in front — `X-Forwarded-For` is otherwise attacker-controlled.
- **Concurrency and daily spend**: `EIS_MAX_INFLIGHT` simultaneous upstream calls
  (429 + `Retry-After: 2` beyond it, released when the response ends) and
  `EIS_DAILY_REQUEST_CAP` per UTC day. Both are per-process, in-memory guards.
- **Input**: types are checked rather than coerced, subject capped at 4 000 chars,
  body capped by `EIS_MAX_BODY_BYTES` (413 beyond it), task and depth validated before
  any provider call. Invalid requests never reach the provider.
- **Headers**: CSP (`script-src 'self'` — the frontend uses external files and
  `textContent` only), `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`,
  `Permissions-Policy` (microphone kept for dictation), `Cache-Control: no-store`.
- **Origins**: same-origin unless `EIS_ALLOWED_ORIGINS` lists them; unknown preflights
  get 403.
- **Access**: `EIS_HOST` defaults to loopback; a wider bind needs `EIS_ACCESS_TOKEN`,
  which the app then prompts for and sends as `Authorization: Bearer …`.
- **Logs**: structured, and `subject`, `prompt`, `code`, `messages`, `apiKey` and
  friends are replaced by their length. Registered secrets are scrubbed from any
  logged string.
- **Cancellation**: a client disconnect aborts the provider call. It watches the
  **response**, not the request stream — `req`'s `close` fires once the body is
  parsed, which would cancel every request in flight.
- `EIS_STRUCTURED_OUTPUT=false` and `EIS_STREAMING=false` are operator escape hatches
  for a provider that rejects the native schema or a proxy that buffers SSE.

## Multiple keys for one provider

`GOOGLE_API_KEYS=key-a,key-b` (note the trailing **S**) adds spare keys for the same
provider. When a provider rejects one — 401/403, or a wording match like Google's
"API key not valid" 400 — or rate limits it, the same request is retried on the next
key and the failed one cools down for 60s (5 minutes for an auth rejection). A bad
model id, an unreadable answer or a cancelled request does **not** rotate: it says
nothing about the credential. `GET /api/health` reports
`{keysConfigured, keyPool: [{index, blocked, reason}]}` — index and state only, never
a value, prefix or length. With a single key the behaviour is unchanged.

## Layout

```
server.js                       entry: validate config, then listen
src/config.js                   the only module reading process.env
src/app.js                      middleware order, routes, static dir
src/routes/explain.js           payload validation, JSON + SSE handlers
src/middleware/security.js      headers, CORS, access token, rate limiter
src/middleware/errorHandler.js  one error shape, 5xx logging
src/errors.js                   ApiError = shared error taxonomy + HTTP status
public/                         index.html, app.html, app.js, styles.css, landing.js
```

AI logic does not live here: the provider adapters, pipeline, prompts and schemas are
in `../shared/` — the same core the extension runs. See `../docs/ARCHITECTURE.md`.
