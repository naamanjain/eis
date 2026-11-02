# Security policy

## Reporting a vulnerability

Please report security issues privately rather than in a public issue:

- **Private vulnerability report:** <https://github.com/naamanjain/eis/security/advisories/new>
  (this must be enabled by the repository owner under *Settings → Security → Advanced →
  Private vulnerability reporting*; if it is not, see the fallback below.)
- **Fallback:** open a draft issue with only the words "security issue" in the title and no
  details, then ask the maintainer to enable private reporting. Do not describe the
  vulnerability in a public issue.

Include, in this order: what the flaw is, how you found it, what an attacker gains, and a
suggested fix if you have one. Redact any credential value you happen to have seen — a
prefix and its length is enough to identify it.

## What this project treats as a security boundary

- **API keys never leave the machine except toward the configured provider.** In VS Code
  they live in `SecretStorage`, not in settings, and never cross into the webview. On the
  website the key stays server-side: the browser only ever talks to `/api/explain`.
- **Error text is scrubbed before it is shown or logged.** Every path that quotes raw
  provider output passes through `redactSecrets()` first, and a regression check asserts it.
  A provider that echoes the request back is a realistic key-leak vector.
- **The webview is untrusted by construction.** The panel loads its script and stylesheet as
  files through `asWebviewUri()`, so there is no inline script anywhere in the document and
  `script-src` can stay at the CSP source with no `'unsafe-inline'` and no nonce. The policy is
  `default-src 'none'`, `connect-src 'none'` (the client opens no fetch, socket or event stream —
  it only posts messages to the host), `base-uri 'none'`, `form-action 'none'`,
  `object-src 'none'`, `img-src <cspSource> data:` and `font-src <cspSource>`. `style-src` keeps
  `'unsafe-inline'`, and the reason is this client rather than the editor: `webview/client.js`
  renders 23 inline `style` attributes through its element helper, and CSP3 has no nonce-less way to
  allow a style attribute (the workbench additionally injects its own theme `<style>` block). A gate
  check demands that allowance be removed the moment those attributes are moved into `styles.css`
  classes, so the exception cannot outlive its reason. `localResourceRoots` is limited to the
  extension folder, messages are validated in both directions, and commands the host does not
  implement are refused rather than ignored.
- **An untrusted folder cannot widen what leaves the machine.** The extension declares
  `untrustedWorkspaces: "limited"` with six `restrictedConfigurations` — `context.currentFile`,
  `context.maxCharacters`, `audit.aiFiles`, `audit.maxSendChars`, `privacy.saveHistory`,
  `privacy.codeRetention` — so VS Code ignores those values when a cloned repository sets them.
  No contributed setting can redirect a request: provider hostnames come from the built-in registry
  and keys from `SecretStorage`. Every numeric setting is clamped, `privacy.codeRetention` is
  validated against its enum, `audit.excludeGlobs` is escaped before it becomes a pattern, and the
  extension never spawns a process.
- **Source code you select is sent to the provider you configured.** The project-wide audit
  is local-only: `src/services/projectAudit.js` requires nothing but
  `src/shared/audit/localFindings.js` and never opens a network connection. Anything else
  that reaches a provider is a request the reader started, and only the context they chose.

## Past credential exposure — closed, and not present in this repository

An earlier private working repository of this project had a Google API key committed in a file
named `env`, in one commit that was later reverted in the tree while remaining reachable in that
repository's history. **The owner revoked the affected credentials, and this repository was
initialised from a clean snapshot: none of that history was imported.** Verified before the first
push, and re-verifiable by anyone with the clone:

- `node scripts/secret-inventory.js` sweeps tracked files, the working directory, every reachable
  Git object and the built `.vsix`, printing only category, length and a truncated SHA-256 — never
  a value. Exit 0 means nothing credential-shaped was found.
- `node scripts/check.js` runs that sweep as part of its `secrets` group, including a check that no
  file prints the leading or trailing characters of a known credential, because head-and-tail
  truncation is key material rather than redaction.

What the incident changed in the design, and what still guards it:

- `.gitignore` covers the credential shapes that actually occur — a bare `env`, extension-less
  private keys, and vendor-named credential JSON — not just `.env`.
- API keys live in VS Code `SecretStorage` (extension) or the server environment (website). They
  never enter a webview, a response body, a log line, a saved file or an error message; four
  provider error paths that used to quote a key now redact it.
- The server logs only whether a key is configured. It prints no prefix, suffix, mask, length or
  digest of the value.

Do not "verify" whether a leaked key still works by calling the provider with it. Confirm status in
the provider's own dashboard.

## Scope

Reports are welcome against the extension, the shared core, the website server and the
verification scripts. Out of scope: social engineering, physical access, third-party
services we do not operate, and attacks that require the victim to paste your code into
their own editor.
