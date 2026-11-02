/* Vendored from ../shared/context/contextEngine.js — do not edit here; run `npm run vendor`. */
'use strict';
// Context engine: turns "whatever the editor had" into a small, explicitly
// described block. Every part that is sent to the provider is listed in
// `manifest`, and oversized input is trimmed in a stated order rather than
// silently. Nothing here reads the workspace: callers pass what they have.

const DEFAULT_LIMITS = {
  maxSubjectChars: 40_000,
  maxContextChars: 8_000,
  surroundRadius: 12,
  maxImports: 12,
};

const DECLARATION = {
  braced: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|enum|fn|func|def|public|private|protected)\b/,
  python: /^\s*(?:async\s+)?(?:def|class)\b/,
};

const IMPORT_PATTERNS = {
  js: [/^\s*import\b.{0,200}$/gm, /^\s*const\s+\{[^}]*\}\s*=\s*require\(.{0,80}\).{0,20}$/gm],
  py: [/^\s*(?:from\s+\S+\s+)?import\s+.{0,120}$/gm],
  go: [/^\s*import\s+.{0,120}$/gm],
  rust: [/^\s*(?:use\s+|mod\s+).{0,120}$/gm],
  java: [/^\s*import\s+.{0,120}$/gm],
  c: [/^\s*#include\s+.{0,80}$/gm],
};

function isPythonish(language) {
  return /^(python|ruby|yaml|yml|coffeescript|haskell|elixir|groovy)$/i.test(language || '');
}

function languageFamily(language) {
  const lang = String(language || '').toLowerCase();
  if (/^java|kotlin|scala/.test(lang)) return 'java';
  if (/^c$|cpp|objc|objective/.test(lang)) return 'c';
  if (/^(go|golang)$/.test(lang)) return 'go';
  if (/^rust$/.test(lang)) return 'rust';
  if (isPythonish(lang)) return 'py';
  return 'js';
}

function estimateTokens(chars) {
  return Math.ceil(chars / 4);
}

function splitLines(text) {
  return String(text == null ? '' : text).replace(/\r\n/g, '\n').split('\n');
}

