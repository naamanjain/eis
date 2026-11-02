'use strict';
/* Credential inventory — reads every place a secret could live and prints REDACTED
 * metadata only: category, length, sha256 prefix, location, and a provenance class.
 *
 *   node scripts/secret-inventory.js              # full inventory
 *   node scripts/secret-inventory.js --json       # machine-readable, still redacted
 *   node scripts/secret-inventory.js --only disk  # one surface
 *
 * Surfaces: tracked files, the whole working directory (including gitignored files,
 * because an ignored secret is still a secret on this machine), every reachable and
 * unreachable Git blob, every local/remote ref, stashes, and the packaged .vsix.
 *
 * No code path in this file writes a credential value to stdout, to a file, or to a
 * subprocess argument. Values are hashed, compared and discarded. That is deliberate:
 * the tool has to be safe to run in a shared terminal and safe to paste the output of
 * into an incident report.
 *
 * Exit codes: 0 = nothing confirmed in the current tree, 1 = a confirmed credential is
 * present where it should not be, 2 = blocked (git missing, so history was not searched).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const EXT_DIR = path.join(ROOT, 'explain-it-simply-vs-code-extension');
const { SECRET_PATTERNS } = require(path.join(ROOT, 'shared', 'audit', 'localFindings.js'));
const { readZip } = require(path.join(ROOT, 'scripts', 'verify-package.js'));

const ENV_LIKE = /(^|\/)(\.env|\.env\..+|env|env\.txt|credentials?(\.json)?|secrets?(\.json)?|service-account.*\.json|.*\.(pem|p12|pfx|key))$/i;
const TEXTISH = /\.(js|cjs|mjs|json|css|html|md|markdown|txt|ya?ml|svg|xml|ini|cfg|conf|env|sh|ps1|bat)$/i;
// Anything matching these is a fixture or template, not a credential. Deliberately narrow:
// guessing "probably fake" is how a live key gets written up as a false positive.
const SYNTHETIC = /(example|placeholder|dummy|fixture|sample|changeme|not-a-real|not-real|your[-_]?[-a-z]*key|redacted|xxxx|todo|<[^>]+>|TEST-ONLY|localFixture|localTest|PROOF|scanner)/i;
// Repeated-character and obviously-synthetic bodies, e.g. AIzaAAAA… — the shape of a test
// string rather than an issued key.
const REPEATED = /^([^\s])\1+$/;

function sh(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.error) return { code: -1, stdout: '', stderr: String(result.error.message || result.error) };
  return { code: result.status === null ? -1 : result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

// Shape → platform. The *category* is printed, never the value, so an owner reading the
// report knows which dashboard to open. OpenRouter and OpenAI share the `sk-` shape, which is
// why SECRET_PATTERNS alone would send the reader to the wrong console.
const PLATFORMS = [
  { re: /^sk-or-(v1-)?[A-Za-z0-9_-]{8,}$/, platform: 'OpenRouter' },
  { re: /^sk-ant-[A-Za-z0-9_-]{8,}$/, platform: 'Anthropic Console' },
  { re: /^gsk_[A-Za-z0-9_-]{8,}$/, platform: 'Groq' },
  { re: /^AIza[0-9A-Za-z_-]{20,}$/, platform: 'Google AI Studio' },
  { re: /^sk-[A-Za-z0-9_-]{20,}$/, platform: 'OpenAI (or an OpenAI-shaped service)' },
  { re: /^AKIA[0-9A-Z]{16}$/, platform: 'AWS' },
  { re: /^gh[pousr]_[0-9A-Za-z]{20,}$/, platform: 'GitHub' },
  { re: /^xox[baprs]-[0-9A-Za-z-]{10,}$/, platform: 'Slack' },
];

// The vendor prefix is metadata, not part of the secret's entropy. Stripping it before the
// repeated-character test is what lets `AIzaAAAA…`-style scanner noise and the repository's
// own planted fixtures be reported as synthetic instead of as a live key.
const KNOWN_PREFIX = /^(AIza|sk-or-v1-|sk-or-|sk-proj-|sk-ant-|sk-|gsk_|gh[pousr]_|xox[baprs]-)/;

function platformOf(value) {
  const hit = PLATFORMS.find((entry) => entry.re.test(String(value)));
  return hit ? hit.platform : 'unidentified shape';
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

// The identifier printed in reports. A truncated digest identifies a value for matching
// without reproducing it — safe here because every value this tool reports is already
// exposed somewhere; do not publish digests of secrets that are still private.
function id(value) {
  return digest(value).slice(0, 12);
}

function classify(value, where) {
  const body = String(value);
  if (SYNTHETIC.test(body) || SYNTHETIC.test(where)) return 'synthetic';
  // Everything after the vendor prefix being one repeated character is a scanner artefact or
  // a planted fixture, never an issued key.
  const core = body.replace(KNOWN_PREFIX, '');
  if (REPEATED.test(core) || /^(.)\1\1+/.test(core)) return 'synthetic';
  if (!core.trim()) return 'synthetic';
  return 'confirmed';
}

// Extract every credential-shaped value from a blob of text, as {category, value}.
function extract(text, location) {
  const found = [];
  for (const pattern of SECRET_PATTERNS) {
    // match(), not test(): these patterns carry the g flag and test() would advance lastIndex
    // past the second occurrence in the same file.
    const hits = String(text).match(pattern.re);
    for (const value of hits || []) found.push({ category: pattern.name, value });
  }
  // A key that does not match a known shape can still be named like one. Anything assigned to
  // a credential-named variable inside an env-shaped file is reported for a human to judge.
  if (ENV_LIKE.test(String(location || ''))) {
    const re = /^[ \t]*([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API)[A-Za-z0-9_]*)[ \t]*=[ \t]*["']?([^"'\r\n]{8,})["']?[ \t]*$/gim;
    let match;
    while ((match = re.exec(text)) !== null) {
      found.push({ category: `named ${match[1]}`, value: match[2], variable: match[1] });
    }
  }
  return found;
}

function scanText(text, location, sink) {
  const seen = new Set();
  for (const hit of extract(text, location)) {
    const key = `${id(hit.value)}|${location}`;
    // One row per value per place. A shape match and a `NAME=` variable match describe the
    // same string; keep the shape match, which is the one with a platform attached.
    if (seen.has(key)) continue;
    seen.add(key);
    sink.push({
      location,
      category: hit.category,
      platform: platformOf(hit.value),
      variable: hit.variable || null,
      length: hit.value.length,
      id: id(hit.value),
      kind: classify(hit.value, location),
    });
  }
}

function scanFile(absolute, location, sink) {
  try {
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) return;
    scanText(fs.readFileSync(absolute, 'utf8'), location, sink);
  } catch (error) {
    // Unreadable is reported, never guessed about.
    sink.push({ location, category: 'unreadable', length: 0, id: '-', kind: 'error' });
  }
}

function walk(dir, base, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'out' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else out.push(full);
  }
  return out;
}

function surfaces() {
  const findings = { tracked: [], disk: [], history: [], refs: [], package: [], errors: [] };

  const gitOk = sh('git', ['rev-parse', '--git-dir']).code === 0;
  if (!gitOk) {
    findings.errors.push('git is unavailable — history, blobs and refs were NOT searched. Absence of a history finding is not evidence of a clean history.');
  }

  // 1. tracked files at HEAD's index
  if (gitOk) {
    for (const file of sh('git', ['ls-files', '-z']).stdout.split('\0').filter(Boolean)) {
      const absolute = path.join(ROOT, file);
      if (fs.existsSync(absolute) && TEXTISH.test(file)) scanFile(absolute, `tracked:${file}`, findings.tracked);
    }
  }

  // 2. the whole working directory, including gitignored files
  for (const absolute of walk(ROOT, ROOT, [])) {
    const relative = path.relative(ROOT, absolute).split(path.sep).join('/');
    if (!TEXTISH.test(relative)) continue;
    if (gitOk && findings.tracked.some((item) => item.location === `tracked:${relative}`)) continue;
    const ignored = gitOk && sh('git', ['check-ignore', '-q', '--', relative]).code === 0;
    const before = findings.disk.length;
    if (TEXTISH.test(relative)) scanFile(absolute, `disk:${relative}`, findings.disk);
    for (let i = before; i < findings.disk.length; i += 1) findings.disk[i].ignored = ignored;
  }

  if (gitOk) {
    // 3. every object in the local database, reachable or not — a rewrite that left objects
    //    behind is exactly what this has to catch.
    const objects = sh('git', ['cat-file', '--batch-all-objects', '--batch-check']).stdout
      .split(/\r?\n/)
      .filter((line) => /\sblob\s/.test(line))
      .map((line) => line.split(' ')[0]);
    const seenBlob = new Set();
    for (const sha of objects) {
      if (seenBlob.has(sha)) continue;
      seenBlob.add(sha);
      const content = sh('git', ['cat-file', 'blob', sha]).stdout;
      if (!content || content.length > 4 * 1024 * 1024) continue;
      const probe = [];
      scanText(content, `blob:${sha}`, probe);
      if (!probe.length) continue;
      // Attribute the blob to the commits that introduced it, the paths inside each of those
      // commits, and the refs that still contain each commit. A commit nobody points at is as
      // dangerous as one everybody points at, so reachability is reported per commit rather
      // than guessed from whether the scan found anything.
      const introducedBy = sh('git', ['log', '--all', '--format=%H', `--find-object=${sha}`]).stdout
        .split(/\r?\n/).filter(Boolean);
      const detail = introducedBy.map((commit) => {
        const tree = sh('git', ['ls-tree', '-r', commit]).stdout
          .split(/\r?\n/).filter((line) => line.includes(`\t${sha}`) || new RegExp(`\\s${sha}\\s`).test(line))
          .map((line) => line.split('\t')[1]);
        const containing = sh('git', ['for-each-ref', '--contains', commit, '--format=%(refname)']).stdout
          .split(/\r?\n/).filter(Boolean);
        return { commit: commit.slice(0, 7), full: commit, paths: [...new Set(tree)], refs: containing };
      });
      const inHead = sh('git', ['ls-tree', '-r', 'HEAD']).stdout.includes(sha);
      for (const item of probe) {
        findings.history.push({
          ...item,
          blob: sha,
          introducedBy: detail.map((entry) => entry.commit),
          paths: [...new Set(detail.flatMap((entry) => entry.paths))],
          refsContaining: [...new Set(detail.flatMap((entry) => entry.refs))],
          inHead,
          reachableFromRef: detail.some((entry) => entry.refs.length > 0),
        });
      }
    }

    // 4. refs: what still points at history, including refs a rewrite does not clean up.
    const refList = sh('git', ['for-each-ref', '--format=%(refname) %(objecttype) %(objectname)'])
      .stdout.split(/\r?\n/).filter(Boolean)
      .map((line) => {
        const [name, type, oid] = line.split(' ');
        return { name, type, oid: oid.slice(0, 7) };
      });
    findings.refs = {
      names: refList.map((ref) => ref.name),
      detail: refList.map((ref) => `${ref.name} ${ref.type} ${ref.oid}`),
      stash: sh('git', ['stash', 'list', '--format=%gd %gs']).stdout.split(/\r?\n/).filter(Boolean),
      reflogEntries: sh('git', ['reflog', '--all', '--format=%gD']).stdout.split(/\r?\n/).filter(Boolean).length,
      originalRefs: refList.filter((ref) => /refs\/(original|rewritten)/.test(ref.name)).map((ref) => ref.name),
      notes: refList.filter((ref) => /refs\/notes/.test(ref.name)).map((ref) => ref.name),
      head: sh('git', ['rev-parse', '--short', 'HEAD']).stdout.trim(),
    };
    // Unreachable-but-present objects are what a rewrite can leave behind. Count them once:
    // the number matters, the ids do not.
    const dangling = sh('git', ['fsck', '--no-reflogs', '--dangling', '--name-only']).stdout
      .split(/\r?\n/).filter((line) => /^[0-9a-f]{40}$/.test(line.trim()));
    findings.refs.danglingObjects = dangling.length;
  }

  // 5. inside the built extension package
  const vsix = fs.existsSync(EXT_DIR)
    ? fs.readdirSync(EXT_DIR).filter((name) => name.endsWith('.vsix')).sort().at(-1)
    : null;
  if (vsix) {
    try {
      const entries = readZip(fs.readFileSync(path.join(EXT_DIR, vsix)), vsix);
      for (const entry of entries) {
        if (!TEXTISH.test(entry.name)) continue;
        scanText(entry.data.toString('utf8'), `vsix:${vsix}!${entry.name}`, findings.package);
      }
      findings.package.push({ vsix, entryCount: entries.length });
    } catch (error) {
      findings.errors.push(`the .vsix could not be opened: ${error.message}`);
    }
  } else {
    findings.errors.push('no .vsix present — the packaged artifact was NOT searched (run npm run package:ext)');
  }

  return { findings, gitOk };
}

// Collapse the same credential across surfaces into one record, so the report says
// "one key, five places" rather than five anonymous rows.
function consolidate(findings) {
  const byId = new Map();
  for (const surface of ['tracked', 'disk', 'history', 'package']) {
    for (const item of findings[surface]) {
      if (!item.id) continue;
      if (!byId.has(item.id)) {
        byId.set(item.id, {
          id: item.id,
          category: item.category,
          platform: item.platform,
          length: item.length,
          kind: item.kind,
          places: [],
          history: null,
        });
      }
      const entry = byId.get(item.id);
      if (item.kind === 'confirmed') entry.kind = 'confirmed';
      entry.places.push({ surface: item.location, ignored: item.ignored, variable: item.variable });
      if (item.blob) {
        entry.history = {
          blob: item.blob.slice(0, 12),
          introducedBy: item.introducedBy,
          paths: item.paths,
          refsContaining: item.refsContaining,
          inHead: item.inHead,
          reachableFromRef: item.reachableFromRef,
        };
      }
    }
  }
  return [...byId.values()].sort((a, b) => (a.kind === b.kind ? a.category.localeCompare(b.category) : a.kind === 'confirmed' ? -1 : 1));
}

function main() {
  const json = process.argv.includes('--json');
  const { findings, gitOk } = surfaces();
  const items = consolidate(findings);
  const fragments = fragmentDisclosure();

  if (json) {
    // Redacted by construction: values are never part of this shape.
    process.stdout.write(`${JSON.stringify({ generatedBy: 'secret-inventory.js', gitAvailable: gitOk, credentials: items, fragmentDisclosure: fragments, refs: findings.refs, errors: findings.errors }, null, 2)}\n`);
  } else {
    console.log('# credential inventory — values are never printed. id = first 12 hex of sha256(value).');
    if (!gitOk) console.log('BLOCKED: git unavailable; history and refs were not searched.');
    console.log(`\n## ${items.length} distinct credential-shaped value(s)`);
    for (const item of items) {
      console.log(`- [${item.kind}] ${item.platform} · ${item.category} · len ${item.length} · id ${item.id}`);
      for (const place of item.places) {
        console.log(`    ${place.surface}${place.ignored ? ' (gitignored)' : ''}${place.variable ? ` as ${place.variable}` : ''}`);
      }
      if (item.history) {
        console.log(`    blob ${item.history.blob}  in HEAD tree: ${item.history.inHead}  reachable from a ref: ${item.history.reachableFromRef}`);
        console.log(`    introduced by: ${item.history.introducedBy.join(', ') || '(no introducing commit found among refs)'}`);
        console.log(`    paths: ${item.history.paths.join(', ') || '(none)'}`);
        console.log(`    refs containing those commits: ${item.history.refsContaining.join(', ') || '(none — object is unreachable but still present)'}`);
      }
    }
    const refs = findings.refs.names || [];
    console.log('\n## refs in this repository');
    console.log(refs.length ? findings.refs.detail.map((line) => `  ${line}`).join('\n') : '  (none)');
    console.log(`  HEAD: ${findings.refs.head || '?'}`);
    if (findings.refs.originalRefs.length) console.log(`  refs/original leftovers (these defeat a rewrite): ${findings.refs.originalRefs.join(', ')}`);
    if (findings.refs.stash.length) console.log(`  stashes: ${findings.refs.stash.join(' | ')}`);
    console.log(`  reflog entries: ${findings.refs.reflogEntries}`);
    console.log(`  dangling objects from git fsck: ${findings.refs.danglingObjects}`);
    for (const error of findings.errors) console.log(`NOTE ${error}`);
    console.log('\n## fragment disclosure — a truncated key in a report is still key material');
    if (fragments.blocked) {
      console.log(`  NOT RUN: ${fragments.blocked}`);
    } else {
      console.log(`  ${fragments.credentials.length} confirmed value(s) compared, ${fragments.targets} identifying fragments tested, ${fragments.hits.length} file(s) carrying one`);
      for (const hit of fragments.hits) console.log(`  FAIL ${hit.file} prints a ${hit.fragmentLength}-character fragment of credential id ${hit.id}`);
    }
  }

  const confirmed = items.filter((item) => item.kind === 'confirmed');
  const inCurrentTree = confirmed.filter((item) => item.places.some((p) => p.surface.startsWith('tracked:') || p.surface.startsWith('vsix:')));
  if (inCurrentTree.length) {
    console.log(`\nFAIL  ${inCurrentTree.length} confirmed-shaped value(s) sit in tracked files or the package:`);
    for (const item of inCurrentTree) console.log(`  ${item.platform} · id ${item.id} · ${item.places.map((p) => p.surface).join(', ')}`);
  }
  const fragmentFiles = fragments.hits ? new Set(fragments.hits.map((hit) => hit.file)).size : 0;
  console.log(`\n${confirmed.length} confirmed-shaped value(s), ${items.length - confirmed.length} synthetic; ${inCurrentTree.length} in tracked files or the package; ${fragmentFiles} file(s) printing a fragment of one.`);
  if (!gitOk) process.exit(2);
  process.exit(inCurrentTree.length || fragmentFiles ? 1 : 0);
}

// Values that appeared in a committed secret-shaped file, kept in memory so the gate can
// assert none of them reappears in a tracked file. Returns {id, value, commit, file} and is
// deliberately not printed anywhere: the caller reports digest ids only. Scoping to env-shaped
// paths keeps this bounded — a full object walk is what surfaces() does when it is asked for.
function historyCredentials() {
  if (sh('git', ['rev-parse', '--git-dir']).code !== 0) return { blocked: 'git is unavailable — history was not searched' };
  const commits = sh('git', ['log', '--all', '--format=%H']).stdout.split(/\r?\n/).filter(Boolean);
  if (!commits.length) return { blocked: 'no commits reachable from any ref — history was not searched' };
  const out = [];
  const seen = new Set();
  for (const commit of commits) {
    for (const line of sh('git', ['ls-tree', '-r', commit]).stdout.split(/\r?\n/)) {
      const parts = line.split(/\s+/);
      const file = line.split('\t')[1];
      if (!file || !ENV_LIKE.test(file)) continue;
      const sha = parts[2];
      if (seen.has(`${sha}|${file}`)) continue;
      seen.add(`${sha}|${file}`);
      const blob = sh('git', ['show', `${commit}:${file}`]).stdout;
      const valueSeen = new Set();
      for (const hit of extract(blob, file)) {
        // One record per distinct value per file. A shape match and a `NAME=` variable match
        // are the same secret, and counting it twice inflates an incident's severity.
        if (valueSeen.has(hit.value) || classify(hit.value, file) !== 'confirmed') continue;
        valueSeen.add(hit.value);
        out.push({ id: id(hit.value), value: hit.value, category: hit.category, platform: platformOf(hit.value), commit: commit.slice(0, 7), file, blob: sha.slice(0, 12) });
      }
    }
  }
  return { credentials: out };
}

// --------------------------------------------------------------------- fragments

// Literal shapes that belong to a vendor rather than to one key. A fragment of one of these
// identifies nothing, and `AIzaSy` / `sk-or-v1-` appear in the repository's own pattern list, so
// reporting them would make the check below cry wolf and get it ignored.
const SHAPES = ['AIza', 'AIzaSy', 'sk-', 'sk-or-', 'sk-or-v1-', 'sk-proj-', 'sk-ant-', 'gsk_', 'AKIA', 'ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'xoxb-'];

// Every confirmed credential the tool can reach, with the places it legitimately lives. Values
// stay in memory, exactly as in historyCredentials(); no caller is handed a printable value.
function confirmedValues() {
  const byId = new Map();
  const history = historyCredentials();
  if (history.blocked) return { blocked: history.blocked, values: [] };
  for (const credential of history.credentials || []) {
    if (!byId.has(credential.id)) byId.set(credential.id, { id: credential.id, value: credential.value, homes: new Set() });
    byId.get(credential.id).homes.add(`git:${credential.commit}:${credential.file}`);
  }
  for (const absolute of walk(ROOT, ROOT, [])) {
    const relative = path.relative(ROOT, absolute).split(path.sep).join('/');
    if (!TEXTISH.test(relative)) continue;
    let text = null;
    try {
      text = fs.readFileSync(absolute, 'utf8');
    } catch (error) {
      continue;
    }
    if (!text || text.includes('\u0000')) continue;
    for (const hit of extract(text, relative)) {
      if (classify(hit.value, relative) !== 'confirmed') continue;
      const key = id(hit.value);
      if (!byId.has(key)) byId.set(key, { id: key, value: hit.value, homes: new Set() });
      byId.get(key).homes.add(relative);
    }
  }
  return { values: [...byId.values()] };
}

// Contiguous fragments taken from the head and the tail of a value — the two places a truncated
// mention can come from.
function fragmentsOf(value, min, zone) {
  const text = String(value);
  const out = new Set();
  for (const [from, to] of [[0, Math.min(text.length, zone)], [Math.max(0, text.length - zone), text.length]]) {
    for (let start = from; start < to; start++) {
      for (let end = start + min; end <= to; end++) out.add(text.slice(start, end));
    }
  }
  return out;
}

// A report that prints a key's leading and trailing characters with an ellipsis between them
// looks redacted and is not: it carries real key material and it links the document to one
// specific credential. This compares every text file against the head and tail fragments of each
// confirmed value and reports file + credential digest id + fragment length — never the fragment
// and never the value. Fragments shorter than `min` are below any reliable detection threshold,
// which is why the writing convention (length + digest, no characters at all) is what actually
// protects a four-character tail. The tool found a fragment in its own source comment the first
// time it ran, which is the only reason anyone would ever believe this works.
function fragmentDisclosure(options = {}) {
  const min = options.min || 6;
  const zone = options.zone || 16;
  const collected = confirmedValues();
  if (collected.blocked) return { blocked: collected.blocked };
  const values = collected.values;
  const targets = new Map();
  for (const entry of values) {
    for (const fragment of fragmentsOf(entry.value, min, zone)) {
      if (SHAPES.some((shape) => shape.includes(fragment))) continue;
      // A fragment carried by two different confirmed values says "a Google key", not "credential
      // C1", so it identifies nothing and stays out of the target set.
      if (values.filter((other) => other.value.includes(fragment)).length !== 1) continue;
      targets.set(fragment, entry.id);
    }
  }
  // One row per file per credential, reporting the longest fragment found.
  const worst = new Map();
  for (const absolute of walk(ROOT, ROOT, [])) {
    const relative = path.relative(ROOT, absolute).split(path.sep).join('/');
    if (!TEXTISH.test(relative)) continue;
    let text = null;
    try {
      text = fs.readFileSync(absolute, 'utf8');
    } catch (error) {
      continue;
    }
    if (!text || text.includes('\u0000')) continue;
    for (const [fragment, credentialId] of targets) {
      if (values.find((entry) => entry.id === credentialId).homes.has(relative)) continue;
      if (!text.includes(fragment)) continue;
      const key = `${relative}|${credentialId}`;
      const previous = worst.get(key);
      if (!previous || fragment.length > previous.fragmentLength) {
        worst.set(key, { file: relative, id: credentialId, fragmentLength: fragment.length, fragments: previous ? previous.fragments + 1 : 1 });
      } else {
        previous.fragments += 1;
      }
    }
  }
  return { credentials: values.map((entry) => entry.id), targets: targets.size, hits: [...worst.values()] };
}

if (require.main === module) main();

module.exports = { digest, id, extract, classify, surfaces, consolidate, platformOf, historyCredentials, fragmentDisclosure, confirmedValues };
