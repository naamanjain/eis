# Explain It Simply — Architecture

Phase 3 state: one AI core in `shared/`, two applications that consume it, and a
dependency-free gate that exercises the whole stack.

```
eis/
  shared/                       the AI core: providers, pipeline, prompts, schemas, context, errors
  explain-it-simply-vs-code-extension/
    src/                        extension host (services, panel, state, commands)
    src/shared/                 vendored copy of shared/ (see "Vendoring")
    webview/                    panel assets: styles.css, client.js (loaded under CSP)
  explain-it-simply-website/
    src/                        config, app, routes, middleware, errors (HTTP shell only)
    public/                     landing (index.html) + app (app.html, app.js, styles.css)
  scripts/check.js              npm run check — full gate
  scripts/vendor-shared.js      shared/ -> extension/src/shared + freshness manifest
```

## Request pipeline

`shared/pipeline/pipeline.js` — each stage is a separate exported function:

```text
input
  ↓ validateRequest      task, subject size, provider, model, key, context limits
  ↓ buildRequestContext  selection → enclosing block → imports → surrounding lines
  ↓ buildPrompt          task × depth → system + user + schema
  ↓ callAdapter          adapter.generate | adapter.stream, wrapped in withRetry
  ↓ extractJsonObject    fence strip, balanced-object scan, truncation repair
  ↓ normalize            Explanation v2 / CodeChange, unknown fields dropped
  ↓ validate             schema check; depth budget applied; shortfalls reported
result + meta
```

`meta` is what makes an answer auditable: `requestId`, task, depth, provider, model,
`modelStatus`, `structuredOutput` (`native|prompt`), `streaming`, `retries`, token
`usage`, `latencyMs`, per-stage timings, and `context.{manifest, truncated, notices,
chars, estTokens}`. The UI shows "what was sent" straight from that manifest.

## Provider abstraction

`shared/providers/index.js` resolves an id to an adapter exposing:

```js
{ providerId, model, capabilities,
  generate({system, user, schema, expectJson, signal}) -> {text, usage, stopReason}
  stream({..., onDelta})                               -> {text, usage, done}
  listModels({signal}) -> [ids]
  validate({signal})   -> {ok, modelExists, liveModels} }
```

| id | style | streaming | structured output | model list |
|---|---|---|---|---|
| google | generateContent | `streamGenerateContent?alt=sse` | `responseMimeType` + `responseSchema` (projected) | `/v1beta/models` |
| anthropic | messages | SSE `content_block_delta` | assistant-turn prefill `{` (no native mode) | none (probe only) |
| openai | chat completions | `stream:true` + `[DONE]` | `response_format.json_schema` strict | `/v1/models` |
| groq | chat completions | same | same | `/openai/v1/models` |
| openrouter | chat completions | same | same (`json_schema`) | `/api/v1/models` (public) |
| kimi (Moonshot) | chat completions | SSE, OpenAI chunk shape | prompt + validator | `/v1/models` |

OpenRouter and Kimi are aggregators/serialisers whose ids churn, so both advertise
`listModels` and the catalogue is reconciled against the live response; OpenRouter
ids are namespaced (`anthropic/claude-sonnet-5.5`) and are matched by the
credential-shape guard as ordinary strings. Attribution headers (`HTTP-Referer`,
`X-OpenRouter-Title`) are declared per provider and only sent there.

Adding a provider = a registry entry (+ a dialect case only if it speaks a new
way). No UI file changes. Anthropic's prefill brace is re-joined before parsing, so
the answer contract is identical across all six.

Schema projection is per-dialect on purpose: OpenAI strict mode needs every property
declared and `additionalProperties:false`; Google **rejects** `additionalProperties`
inside `responseSchema` — verified against the live endpoint on 2026-10-11 — so
`toGoogleSchema()` strips it. Sending one shared shape to both is not possible.

## Models

The only file containing model id strings is `shared/providers/registry.js`; a gate
check fails if a model id appears anywhere else. Each model carries `status:
verified|unverified`, and `RETIRED_MODELS` names what the project used before
(`gpt-3.5-turbo`, `gemini-1.5-*`, `gemini-2.0-flash*`, the Claude 3 snapshots,
`mixtral-8x7b-32768`, `gemma2-9b-it`) so a stale id produces "This model is no
longer available — choose another" instead of an opaque upstream error.

