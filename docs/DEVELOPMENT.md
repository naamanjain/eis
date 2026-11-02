# Development guide

Everything here reflects commands that were run in this repository, with their results.
Where something has not been verified, it says so instead of implying coverage.

## Toolchain

| Piece | Version | Where it is declared |
|---|---|---|
| Node.js (product runtime) | `>=18.17` | `engines.node` in the root and website manifests |
| Node.js (dev toolchain) | **22** | `env.NODE_VERSION` in `.github/workflows/ci.yml` — see why below |
| npm | whatever ships with Node 18.17+ | lockfiles are `lockfileVersion: 3` |
| VS Code | `^1.85.0` | `engines.vscode` in the extension manifest |
| Package manager | npm | `package-lock.json` in the root and website components |

**Not verified:** CI has not run yet, so Node on Linux and macOS is a configuration, not a result.
Locally everything above was exercised on Windows with the Node version reported by
`node --version`. Do not treat this table as cross-platform evidence.

The `verify` matrix is deliberately asymmetric — **ubuntu × {18.17, 20, 22}** plus **Windows × 22**
and **macOS × 22** — and the Node lines are not equal. A missing API or too-new syntax is not
operating-system dependent, so a 3×3 grid would buy the same signal three times.

| Node line | What runs on it | Why |
|---|---|---|
| 18.17 | dependency-free gate only (`check.js`, `vendor-shared.js --check`) | The `engines.node` floor, tied to the Node line VS Code 1.85 shipped with. A static scan of every shipped file found no API newer than it. |
| 20 | dependency-free gate only | Middle of the supported range. |
| 22 | gate **+ `npm ci` + lint + typecheck**; also the packaging, desktop and audit jobs | The tools demand it. |

**The toolchain needs a newer Node than the product does.** Read from the installed packages:
`@vscode/vsce@4.0.0` declares `engines.node: ">= 22"`, and `eslint@9` declares
`"^18.18.0 || ^20.9.0 || >=21.1.0"`. So lint cannot run on 18.17 and packaging cannot run on 20.
npm only *warns* about engines, which means a wrong pin looks like a passing job right up until the
tool actually fails — this was found in the Phase 2 diff review, after the workflow had already been
written with both mistakes. `node scripts/check.js --only ci` now asserts three things about it:
every matrix leg flagged `toolchain: true` clears ESLint's floor, the job running `package:ext`
clears vsce's, and **no operating system can pass CI without lint having executed on it**.

One further exception to the floor: `npm run check:layout` needs **Node 21+**, because the layout
probe drives Chrome over the DevTools protocol through Node's global `WebSocket`. It is
development-only (`tools/**` is excluded from the `.vsix`) and exits 2 with a clear message on an
older Node. Nothing that ships requires more than 18.17 — verified by scanning every shipped file
for newer APIs (`Object.groupBy`, `toSorted`, `AbortSignal.any`, `Array.fromAsync`, `RegExp.escape`,
the regex `v` flag, `util.parseArgs`, `structuredClone`, `crypto.randomUUID` and friends): the only
post-18 API in the whole tree is that dev-only `WebSocket`.

## Install

The verification gate needs no install at all — it uses Node built-ins only.

```bash
npm ci          # root: only the development toolchain (ESLint, TypeScript, vsce, @types/node)
cd explain-it-simply-website && npm ci    # server: express + dotenv, nothing else
```

The extension has **zero** runtime and dev dependencies; it is plain CommonJS loaded by VS
Code. Never add a dependency there without a demonstrated need — every one of them ships
inside the `.vsix` that a user installs.

Do not use yarn or pnpm: both lockfiles here are npm-format and regenerating them creates a
diff nobody can review.

## Run the checks

```bash
node scripts/check.js              # the whole gate, 11 groups
node scripts/check.js --only server
node scripts/check.js --only ci    # asserts the workflow file itself is safe
npm run vendor:check               # shared/ vs the vendored copy in src/shared/
npm run lint                       # ESLint 9, flat config
npm run typecheck                  # tsc --checkJs over the provider and schema modules
npm run audit                      # scripts/audit-policy.js, both npm projects
npm run scan:secrets               # independent secret scan; needs gitleaks (see below)
```

