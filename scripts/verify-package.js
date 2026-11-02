'use strict';
// Extension package verification. Reads the .vsix that `npm run package:ext` produced
// and asserts what a reviewer would check by hand: the artifact is a real VS Code
// package, it ships every file the extension needs to activate, it excludes everything
// that must not leave this machine, the vendored core inside it is byte-identical to the
// authoritative shared/ tree, and no credential or local path is baked into it.
//
//   npm run package:ext
//   npm run verify:package
//
// A .vsix is an ordinary zip. It is read here with zlib instead of a system unzip so the
// same check gives the same answer on Windows, Linux and macOS — the CI workflow runs all
// three, and a gate that only works where one tool exists is a gate that silently skips.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const EXT_DIR = path.join(ROOT, 'explain-it-simply-vs-code-extension');
const SHARED_DIR = path.join(ROOT, 'shared');
const { SECRET_PATTERNS } = require(path.join(SHARED_DIR, 'audit/localFindings.js'));

const textish = /\.(?:js|mjs|cjs|json|css|html|md|svg|txt|yml|yaml|xml)$/i;
// A home directory baked into a shipped file means a developer path leaked into the
// artifact — Windows `C:\Users\name\`, Linux `/home/name/`, macOS `/Users/name/`.
const LOCAL_PATH_RE = /(?:[A-Za-z]:\\Users\\|\/home\/[a-z]|\/Users\/[a-z])/;

function fail(label, detail) {
  return { ok: false, label, detail };
}
function pass(label, detail) {
  return { ok: true, label, detail };
}

// ---- zip reading (central directory -> local header -> raw deflate) -------------------

function readZip(buffer, label) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 66_000); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(`${label} is not a zip archive (no end-of-central-directory)`);
  const count = buffer.readUInt16LE(eocd + 10);
  if (count === 0xffff) throw new Error(`${label} uses zip64, which this reader does not support`);
  const entries = [];
  let off = buffer.readUInt32LE(eocd + 16);
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(off) !== 0x02014b50) throw new Error(`${label}: bad central directory entry ${index}`);
    const method = buffer.readUInt16LE(off + 10);
    const compressed = buffer.readUInt32LE(off + 20);
    const nameLen = buffer.readUInt16LE(off + 28);
    const extraLen = buffer.readUInt16LE(off + 30);
    const commentLen = buffer.readUInt16LE(off + 32);
    const local = buffer.readUInt32LE(off + 42);
    const name = buffer.subarray(off + 46, off + 46 + nameLen).toString('utf8');
    if (buffer.readUInt32LE(local) !== 0x04034b50) throw new Error(`${label}: bad local header for ${name}`);
    const dataAt = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const raw = buffer.subarray(dataAt, dataAt + compressed);
    let data = null;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`${label}: ${name} uses unsupported zip method ${method}`);
    entries.push({ name, data });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// ---- the checks -----------------------------------------------------------------------

