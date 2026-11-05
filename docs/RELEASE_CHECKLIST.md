# Release checklist

Every line here is a command that exists in this repository or a setting the owner controls.
Nothing on this list may be ticked from memory: tick it because you ran it and read the
output.

## 1. Freeze and verify the tree

```bash
git status --porcelain          # must be empty, or the release builds from unreviewed work
git log --oneline -5
```

- [ ] Working tree is clean, or every uncommitted file is deliberately part of this release
- [ ] `node scripts/check.js` — record the pass count printed, currently `164/164`
- [ ] `node scripts/check.js --only server`
- [ ] `npm run vendor:check` — reports the number of synchronized files
- [ ] `rm -rf node_modules && npm ci && npm ls --depth=0` — the lockfile installs reproducibly
      from scratch and resolves exactly the declared dev dependencies
- [ ] `npm run lint`
- [ ] `npm run typecheck`

Warnings are not failures, but they must be **carried forward**, not dropped. The gate prints one
standing warning in this repository: the history scan found no credential in it, which is the same
output a history scan that is not running would produce, so it says so out loud rather than
reporting a silent all-clear. A different warning — one that names a commit — means a credential
really is in the history you are looking at. Read it; never release with an unread warning.

## 2. Build

```bash
npm run vendor                  # only if shared/ changed
npm run package:ext             # runs vendor:check via vscode:prepublish
npm run verify:package
```

- [ ] Version bumped in `explain-it-simply-vs-code-extension/package.json`
- [ ] `npm run package:ext` produced exactly one `.vsix` and it is the new version
- [ ] `npm run verify:package` passes all nine checks
- [ ] `npm run scan:secrets` reports 0 leaks across history, working files and the package, and
      prints that its planted control credential **was** detected
- [ ] Record the `.vsix` SHA-256 and its byte size; the release note and the local manifest must
      carry the same digest
- [ ] `CHANGELOG.md` has an entry for the version, naming the user-visible behaviour change.
      Move what is under `[Unreleased]` into a dated section as part of the release — the file
      records no version boundaries before 2.0.4, because none were ever recorded

## 3. Run it in a real editor

```bash
npm run check:vscode              # working tree
npm run check:vscode:package      # the packaged artifact
npm run check:layout              # needs Chrome
```

- [ ] The real-window suite passes against the working tree
- [ ] The same suite passes against the **packaged** artifact — this is the build a user gets
- [ ] `check:layout` passes at the narrow rail and the wide panel widths
- [ ] Installed into a local VS Code (`code --install-extension <file>.vsix`) and the Activity
      Bar icon opens the panel, a selection explains, and the result scrolls
- [ ] Restricted Mode re-verified by hand, per the A/B procedure in `docs/DEVELOPMENT.md`: the
      automated suite cannot see it (`--disable-workspace-trust`), and the unrestricted
      `audit.maxFiles` control must be honoured in the untrusted run or the test proves nothing

If you cannot run these, the release is **not verified on that surface**. Say so in the
release notes instead of leaving it unstated.

## 4. Server

- [ ] `cd explain-it-simply-website && npm ci --omit=dev && npm start` binds and serves
- [ ] `GET /api/catalog` lists only providers and models the registry actually has
- [ ] `POST /api/explain` and the SSE route return a structured answer with a mocked key
- [ ] **The same route returns a real answer with the key that ships in the deployment.** A mocked key
      proves the plumbing; it cannot prove the product. As of 2026-10-29 this bullet is untickable on
      this machine: both keys in `.env` are refused by their providers, so the core feature fails for
      every visitor
- [ ] A deployment target exists and is named — `ci.yml` has no deploy step and the docs carry no
      production URL, so today there is nothing to check headers, HTTPS and CSP against except a
      loopback instance
- [ ] Binding beyond loopback without `EIS_ACCESS_TOKEN` is refused at startup
- [ ] No secret appears in a response body, a log line, or a saved file

## 5. Security review before publishing

