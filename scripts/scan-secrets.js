#!/usr/bin/env node
'use strict';

// Independent secret scan of everything this repository publishes, using a maintained scanner
// rather than only the project's own detector. It reports three scans and a positive control:
//
//   1. Git history of this repository   — what a clone would inherit.
//   2. The working files, tracked or not — what the next commit would add.
//   3. The built .vsix                   — what an installed user actually receives.
//   4. A planted synthetic credential    — proof the scanner can see one, so "0 findings"
//                                        below cannot be read as "the scan looked at nothing".
//
// Gitleaks is not vendored here: point EIS_GITLEAKS_BIN at the executable, or put it on PATH.
// When it is absent this script exits 1 and says it did not run. A check that did not execute is
// never reported as a pass.
//
// No matched value is ever printed: only rule id, repo-relative path, line number and length.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { readZip, findZip } = require('./verify-package.js');

function gitleaks() {
  const fromEnv = process.env.EIS_GITLEAKS_BIN;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['gitleaks'],
    { encoding: 'utf8', shell: process.platform === 'win32' });
  const found = String(probe.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => fs.existsSync(s))[0];
  return found || null;
}

const bin = gitleaks();
if (!bin) {
  console.error('EISFAIL scan:secrets :: no gitleaks executable found — set EIS_GITLEAKS_BIN or put gitleaks on PATH');
  console.error('  Install: https://github.com/gitleaks/gitleaks/releases (verify the published checksums before running it)');
  process.exit(1);
}

const CONFIG = path.join(ROOT, '.gitleaks.toml');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'eis-scan-'));
let total = 0;
const failures = [];

function scan(label, source, extraFlags) {
  const report = path.join(work, `report-${label.replace(/[^a-z0-9]+/gi, '-')}.json`);
  const run = spawnSync([`"${bin}"`, 'detect', '--source', `"${source}"`, '--config', `"${CONFIG}"`,
    '--redact', '--exit-code', '0', '--report-format', 'json', '--report-path', `"${report}"`, ...(extraFlags || [])].join(' '),
    { encoding: 'utf8', shell: true, maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) {
    failures.push(`${label}: gitleaks exited ${run.status} — ${String(run.stderr || '').split(/\r?\n/).filter(Boolean).slice(-1)[0] || 'no message'}`);
    return;
  }
  if (!fs.existsSync(report)) {
    failures.push(`${label}: no report file was written, so the scan cannot be confirmed`);
    return;
  }
  let leaks;
  try {
    leaks = JSON.parse(fs.readFileSync(report, 'utf8'));
  } catch (error) {
    failures.push(`${label}: report unreadable (${error.message})`);
    return;
  }
  for (const l of leaks) {
    total += 1;
    const file = String(l.File || '').replace(/\\/g, '/').replace(ROOT + '/', '');
    const matchLength = String(l.Match || '').length;
    failures.push(`${label}: ${l.RuleID} in ${file}${l.LineNumber ? `:${l.LineNumber}` : ''} (${matchLength}-char match, redacted)`);
  }
  console.log(`${label}: ${leaks.length} leak(s) reported`);
}

// 1 + 2 — the repository, with and without its history.
scan('history', ROOT, []);
scan('worktree', ROOT, ['--no-git']);

// 3 — the packaged extension, unpacked. Whatever a user installs has to be clean on its own terms.
const vsix = findZip ? findZip() : null;
if (vsix) {
  const into = path.join(work, 'vsix');
  fs.mkdirSync(into, { recursive: true });
  try {
    const entries = readZip(fs.readFileSync(vsix), path.basename(vsix));
    let written = 0;
    for (const entry of entries) {
      if (!entry.data || entry.name.endsWith('/')) continue;
      const to = path.join(into, entry.name);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, entry.data);
      written += 1;
    }
    console.log(`(unpacked ${written}/${entries.length} files from ${path.basename(vsix)}; the archive parsed cleanly)`);
    scan('vsix', into, ['--no-git']);
  } catch (error) {
    failures.push(`vsix: the archive could not be read — ${error.message}`);
  }
} else {
  failures.push('vsix: no package found to scan — run `npm run package:ext` first. An unscanned artifact is not a clean artifact.');
}

// 4 — positive control. A credential-shaped value planted outside the repository must be reported,
// otherwise every "0 leaks" above is unmeasured.
const control = path.join(work, 'control');
fs.mkdirSync(control, { recursive: true });
fs.writeFileSync(path.join(control, 'planted.txt'), 'groq key: ' + ['gsk_', 'aB3dE5fG7hI9jK1lM2nO3pQ'].join('') + '\n');
const controlReport = path.join(work, 'control.json');
spawnSync([`"${bin}"`, 'detect', '--source', `"${control}"`, '--config', `"${CONFIG}"`, '--redact', '--exit-code', '0',
  '--report-format', 'json', '--report-path', `"${controlReport}"`, '--no-git'].join(' '),
  { encoding: 'utf8', shell: true, maxBuffer: 16 * 1024 * 1024 });
const detected = fs.existsSync(controlReport) ? JSON.parse(fs.readFileSync(controlReport, 'utf8')).length : 0;
if (detected < 1) failures.push('control: the planted synthetic credential was NOT detected — the scanner is inert, so no result above means anything');
console.log(`control: planted synthetic credential detected = ${detected > 0}`);

fs.rmSync(work, { recursive: true, force: true });

if (failures.length) {
  failures.forEach((f) => console.error('FAIL ' + f));
  console.error(`${failures.length} scan finding(s) or blocked scan(s).`);
  process.exitCode = 1;
} else {
  console.log('scan:secrets clean — history, working files and the packaged extension: ' + total + ' leaks across every surface, with the scanner proven able to see a planted credential.');
}