`npm run audit` is the CI dependency decision, run locally. It replaces `npm audit
--audit-level=high`, which cannot tell a known dev-toolchain limitation apart from news — a severity
flag fails on both, so the job could never have gone green while an advisory was open. The rules now:
a production tree must be completely clean at **any** severity, and a dev-only advisory is tolerated
at **any** severity only while its GHSA id is named in `scripts/audit-policy.js` with the reason it is
not fixable here. A named id that npm stops reporting fails on its own, which is what proved the last
one was genuinely fixed: `@vscode/vsce` 4.0.0 → 4.1.0 pulled `@azure/identity` 4.14.1, whose range
accepts a patched `@azure/msal-node`, so `GHSA-xcx6-jx8p-x3h5` left the tree and its carve-out was
deleted rather than left behind.

What is carried instead today is `GHSA-g3hv-75wg-m249` (`minimatch`, moderate, fixed in 11.0.1),
reachable only through ESLint and `@vscode/vsce` — both declare `minimatch ^10.2.6`, current ESLint
10.14.0 included, so no compatible upgrade exists. Forcing 11.x through `overrides` would be an
unverified major jump under a lint and packaging API and is a release decision, not an install-time
convenience. It must particularly not be done by declaring the package in root `dependencies`: that is
a **production** dependency of the repository, not a dev pin, and a previous attempt did exactly that
while leaving the vulnerable nested copy untouched.

## Secret scanning

`npm run scan:secrets` runs a maintained scanner (Gitleaks) over three surfaces — this repository's
Git history, the working files whether tracked or not, and the unpacked `.vsix` — then plants a
synthetic credential in a temporary directory and fails if the scanner does not report it, so a zero
count can never mean "the scanner looked at nothing". Gitleaks is not vendored: set
`EIS_GITLEAKS_BIN` to the executable or put `gitleaks` on `PATH`; without it the script exits 1 and
says it did not run, which is a blocked check, not a pass. Download it from its own releases page and
verify the published checksum before running it.

`.gitleaks.toml` keeps the default ruleset and adds exactly one reviewed exemption,
`src/shared/ORIGIN.json`, whose values are the SHA-256 digests of the vendored core and nothing else
— the generic key rule reads `"providers/keyPool.js": "<64 hex>"` as a key assignment. Three gate
checks keep that honest (`npm run check -- --only secrets`): the manifest may hold only digests, the
config may hold only that one path exemption with the default ruleset still extended, and a planted
credential must still be detected. Widening the exemption is a gate failure, not a configuration
choice.

Each exits non-zero on failure and prints the failing check name with the reason. A check
that cannot run reports a failure rather than passing quietly — there is no skip path in
`scripts/check.js`.

Two checks need something outside Node:

```bash
npm run check:vscode         # launches a real, disposable VS Code window
npm run check:vscode:package # the same suite against the unpacked .vsix
npm run check:layout         # headless Chrome over CDP, trusted wheel input
```

`check:vscode` looks for a `code` executable (`EIS_CODE_BIN` overrides it). If none is
found it prints `EISFAIL driver :: no VS Code executable found` and exits 1 — that is a
blocked check, not a passing one.

**`ELECTRON_RUN_AS_NODE` must not reach the editor.** Agents and Electron-packaged shells export it,
and with it set `Code.exe` behaves as a plain Node binary: it rejects `--user-data-dir`,
`--extensionDevelopmentPath` and every other app flag with `bad option`, exits 9, and the suite reports
`0 passed, 0 failed (0 markers)`. The driver deletes the variable before spawning and prints the
host's non-marker output when a run fails to start, so the reason is visible instead of an empty pass
count. If a window suite fails with zero markers, read those lines first — it is an environment
problem, not a product result.

## Build and inspect the extension package

```bash
npm run vendor                  # copy shared/ into the extension
npm run package:ext             # vsce package (runs vendor:check first via vscode:prepublish)
npm run verify:package          # read the .vsix back and check its contents
```

`verify:package` opens the archive with a small pure-Node zip reader rather than a system
`unzip`, so it behaves identically on Windows, Linux and macOS. It asserts nine things:
every file needed to activate is present, the packaged manifest matches the source, the
declared entry point exists, contributed commands all have ids, no development or private
file is included, the vendored core inside the archive is byte-identical to `shared/`, the
provenance manifest hashes true, no credential pattern appears in a shipped text file, and
no home-directory path was baked in.

## Workspace trust, and what a cloned repository can change

The extension declares its posture in `capabilities` instead of inheriting the default:

