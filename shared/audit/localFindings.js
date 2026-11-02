'use strict';
// Deterministic project analysis. Runs with no API key, no network and no cost,
// and reports only what the text literally shows. Severity ladder matches the AI
// pass so a report can mix both:
//   confirmed       the file contains proof of the thing
//   potential       a risky pattern that needs a human to judge it
//   recommendation  hygiene, not a defect

const SECRET_PATTERNS = [
  { name: 'Google API key', re: /AIza[0-9A-Za-z_-]{20,}/g },
  { name: 'OpenAI API key', re: /sk-(?!ant|short)[A-Za-z0-9_-]{20,}/g },
  { name: 'Anthropic API key', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'Groq API key', re: /gsk_[A-Za-z0-9_-]{20,}/g },
  { name: 'AWS access key', re: /AKIA[0-9A-Z]{16}/g },
  { name: 'GitHub token', re: /gh[pousr]_[0-9A-Za-z]{20,}/g },
  { name: 'Slack token', re: /xox[baprs]-[0-9A-Za-z-]{10,}/g },
  { name: 'private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
];

// Earlier, more specific rules win the label for a line.
// Names that a credential tends to be assigned to. One list feeds both the detection
// rule and the pre-request masker, so nothing can be flagged here and still be sent out
// in the clear — SECRET_PATTERNS only knows provider key *shapes*, not `password = "…"`.
const CREDENTIAL_KEYS = [
  'password', 'passwd', 'secret', 'token', 'api_?key', 'access_?key',
  'client_secret', 'refresh_token', 'private_key', 'credentials?',
];

const LITERAL_CREDENTIAL_RE = new RegExp(
  `\\b((?:${CREDENTIAL_KEYS.join('|')})\\s*[:=]\\s*)(['"])[^'"]{8,}\\2`,
  'i',
);

// Masking is deliberately broader than detection: an identifier *named* like a
// credential (clientSecret, dbPassword, refreshToken) must still not leave the machine,
// and a wrongly masked string only costs the model some context, whereas a wrongly sent
// one leaks it. Detection stays strict so the report is not full of noise. The name has
// to END on the credential word, so `tokenizerName` is not treated as a secret.
const MASK_CREDENTIAL_RE = new RegExp(
  `(\\b[\\w$]*?(?:${CREDENTIAL_KEYS.join('|')}|password|passw\\w*|credential|private_?key))(\\s*[:=]\\s*)(['"])[^'"]{8,}\\3`,
  'i',
);

function maskCredentialLiterals(text) {
  let removed = 0;
  const out = String(text == null ? '' : text).replace(
    MASK_CREDENTIAL_RE,
    (match, name, head, quote) => {
      removed += 1;
      return `${name}${head}${quote}[REDACTED]${quote}`;
    },
  );
  return { text: out, removed };
}

const PATTERNS = [
  {
    rule: 'debugger-statement',
    severity: 'confirmed',
    re: /\bdebugger\b\s*[;(]/,
    message: 'A debugger statement is in the code path and halts execution whenever devtools are open.',
  },
  {
    rule: 'raw-html-sink',
    severity: 'potential',
    re: /\.innerHTML\s*=|\.outerHTML\s*=|document\.write\(|dangerouslySetInnerHTML/,
    message: 'Writes markup into the DOM from code. If any part of the value is untrusted, this is an XSS sink.',
  },
  {
    rule: 'dynamic-code-execution',
    severity: 'potential',
    re: /\beval\s*\(|new\s+Function\s*\(/,
    message: 'Evaluates a string as code. Only acceptable when the input cannot come from a user, a file or the network.',
  },
  {
    rule: 'shell-string-interpolation',
    severity: 'potential',
    re: /(?:exec|execSync|spawn|spawnSync)\s*\([^)\n]{0,80}(?:\$\{|\+\s*[A-Za-z_$])/,
    message: 'Builds a shell command from an interpolated value. Pass an argument array instead of a command string.',
  },
  {
    rule: 'sql-string-concat',
    severity: 'potential',
    re: /\b(?:SELECT|INSERT INTO|UPDATE|DELETE FROM)\b[^\n;]*(?:\$\{|\s\+\s)/i,
    message: 'SQL built by interpolation or concatenation. Use placeholders with a bound parameter array.',
  },
  {
    rule: 'empty-catch',
    severity: 'potential',
    re: /catch\s*(?:\([^)]*\))?\s*\{\s*\}/,
    message: 'The failure is caught and discarded, so it can never be seen or logged.',
  },
  {
    rule: 'unguarded-json-parse',
    severity: 'potential',
    re: /JSON\.parse\s*\(/,
    needsTry: true,
    message: 'JSON.parse throws on malformed input. Confirm the call sits in a try block or that the input is trusted.',
  },
  {
    rule: 'literal-credential-assignment',
    severity: 'potential',
    re: LITERAL_CREDENTIAL_RE,
    allowlist: /(example|placeholder|dummy|fixture|changeme|your[-_]?key|xxxx|not-a-real)/i,
    message: 'A credential-shaped value is written as a string literal in source.',
  },
  {
    rule: 'type-safety-suppression',
    severity: 'recommendation',
    re: /@ts-ignore|@ts-nocheck|eslint-disable|as any\b/,
    message: 'Type or lint checking is suppressed here, hiding the class of bug the checker exists to catch.',
  },
  {
    rule: 'todo-comment',
    severity: 'recommendation',
    re: /(?:\/\/|\/\*|#|<!--)\s*(?:TODO|FIXME|XXX|HACK)\b/i,
    message: 'Unfinished work is marked in source rather than tracked where it can be prioritised.',
  },
  {
    rule: 'console-output-in-source',
    severity: 'recommendation',
    re: /console\.(?:log|debug|info|warn)\s*\(/,
    countOnly: true,
    threshold: 6,
    message: 'Verbose console output in application code; use the project logger or delete it.',
  },
];

const TEST_FILE = /(?:^|[/._-])(?:tests?|spec|__tests__)(?:[/._-]|$)/i;
const DOC_FILE = /\.(md|markdown|rst|txt)$/i;
const GENERATED = /(?:^|\/)(?:node_modules|dist|build|out|coverage|\.next|\.cache)\/|\.min\.js$|\.bundle\.js$|\.d\.ts$|generated|auto-import/i;

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text[i] === '\n') line += 1;
  return line;
}

function snippetAt(text, index, max = 140) {
  const start = text.lastIndexOf('\n', index) + 1;
  const end = text.indexOf('\n', index);
  return maskSecrets(text.slice(start, end === -1 ? start + max : Math.min(end, start + max)).trim());
}

// Any rule can quote a line that happens to carry a credential, so masking lives
// here rather than in the one secret rule: evidence is shown in the panel and the
// audited files are sent to a provider.
function maskSecrets(line) {
  let out = String(line || '');
  for (const pattern of SECRET_PATTERNS) {
    const re = new RegExp(pattern.re.source, pattern.re.flags.includes('g') ? pattern.re.flags : `${pattern.re.flags}g`);
    out = out.replace(re, (match) => `${match.slice(0, 4)}…${match.length} chars`);
  }
  return out;
}

// Conservative: an open `try {` with no matching `} catch` before this offset.
function insideTry(text, index) {
  const before = text.slice(Math.max(0, index - 4000), index);
  const opens = (before.match(/\btry\s*\{/g) || []).length;
  const closes = (before.match(/\}\s*catch/g) || []).length;
  return opens > closes;
}

function globToRegExp(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        source += '[\\s\\S]*';
        i += 1;
        if (glob[i + 1] === '/') i += 1;
      } else source += '[^/]*';
      continue;
    }
    if (ch === '?') { source += '[^/]'; continue; }
    source += /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
  }
  return new RegExp(`(^|/)(${source})$`);
}

function matchesGlob(path, glob) {
  if (!glob) return false;
  return globToRegExp(String(glob).replace(/\\/g, '/')).test(String(path).replace(/\\/g, '/'));
}

function shouldScan(path, options = {}) {
  const file = String(path || '').replace(/\\/g, '/');
  if (GENERATED.test(file)) return false;
  if (options.bytes && options.bytes > (options.maxBytes || 400_000)) return false;
  if (options.exclude && options.exclude.some((glob) => matchesGlob(file, glob))) return false;
  if (options.include && options.include.length && !options.include.some((glob) => matchesGlob(file, glob))) return false;
  return true;
}

/**
 * @param {{path: string, text: string, language?: string}} file
 * @returns {{findings: Array<Object>, stats: Object}}
 */
function analyseFile(file) {
  const text = String(file.text == null ? '' : file.text);
  const findings = [];
  const seen = new Set();
  const push = (entry) => {
    const key = `${entry.rule}:${entry.line}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(entry);
  };

  for (const pattern of SECRET_PATTERNS) {
    pattern.re.lastIndex = 0;
    let match;
    while ((match = pattern.re.exec(text)) !== null) {
      push({
        rule: 'credential-in-source',
        severity: 'confirmed',
        kind: 'secret',
        line: lineOf(text, match.index),
        message: `A ${pattern.name.toLowerCase()} appears in this file. Revoke it at the provider and load it from the environment.`,
        evidence: `${match[0].slice(0, 6)}… (${match[0].length} chars)`,
      });
    }
  }

  for (const pattern of PATTERNS) {
    const regex = new RegExp(pattern.re.source, pattern.re.flags.includes('g') ? pattern.re.flags : `${pattern.re.flags}g`);
    let match;
    let count = 0;
    let firstLine = 0;
    while ((match = regex.exec(text)) !== null) {
      count += 1;
      const line = lineOf(text, match.index);
      if (count === 1) firstLine = line;
      if (findings.length > 400) break;
      if (pattern.countOnly) continue;
      if (pattern.needsTry && insideTry(text, match.index)) continue;
      if (pattern.allowlist && pattern.allowlist.test(match[0])) continue;
      push({
        rule: pattern.rule,
        severity: pattern.severity,
        line,
        message: pattern.message,
        evidence: snippetAt(text, match.index),
      });
    }
    if (pattern.countOnly && count >= (pattern.threshold || 5)) {
      push({
        rule: pattern.rule,
        severity: pattern.severity,
        line: firstLine,
        message: `${count} occurrences. ${pattern.message}`,
        evidence: `first at line ${firstLine}`,
        count,
      });
    }
  }

  const lines = text.split('\n');
  let longestBlock = 0;
  let blockStart = 0;
  let depth = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (depth === 0 && /\b(?:function|def|func|fn|class)\b|=>\s*\{/.test(line)) blockStart = i;
    for (const ch of line) {
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
    }
    if (depth <= 0) {
      longestBlock = Math.max(longestBlock, i - blockStart);
      depth = 0;
    }
  }

  const stats = {
    path: file.path,
    language: file.language || 'unknown',
    bytes: text.length,
    lines: lines.length,
    commentLines: lines.filter((line) => /^\s*(?:\/\/|#|\*|\/\*|<!--)/.test(line)).length,
    isTest: TEST_FILE.test(file.path),
    isDoc: DOC_FILE.test(file.path),
    longestBlock,
  };

  if (stats.lines > 800) {
    push({
      rule: 'oversized-file',
      severity: 'recommendation',
      line: 1,
      message: `${stats.lines} lines in one file. Splitting it makes review, blame and search cheaper.`,
      evidence: file.path,
    });
  }
  if (longestBlock > 120) {
    push({
      rule: 'oversized-block',
      severity: 'recommendation',
      line: 1,
      message: `A single block spans about ${longestBlock} lines, which usually means several responsibilities.`,
      evidence: file.path,
    });
  }

  return { findings: findings.sort((a, b) => a.line - b.line), stats };
}

function summariseProject(entries) {
  const byLanguage = {};
  const bySeverity = { confirmed: 0, potential: 0, recommendation: 0 };
  const ruleCounts = {};
  let bytes = 0;
  let lines = 0;
  let testFiles = 0;
  let filesWithFindings = 0;
  const hotspots = [];

  for (const entry of entries) {
    byLanguage[entry.stats.language] = (byLanguage[entry.stats.language] || 0) + 1;
    bytes += entry.stats.bytes;
    lines += entry.stats.lines;
    if (entry.stats.isTest) testFiles += 1;
    if (entry.findings.length) {
      filesWithFindings += 1;
      hotspots.push({
        path: entry.stats.path,
        findings: entry.findings.length,
        confirmed: entry.findings.filter((finding) => finding.severity === 'confirmed').length,
        bytes: entry.stats.bytes,
      });
    }
    for (const finding of entry.findings) {
      bySeverity[finding.severity] = (bySeverity[finding.severity] || 0) + 1;
      ruleCounts[finding.rule] = (ruleCounts[finding.rule] || 0) + 1;
    }
  }

  hotspots.sort((a, b) => b.confirmed - a.confirmed || b.findings - a.findings);

  return {
    files: entries.length,
    bytes,
    lines,
    byLanguage,
    bySeverity,
    rules: Object.entries(ruleCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([rule, count]) => ({ rule, count })),
    testFiles,
    filesWithFindings,
    hotspots: hotspots.slice(0, 12),
    testRatioPercent: entries.length ? Math.round((testFiles / entries.length) * 100) : 0,
  };
}

// Content identity for incremental re-scans; mtime is not trusted.
function contentSignature(text) {
  let hash = 2166136261;
  const source = String(text);
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${source.length.toString(36)}.${(hash >>> 0).toString(36)}`;
}

const RULE_IDS = PATTERNS.map((pattern) => pattern.rule).concat(['credential-in-source', 'oversized-file', 'oversized-block']);

module.exports = {
  SECRET_PATTERNS,
  CREDENTIAL_KEYS,
  maskSecrets,
  maskCredentialLiterals,
  PATTERNS,
  RULE_IDS,
  analyseFile,
  summariseProject,
  shouldScan,
  matchesGlob,
  contentSignature,
  lineOf,
  insideTry,
  TEST_FILE,
  GENERATED,
};