Current defaults: `gemini-3.8-flash`, `claude-sonnet-5-5`, `gpt-4o-mini`,
`gpt-oss-120b`, `anthropic/claude-sonnet-5.5` (OpenRouter), `kimi-k2.7-code`.
OpenRouter's ids came from its live `/api/v1/models` response and Kimi's from its API
docs. That response (checked twice on 2026-10-11) listed **462 models**, of which
**14 ids ended in `:free`** (`google/gemma-4-31b-it:free`,
`nvidia/nemotron-3-super-120b-a12b:free`, `cohere/north-mini-code:free`, …). So
`freeTier: true` is a fact about the provider — but the free routes are **not** pinned
in the catalogue because that suffix rotates between vendors week to week; they are
reached through **Refresh** or by typing the id, which is why the setup screen takes
any string. No Kimi model is available for free there (`moonshotai/kimi-k3` is listed,
`moonshotai/kimi-k3:free` is not).

**Verification caveat, stated plainly:** the Google, Anthropic, OpenAI and GroQ ids
come from vendor documentation scraped on 2026-10-11 (`ai.google.dev/gemini-api/docs/models`,
`platform.claude.com/docs/.../models/overview`, OpenAI's models + structured-output
guides, `console.groq.com/docs/models`). I could not confirm them with an API call
because no working key exists in this repo. OpenRouter's were checked against its
public model list, which needs no key. That is why the registry is not the
last word: `listLiveModels()` queries the provider with the user's own key,
`mergeLiveModels()` reconciles the catalogue (live-only ids are added, catalogue-only
ids are flagged `inLiveList: false`) and caps the extras at `LIVE_DISPLAY_CAP` (40) so
an aggregator's 462 ids do not become a 462-option dropdown — it returns
`hiddenCount`/`capped`, which the setup screen renders as "N more models are available
for this key — type the id". The setup screen has a **Refresh models** button,
`explainItSimply.refreshModels` is a command, and the model field takes any typed id
(`checkConfiguration` reports it as "sent as typed" without blocking, and it is
surfaced as `meta.modelStatus = 'unverified'`).

## Schemas

`shared/schema/explanation.js` — Explanation v2, depth-aware:

```js
{ version: 2, kind: 'topic'|'code'|'error', depth,
  title, summary?,
  simpleExplanation: { heading, body, points[] },
  technicalExplanation: { heading, body, points[] },
  // topic, deep only
  howItWorks[], examples[{title,language,code,note}], keyConcepts[{term,meaning}],
  commonMistakes[], whenToUse[], whenNotToUse[], relatedTopics[{name,why}],
  // code/error
  language, executionFlow[{step,detail}], importantLines[{line,why}], dependencies[],
  potentialIssues[{severity: confirmed|potential|recommendation|uncertain, description, where}],
  improvements[], complexity, example }
```

`quick` requires title + simpleExplanation + keyTakeaway; `balanced` adds the
technical layer; `deep` requires the study material. `REQUIRED[kind][depth]` drives
both the prompt's field list and the validator, so they cannot drift. Depth is
structural, not "more words": the required-field set changes, `applyDepthBudget`
drops over-answering, and the UI renders only what exists.

`shared/schema/codeChange.js` — `{title, language, code, summary, changes[], notes[], risks[]}`
for simplify / optimize / add-comments / generate-test / give-example.

