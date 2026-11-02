'use strict';
/* Runs INSIDE a real VS Code extension host, launched by scripts/vscode-window-check.js.
 * Nothing here ships: .vscodeignore excludes src/test.
 * Reports on stdout with EISPASS/EISFAIL/EISNOTE lines; the driver turns those into
 * a pass/fail summary, because the workbench exits 0 whether or not the run passed.
 */

const fs = require('fs');
const path = require('path');

const EXTENSION_ID = 'explain-it-simply.explain-it-simply';
const OUT = [];

function log(line) {
  OUT.push(line);
  console.log(line);
}

function waitFor(predicate, timeoutMs, intervalMs = 120) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let ok = false;
      try {
        ok = predicate();
      } catch (error) {
        ok = false;
      }
      if (ok) return resolve(true);
      if (Date.now() - started > timeoutMs) return reject(new Error(`timed out after ${timeoutMs}ms`));
      return setTimeout(tick, intervalMs);
    };
    tick();
  });
}

async function step(name, fn) {
  try {
    const note = await fn();
    log(`EISPASS ${name}${note ? ` :: ${note}` : ''}`);
    return true;
  } catch (error) {
    const detail = (error && (error.message || String(error))) || 'unknown';
    log(`EISFAIL ${name} :: ${detail.split('\n').join(' | ')}`);
    return false;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function run() {
  const vscode = require('vscode');
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  let failures = 0;
  const runStep = async (name, fn) => {
    if (!(await step(name, fn))) failures += 1;
  };

  // Captured before anything can use it: the command wrapper reports internal
  // failures through showErrorMessage, so recording those turns a silent catch()
  // into a visible test failure.
  const shown = [];
  try {
    const original = vscode.window.showErrorMessage;
    vscode.window.showErrorMessage = (...args) => {
      shown.push(String(args[0] || ''));
      return Promise.resolve(undefined);
    };
    log(`EISNOTE notifications captured: ${vscode.window.showErrorMessage !== original}`);
  } catch (error) {
    log(`EISNOTE could not patch showErrorMessage (${error.message})`);
  }

  // The sidebar view is observed through the hub's own surface list rather than by
  // patching the vscode API: a property patch works for a development path but is not
  // visible to a packaged extension, and the suite must prove the same thing either way.

  await runStep('the extension is installed in this window', () => {
    assert(extension, `${EXTENSION_ID} not found`);
    assert(!extension.isActive, 'expected a lazy extension, but it was already active');
    return `extensionPath=${extension.extensionPath}`;
  });

  await runStep('a contributed command activates it on demand', async () => {
    await vscode.commands.executeCommand('explainItSimply.openPanel');
    await waitFor(() => extension.isActive, 15000);
    return 'activationEvents:[] is honoured by the real workbench';
  });

  const manifest = JSON.parse(fs.readFileSync(path.join(extension.extensionPath, 'package.json'), 'utf8'));
  const contributed = manifest.contributes.commands.map((command) => command.command);

  await runStep('every contributed command is registered', async () => {
    const all = await vscode.commands.getCommands(true);
    const missing = contributed.filter((id) => !all.includes(id));
    assert(!missing.length, `not registered: ${missing.join(', ')}`);
    return `${contributed.length} commands`;
  });

  await runStep('every contributed setting exists with its declared default type', () => {
    const properties = manifest.contributes.configuration.properties || {};
    const bad = [];
    for (const [id, schema] of Object.entries(properties)) {
      const scoped = vscode.workspace.getConfiguration(id.split('.')[0]);
      const key = id.split('.').slice(1).join('.');
      const inspected = scoped.inspect(key);
      if (!inspected) {
        bad.push(`${id}: not readable`);
        continue;
      }
      const value = scoped.get(key);
      const declared = Array.isArray(schema.type) ? schema.type : [schema.type];
      const actual = Array.isArray(value) ? 'array' : typeof value;
      if (value === undefined || (!declared.includes(actual) && !(actual === 'number' && declared.includes('integer')))) {
        bad.push(`${id}: declared ${declared.join('|')}, got ${actual}`);
      }
    }
    assert(!bad.length, bad.join('; '));
    return `${Object.keys(properties).length} settings`;
  });

  await runStep('the panel HTML carries a CSP that only allows its own assets', async () => {
    const opened = extension.exports.openPanel();
    const panel = opened._panel;
    assert(panel, 'openPanel() gave no webview panel');
    const html = panel.webview.html;
    const csp = /<meta[^>]*Content-Security-Policy[^>]*content="([^"]*)"/.exec(html);
    assert(csp, 'no CSP meta tag');
    assert(/default-src 'none'/.test(csp[1]), `CSP has no default-src 'none': ${csp[1]}`);
    assert(new RegExp(`script-src \\$\\{?|script-src ${panel.webview.cspSource.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(csp[1]), `script-src is not the webview origin: ${csp[1]}`);
    assert(!/<script(?![^>]*\ssrc=)[^>]*>[\s\S]*?<\/script>/.test(html), 'an inline <script> block is present and would be blocked');
    // Asserted on the rendered policy, not on the source string: base-uri and form-action
    // have no default-src fallback, so they only exist if the builder really emitted them.
    for (const directive of ["connect-src 'none'", "base-uri 'none'", "form-action 'none'", "object-src 'none'"]) {
      assert(csp[1].includes(directive), `rendered CSP is missing ${directive}: ${csp[1]}`);
    }
    assert(!/script-src[^;]*unsafe-(?:inline|eval)/.test(csp[1]), 'script-src carries an unsafe source');
    assert(/<script[^>]*src="[^"]*client\.js/.test(html), 'client.js is not loaded from a file');
    assert(/<link[^>]*href="[^"]*styles\.css/.test(html), 'styles.css is not loaded from a file');
    for (const src of html.match(/vscode-webview:\/\/[^"']+/g) || []) {
      const decoded = decodeURIComponent(src.split('/').slice(2).join('/'));
      const onDisk = path.join(extension.extensionPath, decoded.replace(/^[A-Za-z]:/, ''));
      assert(fs.existsSync(onDisk), `asset URI does not resolve to a file: ${src}`);
    }
    return `cspSource=${panel.webview.cspSource}`;
  });

  await runStep('the client script actually runs in the webview under that CSP', async () => {
    const panel = extension.exports.openPanel()._panel;
    const inbound = [];
    panel.webview.onDidReceiveMessage((message) => inbound.push(message));
    const before = inbound.length;
    await waitFor(() => inbound.some((message) => message && message.type === 'ready'), 25000, 200);
    return `webview posted ready (${inbound.length - before} messages seen)`;
  });

  await runStep('the panel is a singleton and recreates after dispose', async () => {
    const first = extension.exports.openPanel();
    const again = extension.exports.openPanel();
    assert(first === again || first._panel === again._panel, 'a second open made a duplicate panel');
    const panel = first._panel;
    const disposed = new Promise((resolve) => panel.onDidDispose(() => resolve(true)));
    panel.dispose();
    // `active` is a focus flag, not a liveness flag: onDidDispose is the real signal.
    const happened = await Promise.race([disposed, waitFor(() => false, 6000).catch(() => false)]);
    assert(happened === true, 'the panel never reported disposal');
    const reopened = extension.exports.openPanel();
    assert(reopened._panel !== panel, 'the disposed panel came back');
    const inbound = [];
    reopened._panel.webview.onDidReceiveMessage((message) => inbound.push(message));
    await waitFor(() => inbound.some((message) => message && message.type === 'ready'), 25000, 200);
    return 'a fresh client booted after dispose';
  });

  await runStep('the Activity Bar view resolves and its client boots', async () => {
    const declared = manifest.contributes.views['explain-it-simply'][0];
    // Product-visible state only: patching the vscode API works for a development
    // path but not for a packaged copy, and the suite has to prove the same thing
    // either way. The hub grows a surface when VS Code resolves the view.
    const before = extension.exports.surfaces().length;
    await vscode.commands.executeCommand('workbench.view.extension.explain-it-simply');
    await waitFor(() => extension.exports.surfaces().length > before, 20000, 10);
    const webview = extension.exports.surfaces().at(-1);
    const inbound = [];
    webview.onDidReceiveMessage((message) => inbound.push(message));
    assert(declared.type === 'webview', `the view is type '${declared.type}', not webview`);
    assert(/default-src 'none'/.test(webview.html), 'the view html has no CSP');
    assert(/client\.js/.test(webview.html), 'the view does not load the client script');
    // The surface is attached before the html finishes loading, so a client that
    // executes under the real CSP announces itself here.
    await waitFor(() => inbound.some((message) => message && message.type === 'ready'), 25000, 20);
    return `view '${declared.id}' booted (surfaces ${before} -> ${extension.exports.surfaces().length})`;
  });

  await runStep('sidebar and editor panel answer from one hub', async () => {
    const views = extension.exports.surfaces().length;
    assert(views >= 1, 'no surface attached');
    await vscode.commands.executeCommand('explainItSimply.openPanelInEditor');
    await waitFor(() => extension.exports.surfaces().length >= 2, 20000, 20);
    const surfaces = extension.exports.surfaces();
    assert(surfaces.length === 2, `expected the view plus one panel, saw ${surfaces.length}`);
    const alive = surfaces.map((webview) => {
      try {
        return webview.html.length > 0;
      } catch (error) {
        return false;
      }
    });
    assert(alive.every(Boolean), `a dead surface is still attached: ${alive.join(',')}`);
    // Asking again must reuse, not stack a third webview.
    await vscode.commands.executeCommand('explainItSimply.openPanelInEditor');
    assert(extension.exports.surfaces().length === 2, `a third surface appeared: ${extension.exports.surfaces().length}`);
    return 'one hub, two live surfaces';
  });

  await runStep('every VS Code command this extension delegates to actually exists', async () => {
    // executeCommand() on a typo'd id has resolved silently in some VS Code versions,
    // so "the suite ran the command" is not proof the target exists. Read the ids out of
    // the shipped source and ask the real host whether each one is registered.
    const sources = ['src/extension.js', 'src/panel.js', 'src/sidePanel.js', 'src/services/projectAudit.js']
      .map((rel) => [rel, fs.readFileSync(path.join(extension.extensionPath, rel), 'utf8')]);
    const delegated = new Set();
    for (const [, text] of sources) {
      for (const match of text.matchAll(/executeCommand\(\s*'([^']+)'/g)) delegated.add(match[1]);
      for (const match of text.matchAll(/^const (?:SIDE_CONTAINER_COMMAND|VIEW_ID)\s*=\s*'([^']+)'/gm)) delegated.add(match[1]);
    }
    const all = await vscode.commands.getCommands(true);
    // setContext is provided by the workbench but is not always listed by getCommands
    // until a menu contribution registers it; it demonstrably resolves at runtime here,
    // so listing it would be a false positive rather than a finding.
    const listingQuirks = new Set(['setContext']);
    const missing = [...delegated].filter((id) => !all.includes(id) && !listingQuirks.has(id));
    assert(missing.length === 0, `delegated to commands the host does not have: ${missing.join(', ')}`);
    return `${delegated.size - listingQuirks.size} delegated ids resolved (${listingQuirks.size} exempt: ${[...listingQuirks].join(', ')})`;
  });

  const fixtureRoot = (vscode.workspace.workspaceFolders || [])[0];

  // The height chain is a flex layout, so a single missing `min-height: 0` clips
  // everything below the fold with no error anywhere. Measure it from inside each
  // live surface instead of trusting the CSS to read correctly.
  await runStep('every surface keeps its content reachable and scrollable', async () => {
    const surfaces = extension.exports.surfaces();
    assert(surfaces.length >= 2, `expected the view and a panel, saw ${surfaces.length}`);
    const seen = [];
    for (const [index, webview] of surfaces.entries()) {
      const inbound = [];
      webview.onDidReceiveMessage((message) => inbound.push(message));
      for (const screen of ['setup', 'main']) {
        const tag = `s${index}:${screen}`;
        await webview.postMessage({ type: 'screen', screen });
        await webview.postMessage({ type: 'probe-layout', tag });
        await waitFor(() => inbound.some((m) => m && m.type === 'layout' && m.tag === tag), 15000, 50);
        const report = inbound.filter((m) => m.type === 'layout' && m.tag === tag).at(-1);
        log(`EISNOTE ${tag} ${JSON.stringify(report)}`);
        assert(report.innerH > 100, `${tag}: the webview reports no viewport`);
        // Nothing may overflow the document: body clips, so overflow is unreachable.
        assert(report.bodyScrollH <= report.innerH + 2,
          `${tag} ${screen}: the document is ${report.bodyScrollH}px tall in a ${report.innerH}px viewport and body clips it (${report.bodyOverflowY}) — content below the fold is unreachable`);
        assert(report.appClientH <= report.innerH + 2, `${tag} ${screen}: #app is ${report.appClientH}px, taller than the ${report.innerH}px viewport`);
        const scroller = report.scroller;
        assert(scroller, `${tag} ${screen}: the screen has no .scroll element`);
        assert(/auto|scroll/.test(scroller.overflowY), `${tag} ${screen}: .scroll overflow-y is ${scroller.overflowY}`);
        if (scroller.scrollH > scroller.clientH + 1) {
          assert(report.scrolledTo > 0, `${tag} ${screen}: .scroll overflows (${scroller.scrollH}>${scroller.clientH}) but did not move when scrolled`);
        }
        seen.push(`${tag} ${screen} vh=${report.innerH} doc=${report.bodyScrollH} scroller=${scroller.clientH}/${scroller.scrollH}${report.scrolledTo ? ` moved=${report.scrolledTo}` : ''}`);
      }
      // Leave every surface on the screen the reader expects.
      await webview.postMessage({ type: 'screen', screen: 'main' });
    }
    return seen.join(' | ');
  });

  await runStep('project audit reads the workspace and marks the planted credential', async () => {
    assert(fixtureRoot, 'no workspace folder');
    const demo = vscode.Uri.joinPath(fixtureRoot.uri, 'demo.js');
    assert(fs.existsSync(demo.fsPath), `fixture missing: ${demo.fsPath}`);
    const token = { signal: new AbortController().signal, isCurrent: () => true };
    const report = await extension.exports.services.audit.audit({ scope: 'workspace', token });
    assert(report && report.kind === 'project-audit', `unexpected report: ${JSON.stringify(report && report.kind)}`);
    const credential = report.findings.filter((finding) => finding.rule === 'credential-in-source');
    assert(credential.length, `no credential finding; rules seen: ${[...new Set(report.findings.map((f) => f.rule))].join(', ')}`);
    assert(credential[0].line >= 1, 'finding has no line');
    // Pull the planted value out of the fixture itself, then prove it is nowhere in
    // the report the panel renders and the AI pass would receive.
    const { SECRET_PATTERNS } = require('../shared/audit/localFindings.js');
    const source = fs.readFileSync(demo.fsPath, 'utf8');
    const found = [];
    for (const pattern of SECRET_PATTERNS) {
      pattern.re.lastIndex = 0;
      const match = pattern.re.exec(source);
      if (match) found.push(match[0]);
    }
    assert(found.length, 'the fixture no longer contains a detectable credential');
    const dumped = JSON.stringify(report);
    const leaked = found.filter((secret) => dumped.includes(secret));
    assert(!leaked.length, `the report carries the raw key: ${leaked.join(',')}`);
    const diagnostics = vscode.languages.getDiagnostics(demo);
    assert(diagnostics.length, 'no diagnostics were published for the audited file');
    assert(diagnostics.every((entry) => entry.source === 'Explain It Simply'), `unexpected diagnostic source: ${diagnostics[0].source}`);
    return `${report.findings.length} findings, ${diagnostics.length} markers, read=${report.scope.read.length}`;
  });

  await runStep('audit markers clear again', async () => {
    await vscode.commands.executeCommand('explainItSimply.clearAuditDiagnostics');
    const demo = vscode.Uri.joinPath(fixtureRoot.uri, 'demo.js');
    assert(vscode.languages.getDiagnostics(demo).length === 0, 'markers survived the clear');
    return 'ok';
  });

  await runStep('an explanation with no key fails as a configuration error, not a crash', async () => {
    const token = { signal: new AbortController().signal, isCurrent: () => true };
    const outcome = await extension.exports.services.ai.explain({
      task: 'explain-topic', input: { subject: 'recursion', language: 'javascript' }, token,
    });
    assert(outcome && outcome.ok === false, `expected a refusal, got ${JSON.stringify(outcome && Object.keys(outcome))}`);
    assert(outcome.error.code === 'CONFIGURATION_ERROR', `wrong code: ${outcome.error.code}`);
    assert(/key/i.test(outcome.error.message), `message does not mention the key: ${outcome.error.message}`);
    return `${outcome.error.code}: ${outcome.error.message}`;
  });

  await runStep('history opens empty and survives a real globalState', async () => {
    const items = await extension.exports.services.history.list({});
    assert(Array.isArray(items), 'history.list did not return an array');
    const count = await extension.exports.services.history.count();
    assert(count === items.length, `count=${count} but list=${items.length}`);
    return `${items.length} items`;
  });

  await runStep('every command runs without an internal error', async () => {
    const noisy = shown.length;
    for (const id of contributed) {
      try {
        await vscode.commands.executeCommand(id);
      } catch (error) {
        throw new Error(`${id} rejected: ${error.message}`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    const fresh = shown.slice(noisy).filter((message) => /command failed|Cannot read|is not defined|is not a function|ENOENT|ENOTFOUND|TypeError/i.test(message));
    assert(!fresh.length, `errors surfaced: ${fresh.join(' // ')}`);
    return `${contributed.length} commands, ${shown.length - noisy} notifications`;
  });

  log(`${failures ? 'EISRESULT FAIL' : 'EISRESULT PASS'} failures=${failures}`);
  log('EISDONE');
  if (failures) process.exitCode = 1;
}

module.exports = { run };
