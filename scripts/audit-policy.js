#!/usr/bin/env node
'use strict';

// One audit decision for every npm project in this repository, so "the toolchain carries a known
// advisory" and "something new is broken" cannot be confused with each other.
//
// Rules, in order of hardness:
//   1. The production tree of every project must be completely clean — no severity floor.
//   2. A dev-only advisory of *any* severity is tolerated only if its GHSA id is named below.
//      There is no "moderate is noise" threshold, because that is how a finding stops being tracked.
//   3. A named id that npm no longer reports is itself a failure, so a carve-out cannot outlive the
//      advisory it was written for and become a permanent blind spot.
//   4. An audit that produced no parseable JSON is reported as not run. A scan that looked at
//      nothing is never allowed to look like a pass.
//
// Nothing from the audit payload is printed except advisory ids, package names, ranges and counts —
// never a payload field that could carry a credential.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

// Dev-only advisories carried as known limitations, each with the reason it is not fixable from
// inside this repository. Deleting a line here is how the next owner learns it got fixed; the check
// fails if the line stays after npm stops reporting it.
const TOLERATED_DEV = [
  {
    id: 'GHSA-g3hv-75wg-m249',
    pkg: 'minimatch',
    chain: 'eslint + @vscode/vsce -> minimatch',
    reason:
      'DoS via glob-pattern amplification, moderate, fixed in minimatch 11.0.1. No consumer can ' +
      'reach it: @vscode/vsce 4.1.0 declares minimatch ^10.2.6 and so does the current eslint ' +
      '10.14.0, so an 11.x line would be a forced override of a toolchain glob API. Dev-only — ' +
      'minimatch is reached by lint and packaging, never by the extension or the web server. ' +
      'Recheck when either consumer moves to minimatch 11.',
  },
];

const PROJECTS = [
  { name: 'web server', dir: path.join(ROOT, 'explain-it-simply-website') },
  { name: 'build toolchain', dir: ROOT, toleratesDev: true },
];

// The command is a literal we assemble from constants; nothing user-supplied reaches the shell.
// A shell is required on Windows because Node refuses to spawn npm.cmd directly (EINVAL).
function audit(dir, omitDev) {
  const flags = omitDev ? ' --omit=dev' : '';
  const run = spawnSync(`npm audit --json${flags}`, {
    cwd: dir,
    encoding: 'utf8',
    shell: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  let payload;
  try {
    payload = JSON.parse(run.stdout || '');
  } catch {
    // npm exits non-zero when it finds something; unparseable output means it did not run at all.
    return { blocked: `npm audit --json${flags} returned no parseable JSON` };
  }
  const advisories = [];
  for (const [pkg, entry] of Object.entries(payload.vulnerabilities || {})) {
    for (const via of entry.via || []) {
      if (typeof via === 'string' || !via.url) continue;
      const id = (via.url.match(/GHSA-[a-z0-9-]{4,}/i) || [])[0];
      if (!id) continue;
      advisories.push({ pkg, id, severity: via.severity, range: via.range });
    }
  }
  const counts = (payload.metadata && payload.metadata.vulnerabilities) || {};
  const deps = (payload.metadata && payload.metadata.dependencies) || {};
  return { advisories, counts, deps, sawAny: Object.keys(payload.vulnerabilities || {}).length >= 0 };
}

const lines = [];
const failures = [];

for (const project of PROJECTS) {
  const prod = audit(project.dir, true);
  if (prod.blocked) {
    failures.push(`${project.name}: ${prod.blocked} — an audit that did not run is not a pass`);
    continue;
  }
  const full = audit(project.dir, false);
  if (full.blocked) {
    failures.push(`${project.name}: ${full.blocked} — an audit that did not run is not a pass`);
    continue;
  }

  // Rule 1: production has no floor at all — any severity is a failure.
  if (prod.advisories.length || Object.entries(prod.counts || {}).some(([s, n]) => s !== 'total' && n > 0)) {
    failures.push(`${project.name}: the production tree carries ${prod.advisories.length} advisory finding(s): `
      + prod.advisories.map((a) => `${a.id} in ${a.pkg} (${a.severity})`).join(', '));
  }

  // Rules 2 and 3 apply to everything else, at every severity.
  const tolerated = project.toleratesDev ? TOLERATED_DEV.filter((t) => full.advisories.some((a) => a.id === t.id)) : [];
  const toleratedIds = new Set(tolerated.map((t) => t.id));
  const unexpected = full.advisories.filter((a) => !toleratedIds.has(a.id));
  const seen = new Set(full.advisories.map((a) => a.id));
  const stale = (project.toleratesDev ? TOLERATED_DEV.map((t) => t.id) : []).filter((id) => !seen.has(id));

  let declared = 0;
  try {
    declared = Object.keys(JSON.parse(fs.readFileSync(path.join(project.dir, 'package.json'), 'utf8')).dependencies || {}).length;
  } catch (error) {
    failures.push(`${project.name}: package.json unreadable — ${error.message}`);
  }

  lines.push(
    `${project.name}: ${declared} declared runtime dep(s) · prod findings ${prod.advisories.length} · ` +
      `dev-only ${full.advisories.length - prod.advisories.length}, named ${tolerated.length}, unnamed ${unexpected.length}`,
  );
  for (const a of unexpected) {
    failures.push(`${project.name}: unnamed ${a.severity} advisory ${a.id} in ${a.pkg} (range ${a.range}) — fix it or name it with a reason`);
  }
  for (const id of stale) {
    failures.push(`${project.name}: carve-out ${id} is stale — npm no longer reports it, delete the entry`);
  }
  for (const t of tolerated) lines.push(`  named, dev-only: ${t.id} · ${t.pkg} · ${t.chain}`);
  if (!full.advisories.length) lines.push('  no advisories reported at all');
}

for (const line of lines) console.log(line);
if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.error(`${failures.length} audit policy failure(s).`);
  process.exitCode = 1;
} else {
  console.log('audit policy satisfied: production carries no advisory, and every dev-only advisory is named with a reason.');
}