function findVsix() {
  if (!fs.existsSync(EXT_DIR)) return null;
  const candidates = fs.readdirSync(EXT_DIR)
    .filter((name) => name.endsWith('.vsix'))
    .map((name) => ({ name, at: fs.statSync(path.join(EXT_DIR, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  return candidates.length ? path.join(EXT_DIR, candidates[0].name) : null;
}

function sourceManifest() {
  return JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'package.json'), 'utf8'));
}

// Files the running extension cannot activate without. Anything missing here is a broken
// artifact rather than a stylistic preference.
const REQUIRED = [
  'extension.vsixmanifest',
  '[Content_Types].xml',
  'extension/package.json',
  'extension/src/extension.js',
  'extension/src/panel.js',
  'extension/src/sidePanel.js',
  'extension/src/webview/index.js',
  'extension/src/services/aiService.js',
  'extension/src/state/settings.js',
  'extension/webview/client.js',
  'extension/webview/styles.css',
  'extension/src/shared/index.js',
  'extension/src/shared/ORIGIN.json',
];

// Anything matching these must never reach a user's machine.
const FORBIDDEN = [
  { re: /^extension\/src\/test\//, why: 'the in-host test suite is a development surface' },
  { re: /^extension\/tools\//, why: 'the preview harness and CDP probe are development-only' },
  { re: /^extension\/node_modules\//, why: 'dependencies must not be vendored by hand' },
  { re: /^extension\/\.git|^extension\/\.gitignore/, why: 'repository metadata' },
  { re: /^extension\/\.vscode\//, why: 'editor settings' },
  { re: /\.vsix$/, why: 'a package inside a package' },
  { re: /(^|\/)\.env/, why: 'local environment files' },
  { re: /\.(key|pem|p12|pkcs12)$/i, why: 'private key material' },
  { re: /^extension\/dist\/|^extension\/out\//, why: 'generated build output' },
];

function normalise(content) {
  return String(content).replace(/\r\n/g, '\n');
}

function stripBanner(text) {
  return text.replace(/^\/\* Vendored from [\s\S]*?\*\/\r?\n/, '');
}

function verify({ vsixPath, results }) {
  const record = (r) => results.push(r);
  const buffer = fs.readFileSync(vsixPath);
  const entries = readZip(buffer, path.basename(vsixPath));
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const label = path.basename(vsixPath);

  // 1. structure
  const missing = REQUIRED.filter((name) => !byName.has(name));
  record(missing.length
    ? fail('the package ships every file needed to activate', `missing ${missing.join(', ')}`)
    : pass('the package ships every file needed to activate', `${entries.length} files in ${label}`));

  // 2. the manifest inside the artifact is the manifest in the tree
  let packed = null;
  try {
    packed = JSON.parse(byName.get('extension/package.json').data.toString('utf8'));
  } catch {
    record(fail('the packaged manifest parses as JSON', 'could not read extension/package.json'));
  }
  if (packed) {
    const wanted = sourceManifest();
    const drift = ['name', 'publisher', 'version', 'engines', 'main']
      .filter((key) => JSON.stringify(packed[key]) !== JSON.stringify(wanted[key]));
    record(drift.length
      ? fail('the packaged manifest matches the source manifest', `differs in ${drift.join(', ')}`)
      : pass('the packaged manifest matches the source manifest', `${packed.publisher}.${packed.name} ${packed.version}`));

    const main = String(packed.main || '').replace(/^\.\//, '');
    record(byName.has(`extension/${main}`)
      ? pass('the declared entry point is present', main)
      : fail('the declared entry point is present', `${main} is not in the package`));

    const contributed = Object.values((packed.contributes || {}).commands || {})
      .filter((command) => typeof command.command !== 'string' || !command.command);
    record(contributed.length
      ? fail('every contributed command has an id', `${contributed.length} command(s) without a command id`)
      : pass('every contributed command has an id', `${(packed.contributes || {}).commands?.length ?? 0} commands`));
  }

  // 3. exclusions
  const violations = [];
  for (const entry of entries) {
    const hit = FORBIDDEN.find((rule) => rule.re.test(entry.name));
    if (hit) violations.push(`${entry.name} (${hit.why})`);
  }
  record(violations.length
    ? fail('the package excludes development and private files', violations.join('; '))
    : pass('the package excludes development and private files', `${entries.length} files, none excluded`));

  // 4. the vendored core inside the artifact really is the current shared/ tree
  const originRaw = byName.get('extension/src/shared/ORIGIN.json');
  if (!originRaw) {
    record(fail('the vendored core carries its provenance file', 'src/shared/ORIGIN.json missing'));
  } else {
    const origin = JSON.parse(originRaw.data.toString('utf8'));
    const listed = Object.keys(origin.files || {});
    const stale = [];
    const badHashes = [];
    for (const relative of listed) {
      const packedEntry = byName.get(`extension/src/shared/${relative}`);
      const sourcePath = path.join(SHARED_DIR, ...relative.split('/'));
      if (!packedEntry) {
        stale.push(`${relative} is listed but not packaged`);
        continue;
      }
      if (!fs.existsSync(sourcePath)) {
        stale.push(`${relative} is packaged but no longer in shared/`);
        continue;
      }
      const body = normalise(stripBanner(packedEntry.data.toString('utf8')));
      if (crypto.createHash('sha256').update(body).digest('hex') !== origin.files[relative]) {
        badHashes.push(`${relative} does not hash to its own ORIGIN.json entry`);
      }
      if (body !== normalise(fs.readFileSync(sourcePath, 'utf8'))) {
        stale.push(`${relative} differs from shared/`);
      }
      if (!packedEntry.data.toString('utf8').startsWith('/* Vendored from')) {
        stale.push(`${relative} lost its vendored header`);
      }
    }
    const unlisted = entries
      .map((entry) => entry.name)
      .filter((name) => name.startsWith('extension/src/shared/')
        && name !== 'extension/src/shared/ORIGIN.json'
        && !listed.some((relative) => name === `extension/src/shared/${relative}`));
    record(stale.length || unlisted.length
      ? fail('the vendored core in the package matches shared/', [...stale, ...unlisted.map((n) => `unlisted: ${n}`)].join('; '))
      : pass('the vendored core in the package matches shared/', `${listed.length} files synchronized`));
    record(badHashes.length
      ? fail('the provenance manifest inside the package hashes true', badHashes.join('; '))
      : pass('the provenance manifest inside the package hashes true', `${listed.length} digests verified`));
  }

  // 5. nothing credential-shaped or machine-specific inside the shipped text files
  const leaks = [];
  const absolutePaths = [];
  for (const entry of entries) {
    if (!textish.test(entry.name)) continue;
    const content = entry.data.toString('utf8');
    // match(), not test(): these patterns carry the g flag, and a stateful lastIndex
    // would let a second occurrence slip through the same file.
    for (const pattern of SECRET_PATTERNS) {
      if (content.match(pattern.re)) leaks.push(`${entry.name} → ${pattern.name}`);
    }
    if (LOCAL_PATH_RE.test(content)) absolutePaths.push(entry.name);
  }
  record(leaks.length
    ? fail('no credential pattern is inside the package', leaks.join('; '))
    : pass('no credential pattern is inside the package', `${SECRET_PATTERNS.length} patterns scanned`));
  record(absolutePaths.length
    ? fail('no private local path is inside the package', absolutePaths.join('; '))
    : pass('no private local path is inside the package', 'no home-directory paths found'));

  return { entries, label };
}

function main() {
  const vsixPath = findVsix();
  if (!vsixPath) {
    console.error('verify:package BLOCKED — no .vsix found. Run `npm run package:ext` first.');
    process.exit(2);
  }
  const results = [];
  let packedInfo;
  try {
    packedInfo = verify({ vsixPath, results });
  } catch (error) {
    console.error(`verify:package BLOCKED — ${error.message}`);
    process.exit(2);
  }

  const failed = results.filter((result) => !result.ok);
  for (const result of results) {
    console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.label}${result.detail ? ` — ${result.detail}` : ''}`);
  }
  const bytes = packedInfo.entries.reduce((total, entry) => total + entry.data.length, 0);
  console.log(`\n${packedInfo.label}: ${packedInfo.entries.length} files, ${bytes.toLocaleString('en-US')} unpacked bytes`);
  console.log(failed.length
    ? `${results.length - failed.length}/${results.length} package checks passed`
    : `${results.length}/${results.length} package checks passed`);
  process.exit(failed.length ? 1 : 0);
}

if (require.main === module) main();

module.exports = { readZip, verify, findZip: findVsix };