Nothing is invented: `normalize()` keeps valid parts, drops the rest, and a missing
*optional* field is reported in `meta.missingFields` (the UI says "this depth wanted
N more field(s)"). Only a missing core field (`title`, `simpleExplanation`) is a hard
`MALFORMED_RESPONSE` failure.

## Prompts

`shared/prompts/tasks.js` holds task definitions — `explain-topic`, `explain-code`,
`explain-error`, `find-issues`, `teach-me`, `give-example`, `simplify`, `optimize`,
`add-comments`, `generate-test` — each with its ask text, contract and kind, plus
per-depth instructions and per-field guidance. `buildMessages()` assembles system +
user, the context block, the honesty guard ("do not claim anything about code you
were not shown"), and the answer language. No prompt string exists in an adapter or
in UI code.

## Context and budget

`shared/context/contextEngine.js` builds, in priority order: **selection → enclosing
function/class → imports → surrounding lines** (brace matching, or indentation for
Python-like files), inside `maxContextChars` (default 8 000; selection itself capped
at 40 000). Every included part is recorded in `manifest` with its size and reason,
truncation sets `truncated` plus a human notice, and nothing is dropped silently.
Hard ceilings: `HARD_MAX_DOCUMENT_CHARS` (200k) throws `CONTEXT_TOO_LARGE` before any
network call. The workspace is never read — callers pass what they have.

## Errors, timeouts, retries, cancellation

`shared/errors.js` defines the taxonomy (`VALIDATION_ERROR`, `CONFIGURATION_ERROR`,
`CONTEXT_TOO_LARGE`, `AUTHENTICATION_ERROR`, `RATE_LIMIT_ERROR`, `TIMEOUT_ERROR`,
`NETWORK_ERROR`, `PROVIDER_ERROR`, `MALFORMED_RESPONSE`, `CANCELLED`, `UNKNOWN_ERROR`)
with HTTP status mapping and `userHint()` text. `shared/providers/base.js` classifies
HTTP responses — including Google's habit of reporting an invalid key as **400**, not
401, which is detected by wording so the user is told to fix the key rather than
"try another depth".

- **Timeout**: one deadline per request (`EIS_REQUEST_TIMEOUT_MS` /
  `ai.requestTimeoutSeconds`), enforced by the http client plus a socket timer, plus a
  response size cap.
- **Retry**: `shared/pipeline/retry.js` — exponential backoff with full jitter,
  honours `Retry-After`, capped attempts; only `retryable` errors qualify. Never for
  validation, auth, configuration, context size, malformed replies or cancellation.
  A stream that already emitted text is never replayed.
- **Cancellation**: `AbortController` through client → adapter → route. Both surfaces
  use `shared/pipeline/requestLedger.js`: the newest request wins, the previous one is
  aborted, and `isActive()` prevents a slow answer from overwriting a fresh one
  (the panel test proves it with a deliberately slow first reply).
  On the website, disconnect is watched on the **response** — `req`'s close event
  fires when the body finishes parsing and would cancel every in-flight request
  (this was a real bug; see Vendoring/gates note).

## Website backend security

`src/middleware/security.js` — `Content-Security-Policy` (`script-src 'self'`; the
frontend uses external scripts and textContent only), `nosniff`, `X-Frame-Options:
DENY`, `Referrer-Policy`, `Permissions-Policy` (microphone kept), `Cache-Control:
no-store`, `Cross-Origin-Resource-Policy`. CORS is same-origin unless
`EIS_ALLOWED_ORIGINS` lists origins, and preflights from unknown origins get 403.
Rate limiting is a per-address sliding window with a burst allowance and
`X-RateLimit-*` / `Retry-After` headers. Body size is capped (`EIS_MAX_BODY_BYTES`,
413 beyond it), the query length is capped at 4 000 chars and types are checked
rather than coerced. `EIS_HOST` defaults to `127.0.0.1`; binding elsewhere **without**
`EIS_ACCESS_TOKEN` is refused at startup, because that turns the server into an open
proxy for the owner's key. When a token is set, `/api` requires it while the static
site still loads.

Logging (`shared/observability/logger.js`) is structured and redacts by key name:
`subject`, `prompt`, `code`, `messages`, `body`, `apiKey` etc. are replaced with their
length, and registered secrets are scrubbed from every string. Requests are logged as
`explain.ok {requestId, task, depth, provider, model, latencyMs, chars, retries,
shortfalls}` — no prompt, no source, no key.

## Webview surfaces

One controller (`src/panel.js`, the hub) owns the request ledger, the last result and
the editor-context listeners. It can be attached to more than one surface at a time:

| surface | how it appears | created by |
|---|---|---|
| Activity Bar view | the icon in the left rail, persistent | `src/sidePanel.js` (`SidePanelProvider`) |
| editor-area panel | a second column beside the code | `explainItSimply.openPanelInEditor` |

Invariants the hub keeps, each pinned by a check:

- **One state, many surfaces.** `_post` broadcasts to every attached webview, so an
  audit started from the editor menu shows up in the sidebar too.
- **A surface is dropped when it dies.** `postMessage` on a disposed webview *throws*
  in VS Code; a throw during a broadcast would lose the message for every live
  surface. Reading `.html` throws for the same reason and is used as a side-effect-free
  liveness probe (`_pruneDeadSurfaces`).
- **The hub outlives a surface, but not all of them.** Closing the sidebar view keeps
  the panel (and vice versa); the hub disposes only when the last surface is gone, and
  `ExplainPanel.sideWebview` is cleared before the surface removal so a dead view
  cannot keep a hub alive.
- **Commands prefer what is already visible**: an open editor panel is revealed, else
  the sidebar view is focused, else a panel is created. Nothing stacks a second copy.

Both surfaces render the same `webview/client.js`, loaded as a file under
`default-src 'none'` with `script-src` limited to the webview's own `cspSource`.

## Extension state, settings and history

- Per-provider API keys in secret storage (`eis.apiKey.<provider>`), so switching
  providers keeps the other keys; prefix-checked before saving.
- Choices in globalState: `eis.providerId`, `eis.model`, `eis.depth`, `eis.language`,
  `eis.modelChoices` (last model per provider).
- Advanced settings in VS Code (`explainItSimply.*`): context inclusion and budget,
  timeout, retries, structured-output toggle, history on/off, code retention, history
  limit. The panel can write only a whitelisted set of keys (`ExplainPanel.WRITABLE`).
- History (`src/services/historyService.js`) lives in globalState, capped, searchable,
  pinnable, deletable, with a byte size readout. `privacy.codeRetention` decides how
  much source survives: `none` (no code at all), `summary` (file name + 160 chars),
  `snippet` (≤ 4000 chars). Stored strings pass through a key-shape scrubber, and no
  field named like a credential is ever persisted.
- Commands: Open Panel, Explain Selection / Function / File / Error / Topic, Teach Me,
  Simplify, Find Issues, Optimize, Add Comments, Generate Test, Generate Example,
  Refresh Model List, Open Advanced Settings, Reset API Settings, Clear History.
  Menu visibility uses `editorHasSelection` plus a `explainItSimply.hasDiagnostic`
  context key updated on selection change, so "Explain Error" appears where it works.
- Webview: `webview/client.js` + `webview/styles.css` loaded via `asWebviewUri` under
  CSP with no inline scripts; every model string reaches the DOM through
  `textContent`, and `el()` throws if anything asks for raw html.

## Vendoring

`vsce` packages only the extension folder, so the core is copied into
`src/shared/` by `npm run vendor`, each file carrying a "do not edit here" header,
with `src/shared/ORIGIN.json` holding per-file sha256. `npm run check` runs
`vendor-shared.js --check` and fails if the copies drift, if a file is stale, or if
the vendored copy was edited directly. The website reads `../../shared` directly — it
has no packaging constraint. Phase 4 may replace this with a bundling step; the
drift check is the guard until then.

## Project audit

`shared/audit/localFindings.js` is deterministic and free: it reads nothing from the
network and spends no key. Rules cover credentials in source (seven token families,
each detector exercised by the gate), abandoned catches, unguarded `JSON.parse`,
DOM sinks, dynamic code execution, shell/SQL string building, literal credentials,
type-suppression, TODO markers, console sprawl, and size hotspots. Every finding
carries `{rule, severity, line, message, evidence}` where severity is only ever
`confirmed | potential | recommendation` — the analyser never claims more than the
text shows, and the credential finding masks the value it matched.

`src/services/projectAudit.js` then spends money deliberately: `auditProject`
discovers files with `workspace.findFiles`, drops generated/vendor paths and
anything over `audit.maxFileBytes`, analyses up to `audit.maxFiles` locally, and
sends only the top `audit.aiFiles` (default **3**) to the model for `find-issues`
judgement. Before sending, credential literals are replaced with
`[REDACTED <kind>]`, so a secret found locally is never pasted into a request.
The report states what was read versus what was sent, the character and token
estimate, what was trimmed, and how many credentials were stripped. Findings also
become editor diagnostics (and Problems entries), which makes `Explain Error` on a
flagged line part of the loop. Signatures of file contents are stored in
`workspaceState`, so a second run re-reads only changed files and the report says
how many.

## Key pool and server limits

`shared/providers/keyPool.js` — a core can hold several keys. Rotation happens only
on `AUTHENTICATION_ERROR` and `RATE_LIMIT_ERROR`; a bad model id, an unreadable reply
or a cancelled request says nothing about the credential, so it does not burn the
pool. A rejected key cools down for 60s (5 min for auth) and the next key serves the
*same* request, so the user sees an answer rather than a failure. `meta.keyIndex`,
`keysConfigured` and `keysTried` make it auditable; `/api/health` reports only
`{index, blocked, reason}` — never a value, prefix or length. With one key, the code
path is exactly the pre-pool behaviour.

Server ceilings (per process, in-memory, documented as such): `EIS_TRUST_PROXY`
(default 0 → `X-Forwarded-For` is ignored, because any client can set it; the bucket
is the socket address), `EIS_MAX_INFLIGHT` (default 2 concurrent upstream calls →
429 + `Retry-After: 2`, released on `finish`/`close`), `EIS_DAILY_REQUEST_CAP`
(default 300 per UTC day → 429 with an operator hint), and rate buckets keyed by
address only, not by method.

## Verification

`npm run check` → 110 checks in groups: syntax, secrets, vendored core, core, registry,
extension, webview, audit, security, server. Run one with `npm run check -- --only webview`.
None of them needs a GUI, a key, or an install.

`npm run check:vscode` is the exception: it launches a **real VS Code window** in a
throwaway profile (`--user-data-dir`, `--extensions-dir`, `--disable-extensions`) and runs
`src/test/realWindow.js` inside the actual extension host via `--extensionTestsPath`. It
asserts what only the workbench can answer — a contributed command activates the
extension despite `activationEvents: []`; all 22 commands register and all 15 settings
read back with their declared types; the panel's CSP is enforced and `client.js`
really executes (the webview's own `ready` message is the proof); the panel is a
singleton and rebuilds after dispose; audit markers reach `vscode.languages` with
their owner, rule id and severity ladder; and the audit report never carries the raw
secret it found. The first run of this suite found three defects that 100+ offline
checks had passed: evidence from an unrelated rule echoed a credential,
`new Diagnostic(range, message, severity)` was never given `source`/`code`, and finding
severities (`confirmed`/`potential`/…) were compared against an editor vocabulary
(`error`/`warning`), so every marker was a warning. It cannot run in CI without a
display, so it stays a separate command.

Beyond the groups named above: `node --check` on every source file; credential
scanning of tracked files plus a self-test that the scanner catches a planted key;
ignore coverage for the bare-`env` leak vector; the history scan reported as a
warning; the pipeline against a stubbed transport (depth effects, context manifest,
refusal before network, prose/truncated/extra-field replies, retry with
`Retry-After`, no retry on 401/400, 5xx retried, cancellation, ledger newest-wins,
streaming assembly, per-provider shapes, structured output off, live model
reconciliation, log redaction); registry invariants; the extension under a stubbed
`vscode` (command parity with the manifest, CSP + external assets, per-provider keys,
retention modes, history search/pin/scrub, no duplicate listeners, stale-result
guard, error recovery codes, client helpers + section renderers); the webview group **executes** `webview/client.js`
against a minimal fake DOM and asserts on the tree that comes out — screen renders,
option counts, masked key field, what a Save click actually posts, and model text
arriving as a text node rather than a tag. Two defects were found that way and are
now pinned by checks: a button that closed over the model id captured at render time
(so a typed id never reached `saveSettings`), and a provider switch that fell back to
the previously stored model, which belongs to another vendor; and the website
over real HTTP (headers, `.env` unreachable, catalog without secrets, validation
incl. 413, happy path, code auto-detection, SSE, rate-limit `Retry-After`, token
gate, CORS refusal, slow-provider lifecycle, response-bound cancellation guard).

plants a sample per detector (proving none is dead) and a clean file (proving no
false alarms), then drives `auditProject` against a stubbed workspace. The security
group proves failover ordering, cooldown across requests, no rotation on model or
parse errors, proxy-trust bucketing, in-flight shedding and release, and budget
rollover. Every gate has been sabotage-checked: disabling a detector, neutering the
limiter, removing the release, or turning rotation off each turns the run red.



## Phase 4 builds on

`meta.requestId` + `Ledger` for conversational continuity; `relatedTopics` and
`followupsFor()` as the surface for quiz/lesson actions; `potentialIssues[].severity`
for confirmed-vs-guess language; `listLiveModels()` for model-list refresh in the UI;
`CodeChange` + `applyCode` for editor write-back. Not built here on purpose: quizzes,
teaching mode beyond `teach-me`, accounts, analytics, persistent server-side state.
