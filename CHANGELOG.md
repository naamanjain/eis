# Changelog

Release history for Explain It Simply. Versions follow the extension manifest in
`explain-it-simply-vs-code-extension/package.json`.

**What this file can and cannot claim.** It was started in October 2026. Versions 2.0.0–2.0.2 have
no recorded release boundary — no tags and no version markers in the history — so they are **not**
reconstructed here; guessing which change shipped in which release would be inventing history.
The first tag in this repository is `v2.0.4`. Entries are written from work that can be pointed at
in the tree or in a report.

## [Unreleased]

Build toolchain and verification only. No file the extension ships changed, so this produces **no new
release and no new artifact** — the published `explain-it-simply-2.0.4.vsix` and its checksum stand.

### Fixed

- **`GHSA-g3hv-75wg-m249` / CVE-2026-118764 is resolved, not re-suppressed.** The advisory covers
  `minimatch >= 7.0.0, < 11.0.1`, and the only install inside that range was the `minimatch@10.2.6`
  that `@vscode/vsce@4.1.0` pulls — `npm ls minimatch` shows the three `minimatch@3.1.5` copies under
  ESLint sitting below the range, so they were never affected despite what the old carve-out said.
  Root `package.json` now declares `overrides: { "@vscode/vsce": { "minimatch": "^11.0.1" } }`, which
  resolves to **11.0.4**, and the exception entry is deleted rather than left behind.
- Why no upgrade was available first: vsce 4.1.0 is the current release and still declares `^10.2.6`;
  ESLint 10.14.0 declares `^10.2.6` as well, so adopting it would have **added** an affected copy
  where there were none. npm's own `fixAvailable` offered a semver-major downgrade to vsce 3.9.1,
  which would also have undone the `@azure/msal-node` fix that 4.1.0 brought. Both rejected.
- The override is scoped rather than global on purpose. A global `minimatch` override would force
  ESLint's 3.1.5 copies across two majors, and 3 → 11 changes the export shape that `eslint`,
  `@eslint/config-array` and `@eslint/eslintrc` import.
- The major jump that is taken was verified on behaviour, not on the changelog. vsce's whole use of
  the library is `minimatch(path, pattern, { dot: true })` at four call sites in `out/package.js` —
  lines 1377, 1378, 1636 and 1642 of the installed 4.1.0, counted from `minimatch_1.minimatch(`
  occurrences; an earlier draft of these notes said three. Minimatch 11's removals (`makeRe`,
  `Minimatch#regexp`, `MMRegExp`, the `AST` class, `maxExtglobRecursion`, `debug`) are used nowhere in
  it. The extension was then packaged under 10.2.6 and under 11.0.4 and compared member by member:
  **all 41 archive members identical by content digest**, so the build product did not change.
- The audit policy's stale-id rule is what proved the removal. With the override in place and the
  carve-out still written, `npm run audit` failed with `carve-out GHSA-g3hv-75wg-m249 is stale` while
  `npm audit --json` counted `total: 0` — a suppressed finding cannot produce that pair of results.
- **A new gate assertion, and two corrected ones** (164 → 165). `node scripts/check.js` now reads `package-lock.json` and
  fails if any `minimatch` install lands in `>= 7.0.0, < 11.0.1`, if the override is global, if
  `overrides` grows a second key, or if it stops requiring 11.x; a lockfile with no minimatch at all
  fails as a check that proved nothing. The older assertion that the policy "names an advisory id"
  was corrected, since an empty exception list is the goal — it now checks that advisory ids can be
  extracted and that any carve-out present carries id, package, chain and reason.
- Corrected in `README.md`, `docs/DEVELOPMENT.md`, `docs/RELEASE_CHECKLIST.md` and the policy comments:
  the installed ESLint is **9.39.5**, not the 10.14.0 those texts claimed, and ESLint was named as
  part of the vulnerable chain when its resolved copies sit outside the advisory range.

## [2.0.4] — 2026-11-02

The first release published from this repository. It is the 2.0.3 build plus everything recorded
below, packaged fresh from this tree as `explain-it-simply-2.0.4.vsix` (41 files) and verified with
`npm run verify:package` and the real-window suite against the package itself.

### Added — engineering gates (Phase 2)

- `.github/workflows/ci.yml`: portable checks on Windows, Linux and macOS across Node
  18.17 / 20 / 22, packaging plus the real VS Code window suite on Linux under Xvfb, a dependency
  audit, and a single summary check that treats a skipped job as a failure. Read-only token, no
  secrets, every action pinned to a commit SHA.
