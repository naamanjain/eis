# 🧠 Explain It Simply — VS Code Extension

Context-aware, two-layer explanations for code and concepts. Select code, park the
caret in a function, or sit on a compiler error — the command that fits the moment is
the one that shows up.

## ▶ Run it in development

1. Open this folder in VS Code and press **F5** (`Run Extension`) to start an
   **Extension Development Host**.
2. Press `Ctrl+Alt+E`, or select code and use the editor right-click menu.
3. First run opens setup: provider → model → key, with **Test connection** and
   **Refresh models** before anything is saved. Your key goes to VS Code secret
   storage (one per provider), never into the panel.
4. Aggregators list hundreds of models, so **Refresh models** shows the built-in
   ids plus 40 live ones and tells you how many more exist — the field next to the
   dropdown takes any id you type, e.g. an OpenRouter `:free` route.

There is no build step: `src/shared/` is a vendored copy of the repo's `shared/`
core, refreshed with `npm run vendor` from the repository root.

To check the extension in a real VS Code window (isolated profile, nothing of yours
touched, a window flashes open for ~20 s):

```bash
npm run check:vscode        # from the repository root
```

It runs `src/test/realWindow.js` inside the actual extension host and reports on
activation, commands, settings, the sidebar view, the webview CSP, audit diagnostics
and secret handling. `src/test/` is excluded from the packaged `.vsix`.

Package the same way twice and check the shipped files, not your working tree:

```bash
npm run package:ext          # explain-it-simply-<version>.vsix
npm run check:vscode:package # unpacks that .vsix and re-runs the suite inside it
code --install-extension explain-it-simply-<version>.vsix
```

## 🧭 Where the UI lives

The Activity Bar icon (left rail) opens the panel as a **sidebar view** — that is the
normal way in, no command palette needed. `Ctrl+Alt+E` on a selection works from the
editor too. Both surfaces show the *same* state: a run started from the editor menu
appears in the sidebar, and closing either one leaves the other usable. Prefer a wide
column for long answers? `Explain It Simply: Open in Editor Area`.

## ⌨ Commands

| Command | Default |
|---|---|
| Open Panel (sidebar if open, else editor area) | `Ctrl+Alt+E` |
| Open in Sidebar | the Activity Bar icon |
| Open in Editor Area | command palette |
| Explain Selection | `Ctrl+Alt+S` (needs a selection) |
| Explain Function at Cursor | `Ctrl+Alt+F` |
| Explain Current File | context menu |
| Explain Error Here | `Ctrl+Alt+D` (appears when the line has a diagnostic) |
| Explain a Topic · Teach Me · Generate Example | command palette |
| Find Issues · Simplify · Optimize · Add Comments · Generate Test | context menu |
| Audit Project · Audit Current File · Clear Audit Markers | command palette, explorer menu |
| Refresh Model List · Open Advanced Settings · Reset API Settings · Clear History | command palette |

`Ctrl+Shift+X` is deliberately **not** bound — that is VS Code's Extensions view.

## 🧭 What the panel shows

Answer sections render only when the answer contains them: Summary, Explain it
simply, Technical breakdown, How it works, Execution flow, Important lines,
Examples, Depends on, Key concepts, Potential issues (each labelled
`confirmed / potential / recommendation / uncertain`), Improvements, Complexity, Key
takeaway, Related topics. Each section has a copy button and collapses; code blocks
get a language label, copy control and a collapsed-by-default state for long ones.
Underneath: follow-up actions (simpler, deeper, example, teach me — or for code:
find issues, simplify, optimize, comment, test), Regenerate, and a "what was sent"
breakdown of the exact context included.

Depth is structural, not cosmetic: **Quick** asks for the simple layer and the
takeaway, **Balanced** adds the technical layer, **Deep dive** requires mechanism,
examples, concepts and mistakes.

## 🔍 Project audit

`Audit Project` runs in two passes:

1. **Local, free, offline.** Discovers source files (generated and vendor paths
   skipped, per-file size capped), then applies rules that only report what the text
   literally shows: credentials in source, abandoned `catch {}`, unguarded
   `JSON.parse`, `innerHTML`/`eval` sinks, shell or SQL built by string building,
   literal passwords, suppressed type/lint checks, TODO markers, console sprawl,
   oversized files and blocks. Every finding carries a severity of exactly
   `confirmed`, `potential` or `recommendation` — no guesses presented as facts.
   Confirmed and potential findings also become editor markers, so you can jump to
   one and press `Ctrl+Alt+D` to have that line explained.