- [ ] `node scripts/check.js` reports no credential in tracked files
- [ ] No new credential-shaped fixture was added (the gate scans test files too)
- [ ] `npm audit --omit=dev` in `explain-it-simply-website` — zero, or each finding written
      into the release notes with its severity
- [ ] `npm run audit` at the root (after `npm ci`) — `scripts/audit-policy.js`: production must be
      clean at any severity, and every dev-only advisory at any severity must be named there. As of
      2.0.4 it passed carrying one named limitation, `GHSA-g3hv-75wg-m249` (`minimatch` >= 7.0.0,
      < 11.0.1), which has since been **resolved** by an `overrides` entry scoped to
      `@vscode/vsce` — so the list is empty and a clean `npm run audit` is the expected result, not a
      tolerated finding. A named id that npm no longer reports is itself a failure, and that rule is
      what proved the dependency had actually left the tree. If a future carve-out is unavoidable it
      must carry id, package, chain and reason, and the release notes must name it as an open
      limitation rather than as resolved.
- [ ] `.env`, keys and local paths are absent from the `.vsix` (`verify:package` asserts this)
- [ ] Past incidents restated in the release notes, not summarized away. `.github/SECURITY.md` is
      the published disclosure for this repository: it states what was exposed in the earlier private
      repository, that the credentials were revoked, and that none of that history was imported here.
      Do not describe a credential as revoked because a document says so — the claim belongs to the
      owner, and this repository's job is to prove its own history is clean with
      `node scripts/secret-inventory.js` and `npm run scan:secrets`.
- [ ] `node scripts/secret-inventory.js` exits 0 and reports no confirmed value in tracked files
      or the package (it prints categories, lengths and digests only — safe to paste into a
      release note)

## 6. Publish

These are owner actions and are not performed by an agent without authorization.

- [ ] A tag exists for the version (`git tag -a v<version>`) and `git ls-remote --tags origin`
      shows exactly that tag on the commit that was verified
- [ ] `main` on the remote is the commit that was verified — checked with
      `git rev-parse HEAD` against `git ls-remote origin main`, not assumed
- [ ] CI is green on the pushed commit, including the `All required checks` job.
      Measured on run `41696231574` (commit `d46ca94`): 8 jobs, every step, including both
      real-window legs. A green run is a property of the commit it ran on — re-check it on
      whichever commit is actually being released, and read the per-job conclusions rather
      than the run badge.
- [ ] The tag for the version points at a commit whose **shipped** source is the one in the
      artifact. `v2.0.4` points at `de20eaa`; everything after it in this branch touched CI,
      the local gate and documentation only, which `git diff --name-only v2.0.4..HEAD` proves
      by naming no file under `explain-it-simply-vs-code-extension/`, `shared/` or
      `explain-it-simply-website/`. Moving a published tag is a rewrite: don't do it to make
      this line read better — record what the tag points at instead.
- [ ] The `.vsix` from CI's artifact is the one published, or `vsce publish` run from the
      same commit
- [ ] Extension Marketplace listing matches what the code actually does

## 7. After publishing

- [ ] Install the released version from the marketplace in a clean VS Code profile and repeat
      the golden path
- [ ] Open issues caused by this release are labelled and linked to the version
- [ ] Any revoked-or-unconfirmed credential is still listed as open until the owner confirms
      provider-side revocation

## Not yet in this checklist

Things the repository cannot honestly assert yet, so no line pretends they happen:

- A signed release artifact (no signing key or `signCode` step is configured).
- Automated marketplace publication on tag (CI builds and verifies the `.vsix`, it does not
  publish it).
- Cross-platform **proof** for the real-window suite: it runs on Linux under Xvfb in CI and
  on Windows locally; macOS has never run it.
- A licence. `LICENSE` is MIT, copyright 2026 the repository owner; the third-party position is in
  open, which blocks publishing the extension as open source and blocks any marketplace listing
  that implies a grant.