- **`untrustedWorkspaces: "limited"`** with six `restrictedConfigurations` —
  `context.currentFile`, `context.maxCharacters`, `audit.aiFiles`, `audit.maxSendChars`,
  `privacy.saveHistory`, `privacy.codeRetention`. In an untrusted folder VS Code ignores those when
  they come from the folder, so a repository someone else wrote cannot silently widen how much of
  your code goes to a provider or what gets kept on disk. User-level values still work.
- **`virtualWorkspaces: "limited"`** — editor-based explaining works without a disk; the project
  audit reads file sizes through Node `fs` and reports files it cannot stat as unreadable instead of
  throwing.

Why those six and not the other nine: there is **no setting that redirects a request** (hostnames
come from the registry, keys from `SecretStorage`), every numeric setting is clamped in
`src/state/settings.js`, `privacy.codeRetention` is validated against its enum, `globToRegExp()`
escapes metacharacters so `audit.excludeGlobs` cannot inject a backtracking pattern, and the
extension never spawns a process. What a folder *can* do is raise egress volume and retention within
those bounds — which is exactly what is restricted.

The declaration is enforced by four checks in `node scripts/check.js --only extension`, including
that every restricted id names a setting that still exists. A renamed setting would otherwise
un-restrict itself quietly.

**Not covered by the automated suite, but verified by hand on 2026-10-21.** The window driver
launches VS Code with `--disable-workspace-trust`, so `isTrusted` is always true under
`npm run check:vscode` and restricted mode is never observed there. A one-off probe against a real
extension host settled it, using an A/B pair so the result could not be explained by anything other
than trust enforcement.

Method: a throwaway profile and a temp folder whose `.vscode/settings.json` plants
`context.currentFile: true`, `context.maxCharacters: 60000`, `privacy.codeRetention: "none"` —
three restricted ids — **plus `audit.maxFiles: 2000`, which is deliberately not restricted** and
acts as the control.

| Window | `isTrusted` | `currentFile` | `maxCharacters` | `codeRetention` | `audit.maxFiles` (control) |
|---|---|---|---|---|---|
| trust enforced, folder untrusted | `false` | `false` (default) | `8000` (default) | `"snippet"` (default) | **`2000` — honoured** |
| `--disable-workspace-trust` | `true` | `true` | `60000` | `"none"` | `2000` — honoured |

Workspace settings are clearly being read in the untrusted case, because the control took effect
there; the three restricted ones did not. That is the declaration working, not a config-loading
accident. Note also that `workspace.workspaceTrustEnabled` is **not** in the stable API here and
reads as `undefined` — gating on it produces a false "did not run"; `isTrusted` is the value to
test.

The probe lived outside the repository deliberately, so the release diff stays free of one-off
scaffolding. Reproduce it with a temp folder as above and a `--extensionTestsPath` module that logs
`vscode.workspace.isTrusted` and `getConfiguration('explainItSimply').get(...)`, launched with and
without `--disable-workspace-trust` on **separate** `--user-data-dir` values (trust decisions are
remembered per profile). It should be re-run after any change to `restrictedConfigurations`.

### The webview CSP

`src/webview/index.js` builds: `default-src 'none'`, `script-src <cspSource>` with no
`'unsafe-inline'` (the client is loaded from a file, and there is no inline script anywhere),
`connect-src 'none'`, `base-uri 'none'`, `form-action 'none'`, `object-src 'none'`,
`img-src <cspSource> data:`, `font-src <cspSource>` and `style-src <cspSource> 'unsafe-inline'`.

`style-src` is the one directive that cannot be tightened today, and the reason is this project's own
code: `webview/client.js` renders 23 inline `style` attributes through its element helper, and CSP3
has no nonce-less way to allow a style attribute (the workbench additionally injects its own theme
`<style>` block). Moving those declarations into `styles.css` classes would let the allowance go —
a refactor, not a config edit — and a gate check now demands the removal so the exception cannot
outlive its reason. `frame-ancestors` is deliberately absent; the VS Code host frames the document by
design. Both reasons are in the code comment, so nobody re-derives them later.



## How shared-core synchronization works

`shared/` at the repository root is the **only** place to edit the AI core. The extension
needs its own copy because `vsce` packages files inside the extension folder only, so a
cross-directory `require` works in the tree and crashes in an installed `.vsix`.

```
shared/**/*.js  --(npm run vendor)-->  explain-it-simply-vs-code-extension/src/shared/**/*.js
```

