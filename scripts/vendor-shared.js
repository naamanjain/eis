'use strict';
// Copies the repo-root `shared/` AI core into the extension as
// `src/shared/`, because vsce only packages files inside the extension folder —
// a cross-directory require would load in the source tree but break in a
// installed .vsix. The website server reads ../shared directly and needs no copy.
//
//   node scripts/vendor-shared.js           copy + write manifest
//   node scripts/vendor-shared.js --check   fail if the copy is stale or edited
//
// `shared/` is the source of truth; never edit the vendored copy.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'shared');
const TARGET = path.join(ROOT, 'explain-it-simply-vs-code-extension', 'src', 'shared');
const MANIFEST = 'ORIGIN.json';

function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else if (entry.name.endsWith('.js')) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

function digest(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

// Git with core.autocrlf=true rewrites text files to CRLF on checkout, so a
// byte-for-byte comparison reports a perfectly clean clone as stale — this gate went
// red on Windows for exactly that reason. Content is what is being asserted, so
// line endings are normalised before hashing on both sides.
function normalise(content) {
  return String(content).replace(/\r\n/g, '\n');
}

function digestFile(file) {
  return digest(normalise(fs.readFileSync(file, 'utf8')));
}

function buildManifest(dir) {
  const files = {};
  for (const rel of listFiles(dir)) {
    files[rel] = digestFile(path.join(dir, rel));
  }
  return { source: dir === SOURCE ? 'shared/' : 'vendored copy', files, count: Object.keys(files).length };
}

function copy() {
  fs.rmSync(TARGET, { recursive: true, force: true });
  const manifest = buildManifest(SOURCE);
  for (const rel of Object.keys(manifest.files)) {
    const destination = path.join(TARGET, rel);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const source = fs.readFileSync(path.join(SOURCE, rel), 'utf8');
    fs.writeFileSync(
      destination,
      `/* Vendored from ../shared/${rel} — do not edit here; run \`npm run vendor\`. */\n${source}`,
    );
  }
  fs.writeFileSync(path.join(TARGET, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest.count;
}

// The header line added to each file changes its bytes, so compare per-file
// content after stripping that line.
function check() {
  const sourceManifest = buildManifest(SOURCE);
  const manifestPath = path.join(TARGET, MANIFEST);
  if (!fs.existsSync(manifestPath)) {
    return ['the vendored copy is missing (run: npm run vendor)'];
  }
  const stored = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const problems = [];

  for (const [rel, hash] of Object.entries(sourceManifest.files)) {
    const vendored = path.join(TARGET, rel);
    if (!fs.existsSync(vendored)) {
      problems.push(`${rel}: missing from src/shared/`);
      continue;
    }
    const text = fs.readFileSync(vendored, 'utf8');
    const stripped = text.replace(/^\/\* Vendored from [\s\S]*?\*\/\r?\n/, '');
    if (digest(normalise(stripped)) !== hash) problems.push(`${rel}: differs from shared/ (edit shared/, then run npm run vendor)`);
    if (!text.startsWith('/* Vendored from')) problems.push(`${rel}: missing the vendored header`);
  }
  for (const rel of Object.keys(stored.files || {})) {
    if (!(rel in sourceManifest.files)) problems.push(`${rel}: stale file no longer in shared/`);
  }
  for (const rel of listFiles(TARGET)) {
    if (!(rel in sourceManifest.files)) problems.push(`${rel}: extra file in src/shared/`);
  }
  return problems;
}

function main() {
  if (process.argv.includes('--check')) {
    const problems = check();
    if (problems.length) {
      console.error('vendored core is out of sync:');
      for (const problem of problems) console.error(`  - ${problem}`);
      process.exit(1);
    }
    console.log(`src/shared is in sync with shared/ (${buildManifest(SOURCE).count} files)`);
    return;
  }
  const count = copy();
  console.log(`vendored ${count} files into explain-it-simply-vs-code-extension/src/shared/`);
}

main();