2. **Model pass on the few files that need judgement.** By default 3 files — the ones
   with the hardest evidence — go through `find-issues` for purpose, risks and what
   to fix first. Any credential literal found locally is replaced with
   `[REDACTED <kind>]` *before* sending, so the audit never pastes a secret into a
   request.

The report states the file count, what was read versus what was sent, the character
and token estimate, what was trimmed, how many credentials were stripped, and the
hotspots ranked. File content signatures are remembered, so re-running re-reads only
what changed. `Local pass only, no API cost` in the Audit tab runs step 1 alone.

## ⚙️ Settings

Common choices live in the panel (provider, model, depth, answer language).
Advanced ones live in VS Code settings under `explainItSimply.`:

| Key | Default | Purpose |
|---|---|---|
| `context.surrounding` | `true` | include a few lines around the selection |
| `context.currentFile` | `false` | also send imports + enclosing function |
| `context.maxCharacters` | `8000` | extra-context budget (500–60000) |
| `ai.requestTimeoutSeconds` | `45` | abort a hung provider |
| `ai.maxRetries` | `2` | transient failures only (429/network/timeout) |
| `ai.structuredOutput` | `true` | use native JSON modes when a provider has one |
| `privacy.saveHistory` | `true` | keep answers locally |
| `privacy.codeRetention` | `snippet` | `none` / `summary` / `snippet` |
| `privacy.historyLimit` | `50` | entries kept; pinned entries survive clears |
| `audit.maxFiles` | `150` | files the local pass reads |
| `audit.aiFiles` | `3` | files sent for model review (0 = free local pass only) |
| `audit.maxFileBytes` | `200000` | largest file the audit will read |
| `audit.maxSendChars` | `40000` | total characters one audit may send |
| `audit.excludeGlobs` | fixtures, snapshots | extra paths to skip |
| `audit.showDiagnostics` | `true` | turn findings into editor markers |

History supports open, search, pin, delete and clear, shows its byte size, and never
stores a key — key-shaped strings found in model text are replaced before writing.
Need more quota than one key gives you? Paste several into the same field, separated by
commas. When a provider rate limits or rejects one, the request moves to the next key
and that key rests for a minute; the answer footer says which key answered
(`key 2 of 3`). A bad model id or an unreadable answer never rotates.

## 🔑 Providers and models

Defined once, in `src/shared/providers/registry.js` (source of truth: repo-root
`shared/`): Google Gemini (`gemini-3.8-flash`), Anthropic Claude
(`claude-sonnet-5-5`), OpenAI (`gpt-4o-mini`), Groq (`gpt-oss-120b`), OpenRouter
(`anthropic/claude-sonnet-5.5`) and Kimi/Moonshot (`kimi-k2.7-code`, tuned for
code). The last two are aggregators whose ids move around, which is exactly what
**Refresh models** is for. Models are
labelled `verified` or `unverified`; **Refresh Model List** asks the provider itself
which ids the key can use, and you may type any model id (it is then marked
unconfirmed). Ids the project used before and that are now retired are refused with a
clear message rather than sent.

## 🗂 Layout

```
src/
  extension.js              activation + command registration (no UI work at startup)
  panel.js                  webview lifecycle, message routing, request ledger
  webview/index.js          assembles the panel HTML + CSP
  webview/  (folder root)   styles.css, client.js — loaded as files, not inline
  services/
    aiService.js            the one door to the shared core
    editorContext.js        selection / function / file / diagnostics capture
    historyService.js       local history + privacy retention + key scrubbing
  state/settings.js         secret storage, choices, advanced settings
  shared/                   vendored AI core (adapters, pipeline, prompts, schemas)
```

Flow, error taxonomy and security details: [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md).
Check it: `npm run check` from the repository root.

## 📦 Package

```bash
npm install -g @vscode/vsce
cd explain-it-simply-vs-code-extension
vsce package --no-dependencies
```

`vscode:prepublish` runs the vendoring freshness check, so a stale `src/shared`
fails the package step instead of shipping an out-of-date core.

## 🔐 Security

Keys stay in secret storage and are stripped from every message; the webview runs
`default-src 'none'` with assets served from `webview/` only (`localResourceRoots`),
no inline scripts, and all model text enters the DOM through `textContent`. Requests
go only to the provider host named in the registry, and `open` links are restricted
to the registry's key-page URLs.
