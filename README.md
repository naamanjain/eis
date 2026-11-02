# Explain It Simply

An explanation layer for developers and learners. Ask about a concept or hand it some code and you
get two answers: one in plain language you can act on in fifteen seconds, and one with the precise
terminology, mechanism and edge cases. Then you can go deeper, ask for an example, or run a code
action on the same context.

Two surfaces, one shared core:

- **A VS Code extension** — explain a selection, a function, a file, an error at the cursor; find
  issues; simplify code. Answers live in an Activity Bar panel with local, searchable history.
- **A self-hosted web app** — an Express server that holds the provider key server-side and serves a
  landing page plus the explainer, including token-by-token streaming and cancel.

Both call the model you configure. Nothing about the product works without a provider key of your own.

---

## What it does, and where the boundaries are

| | |
|---|---|
| **Two-level answers** | Every reply is validated against a schema and rendered as a plain-language layer plus a technical layer, with a takeaway, an example and follow-up questions. |
| **Depth is a request, not a length** | *Quick*, *Balanced* and *Deep dive* ask for different structures; a deep answer carries nine sections, not more words. |
| **Code context is bounded and disclosed** | The selection plus enclosing function, imports and surrounding lines, capped by `explainItSimply.context.maxCharacters` (default 8 000). Every part included is listed on the answer with its size and any truncation notice. |
| **Local project audit** | `Find issues` scans the workspace with local rules only — `src/services/projectAudit.js` opens no network connection and never sends your tree to a provider. |
| **Six providers** | Google, Anthropic, OpenAI, Groq, OpenRouter and Kimi. Model ids come from vendor documentation dated 2026-10-11 and are labelled `verified` or `unverified`; the live model list reconciles them with reality once a key is present. |
| **Keys stay where they belong** | In the extension, keys live in VS Code `SecretStorage`; on the web, in the server's environment. A key never reaches a webview, a browser, a response body, a log line, a saved file or an error message. |
| **History is yours** | Local, capped, searchable, pinnable. `explainItSimply.privacy.codeRetention` decides how much source a saved answer keeps; `none` stores no code at all. |

It does **not** do: accounts, telemetry, cloud storage, a database, or a hosted demo. There is no
deploy step in this repository — the web app is meant to be run by whoever hosts it.

## Requirements

- **VS Code 1.85 or newer** (`engines.vscode: ^1.85.0`).
- **Node 18.17+** to run the web app and the verification gate. The build toolchain wants more:
  `@vscode/vsce` requires Node ≥ 22 and ESLint ≥ 18.18, so use Node 22 for linting and packaging.
  CI covers 18.17, 20 and 22 across Linux, Windows and macOS.
- **A provider API key** from one of the six supported providers.

## Install the extension

From a published `.vsix` (the packaging route this repository uses — it is not on the Marketplace):

```bash
code --install-extension explain-it-simply-2.0.4.vsix
```

Or inside VS Code: **Extensions → ⋯ → Install from VSIX…**.

Then open the **Explain It Simply** icon in the Activity Bar. The first run asks for
provider → model → key, with **Test connection** and **Refresh models** before it saves anything.

## Run it from source

```bash
git clone https://github.com/naamanjain/eis.git
cd eis
npm ci                                  # development toolchain only; the repo has no runtime deps
npm run check                           # the whole verification gate, no install needed for it
code explain-it-simply-vs-code-extension   # then press F5 to launch an Extension Development Host
```

Inside the development host: select code and press `Ctrl+Alt+E` (panel), `Ctrl+Alt+S` (explain
selection), `Ctrl+Alt+F` (enclosing function), `Ctrl+Alt+D` (the error at the cursor — only offered
when a diagnostic is present). The right-click menu adds *Find Issues* and *Simplify*.

## Build a `.vsix` locally

```bash
npm run vendor            # copy shared/ into the extension (do not hand-edit src/shared/)
npm run package:ext       # vsce package, after the vendoring gate
npm run verify:package    # read the archive back and assert what is inside it
npm run check:vscode:package   # run the real window suite against that package
```

`verify:package` is the one that matters before you hand a file to anyone: it asserts the package
contains every file needed to activate, that the manifest inside matches the source, that the
vendored core hashes the same as `shared/`, and that no credential pattern or home-directory path
survived the build.

## Run the web app

```bash
cd explain-it-simply-website
cp .env.example .env      # set one key, e.g. GOOGLE_API_KEY, and EIS_MODEL
npm ci
npm start                 # prints the bound address; defaults to 127.0.0.1:3000
```

`.env` is gitignored and `.env.example` ships only empty placeholders — fill it locally, never in a
commit. Then open the printed URL: `index.html` is the product page, `app.html` is the explainer.
`POST /api/explain` and `POST /api/explain/stream` (SSE) are the real endpoints and
`GET /api/catalog` tells the UI which providers, models, depths and tasks actually exist, so nothing
in the frontend is hardcoded ahead of the backend.

Out of the box the server binds to loopback, is rate limited, and serves only `public/`. Binding to a
reachable interface without `EIS_ACCESS_TOKEN` is refused at startup — otherwise the server is an
open proxy for your API key. Set `EIS_DAILY_REQUEST_CAP` if you expose it to anyone else.

## Test and verify