The copy adds one line at the top of every file —
`/* Vendored from ../shared/<path> — do not edit here; run `npm run vendor`. */` — and
writes `src/shared/ORIGIN.json` holding a sha256 per file. `--check` strips the header,
normalises CRLF to LF **on both sides**, and compares digests, so a clean clone checked out
with `core.autocrlf=true` is not reported as stale. That normalisation is load-bearing: the
gate used to fail on Windows for exactly that reason.

The website server reads `../shared` directly and has no copy.

## How to add or change a provider safely

1. **Describe it in the registry** (`shared/providers/registry.js`). A provider entry is
   data: `id`, `name`, `style`, `hostname`, `path`, `keyEnv`, `keyUrl`, `keyPrefix`,
   `capabilities`, `defaultModel`, and the curated `models` list with a `status` per model.
2. **Pick a `style`.** Three adapters exist: `openai-chat-completions` (serves OpenAI,
   Groq, OpenRouter and Kimi), `anthropic-messages`, `google-generate-content`. A new
   dialect that speaks one of those shapes needs no new adapter — just a registry entry.
   A genuinely new dialect needs a new module plus one line in the `ADAPTERS` map in
   `shared/providers/index.js`.
3. **Declare capabilities truthfully.** `listModels`, `streaming`, `structuredOutput`
   (`json-schema` | `response-schema` | `prefill` | `prompt`) and `keyInQuery`. The webview
   reads these to decide what to render: a Refresh button only appears for a provider with
   `listModels`, and `keyInQuery: true` is what makes redaction on error text mandatory
   rather than defensive.
4. **Never put a curated model in without a status.** `STATUS.VERIFIED` means it was seen
   live; anything else is presented as unverified. `retirementReason()` documents models
   that used to exist.
5. **Route every error through `classifyResponse()`** with `secrets: [apiKey]`. That is the
   single place an HTTP failure becomes the error taxonomy, and it scrubs the key out of
   the message. Any new place that quotes raw provider text must redact first — the three
   "replied with something that is not JSON" paths were inconsistent exactly this way and
   are now covered by a regression check.
6. **Add mocked tests.** No check in this repository makes a live API request or needs a
   real key; adapters are exercised through an injected `transport`.
7. Re-run `npm run vendor`, `node scripts/check.js`, `npm run lint`, `npm run typecheck`.

## Diagnosing common failures

| Symptom | Cause and fix |
|---|---|
| `vendored core is out of sync` | You edited `src/shared/` directly. Put the change in `shared/` and run `npm run vendor`. |
| `npm run vendor:check` fails only on Windows | Line endings. Digests are normalised; if it still fails, a real content difference exists. |
| `vsce` refuses to package | `vscode:prepublish` runs the vendor gate first — fix the sync. Or a missing `repository`/`license` field; `--allow-missing-repository` covers the first, and the licence is an open owner decision. |
| `not sha-pinned: actions/...` | Someone moved a workflow step back to a tag. Pin the commit SHA. |
| `verify:package BLOCKED — no .vsix found` | Run `npm run package:ext` first. Exit code 2 means blocked, 1 means a real content failure. |
| `EISFAIL driver :: no VS Code executable found` | Set `EIS_CODE_BIN`, or run on a machine with VS Code installed. |
| The webview check complains about a command | `src/test/realWindow.js` extracts every `executeCommand('…')` target from source and asserts the host has it. A command that does not exist is a defect, not a test problem. |
| Lint reports `no-undef` for a runtime global | Add it to the correct globals map in `eslint.config.js` — Node globals and browser globals are deliberately separate. |
| `check:layout needs Node 21+` | The layout probe drives Chrome through Node's global `WebSocket`. Nothing shipped needs 21; switch this one command to a newer Node. |

## Style

- CommonJS (`require`/`module.exports`) throughout. No bundler, no transpiler.
- `'use strict'` at file top in Node files; inside the IIFE in the two browser scripts,
  which is why the `strict` rule is off for those paths only.
- Errors carry a code from `shared/errors.js` and are user-readable by design.
- Comments explain *why*, not *what*, and name the defect that produced them. Several exist
  because a gate once went red for a reason worth recording.

## Pull request expectations

See `.github/CONTRIBUTING.md`. CI runs the same commands listed above; if a check cannot
run on your machine, say so in the pull request instead of leaving it unstated.