- `npm run lint` (ESLint 9, `eslint.config.js`) and `npm run typecheck` (`tsc --checkJs` +
  `strictNullChecks` over the provider and schema modules).
- `npm run verify:package` (`scripts/verify-package.js`): nine assertions about the built `.vsix`
  — required files, manifest agreement, exclusions, vendored-core drift, provenance digests,
  credential patterns, baked-in local paths.
- Eight `ci` checks, four workspace-trust checks and four credential-containment checks inside
  `node scripts/check.js`, plus two tests
  that error paths never quote an API key and one that an all-empty list field answers instead of
  crashing. The gate went from 133 checks to 155.
- Contributor surface: `CONTRIBUTING.md`, `SECURITY.md`, issue and pull-request templates,
  `docs/DEVELOPMENT.md` and `docs/RELEASE_CHECKLIST.md`.

### Fixed — engineering (Phase 2)

- **An answer containing an all-empty list crashed instead of replying.** `normalizeList()` returns
  `undefined` for a list whose every entry was empty, and two call sites in
  `shared/schema/explanation.js` chained `.map()` onto it — so a provider replying
  `"potentialIssues": [null]` threw `TypeError: Cannot read properties of undefined (reading 'map')`
  at the reader, and no retry could fix it. Such a field is now treated as absent.
- **Three providers' malformed-reply errors quoted the API key.** The "replied with something that
  is not JSON" message redacted the key for Google only; Anthropic and the OpenAI-compatible path —
  which also serves OpenAI, Groq, OpenRouter and Kimi — inserted the raw provider body. A gateway
  that echoes the request could put the key into a log, an API error body or the panel. All four
  sites now redact, and `shared/ai/extractJson.js` now actually uses the `secrets` argument it
  accepted and ignored.
- `shared/providers/openaiCompatible.js` called `redactSecrets` without importing it — a
  `ReferenceError` waiting on exactly the error path it was meant to protect.
- Dead code removed from the shared core and the gate: an unused `LITERAL_CREDENTIAL_RE` (the audit
  rule now uses the properly-escaped constant instead of an inline duplicate), unused imports, and
  parameters that had drifted out of `parseJson()` and `checkBlocked()`.

### Changed — extension reliability (Phase 2)

- **Webview CSP tightened.** `connect-src` moved from the webview's own origin to `'none'` (the
  client opens no fetch, socket or event stream), and `base-uri`, `form-action` and `object-src`
  are now stated explicitly rather than inherited. `style-src` keeps `'unsafe-inline'` with the
  reason recorded in the code: the workbench injects its theme `<style>` block into every webview.
- **Workspace trust declared instead of inherited.** The manifest now sets
  `capabilities.untrustedWorkspaces` to `"limited"` with six `restrictedConfigurations`, so a cloned
  repository cannot silently widen how much of your code goes to a provider or what gets retained on
  disk. `virtualWorkspaces` is declared `"limited"`: the project audit needs a real filesystem and
  reports unreadable files instead of failing.
- `npm run check:layout` now refuses to start on Node below 21 with an explicit message instead of
  failing mid-run, because the probe drives Chrome through Node's global `WebSocket`. Nothing that
  ships in the `.vsix` requires more than the declared Node 18.17 floor.

### Security — credential containment and closure verification (P0 incident, 2026-10-21 → 2026-11-02)

**Status: closed for this repository.** Three credentials were identified by length and truncated
SHA-256 — never a value — the owner revoked them, and this repository was initialised from a clean
file snapshot: none of the affected history, and none of the internal forensic reports, are part of
it. `.github/SECURITY.md` carries the published disclosure, and the checks below are what keep the
class of failure from returning.
- `scripts/secret-inventory.js`: full-surface credential sweep (tracked files, working directory
  including ignored files, every reachable and unreachable blob, all refs, stashes, the `.vsix`) plus
  `fragmentDisclosure()`, which flags any file printing the leading or trailing characters of a known
  credential. Exit codes are meaningful: 0 clean, 1 credential or fragment found, 2 git unavailable.
