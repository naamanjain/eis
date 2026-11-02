# Contributing

Thanks for taking the time. This is a small codebase with unusually strict verification, so
please read this before opening a pull request.

## What to read first

1. [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) — the request pipeline, the provider
   boundary, the schemas and the security model.
2. [`docs/DEVELOPMENT.md`](../docs/DEVELOPMENT.md) — setup, every command, how shared-core
   synchronization works, and how to add a provider safely.

## Ground rules

- **`shared/` is the source of truth for the AI core.** Never edit
  `explain-it-simply-vs-code-extension/src/shared/` — it is a generated copy. Change
  `shared/`, then run `npm run vendor`.
- **Do not weaken a check to get green.** No skipped tests, no loosened assertions, no
  `eslint-disable` without a reason that survives review, no marking an unverified feature
  as passing. If a gate cannot run on your machine, say so in the pull request.
- **Never commit a credential.** `.env`, keys, tokens, private keys and connection strings
  stay out of the repository — including in test fixtures. Fixtures use inert values that do
  not mimic a real provider key shape, because the secret gate in `scripts/check.js` scans
  the whole tree, test files included, and this repository has been burned by exactly that.
- **No new dependencies without a demonstrated need.** The extension ships with zero
  runtime dependencies and that is a feature. The verification gate runs on Node built-ins
  alone so that a fresh clone can check itself with no install step.
- **Preserve the public contract**: extension identifier, command ids, setting keys,
  provider ids and the shape of `/api/explain`. Changing any of them is a breaking change
  and must be called out as such.

## Before you open a pull request

```bash
node scripts/check.js
npm run vendor:check
npm ci
npm run lint
npm run typecheck
npm run package:ext
npm run verify:package
```

If you touched anything the extension host runs, also:

```bash
npm run check:vscode
npm run check:vscode:package
```

If you touched webview layout or scrolling:

```bash
npm run check:layout
```

`npm run check:layout` needs Chrome and drives the real panel at measured sizes with trusted
wheel input. Programmatic scrolling reports success even when nothing is reachable by hand,
so it is not an acceptable substitute.

## Pull request expectations

Use the template. In short, a pull request should state:

- what changes and why it was needed, with the file and line where the defect lived;
- which checks you ran, with the numbers, and which ones you could not run;
- any behaviour a user would notice;
- screenshots or a short recording for webview changes.

One focused pull request beats a bundle. If you spot something unrelated, note it rather
than folding a drive-by fix in.

## Reporting a security issue

Do not open a public issue for a credential leak. This repository's history already contains
one unrevoked key, and a public issue is how the second one becomes a third. Use the private
route in [SECURITY.md](./SECURITY.md).
