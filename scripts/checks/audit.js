'use strict';
// Audit gate group: proves every rule fires on planted code, stays silent on clean
// code, never echoes a secret, and that the extension wiring exists.

const fs = require('fs');
const path = require('path');

function run(ctx) {
  const { check, fail, assert, setGroup, SHARED, EXT_DIR, loadExtension, makeVscodeStub, freshState } = ctx;
  setGroup('audit');
  const audit = require(path.join(SHARED, 'audit/localFindings.js'));

  // Assembled by concatenation so this file holds no credential-shaped literal.
  const plantedKey = ['AIza', 'Q'.repeat(35)].join('');
  const dirty = [
    `const CONFIG = { apiKey: '${plantedKey}' };`,
    'export function run(cmd) { const cp = require("child_process"); cp.exec("sh -c " + cmd); }',
    'function load(text) { return JSON.parse(text); }',
    'try { risky(); } catch (e) { }',
    'node.innerHTML = userInput;',
    'const doubled = eval("1 + 1");',
    '// TODO: delete before release',
    '// eslint-disable-next-line no-console',
    'debugger;',
    'const password = "hunter2-super-secret";',
    'function noisy() {',
    ...Array.from({ length: 9 }, () => '  console.log("tick");'),
    '}',
  ].join('\n');

  const clean = [
    "import { spawn } from 'child_process';",
    'export function parseConfig(text) {',
    '  try { return JSON.parse(text); } catch (error) { throw new Error(`bad config: ${error.message}`); }',
    '}',
    'export function runSafe(args) { return spawn("node", args); }',
    'const password = process.env.PASSWORD;',
    'node.textContent = userInput;',
  ].join('\n');

  const dirtyResult = audit.analyseFile({ path: 'src/dirty.js', text: dirty, language: 'javascript' });
  const cleanResult = audit.analyseFile({ path: 'src/clean.ts', text: clean, language: 'typescript' });
  const rulesOf = (result) => new Set(result.findings.map((finding) => finding.rule));

  return Promise.resolve().then(async () => {
    await check('every rule fires on its planted sample', () => {
      const found = rulesOf(dirtyResult);
      const expected = [
        'credential-in-source',
        'shell-string-interpolation',
        'unguarded-json-parse',
        'empty-catch',
        'raw-html-sink',
        'dynamic-code-execution',
        'todo-comment',
        'type-safety-suppression',
        'debugger-statement',
        'literal-credential-assignment',
        'console-output-in-source',
      ];
      const missing = expected.filter((rule) => !found.has(rule));
      if (missing.length) fail(`rules that never fired: ${missing.join(', ')}`);
    });

    await check('every secret family and remaining rule is exercised', () => {
      const families = [
        ['AIza', 'Google API key'],
        ['gsk_', 'Groq API key'],
        ['sk-ant-', 'Anthropic API key'],
        ['sk-', 'OpenAI API key'],
        ['ghp_', 'GitHub token'],
        ['xoxb-', 'Slack token'],
        ['AKIA', 'AWS access key'],
      ];
      for (const [prefix, name] of families) {
        const filler = 'Z'.repeat(prefix === 'AKIA' ? 16 : 30);
        const planted = prefix + filler;
        const result = audit.analyseFile({ path: 'k.js', text: `const k = "${planted}";
` });
        const hit = result.findings.find((finding) => finding.rule === 'credential-in-source');
        assert.ok(hit, `no detector caught a planted ${name}`);
        assert.ok(hit.message.includes(name.toLowerCase()), `${name} was caught by the wrong detector: ${hit.message}`);
        assert.ok(!JSON.stringify(hit).includes(planted), `${name} finding echoed the raw value`);
      }

      const sql = audit.analyseFile({ path: 'q.js', text: 'const q = "SELECT * FROM users WHERE id = " + userId;\n' });
      assert.ok(sql.findings.some((f) => f.rule === 'sql-string-concat'), 'SQL concatenation was missed');

      const cleanSql = audit.analyseFile({ path: 'q2.js', text: 'const q = "SELECT * FROM users WHERE id = $1";\n' });
      assert.ok(!cleanSql.findings.some((f) => f.rule === 'sql-string-concat'), 'a parameterised query was flagged');

      const bigFile = audit.analyseFile({ path: 'big.js', text: Array.from({ length: 900 }, (_, i) => `const v${i} = ${i};`).join('\n') });
      assert.ok(bigFile.findings.some((f) => f.rule === 'oversized-file'), 'a 900-line file was not called out');

      const giantBlock = audit.analyseFile({ path: 'block.js', text: `function big() {
${'const x = 1;\n'.repeat(200)}}` });
      assert.ok(giantBlock.findings.some((f) => f.rule === 'oversized-block'), 'a 200-line block was not called out');

      const lookalikes = ['const hint = "AIza is the prefix Google keys use";', 'const label = "sk- short";', 'const doc = "use gsk_ keys";'];
      for (const line of lookalikes) {
        const none = audit.analyseFile({ path: 'doc.js', text: line });
        assert.ok(!none.findings.some((f) => f.rule === 'credential-in-source'), `false positive on: ${line}`);
      }

      assert.ok(audit.RULE_IDS.length >= 13, `only ${audit.RULE_IDS.length} rules are declared`);
    });

    await check('the clean sample trips no rule (false-alarm guard)', () => {
      if (cleanResult.findings.length) {
        fail(`false positives: ${cleanResult.findings.map((f) => `${f.rule}@${f.line}`).join(', ')}`);
      }
    });

    await check('findings carry severity, line, message and evidence', () => {
      for (const finding of dirtyResult.findings) {
        assert.ok(['confirmed', 'potential', 'recommendation'].includes(finding.severity), `bad severity ${finding.severity}`);
        assert.ok(finding.line >= 1, `${finding.rule} has no usable line`);
        assert.ok(finding.message && finding.message.length > 20, `${finding.rule} has no explanation`);
        assert.ok(finding.evidence, `${finding.rule} has no evidence`);
      }
      assert.ok(dirtyResult.findings.some((f) => f.severity === 'confirmed' && f.rule === 'debugger-statement'));
    });

    await check('no finding from any rule echoes a secret', () => {
      const secrets = dirtyResult.findings.filter((finding) => finding.rule === 'credential-in-source');
      assert.ok(secrets.length >= 1, 'the planted key was not detected');
      for (const finding of secrets) {
        assert.ok(finding.evidence.includes('…'), 'evidence should be a masked summary');
      }
      // The bug this catches: an unrelated rule quotes the whole line, and the line
      // carries a key. Masking must happen where evidence is produced, not per rule.
      for (const finding of dirtyResult.findings) {
        assert.ok(!JSON.stringify(finding).includes(plantedKey), `${finding.rule} leaked the raw secret: ${finding.evidence}`);
      }

      const families = ['AIza', 'sk-ant-', 'gsk_', 'ghp_', 'xoxb-', 'AKIA'];
      for (const prefix of families) {
        const secret = prefix + 'Q'.repeat(prefix === 'AKIA' ? 16 : 30);
        const line = `const q = "SELECT * FROM users WHERE id = " + "${secret}";`;
        const mixed = audit.analyseFile({ path: 'm.js', text: `${line}\n`, language: 'javascript' });
        const byOtherRule = mixed.findings.filter((finding) => finding.rule !== 'credential-in-source');
        assert.ok(byOtherRule.length, `nothing but the secret rule fired on: ${line}`);
        for (const finding of mixed.findings) {
          assert.ok(!JSON.stringify(finding).includes(secret), `${finding.rule} echoed a planted ${prefix} secret`);
        }
      }
    });

    await check('JSON.parse is flagged only when unguarded', () => {
      const guarded = audit.analyseFile({ path: 'a.js', text: 'function f(t){ try { return JSON.parse(t); } catch (e) { return null; } }' });
      assert.ok(!rulesOf(guarded).has('unguarded-json-parse'), 'a guarded parse was flagged');
      const bare = audit.analyseFile({ path: 'b.js', text: 'function f(t){ return JSON.parse(t); }' });
      assert.ok(rulesOf(bare).has('unguarded-json-parse'), 'an unguarded parse was missed');
    });

    await check('project summary aggregates severity, hotspots and rules', () => {
      const summary = audit.summariseProject([dirtyResult, cleanResult]);
      assert.strictEqual(summary.files, 2);
      assert.ok(summary.bySeverity.confirmed >= 1);
      assert.strictEqual(summary.filesWithFindings, 1, 'clean file counted as having findings');
      assert.strictEqual(summary.hotspots[0].path, 'src/dirty.js');
      assert.ok(summary.bytes > dirty.length);
      assert.ok(summary.rules.length >= 5);
    });

    await check('generated and vendor paths are never read', () => {
      for (const skipped of ['node_modules/express/index.js', 'dist/app.min.js', 'build/out.js', 'src/a.d.ts', 'coverage/lcov.info']) {
        assert.ok(!audit.shouldScan(skipped), `${skipped} should be excluded`);
      }
      for (const kept of ['src/app.js', 'tests/app.test.js', 'docs/readme.md', 'packages/ui/src/button.tsx']) {
        assert.ok(audit.shouldScan(kept), `${kept} should be included`);
      }
      assert.ok(!audit.shouldScan('src/legacy/old.js', { exclude: ['src/legacy/**'] }), 'exclude glob ignored');
      assert.ok(!audit.shouldScan('src/a.js', { bytes: 9_000_000, maxBytes: 400_000 }), 'oversized file not skipped');
      assert.ok(audit.shouldScan('src/a.js', { include: ['src/**/*.js'] }), 'include glob rejected a match');
      assert.ok(!audit.shouldScan('src/a.ts', { include: ['**/*.js'] }), 'include glob accepted a non-match');
    });

    await check('content signatures drive an incremental re-scan', () => {
      const same = audit.contentSignature('same content');
      assert.strictEqual(same, audit.contentSignature('same content'));
      assert.notStrictEqual(same, audit.contentSignature('same content!'));
      assert.ok(same.length < 24, `signature too fat to cache: ${same}`);
      const unique = new Set(['', 'a', 'x'.repeat(1000), 'x'.repeat(1001), '\n\n\n'].map(audit.contentSignature));
      assert.strictEqual(unique.size, 5, 'signatures collided');
    });

    await check('the extension declares the audit commands and their settings', () => {
      const manifest = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'package.json'), 'utf8'));
      const ids = manifest.contributes.commands.map((command) => command.command);
      for (const id of ['explainItSimply.auditProject', 'explainItSimply.auditFile', 'explainItSimply.clearAuditDiagnostics']) {
        assert.ok(ids.includes(id), `${id} is not contributed`);
      }
      const props = manifest.contributes.configuration.properties;
      for (const key of [
        'explainItSimply.audit.maxFiles',
        'explainItSimply.audit.aiFiles',
        'explainItSimply.audit.maxFileBytes',
        'explainItSimply.audit.excludeGlobs',
        'explainItSimply.audit.showDiagnostics',
      ]) {
        assert.ok(props[key], `setting ${key} is not declared`);
      }
      assert.ok(props['explainItSimply.audit.aiFiles'].default <= 5, 'the AI pass defaults to a costly file count');
      assert.ok(props['explainItSimply.audit.showDiagnostics'].type === 'boolean', 'showDiagnostics must be a toggle');
    });

    await check('audit findings become usable editor diagnostics', () => {
      const service = require(path.join(EXT_DIR, 'src/services/projectAudit.js'));
      const converted = service.toDiagnostics([
        { path: 'src/dirty.js', severity: 'error', message: 'debugger left in code', line: 3, rule: 'debugger-statement' },
        { path: 'src/dirty.js', severity: 'warning', message: 'xss sink', line: 5, rule: 'raw-html-sink' },
      ]);
      assert.strictEqual(converted.length, 2);
      assert.strictEqual(converted[0].file, 'src/dirty.js');
      assert.ok(converted[0].range, 'diagnostic has no range');
      assert.strictEqual(converted[0].range[0], 2, 'line 3 must map to zero-based 2');
      const edge = service.toDiagnostics([{ path: 'a.js', severity: 'info', message: 'm', rule: 'r' }]);
      assert.strictEqual(edge.length, 1, 'a finding without a line was dropped');
      assert.strictEqual(edge[0].range[0], 0);
      // Unknown severity must degrade to info rather than throw.
      assert.ok(service.toDiagnostics([{ path: 'a.js', severity: 'weird', message: 'm', line: 1, rule: 'r' }]).length === 1);
    });

    await check('published markers keep their rule, owner and severity', async () => {
      // The real VS Code Diagnostic constructor takes only (range, message, severity).
      // A stub that fills in `source` itself hides the bug this check exists to catch,
      // so assert on what actually reaches the collection.
      const state = freshState();
      const stub = makeVscodeStub(state);
      const published = [];
      const service = require(path.join(EXT_DIR, 'src/services/projectAudit.js'));
      const audit = new service.ProjectAuditService({
        vscode: stub,
        workspace: stub.workspace,
        fs: { readFile: () => Promise.resolve('x'), statSync: () => ({ size: 1 }) },
        settings: { advanced: { auditShowDiagnostics: true } },
        ai: {},
        diagnosticsCollection: { set: (uri, items) => published.push({ uri, items }), clear: () => {} },
      });
      await audit._setDiagnostics({
        'a.js': [
          { path: 'a.js', rule: 'credential-in-source', severity: 'confirmed', message: 'revoke it', line: 2 },
          { path: 'a.js', rule: 'raw-html-sink', severity: 'potential', message: 'sink', line: 4 },
          { path: 'a.js', rule: 'todo-comment', severity: 'recommendation', message: 'todo', line: 6 },
          { path: 'a.js', rule: 'unguarded-json-parse', severity: 'uncertain', message: 'maybe', line: 8 },
        ],
      });
      assert.strictEqual(published.length, 1, 'nothing was published');
      const items = published[0].items;
      assert.strictEqual(items.length, 4);
      const { DiagnosticSeverity } = stub;
      assert.deepStrictEqual(
        items.map((item) => item.severity),
        [DiagnosticSeverity.Error, DiagnosticSeverity.Warning, DiagnosticSeverity.Information, DiagnosticSeverity.Hint],
        `severity ladder lost: ${items.map((item) => item.severity).join(',')}`,
      );
      for (const item of items) {
        assert.strictEqual(item.source, 'Explain It Simply', `marker lost its owner: ${item.message}`);
        assert.ok(item.code, `marker lost its rule id: ${item.message}`);
      }
      assert.strictEqual(items[0].range.start.line, 1, 'line 2 must map to zero-based 1');
    });

    await check('the audit report states what it read and what it sent', () => {
      const service = require(path.join(EXT_DIR, 'src/services/projectAudit.js'));
      const summary = service.describeScope({
        read: [
          { path: 'a.js', bytes: 100, sent: true },
          { path: 'b.css', bytes: 50, sent: false },
        ],
        sent: [{ path: 'a.js', chars: 100, truncated: false }],
      });
      assert.match(summary, /1 file sent to the model/);
      assert.match(summary, /1 file read but not sent/);
      assert.ok(summary.includes('a.js'), summary);
    });

    await check('incremental re-scan only re-reads changed files', () => {
      const service = require(path.join(EXT_DIR, 'src/services/projectAudit.js'));
      const previous = { 'src/a.js': 'sig-a', 'src/b.js': 'sig-b' };
      const current = { 'src/a.js': 'sig-a', 'src/b.js': 'CHANGED', 'src/c.js': 'sig-c' };
      const { changed, removed } = service.diffSignatures(previous, current);
      assert.deepStrictEqual(changed.sort(), ['src/b.js', 'src/c.js']);
      assert.deepStrictEqual(removed, []);
      const deleted = service.diffSignatures({ 'src/z.js': 'x' }, {});
      assert.deepStrictEqual(deleted.removed, ['src/z.js']);
    });

    await check('what the audit detects, it also masks before sending', () => {
      // Two vocabularies, one guarantee: a value the auditor calls a credential must
      // never reach the model, even when SECRET_PATTERNS does not know its shape.
      // Masking is keyed on the variable NAME, so the fixture deliberately carries no
      // real token shape: a literal ghp_/AIza value in the source gets flagged by
      // GitHub push protection and by secret scanners as a leak, which wastes the one
      // signal that matters. Length >= 8 is all the rule under test needs.
      const cases = [
        ['const clientSecret = "not-a-real-token-local-fixture-only";', 'not-a-real-token-local-fixture-only'],
        ['let dbPassword = "sup3rs3cretvalue";', 'sup3rs3cretvalue'],
        ['const refresh_token = "rT_abcdefghijklmnop";', 'rT_abcdefghijklmnop'],
        ['cfg.apiKey = "local-fixture-value-not-a-key";', 'local-fixture-value-not-a-key'],
      ];
      for (const [line, secret] of cases) {
        const masked = audit.maskCredentialLiterals(line);
        assert.ok(masked.removed >= 1, `nothing masked in: ${line}`);
        assert.ok(!masked.text.includes(secret), `${secret} survived masking: ${masked.text}`);
      }
      // Benign strings must not be shredded, or the model loses real context.
      for (const line of ['const tokenizerName = "a fairly long normal string here";', 'function descriptionOf(model) { return model.name; }']) {
        assert.strictEqual(audit.maskCredentialLiterals(line).removed, 0, `over-eager masking: ${line}`);
      }
    });

    await check('an audit never reads a file outside the opened workspace', async () => {
      const projectAudit = require(path.join(EXT_DIR, 'src/services/projectAudit.js'));
      const stub = makeVscodeStub(freshState());
      const published = [];
      const service = new projectAudit.ProjectAuditService({
        vscode: stub,
        workspace: { workspaceFolders: [{ uri: stub.Uri.file('/work/proj'), name: 'proj' }], findFiles: async () => [] },
        fs: { readFile: () => Promise.resolve(''), statSync: () => ({ size: 1 }) },
        settings: {
          advanced: {
            auditShowDiagnostics: true, auditMaxFiles: 10, auditAiFiles: 0, auditMaxFileBytes: 1000,
            auditMaxSendChars: 1000, auditExcludeGlobs: [],
          },
        },
        ai: { catalog: () => ({ providers: [] }), explain: async () => ({ ok: false }) },
        logger: { appendLine: () => {} },
        diagnosticsCollection: { set: (uri, items) => published.push(items), clear: () => {} },
        stateStore: { get: () => undefined, update: async () => {} },
      });
      const outside = stub.Uri.file('/etc/passwd');
      await assert.rejects(
        () => service.audit({ scope: 'file', target: outside }),
        /outside the workspace/i,
        'a path outside the workspace was accepted',
      );
      // A file inside the workspace still works.
      const inside = stub.Uri.file('/work/proj/src/a.js');
      const report = await service.audit({ scope: 'file', target: inside });
      assert.ok(report.kind === 'project-audit', 'an in-workspace file was refused');
    });

    await check('the audit report keeps the confidence ladder into editor markers', async () => {
      // Through the real path, not a hand-fed _setDiagnostics: an earlier version mapped
      // 'confirmed' -> 'error' here and then looked 'error' up in a ladder keyed by
      // 'confirmed', so every marker degraded to Information.
      const projectAudit = require(path.join(EXT_DIR, 'src/services/projectAudit.js'));
      const stub = makeVscodeStub(freshState());
      const secret = ['AIza', 'R'.repeat(30)].join('');
      const published = [];
      const service = new projectAudit.ProjectAuditService({
        vscode: stub,
        workspace: {
          workspaceFolders: [{ uri: stub.Uri.file('/work/proj'), name: 'proj' }],
          findFiles: async () => [stub.Uri.file('/work/proj/a.js')],
          openTextDocument: async () => ({ getText: () => `const key = ${JSON.stringify(secret)};\ndebugger;\n` }),
        },
        fs: { readFile: () => Promise.resolve(`const key = ${JSON.stringify(secret)};\ndebugger;\n`), statSync: () => ({ size: 60 }) },
        settings: {
          advanced: {
            auditShowDiagnostics: true, auditMaxFiles: 10, auditAiFiles: 0, auditMaxFileBytes: 100000,
            auditMaxSendChars: 10000, auditExcludeGlobs: [],
          },
        },
        ai: {},
        logger: { appendLine: () => {} },
        diagnosticsCollection: { set: (uri, items) => published.push(items), clear: () => {} },
        stateStore: { get: () => undefined, update: async () => {} },
      });
      const report = await service.audit({ scope: 'workspace' });
      assert.ok(report.scope.fileCount >= 1, 'the report never said how many files it read');
      assert.ok(published.length, 'no markers published');
      const severities = published.flat().map((item) => item.severity);
      assert.ok(
        severities.includes(stub.DiagnosticSeverity.Error),
        `no confirmed finding became an editor error: ${severities.join(',')}`,
      );
      assert.ok(published.flat().every((item) => item.source === 'Explain It Simply'), 'markers lost their owner');
    });

    await check('audit runs against a stubbed workspace end to end', async () => {
      const state = freshState();
      const stub = makeVscodeStub(state);
      const loaded = loadExtension(stub);
      const { value } = ctx.makeContext(stub);
      const settings = new loaded.settings.SettingsManager(value, ctx.configStub({
        'audit.maxFiles': 10,
        'audit.aiFiles': 1,
        'audit.maxFileBytes': 100_000,
        'audit.showDiagnostics': true,
      }));
      const history = new loaded.historyService.HistoryService(value, settings);
      const ai = new loaded.aiService.ExplainService({ settings, history, logger: { appendLine: () => {} } });
      ai.core.setConfig({
        providerId: 'google',
        model: 'gemini-3.8-flash',
        apiKey: ctx.FAKE_KEY,
        transport: ctx.makeTransport(() => ({
          status: 200,
          headers: {},
          text: JSON.stringify({
            candidates: [{
              content: {
                parts: [{
                  text: JSON.stringify({
                    title: 'Server entry point',
                    simpleExplanation: { body: 'It wires the app together.' },
                    technicalExplanation: { body: 'Startup order matters here.' },
                    potentialIssues: [{ severity: 'potential', description: 'Unvalidated config read', where: 'line 4' }],
                    keyTakeaway: 'Validate config at the edge.',
                  }),
                }],
              },
            }],
          }),
        })),
      });

      const files = {
        'src/server.js': 'const key = ' + JSON.stringify(['AIza', 'Z'.repeat(30)].join('')) + ';\ndebugger;\nmodule.exports = 1;\n',
        'src/util.js': 'export const add = (a, b) => a + b;\n',
        'dist/bundle.js': 'debugger;\n',
      };
      const workspace = {
        folders: [{ uri: { fsPath: '/tmp/proj', path: '/tmp/proj' } }],
        async findFiles() {
          return Object.keys(files).map((name) => ctx.uriFor(name));
        },
        async readFile() {
          return { toString: () => 'not used' };
        },
      };
      const fsStub = {
        statSync: (p) => ({ size: files[String(p).replace(/^\/tmp\/proj\//, '')].length }),
        readFile: (p) => Buffer.from(files[String(p).replace(/^\/tmp\/proj\//, '')], 'utf8'),
      };
      const service = new loaded.projectAudit.ProjectAuditService({
        vscode: stub,
        workspace,
        fs: fsStub,
        settings,
        ai,
        logger: { appendLine: () => {} },
        diagnosticsCollection: stub.languages.createDiagnosticCollection
          ? stub.languages.createDiagnosticCollection()
          : { set() {}, clear() {}, dispose() {} },
      });

      const report = await service.audit({ scope: 'workspace' });
      assert.ok(report, 'no report returned');
      assert.strictEqual(report.stats.files, 2, `unexpected file set: ${report.scope.read.map((f) => f.path)}`);
      assert.ok(report.findings.some((finding) => finding.rule === 'credential-in-source'), 'secret not found');
      assert.ok(report.findings.some((finding) => finding.rule === 'debugger-statement'), 'debugger not found');
      assert.ok(!report.scope.read.some((file) => file.path.startsWith('dist/')), 'a generated file was analysed');
      assert.ok(report.summary.ai.length >= 1, 'the AI pass produced nothing');
      assert.strictEqual(report.summary.ai[0].path, 'src/server.js', 'the AI pass skipped the hotspot file');
      assert.ok(report.scope.sent.length === 1, `expected 1 file sent, got ${report.scope.sent.length}`);
      assert.ok(!JSON.stringify(report).includes(['AIza', 'Z'.repeat(30)].join('')), 'a raw secret was copied into the report');
      assert.ok(report.diagnostics.length >= 2, 'findings were not converted to diagnostics');
      assert.ok(report.totals.estimatedTokens > 0, 'no token estimate for the send');
      // Both stamps come from Date.now(), so a stubbed audit on a fast runner legitimately lands in
      // the same millisecond: `>` was the wrong contract and failed one ubuntu-22 leg on
      // 2026-11-02 (run 41496929800) while passing the same commit everywhere else. What has to
      // hold is that the pair is ordered and that it MOVES when the work takes longer — asserted
      // below against a deliberately slow read, which a bare `>` never proved.
      assert.ok(Number.isFinite(report.startedAt) && Number.isFinite(report.finishedAt),
        `timestamps are not both numbers: ${report.startedAt} / ${report.finishedAt}`);
      assert.ok(report.finishedAt >= report.startedAt,
        `the report finished before it started: ${report.startedAt} → ${report.finishedAt}`);

      const slowRun = await (async () => {
        const slowFs = {
          statSync: (p) => {
            const until = Date.now() + 6;
            while (Date.now() < until) { /* make the clock move */ }
            return fsStub.statSync(p);
          },
          readFile: (p) => fsStub.readFile(p),
        };
        const slowService = new loaded.projectAudit.ProjectAuditService({
          vscode: stub, workspace, fs: slowFs, settings, ai,
          logger: { appendLine: () => {} },
          diagnosticsCollection: stub.languages.createDiagnosticCollection
            ? stub.languages.createDiagnosticCollection()
            : { set() {}, clear() {}, dispose() {} },
        });
        return slowService.audit({ scope: 'workspace' });
      })();
      assert.ok(slowRun.finishedAt > slowRun.startedAt,
        `a six-millisecond-per-file scan reported no elapsed time: ${slowRun.startedAt} → ${slowRun.finishedAt}`);

      // Second run with one file edited: only that file is re-read.
      files['src/util.js'] = 'export const add = (a, b) => a + b;\n// touched\n';
      const second = await service.audit({ scope: 'workspace' });
      assert.deepStrictEqual(second.rerescan, ['src/util.js'], `incremental scan re-read too much: ${second.rerescan}`);
      assert.strictEqual(second.stats.files, 2);
    });
  });
}

module.exports = { run };