// The block containing `line`, found by brace matching (indentation for
// Python-like files). Returns { start, end, header } or null.
function enclosingBlock(documentText, line, language) {
  const lines = splitLines(documentText);
  if (!lines.length || line < 0 || line >= lines.length) return null;
  const python = isPythonish(language);
  const test = python ? DECLARATION.python : DECLARATION.braced;

  let start = null;
  for (let i = line; i >= 0; i -= 1) {
    if (test.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === null) return null;

  if (python) {
    const baseIndent = lines[start].match(/^\s*/)[0].length;
    let end = start;
    for (let i = start + 1; i < lines.length; i += 1) {
      if (!lines[i].trim()) continue;
      if (lines[i].match(/^\s*/)[0].length <= baseIndent) break;
      end = i;
    }
    return { start, end, header: lines[start].trim() };
  }

  let depth = 0;
  let seenOpen = false;
  for (let i = start; i < lines.length; i += 1) {
    for (const char of lines[i]) {
      if (char === '{') { depth += 1; seenOpen = true; }
      else if (char === '}') depth -= 1;
    }
    if (seenOpen && depth <= 0) return { start, end: i, header: lines[start].trim() };
    if (i === start && depth === 0) {
      return { start, end: i, header: lines[start].trim() };
    }
  }
  return { start, end: Math.min(lines.length - 1, start + 40), header: lines[start].trim() };
}

function extractImports(text, language) {
  const patterns = IMPORT_PATTERNS[languageFamily(language)] || IMPORT_PATTERNS.js;
  const found = [];
  const seen = new Set();
  for (const pattern of patterns) {
    for (const match of String(text).matchAll(pattern)) {
      const line = match[0].trim();
      if (line && !seen.has(line)) {
        seen.add(line);
        found.push(line);
      }
      if (found.length >= DEFAULT_LIMITS.maxImports) return found;
    }
  }
  return found;
}

// Head+tail cut so a huge block still shows its signature and its closing.
function headTail(text, maxChars) {
  if (text.length <= maxChars) return { text, removed: 0 };
  const head = Math.ceil(maxChars * 0.65);
  const tail = Math.floor(maxChars * 0.3);
  const removed = Math.max(0, text.length - head - tail);
  return {
    text: `${text.slice(0, head)}\n\n/* … ${removed} characters omitted … */\n\n${text.slice(text.length - tail)}`,
    removed,
  };
}

/**
 * @param {Object} input
 * @param {string} input.subject         the thing to explain: selection, snippet, or question
 * @param {string} [input.language]
 * @param {string} [input.fileName]
 * @param {string} [input.fullDocument]  used only to mine context around the cursor
 * @param {number} [input.cursorLine]    zero-based line of the selection/cursor
 * @param {string} [input.diagnostics]   error text, when explaining an error
 * @param {Object} [input.limits]
 */
function buildContext(input = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(input.limits || {}) };
  const manifest = [];
  const notices = [];
  const blocks = [];
  let used = 0;
  let truncated = false;

  const rawSubject = typeof input.subject === 'string' ? input.subject : String(input.subject ?? '');
  if (!rawSubject.trim()) {
    return {
      subject: '', contextText: '', language: input.language || '', fileName: input.fileName || '',
      diagnostics: '', manifest: [], notices: ['Nothing to explain.'], truncated: false, chars: 0, estTokens: 0,
    };
  }

  // 1. The selection itself — never dropped, only trimmed at the middle.
  let subject = rawSubject;
  if (subject.length > limits.maxSubjectChars) {
    const cut = headTail(subject, limits.maxSubjectChars);
    subject = cut.text;
    truncated = true;
    notices.push(`Selection trimmed: ${cut.removed.toLocaleString()} characters omitted from the middle.`);
  }
  manifest.push({ part: 'selection', chars: subject.length, reason: 'what you asked about' });
  used += subject.length;

  const language = input.language || detectLanguage(subject, input.fileName);
  const documentLines = splitLines(input.fullDocument || '');
  const cursorLine = Number.isInteger(input.cursorLine) && input.cursorLine >= 0 ? input.cursorLine : null;
  const remaining = () => Math.max(0, limits.maxContextChars - used);

  const addBlock = (part, text, reason, range) => {
    const clean = String(text || '').trim();
    if (!clean) return;
    if (subject.includes(clean)) return; // already inside the selection
    const budget = remaining();
    if (budget < 80) {
      truncated = true;
      notices.push(`Context budget reached — '${part}' not included.`);
      return;
    }
    const fit = clean.slice(0, budget);
    if (fit.length < clean.length) truncated = true;
    blocks.push({ part, text: fit });
    manifest.push({ part, chars: fit.length, reason, ...range });
    used += fit.length;
  };

  if (documentLines.length && cursorLine !== null) {
    // 2. Enclosing function or class.
    const block = enclosingBlock(input.fullDocument, cursorLine, language);
    if (block) {
      const body = documentLines.slice(block.start, block.end + 1).join('\n');
      addBlock('enclosing-block', body, block.header.slice(0, 80), { from: block.start + 1, to: block.end + 1 });
    }

    // 3. Imports.
    const imports = extractImports(input.fullDocument, language);
    addBlock('imports', imports.join('\n'), `${imports.length} import line(s)`);

    // 4. Surrounding lines, only if budget remains.
    if (remaining() > 200) {
      const start = Math.max(0, cursorLine - limits.surroundRadius);
      const end = Math.min(documentLines.length - 1, cursorLine + limits.surroundRadius);
      const surrounding = documentLines.slice(start, end + 1).join('\n');
      addBlock('surrounding-lines', surrounding, `lines ${start + 1}-${end + 1}`, { from: start + 1, to: end + 1 });
    }
  }

  let diagnostics = '';
  if (input.diagnostics && String(input.diagnostics).trim()) {
    diagnostics = String(input.diagnostics).trim().slice(0, 2000);
    manifest.push({ part: 'diagnostics', chars: diagnostics.length, reason: 'the error you asked about' });
    used += diagnostics.length;
  }

  if (truncated && !notices.some((n) => /budget/i.test(n))) {
    notices.push('Context was trimmed to fit the request budget.');
  }

  return {
    subject,
    language,
    fileName: input.fileName || '',
    diagnostics,
    // Only the mined context travels; the file itself does not.
    contextText: blocks.map((b) => `/* ${b.part} */\n${b.text}`).join('\n\n'),
    manifest,
    notices,
    truncated,
    chars: used,
    estTokens: estimateTokens(used),
  };
}

const LANG_FROM_EXT = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', py: 'python', go: 'go', rs: 'rust',
  java: 'java', kt: 'kotlin', rb: 'ruby', php: 'php', cs: 'csharp', c: 'c',
  h: 'c', cpp: 'cpp', cc: 'cpp', hh: 'cpp', sql: 'sql', sh: 'shell', bash: 'shell',
  html: 'html', css: 'css', json: 'json', yaml: 'yaml', yml: 'yaml', md: 'markdown',
};

function detectLanguage(text, fileName) {
  const ext = String(fileName || '').split(/[\\/]/).pop().split('.').pop().toLowerCase();
  if (LANG_FROM_EXT[ext]) return LANG_FROM_EXT[ext];
  if (/^\s*(?:import|export)\s/m.test(text)) return 'javascript';
  if (/^\s*def\s+\w+\s*:/m.test(text)) return 'python';
  if (/^\s*(?:package\s+[\w.]+;|public\s+(?:class|static))/m.test(text)) return 'java';
  return '';
}

module.exports = {
  DEFAULT_LIMITS,
  buildContext,
  enclosingBlock,
  extractImports,
  detectLanguage,
  estimateTokens,
  headTail,
  isPythonish,
  languageFamily,
};
