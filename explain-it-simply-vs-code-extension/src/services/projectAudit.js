'use strict';
// Project audit: read a bounded set of workspace files, run deterministic local
// rules (free, offline), then spend the user's key only on the few files that
// actually need judgement. Credentials found locally are redacted before any
// request, and the report states exactly what was read versus what was sent.

const {
  analyseFile,
  summariseProject,
  shouldScan,
  contentSignature,
  SECRET_PATTERNS,
  maskCredentialLiterals,
} = require('../shared/audit/localFindings');
const { ConfigurationError } = require('../shared/errors');

const SOURCE_GLOB = '**/*.{js,mjs,cjs,ts,tsx,jsx,py,go,rs,java,kt,c,h,cpp,cs,php,rb,swift,sql,sh,bash,html,css,json,yml,yaml,md}';
const PER_FILE_SEND_CHARS = 12_000;
const MAX_REPORT_FINDINGS = 60;
const SEVERITY_ORDER = { confirmed: 0, potential: 1, recommendation: 2 };

const STATE_KEY = 'eis.audit.signatures';

function relPath(root, target) {
  const filePath = String(typeof target === 'string' ? target : (target && (target.fsPath || target.path)) || '');
  const base = String(root || '').replace(/[\\/]+$/, '');
  if (base && filePath.startsWith(base)) {
    return filePath.slice(base.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
  }
  return filePath.replace(/\\/g, '/');
}

// Strips credentials so a secret is never pasted into a model request. Both detectors
// are used: key *shapes* (Google/OpenAI/AWS/…) and credential-shaped *assignments*,
// because a file the audit flags as leaking a password must not then be sent verbatim.
function redactCredentials(text) {
  let out = String(text);
  let removed = 0;
  for (const pattern of SECRET_PATTERNS) {
    const re = new RegExp(pattern.re.source, pattern.re.flags.includes('g') ? pattern.re.flags : `${pattern.re.flags}g`);
    out = out.replace(re, () => {
      removed += 1;
      return `[REDACTED ${pattern.name.toLowerCase()}]`;
    });
  }
  const literals = maskCredentialLiterals(out);
  out = literals.text;
  removed += literals.removed;
  return { text: out, removed };
}

// Findings are graded by confidence, editor markers by VS Code severity.
const DIAGNOSTIC_SEVERITY = {
  confirmed: 'Error',
  potential: 'Warning',
  recommendation: 'Information',
  uncertain: 'Hint',
};

function toDiagnostics(findings) {
  return (findings || []).map((finding) => {
    const line = Math.max(0, (Number(finding.line) || 1) - 1);
    return {
      file: finding.path,
      severity: finding.severity,
      message: `[Explain It Simply] ${finding.rule}: ${finding.message}`,
      source: 'Explain It Simply',
      code: finding.rule,
      range: [line, 0, line, 1],
    };
  });
}

function describeScope(scope) {
  const read = (scope && scope.read) || [];
  const sent = (scope && scope.sent) || [];
  const sentSet = new Set(sent.map((entry) => entry.path));
  const notSent = read.filter((entry) => !sentSet.has(entry.path));
  const parts = [
    `${read.length} file(s) read locally, ${sent.length} file sent to the model`,
    sent.length ? `sent: ${sent.map((entry) => `${entry.path} (${entry.chars} chars${entry.truncated ? ', trimmed' : ''}${entry.redacted ? ', credentials removed' : ''})`).join(', ')}` : '',
    notSent.length ? `${notSent.length} file read but not sent: ${notSent.slice(0, 8).map((entry) => entry.path).join(', ')}${notSent.length > 8 ? ' …' : ''}` : '',
  ].filter(Boolean);
  return parts.join(' · ');
}

function diffSignatures(previous, current) {
  const prev = previous || {};
  const next = current || {};
  const changed = Object.keys(next).filter((file) => prev[file] !== next[file]);
  const removed = Object.keys(prev).filter((file) => !(file in next));
  return { changed, removed };
}

class ProjectAuditService {
  constructor({ vscode, workspace, fs, settings, ai, logger, stateStore, diagnosticsCollection }) {
    this._vscode = vscode;
    this._workspace = workspace;
    this._fs = fs;
    this._settings = settings;
    this._ai = ai;
    this._logger = logger;
    this._state = stateStore;
    this._diagnostics = diagnosticsCollection;
    this._signatures = null;
  }

  async _previousSignatures() {
    if (this._signatures) return this._signatures;
    if (this._state && typeof this._state.get === 'function') {
      this._signatures = this._state.get(STATE_KEY) || {};
    } else {
      this._signatures = {};
    }
    return this._signatures;
  }

  async _rememberSignatures(map) {
    this._signatures = map;
    if (this._state && typeof this._state.update === 'function') {
      await this._state.update(STATE_KEY, map);
    }
  }

  clearDiagnostics() {
    if (this._diagnostics && typeof this._diagnostics.clear === 'function') this._diagnostics.clear();
  }

  // A target arrives from a command (an editor URI) or from a webview message, so treat
  // it as untrusted: an audit must never read a file outside the opened workspace.
  _containedTarget(target, rootPath) {
    const raw = typeof target === 'string' ? target : (target && (target.fsPath || target.path));
    const clean = String(raw || '').replace(/\\/g, '/');
    const root = String(rootPath || '').replace(/\\/g, '/').replace(/\/+$/, '');
    // Fail closed: without a workspace root nothing can contain the path, and a missing
    // root must not quietly mean "anything goes".
    if (!clean || !root) throw new ConfigurationError('Audit needs an open folder and one file inside it.');
    const sameCase = process.platform === 'win32' || /^[A-Za-z]:/.test(clean);
    const a = sameCase ? clean.toLowerCase() : clean;
    const b = sameCase ? root.toLowerCase() : root;
    if (!a.startsWith(`${b}/`)) throw new ConfigurationError(`Refusing to audit outside the workspace: ${clean}`);
    return typeof target === 'string' ? this._vscode.Uri.file(target) : target;
  }

  async _readFile(uri) {
    const document = await this._workspace.openTextDocument
      ? await this._workspace.openTextDocument(uri)
      : null;
    if (document && typeof document.getText === 'function') return document.getText();
    const target = uri && (uri.fsPath || uri.path);
    const buffer = await this._fs.readFile(target);
    return buffer.toString();
  }

  _setDiagnostics(byFile) {
    if (!this._diagnostics) return;
    if (!this._settings.advanced.auditShowDiagnostics) {
      this._diagnostics.clear();
      return;
    }
    for (const [file, items] of Object.entries(byFile)) {
      const uri = this._vscode.Uri.file(file);
      // Findings carry line numbers, not ranges; toDiagnostics converts them.
      const converted = toDiagnostics(items);
      const collection = this._vscode.Diagnostic && this._vscode.Range
        ? converted.map((item) => {
          const diagnostic = new this._vscode.Diagnostic(
            new this._vscode.Range(item.range[0], item.range[1], item.range[2], item.range[3]),
            item.message,
            this._vscode.DiagnosticSeverity[DIAGNOSTIC_SEVERITY[item.severity] || 'Information'],
          );
          // The constructor takes only range/message/severity: source and code are
          // separate fields, and without them a marker does not say which rule it is.
          diagnostic.source = item.source;
          diagnostic.code = item.code;
          return diagnostic;
        })
        : converted;
      this._diagnostics.set(uri, collection);
    }
  }

  /**
   * @param {{scope?: 'workspace'|'file', target?: string, aiFiles?: number, token?: {signal: AbortSignal|null, isCurrent: () => boolean}}} options
   */
  async audit(options = {}) {
    const startedAt = Date.now();
    const advanced = this._settings.advanced;
    // `workspaceFolders` is the property VS Code actually exposes; reading a shorter
    // alias left the root empty, so markers became absolute-path URIs and the read/sent
    // manifest carried full paths instead of paths relative to the folder.
    const folders = this._workspace.workspaceFolders || this._workspace.folders || [];
    const root = (folders[0] && folders[0].uri) || null;
    const rootPath = root ? (root.fsPath || root.path) : '';

    const limits = {
      maxFiles: advanced.auditMaxFiles,
      aiFiles: Math.max(0, Math.min(options.aiFiles ?? advanced.auditAiFiles, 12)),
      maxFileBytes: advanced.auditMaxFileBytes,
      excludeGlobs: advanced.auditExcludeGlobs,
      maxSendChars: advanced.auditMaxSendChars,
    };

    const found = options.scope === 'file' && options.target
      ? [this._containedTarget(options.target, rootPath)]
      : await this._workspace.findFiles(SOURCE_GLOB, '**/node_modules/**');

    const previous = await this._previousSignatures();
    const candidates = [];
    const skipped = { generated: 0, tooBig: 0, unreadable: 0 };
    const current = {};

    for (const entry of found) {
      const relative = relPath(rootPath, entry);
      let size = 0;
      try {
        size = (this._fs.statSync(entry.fsPath || entry.path) || {}).size || 0;
      } catch (error) {
        skipped.unreadable += 1;
        continue;
      }
      if (!shouldScan(relative, { bytes: size, maxBytes: limits.maxFileBytes, exclude: limits.excludeGlobs })) {
        if (GENERATEDISH.test(relative)) skipped.generated += 1;
        else skipped.tooBig += 1;
        continue;
      }
      candidates.push({ entry, relative, size });
      if (candidates.length >= limits.maxFiles) break;
    }

    const analysed = [];
    for (const candidate of candidates) {
      let text = '';
      try {
        text = await this._readFile(candidate.entry);
      } catch (error) {
        skipped.unreadable += 1;
        continue;
      }
      const signature = contentSignature(text);
      current[candidate.relative] = signature;
      const result = analyseFile({ path: candidate.relative, text, language: languageOf(candidate.relative) });
      analysed.push({ ...result, text, relative: candidate.relative, bytes: candidate.size });
    }

    const stats = summariseProject(analysed.map(({ findings, stats: fileStats }) => ({ findings, stats: fileStats })));
    const findings = analysed
      .flatMap((item) => item.findings.map((finding) => ({ ...finding, path: item.relative })))
      .sort((a, b) => (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]) || (a.path.localeCompare(b.path)) || (a.line - b.line));

    // Spend the key where the evidence already points.
    const ranked = [...analysed].sort((a, b) => {
      const rank = (item) => item.findings.filter((f) => f.severity === 'confirmed').length * 100
        + item.findings.length * 10
        + Math.min(item.bytes / 1000, 50);
      return rank(b) - rank(a);
    });

    const sent = [];
    const aiReports = [];
    let sendBudget = limits.maxSendChars;
    const token = options.token || { signal: null, isCurrent: () => true };

    for (const item of ranked) {
      if (aiReports.length >= limits.aiFiles) break;
      if (sendBudget < 800) break;
      if (!item.findings.length && aiReports.length >= Math.min(1, limits.aiFiles)) continue;

      const redaction = redactCredentials(item.text);
      const body = redaction.text.slice(0, Math.min(PER_FILE_SEND_CHARS, sendBudget));
      const truncated = body.length < redaction.text.length;
      sendBudget -= body.length;

      const outcome = await this._ai.explain({
        task: 'find-issues',
        input: {
          subject: body,
          language: languageOf(item.relative),
          fileName: item.relative,
          fullDocument: '',
          cursorLine: null,
          diagnostics: '',
        },
        depth: body.length > 4000 ? 'deep' : 'balanced',
        token: { signal: token.signal, isCurrent: token.isCurrent, id: `audit:${item.relative}` },
      });

      sent.push({
        path: item.relative,
        chars: body.length,
        truncated,
        redacted: redaction.removed,
        ok: !!outcome.ok,
      });
      if (outcome.ok && token.isCurrent()) {
        aiReports.push({
          path: item.relative,
          title: outcome.result.title,
          summary: outcome.result.summary || '',
          takeaway: outcome.result.keyTakeaway || '',
          issues: (outcome.result.potentialIssues || []).map((issue) => ({
            severity: issue.severity,
            description: issue.description,
            where: issue.where || '',
          })),
          requestId: outcome.meta.requestId,
          tokens: outcome.meta.usage ? outcome.meta.usage.outputTokens : 0,
        });
      } else if (!outcome.ok) {
        aiReports.push({ path: item.relative, error: outcome.error });
      }
      if (!token.isCurrent()) break;
    }

    const byFile = {};
    for (const finding of findings) {
      if (finding.severity === 'recommendation') continue;
      const absolute = `${rootPath}/${finding.path}`.replace(/\\/g, '/');
      byFile[absolute] = byFile[absolute] || [];
      // Keep the finding's own confidence ladder: _setDiagnostics maps it to editor
      // severities. Rewriting it here made every lookup miss, so a confirmed credential
      // rendered as the least visible marker VS Code has.
      byFile[absolute].push({ ...finding });
    }
    this._setDiagnostics(byFile);

    const rerescan = diffSignatures(previous, current).changed.filter((file) => file in current);
    await this._rememberSignatures(current);

    const report = {
      kind: 'project-audit',
      version: 1,
      root: rootPath,
      startedAt,
      finishedAt: Date.now(),
      scope: {
        // The panel titles a single-file audit differently; without this it called every
        // run an audit of the workspace.
        fileCount: analysed.length,
        read: analysed.map((item) => ({
          path: item.relative,
          bytes: item.bytes,
          sent: sent.some((entry) => entry.path === item.relative),
        })),
        sent,
        description: describeScope({
          read: analysed.map((item) => ({ path: item.relative, bytes: item.bytes, sent: sent.some((entry) => entry.path === item.relative) })),
          sent,
        }),
        skipped,
        limits: { maxFiles: limits.maxFiles, aiFiles: limits.aiFiles, maxSendChars: limits.maxSendChars },
      },
      stats,
      findings: findings.slice(0, MAX_REPORT_FINDINGS),
      findingsTruncated: Math.max(0, findings.length - MAX_REPORT_FINDINGS),
      summary: { ai: aiReports },
      rerescan,
      diagnostics: Object.values(byFile).flat(),
      totals: {
        estimatedTokens: Math.ceil(sent.reduce((sum, entry) => sum + entry.chars, 0) / 4),
        sentChars: sent.reduce((sum, entry) => sum + entry.chars, 0),
        localFindings: findings.length,
      },
    };

    this._logger.appendLine(
      `audit.done files=${analysed.length} sent=${sent.length} findings=${findings.length} `
      + `confirmed=${stats.bySeverity.confirmed} aiReports=${aiReports.length} ms=${report.finishedAt - startedAt}`,
    );
    return report;
  }
}

const GENERATEDISH = /(?:^|\/)(?:node_modules|dist|build|out|coverage|\.next|\.cache)\//i;
const EXTENSION_LANGUAGE = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', py: 'python', go: 'go', rs: 'rust',
  java: 'java', kt: 'kotlin', c: 'c', h: 'c', cpp: 'cpp', cs: 'csharp',
  php: 'php', rb: 'ruby', swift: 'swift', sql: 'sql', sh: 'shell', bash: 'shell',
  html: 'html', css: 'css', json: 'json', yml: 'yaml', yaml: 'yaml', md: 'markdown',
};

function languageOf(file) {
  const ext = String(file).split('.').pop().toLowerCase();
  return EXTENSION_LANGUAGE[ext] || '';
}

module.exports = {
  ProjectAuditService,
  toDiagnostics,
  describeScope,
  diffSignatures,
  redactCredentials,
  relPath,
  languageOf,
  SOURCE_GLOB,
  PER_FILE_SEND_CHARS,
  STATE_KEY,
};