- Two reporting defects fixed, both found by writing the closure checklist: the gate's own disk
  warning printed **the first six characters of each on-disk credential**, and the Phase 1 reports
  printed each credential's head and tail. Both are now length + digest id only, and `node
  scripts/check.js` fails if a warning or a file carries credential material — checks demonstrated to
  fail on the real defect before they were allowed to pass.
- `.gitignore` and `.vscodeignore` extended to the shapes they previously missed: extension-less
  private keys, vendor credential JSON, and every secret filename inside the packaged extension.
  `.env.example` stays tracked, with a gate check that fails if it is ever ignored.
- Credential persistence re-audited in the extension: keys reach only `context.secrets`; `patch()`
  whitelists `providerId`/`model`/`depth`/`proseLanguage` into `globalState` and writes only a boolean
  `configured` flag.

### Fixed — server dependency (GHSA-27r3-jxmh-p828), 2026-10-25

- **`body-parser` 2.3.0 → 2.4.0** in `explain-it-simply-website`, transitively required by
  `express@5.2.1` (which declares `^2.2.1`, so no express upgrade and no code change were needed).
  Advisory: one unauthenticated request could crash the server — a valid gzip frame followed by
  trailing bytes reached a decompression stream that had been left piped with no error listener, and
  the decoder's error became an uncaught exception. 2.4.0 detaches the decoder with an error handler
  (`req.unpipe(stream); stream.on('error', () => {}); stream.destroy(); req.resume()`).
  Resolution was the smallest the existing chain allows: **`npm update body-parser`** (lockfile only,
  inspected before materialising, then `npm ci`) — 68 lock entries before and after, exactly three
  version changes (`body-parser` 2.3.0→2.4.0, `iconv-lite` 0.7.2→0.7.3, `qs` 6.16.0→6.16.1), zero
  packages added or removed, `package.json` untouched. `npm audit fix` was deliberately not run.
  Verified by `npm audit --omit=dev` → 0, `npm ci` exit 0, server group 21/21, security group 20/20,
  full gate 155/155, lint and typecheck clean, and the production entry booting on loopback. The
  crash itself was **not** reproduced locally against 2.3.0 (seven payload shapes under Node 24 all
  errored as 400 instead of crashing), so the fix is confirmed by the advisory range, the audit and
  the upstream source change — not by a PoC.

### Fixed — credential material in startup logs, 2026-10-25

- **The website no longer logs any characters of the API key at boot.** `server.js` printed
  `key <first 4>…<last 4>`, so four real characters of the live key went to stdout on every start —
  and stdout is a log aggregator in production. The masking helper is replaced by
  `describeKeyState()`, which says only `configured` or `not configured`: no prefix, no suffix, no
  mask, no length, no digest.
- **A regression test that could not fail was replaced.** The old assertion was
  `!log.includes(key) || path.includes('key=…')`; because Google carries the key in the query string
  by design, the right-hand side is always true, so it passed however widely the key was logged. It is
  now scoped (everything except the request path must not contain the key), with a can-see control on
  each side of that claim, plus an end-to-end check that boots the real process and scans its complete
  output for **any run of four or more characters** of a synthetic key. Both were break-proved:
  reinstating the mask fails the boot check (21/22), planting the key in request headers fails the
  scoped check (24/25), and the temporary source edits were reverted and verified byte-exact.
- **`scripts/vscode-window-check.js` stops hiding why the editor failed to start.** It inherited
  `ELECTRON_RUN_AS_NODE=1` from agent and Electron-packaged shells, which turns `Code.exe` into a plain
  Node binary that rejects every app flag and exits 9, while the driver reported only
  `0 passed, 0 failed (0 markers)`. The variable is now cleared for the child, and the host's
  non-marker output is printed when a run fails to start. The real-window suite passes 16/16 on the
  working tree and 16/16 on the packaged `.vsix` again.
- Whether an **already-captured** log line still sits in a hosted or CI log is a separate question that
  this cannot answer; only rotation ends it, which the owner has since done.

### Fixed — dependency metadata and the audit gate, 2026-10-29

- **The msal workaround was reverted: it fixed nothing and it corrupted the manifest.** The attempted
  containment of `GHSA-xcx6-jx8p-x3h5` had added `"@azure/msal-node": "^7.1.0"` to root
  `dependencies`, where HEAD declares **no** runtime dependency at all. `@azure/identity@4.14.0`
  cannot accept 7.x, so npm still nested the vulnerable `6.0.1` under it and the hoisted 7.1.0 was an
  unused second copy — while every clone of this repository installed a Microsoft auth library as a
  **production** dependency of a toolchain that ships nothing. Removing it: root lock 231 → 230
  entries (exactly one removal, no other version drift), `npm ls --omit=dev` → empty tree,
  `npm audit --omit=dev` → 0, and the lockfile re-proved with `npm ci` in a scratch directory
  (exit 0, 210 packages). **The advisory is open and is not claimed as fixed.**
- **`npm run audit` (`scripts/audit-policy.js`) replaces `npm audit --audit-level=high`, in CI and
  locally.** A severity flag cannot express "this one dev-toolchain advisory is a known limitation"
  and "this one is news" at the same time, so the audit job as written could never have reported
  green. Production trees must be completely clean, with no floor. A high reaching only dev
  dependencies is tolerated only when its GHSA id is named in the file. A named id that npm no longer
  reports fails on its own, so the carve-out cannot quietly outlive the advisory.
- **Gate total 156 → 157.** The new `ci` check holds the line the workaround crossed — the root
  manifest may declare no runtime dependency — and additionally requires that CI runs the policy
  rather than a severity flag, that the policy names advisory ids, audits production separately, and
  can distinguish an audit that failed from an audit that found nothing. Break-proved: re-adding a
  runtime dependency fails the gate with exit 1; renaming the tolerated id, and emptying the list,
  each fail `npm run audit` with exit 1; all three files were restored byte-identical afterwards.
- The advisory that motivated this machinery (`GHSA-xcx6-jx8p-x3h5`, `@azure/msal-node`) was later
  fixed properly rather than carried — see the 2.0.4 publication entry below.

### Fixed — website defects found by a live browser pass, 2026-10-29

Written by a parallel QA session that drove the website in a real browser against locally started
instances; the gate, the diffs and the break proof below were re-measured independently afterwards.
The report and its 93-row coverage ledger were kept with the development record rather than
published, because they reference the on-disk credential file and provider refusals.

- **The auth error told the user something false.** `AUTHENTICATION_ERROR` read "…so the request never
  left", and the server log for the same request showed a completed provider call. Now
  "so no answer could be made". `VALIDATION_ERROR` said "nothing was sent" for refusals raised after
  the body reached the server; now "nothing was generated" (`public/app.js`).
- **Rejected submissions stacked identical error cards.** `renderError(…, { keepAnswer: true })`
  appended without clearing, so two failed submits produced two `role="alert"` cards — and with no
  dismiss control, the pile buried both the retry button and the kept answer. Prior alerts are now
  removed before the new one is inserted (3 empty submits → 1 card).
- **The question box had no keyboard focus indicator.** `.ask textarea:focus { outline: none }` killed
  the ring for keyboard users too; measured live, tabbing into it changed nothing while the other 11
  controls drew a 2 px ring — a WCAG 2.4.7 failure on the product's primary control. The rule is now
  `:focus:not(:focus-visible)`, which keeps the no-ring-on-pointer intent (`public/styles.css`).
- **The daily-budget refusal sent no `Retry-After` while claiming `retryable: true`.** The budget rolls
  at UTC midnight, so the wait is computable; `src/middleware/security.js` now sets `Retry-After` and
  says "resets in 4h 12m" instead of inviting retries that cannot succeed until the day turns over.
  Guarded by a new `server` gate check over a real listening socket — and **break-proved**: deleting
  only the header line gives `22/23`, exit 1, `Retry-After missing or out of a day: undefined`, with
  the file restored byte-identical.
- **Gate total 157 → 158.** Five further defects were reported rather than quietly patched: 20–22 px
  nav targets, JSON-shaped 404s for favicon/robots/sitemap, cancellations logged as
  `MALFORMED_RESPONSE`, one dead CSS selector, and a static design mockup that was served but inert
  under the app's own Content-Security-Policy. That mockup is the one of the five with a licence
  consequence: its own `© 2025 … Hackathon` notice predates this project's history and nothing in the
  repository establishes who authored it, so it is not published here.
- **Not a fix, and the reason that release was held:** both provider keys in
  `explain-it-simply-website/.env` were being refused by their own providers at the time. A product
  cannot ship on the strength of a mocked transport, and a placeholder key is not a substitute for
  the owner supplying a working one.

### Added — publication, licensing and an independent secret scan (2.0.4)

- **MIT licence applied**, copyright 2026 the repository owner, with `license` and `author` fields
  added to all three manifests and the licence text shipped inside the `.vsix` (41 files, one more
  than the previous build, and the extra file is `LICENSE`).
- **The build toolchain advisory is fixed, not carried.** `@vscode/vsce` 4.0.0 → 4.1.0 pulls
  `@azure/identity` 4.14.0 → 4.14.1, whose dependency range accepts `@azure/msal-node` 7.1.2, so the
  vulnerable nested 6.0.1 left the tree entirely. `npm audit` now reports 0 HIGH and 0 CRITICAL, and
  the carve-out for `GHSA-xcx6-jx8p-x3h5` was deleted — the policy fails if a named id stops being
  reported, so keeping it would have been caught.
- **One new advisory is named rather than thresholded away.** `GHSA-g3hv-75wg-m249` (`minimatch`,
  moderate, fixed in 11.0.1) is reached only through ESLint and `@vscode/vsce`, both of which declare
  `minimatch ^10.2.6` — including current ESLint 10.14.0 — so no compatible upgrade exists. The audit
  policy now fails on **any unnamed dev-only advisory at any severity**, not only high and critical:
  a severity threshold is where an open finding goes to become invisible.
- **`npm run scan:secrets`** scans this repository's Git history, its working files and the unpacked
  `.vsix` with a maintained scanner (Gitleaks), using one reviewed allowlist entry — the vendored
  provenance manifest, whose values are SHA-256 digests and nothing else. Three checks make that
  exemption safe rather than convenient: the manifest may contain only `source`, `count` and 64-hex
  digests; the scanner config may hold exactly one path exemption, must keep Gitleaks' default
  ruleset, and must not gain a shape-based regex; and the scan plants a synthetic credential in a
  temporary directory and fails if the scanner does not report it. Without a scanner installed the
  script exits 1 and says it did not run.
- **A test fixture stopped looking like a key.** The Groq fixture in `scripts/check.js` was a
  contiguous key-shaped literal, which is precisely what a secret scanner is built to find; it is now
  assembled at run time from fragments while staying long enough and shaped well enough to exercise
  the provider prefix rule. Break proof: joining without the separator fails the suite with
  `One of those keys does not match Groq: Groq keys start with 'gsk_'`, so the fixture still tests the
  thing it claimed to test.
- **Assets withheld from publication on provenance grounds**, with the reason recorded: the
  hackathon-era design mockup whose authorship no evidence in the repository establishes. Nothing
  referenced it, no test depended on it, and the site's two real pages are unaffected.
- **Gate total 158 → 161.** Two `secrets` checks for the scanner guardrails described above, and
  one `ci` check that reads the verify job's step order. Three break proofs (extra content in the
  provenance manifest, a shape-based exemption, a second allowlist) each failed the suite with exit 1
  and were restored byte-identically.
- **The first real CI run found an ordering defect no local run could see.** All five verify legs
  failed on the runner while every local run passed: the job ran `node scripts/check.js` before
  anything installed the web server's dependencies, and the gate's server group boots the real
  Express app. Reproduced locally by deleting `explain-it-simply-website/node_modules` from a clone
  (same failure, `Cannot find module 'dotenv'`), then fixed by installing the production tree of the
  web server first. Confirmed on the runner: on run `41485402700` the dependency audit and four of
  five verify legs then passed — ubuntu at Node 18.17, 20 and 22, and windows at 22 — replacing
  five failures, while macOS still failed inside the gate. The full picture is in the next bullet.
  The new `ci` check fails if the gate ever moves ahead of that install again
  the install back after the gate reports `CI installs what the gate boots before it runs the gate`
  at 10/11, exit 1, with the workflow restored byte-identically.

- **The runner picture, as finally measured.** On run `41485402700` the ordering fix made the
  dependency audit and four verify legs pass — ubuntu at 18.17, 20 and 22, and windows at 22 — while
  macOS still failed inside the gate and the package job was cancelled at 31 minutes in an unbounded
  download step. On the next run, `ddb58c2`, **all five verify legs and the audit passed**, including
  macOS, and the package job failed fast (3m10s) in that same download step now that it is bounded. The
  step was then made self-describing in `4792c3f`, which got past the download and failed later, at the
  real-window suite.

  Two of those results were written up at the time as unexplained, and they were: the job logs need
  authentication, and check-run annotations came back empty. Once the logs were readable with the
  repository's own credential — never printed, used only to name a failing check — both causes were
  ordinary defects, and neither was silenced by loosening a test.

  - The red ubuntu-22 leg on `4792c3f` (run `41496929800`) was `audit: audit runs against a stubbed
    workspace end to end`, on `assert.ok(report.finishedAt > report.startedAt)`. Both stamps come from
    `Date.now()`, so a stubbed audit that finishes inside the same millisecond fails there and passes on
    every other machine — which is exactly what the five later runs did. The assertion has been
    replaced with the contract the product actually has: the pair is ordered, and elapsed time
    **moves**, proved against a deliberately slow scan where the old `>` would also have passed a
    hardcoded value. Break-proved both ways: pinning `finishedAt` to `startedAt` fails the elapsed-time
    half, and setting it five milliseconds earlier fails the ordering half.
  - The packaging leg failed in one second because the Linux archive holds **two** files named `code`.
    The download step took `bin/code`, a shell wrapper that starts the CLI: it answers `--version` (so
    the step that checks the editor starts passed) and exits 0 with no window, so the window step
    reported `0 passed, 0 failed` and nothing about why. Selecting the application binary by its header
    then moved the failure to the probe, because `--version` against the binary opens a workbench and
    sits until its ceiling. Each file now does what it is for — the binary is `EIS_CODE_BIN` and the
    window target, the wrapper answers `--version`, and the shared libraries are checked with `ldd`,
    which cannot hang.
  - That exposed a third defect the same run could not have shown on Windows: the packaged leg asserted
    `README.md` against the extracted tree, and vsce ships `readme.md`. A case-insensitive filesystem
    returned the file; the Linux runner did not. Package contents are now asserted against the archive
    index, case-folded, so the assertion means the same thing on both.

  My own pushes were also destroying evidence: `cancel-in-progress: true` applied to pushes as well as
  pull requests, so each commit cancelled the run for the one before it and a macOS leg that had been
  going for twenty minutes reported `cancelled` — which is not a result. Cancellation is now limited to
  superseded pull-request runs, and the gate rejects an unconditional setting.

  Run `41696231574`, at commit `d46ca94`, is the first fully green run this workflow has produced: the
  dependency audit, all five verify legs (macOS, Windows, and ubuntu at 18.17, 20 and 22), and the
  package job with **both** real-window legs and the artifact upload — 8 jobs, every step. The window
  suite has never run on macOS or Windows CI; that leg is Linux under Xvfb and is not claimed as
  cross-platform coverage.
- **Line endings are pinned with `.gitattributes`.** Cloning the published repository on Windows
  produced a CRLF working tree while the snapshot directory held LF: two builds of one commit whose
  41 archive members are content-identical (all 41 normalised digests match) and whose raw bytes
  differ for 26. Pinning `eol=lf` makes one commit build one file. Independently measured: the zip
  container still embeds a DOS timestamp per entry, so two builds of the same commit differ at
  archive byte 10 and nowhere else — verification is by member digest, and the archive digest
  identifies one exact file.

## [2.0.3] — built, not published

Version in `explain-it-simply-vs-code-extension/package.json`. Reached by commit `2ebeb7a`
("Rework the extension: module boundaries, Activity Bar surface, 2.0.3") and the uncommitted work
described under [Unreleased] above. Not tagged, not on the marketplace.

### Added

- Activity Bar surface (`explainItSimply.sidePanel`) alongside the editor panel, sharing one hub so
  both show the same state.
- Project audit command with local-only analysis and in-editor markers.
- Free-route model visibility: `:free` suffix or zero-priced routes are labelled, filterable, and no
  longer hidden behind a curated shortlist.
- 22 contributed commands; `activationEvents: []` with on-demand activation verified against a real
  workbench.

### Fixed

- The webview could not scroll: the flex height/width chain was unbounded at several links, so
  content was clipped rather than scrollable. Measured inside a real window and in headless Chrome
  with trusted wheel input, not inferred from CSS.
- `explainItSimply.openSettings` delegated to `workbench.action.settings.workspace`, a command the
  host does not have; now routed to `workbench.action.openSettings` through a contributed command so
  the real-window suite covers the path.
- The Refresh control was offered to providers that cannot list models. It is now gated on
  `capabilities.listModels`.
- Vendoring was byte-comparison-sensitive, so a clean Windows clone with `core.autocrlf=true` looked
  stale; digests are now line-ending independent.

## Before 2.0.3

Not documented. `efdacb6` (repo hygiene, verification gate, architecture docs), `014fd50` (provider
core extracted into `shared/` and vendored), `af29ce7` (website restructured, keys server-side),
`30a5e17` (README), `6adfb98`, `0d59c7f` and `ab1178e` (secret-handling hardening) are the record;
no version boundary is recorded between them, so no version numbers are claimed for them here.

The website and extension were built together from 2026-03-29. The earliest material in the
private development history is a hackathon-era page that describes the project as a hackathon build;
its provenance was left unresolved there and it is not part of this published tree. What this
repository publishes is the source whose authorship is recorded here, licensed under MIT.