```bash
npm run check          # 160 dependency-free checks in 11 groups; prints the live total
npm run check -- --only secrets    # credential containment across files, history and package
npm run check -- --only server     # boots the real Express app with a mocked transport
npm run lint           # ESLint 9 over source, scripts, tests and the webview
npm run typecheck      # tsc --checkJs + strictNullChecks on the provider and schema modules
npm run vendor:check   # shared/ and the vendored copy must be identical
npm run audit          # dependency policy: production clean, every dev-only advisory named
npm run scan:secrets   # independent secret scan of history, working files and the built .vsix
npm run check:vscode   # a real, disposable VS Code window (needs a desktop)
npm run check:layout   # headless Chrome over CDP with trusted wheel input (needs Chrome)
```

Two rules govern these scripts, and they are asserted by the suite itself: a check that cannot run
reports a failure rather than passing quietly, and a scanner must prove it can see something before
its "nothing found" is allowed to count. `npm run scan:secrets` needs a maintained scanner —
set `EIS_GITLEAKS_BIN` or put `gitleaks` on `PATH`; without it the script exits 1 and says so.

## Repository structure

```text
eis/
├── shared/                              the AI core: providers, pipeline, prompts, schemas, context, errors
├── explain-it-simply-vs-code-extension/  the extension (src/shared/ is a generated copy of shared/)
│   ├── src/{extension,panel,sidePanel}.js
│   ├── src/{services,state,webview,test}/
│   ├── webview/{client.js,styles.css}
│   └── tools/preview/                   dev-only browser probe, excluded from the package
├── explain-it-simply-website/           Express server + static frontend
│   ├── server.js, src/{app,config,errors}.js, src/{middleware,routes}/
│   └── public/                          index.html, app.html, app.js, styles.css
├── scripts/                             the verification gate and release tooling
├── .github/workflows/ci.yml             the same checks on Linux, Windows and macOS
└── docs/                                ARCHITECTURE.md, DEVELOPMENT.md, RELEASE_CHECKLIST.md
```

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before changing the core: it covers the pipeline,
the provider boundary, the schema layer, and where secrets are allowed to exist.
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) has every command, the Node/toolchain floor table and the
vendoring workflow.

## Troubleshooting

| Symptom | What it actually is |
|---|---|
| "This server is not configured with a provider key" | No key in `SecretStorage` (extension) or the environment (web). Nothing you type can work until one exists. |
| The provider refuses the key | The key is wrong, scoped to a different project, or revoked. Check the provider's own console; do not probe a key by spending it. |
| `npm run check` reports a credential warning | A key-shaped value is sitting in a file the scan can read — usually a local `.env`. It is a reminder to revoke once, not a build error. |
| A model id is refused as retired | `shared/providers/registry.js` records retired ids with a recovery message; pick a current one from the live list. |
| `npm run check:vscode` exits 1 with "no VS Code executable found" | Blocked, not failed. Set `EIS_CODE_BIN` to your `code` binary. Never export `ELECTRON_RUN_AS_NODE` into it — that turns `Code.exe` into a plain Node binary. |
| `npm run scan:secrets` says no scanner found | Install Gitleaks and point `EIS_GITLEAKS_BIN` at it. An unrun scan is reported as a failure on purpose. |
| Packaging refuses | `vscode:prepublish` runs the vendoring gate first; run `npm run vendor` and retry. Never edit `src/shared/` by hand. |

## Contributing

See [CONTRIBUTING.md](.github/CONTRIBUTING.md) for the workflow and [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)
for the commands. The two conventions that catch most first contributions: edit `shared/` and run
`npm run vendor` — never the copy in `src/shared/` — and every behaviour you claim fixed needs a check
in `scripts/check.js` that fails without the fix.

## Reporting a security issue

See [SECURITY.md](.github/SECURITY.md). Use **private vulnerability reporting** on this repository
rather than a public issue, especially for anything credential-shaped. That file also records the
project's one past credential exposure, how it was closed, and which checks now guard it.

## Licence and third-party material

**MIT** — see [LICENSE](LICENSE). Copyright (c) 2026 Naaman Jain.

- Everything inside the built `.vsix` is authored in this repository: `npm run verify:package`
  enumerates the 41 files it ships and fails if an unexpected one appears. No third-party code,
  font or binary is redistributed by the extension or the web app.
- The web pages fetch two typefaces (**Syne**, **DM Sans**) at runtime from Google Fonts
  (`fonts.googleapis.com`, `fonts.gstatic.com`), both released under the SIL Open Font License 1.1.
  Nothing is bundled, so a browser visiting your deployment contacts Google's CDN — worth knowing if
  you self-host for users who shouldn't.
- Development tools (ESLint, TypeScript, `@vscode/vsce` and its signing binaries) are installed from
  npm at build time under their own licences, and never ship.

MIT is a permission to use, copy, modify, merge, publish, distribute and sublicense the code, and it
grants no royalty on anything downstream builds commercially from it.

## Known limitations

- **Model availability is a dated claim.** The ids in the registry were checked against vendor
  documentation on 2026-10-11. `npm run check` proves shapes and behaviour, not that a specific id is
  still sold tomorrow.
- **Only OpenRouter has been exercised end to end with a live key.** The other five adapters are
  verified against schemas, transports and error paths, not against a paid provider response.
- **One development-only advisory remains open.** `GHSA-g3hv-75wg-m249` (`minimatch`, moderate, fixed
  in 11.0.1) is reached only through ESLint and `@vscode/vsce`, both of which currently declare
  `minimatch ^10.2.6`, so no compatible upgrade exists. It cannot reach a user: production trees are
  audited with no severity floor. `npm run audit` names it explicitly rather than hiding it behind a
  severity threshold — see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).
- **No hosted deployment of the web app exists**, so nothing here claims HTTPS, header or CDN
  behaviour on a public origin. Those are properties of wherever you deploy it.
