#!/usr/bin/env node
'use strict';
/* Dev-only visual harness for the extension webview. Nothing here ships (.vscodeignore).
 *
 *   node tools/preview/serve.js            # http://127.0.0.1:8931
 *   npm run preview:webview -- --open
 *
 * It loads the real webview/client.js and webview/styles.css — the files VS Code loads,
 * byte for byte — into iframes sized to the geometry measured inside a real window:
 * a 297x662 Activity Bar rail and a 712x670 editor panel. The client detects no
 * acquireVsCodeApi(), so post() is inert and the host is simulated by dispatching the
 * same messages panel.js sends.
 *
 * What this proves: layout, overflow, spacing, wrapping at the real widths.
 * What it cannot prove: colours. The stylesheet is built on --vscode-* variables, so the
 * shell below supplies Dark+ approximations; the real theme comes from the user's window.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const EXT_DIR = path.resolve(__dirname, '..', '..');
const WEBVIEW = path.join(EXT_DIR, 'webview');
const { createCore, registry } = require(path.join(EXT_DIR, 'src', 'shared', 'index.js'));
const PORT = Number(process.env.EIS_PREVIEW_PORT || 8931);

const RESULT = {
  title: 'Recursion',
  summary: 'A function that calls itself until something stops it.',
  simpleExplanation: {
    heading: 'In plain words',
    body: 'Recursion is a recipe that refers to itself. To count a stack of plates you do not count all of them at once: you take the top one, ask the same question about what is left, and add one to the answer.',
    points: ['Every recursive call needs a stopping condition.', 'The call stack remembers where each step came from.', 'Tail calls can be flattened into a loop.'],
  },
  technicalExplanation: {
    heading: 'Under the hood',
    body: 'Each call pushes a stack frame holding its arguments and return address. Depth is bounded by the stack size, so an unbounded recursion throws a RangeError rather than looping forever.',
    points: ['Frame per call, popped on return.', 'Memoisation trades memory for repeated work.'],
  },
  keyTakeaway: 'Recursion replaces an explicit loop by letting the call stack keep the state.',
  concepts: [
    { term: 'Base case', meaning: 'The input small enough to answer without recursing.' },
    { term: 'Call stack', meaning: 'LIFO frames, one per pending invocation.' },
    { term: 'Tail recursion', meaning: 'The recursive call is the last action.' },
  ],
  nextSteps: ['Trace factorial(4) on paper.', 'Rewrite one recursive helper as a loop.'],
};

const META = {
  provider: 'OpenRouter', model: 'nvidia/nemotron-3.5-super-vl:free', elapsedMs: 7200,
  tokens: { prompt: 812, completion: 640 }, requestId: 'preview-1', depth: 'balanced',
  chars: 1490, fromHistory: false, costNote: 'free tier',
};

function catalog({ configured = ['openrouter'] } = {}) {
  const core = createCore({});
  const providers = core.catalog().providers;
  const providerId = configured[0] || 'google';
  return {
    defaultProvider: core.catalog().defaultProvider,
    providers,
    tasks: core.tasks(),
    selected: {
      providerId,
      model: registry.defaultModelFor(providerId),
      depth: 'balanced',
      proseLanguage: 'en',
    },
    keysConfiguredFor: configured,
    isConfigured: configured.length > 0,
    advanced: {
      includeSurroundingContext: true,
      includeCurrentFile: false,
      contextCharBudget: 8000,
      requestTimeoutMs: 45000,
      maxRetries: 2,
      nativeStructuredOutput: true,
      historyEnabled: true,
      historyCodeStorage: 'summary',
    },
  };
}

const DATA = {
  catalog: catalog({}),
  unconfiguredCatalog: catalog({ configured: [] }),
  history: [
    { id: 'h1', title: 'Recursion', taskLabel: 'Explain a topic', createdAt: Date.now() - 3600e3, provider: 'OpenRouter', model: 'nvidia/nemotron-3.5-super-vl:free' },
    { id: 'h2', title: 'TCP handshake', taskLabel: 'Explain a topic', createdAt: Date.now() - 86400e3, provider: 'OpenRouter', model: 'nvidia/nemotron-3.5-super-vl:free' },
  ],
  historyBytes: 4096,
  context: {
    available: true,
    fileName: 'checkout.ts',
    language: 'typescript',
    hasSelection: true,
    selectedChars: 612,
    totalLines: 240,
    cursorLine: 88,
    diagnostics: ['line 91: Object is possibly undefined. [ts2532]'],
    truncated: false,
  },
  result: RESULT,
  meta: META,
  // A live OpenRouter response, captured 2026-10-18 through the real adapter path
  // (470 ids, 19 free). Trimmed to what the picker shows; free routes lead.
  liveRefresh: {
    type: 'models.refreshed',
    ok: true,
    providerId: 'openrouter',
    liveCount: 470,
    freeCount: 19,
    hiddenCount: 408,
    models: [
      { id: 'anthropic/claude-sonnet-5.5', name: 'Claude Sonnet 5.5 (via OpenRouter)', status: 'verified', free: false, contextWindow: '1M' },
      { id: 'cohere/north-mini-code:free', name: 'Cohere: North Mini Code (free)', status: 'verified', free: true, contextWindow: '256K' },
      { id: 'google/gemma-4-26b-a4b-it:free', name: 'Gemma 4 26B A4B IT (free)', status: 'verified', free: true, contextWindow: '262K' },
      { id: 'nvidia/nemotron-3.5-super-vl:free', name: 'NVIDIA Nemotron 3.5 Super VL (free)', status: 'verified', free: true, contextWindow: '128K' },
      { id: 'poolside/laguna-s-2.1:free', name: 'Poolside Laguna S 2.1 (free)', status: 'verified', free: true, contextWindow: '131K' },
      { id: 'thinkingmachines/inkling:free', name: 'Thinking Machines Inkling (free)', status: 'verified', free: true, contextWindow: '1M' },
      { id: 'x-ai/grok-4.1-fast', name: 'xAI: Grok 4.1 Fast', status: 'verified', free: false, contextWindow: '2M' },
      { id: 'deepseek/deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash', status: 'verified', free: false, contextWindow: '164K' },
    ],
  },
};

const SHELL = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>EIS webview preview</title><style>
:root{color-scheme:dark}
body{margin:0;padding:22px;background:#141414;color:#ccc;font:13px/1.4 system-ui,sans-serif;display:flex;gap:26px;align-items:flex-start}
.pane{display:flex;flex-direction:column;gap:7px}
.pane b{font-weight:600;color:#9cdcfe}
iframe{border:1px solid #333;background:#1e1e1e;display:block}
a{color:#4aa3f0}
</style></head><body>
<div class="pane"><b>Activity Bar rail — 297 x 662 (measured)</b><iframe id="rail" width="297" height="662"></iframe></div>
<div class="pane"><b>Editor panel — 712 x 670 (measured)</b><iframe id="panel" width="712" height="670"></iframe></div>
<div class="pane"><b>screens</b>
<a href="/?screen=main">main</a> <a href="/?screen=setup">setup</a> <a href="/?screen=setup&amp;unconfigured=1">setup (no key)</a>
<a href="/?screen=setup&amp;live=1">setup (live list)</a> <a href="/?screen=setup&amp;open=1">setup (all providers)</a>
<a href="/?screen=settings">settings</a> <a href="/?screen=history">history</a> <a href="/?screen=audit">audit</a>
</div>
<script>
const q = new URLSearchParams(location.search);
const screen = q.get('screen') || 'main';
for (const [id, w] of [['rail', 297], ['panel', 712]]) {
  document.getElementById(id).src = '/frame.html?screen=' + encodeURIComponent(screen)
    + '&width=' + w + (q.get('unconfigured') ? '&unconfigured=1' : '')
    + (q.get('empty') ? '&empty=1' : '') + (q.get('busy') ? '&busy=1' : '')
    + (q.get('open') ? '&open=1' : '') + (q.get('live') ? '&live=1' : '');
}
</script></body></html>`;

// The page VS Code would build, minus the CSP (which is tested in a real window) and
// with the Dark+ variables the real workbench injects.
const FRAME = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
:root{
--vscode-editor-background:#1e1e1e;--vscode-editor-foreground:#d4d4d4;--vscode-descriptionForeground:#9d9d9d;
--vscode-panel-border:#3c3c3c;--vscode-editorWidget-background:#252526;--vscode-input-background:#3c3c3c;
--vscode-input-foreground:#cccccc;--vscode-input-border:#3c3c3c;--vscode-button-background:#0e639c;
--vscode-button-foreground:#ffffff;--vscode-button-hoverBackground:#1177bb;--vscode-button-secondaryBackground:#3a3d41;
--vscode-button-secondaryForeground:#ffffff;--vscode-button-secondaryHoverBackground:#45494e;--vscode-focusBorder:#007fd4;
--vscode-textLink-foreground:#3794ff;--vscode-errorForeground:#f48771;--vscode-font-family:system-ui,sans-serif;
--vscode-font-size:13px;--vscode-editor-font-family:Consolas,monospace;--vscode-list-hoverBackground:#2a2d2e;
--vscode-list-activeSelectionBackground:#04395e;--vscode-list-activeSelectionForeground:#ffffff;
--vscode-editorWarning-foreground:#cca700;--vscode-testing-iconPassed:#73c991;--vscode-charts-orange:#e8a33d;--vscode-charts-blue:#4aa3f0;}
</style>
<link rel="stylesheet" href="/styles.css"></head>
<body class="vscode-dark"><div id="app"></div>
<script src="/data.js"></script>
<script src="/client.js"></script>
<script src="/driver.js"></script>
</body></html>`;

const DRIVER = `(function () {
  var params = new URLSearchParams(location.search);
  var data = window.__EIS_DATA__;
  var send = function (message) { window.dispatchEvent(new MessageEvent('message', { data: message })); };
  send({ type: 'bootstrap', catalog: params.get('unconfigured') ? data.unconfiguredCatalog : data.catalog, history: data.history, historyBytes: data.historyBytes });
  send({ type: 'context', available: params.get('empty') ? false : data.context.available, fileName: data.context.fileName, language: data.context.language, hasSelection: !params.get('empty') && data.context.hasSelection, selectedChars: params.get('empty') ? 0 : data.context.selectedChars, totalLines: data.context.totalLines, cursorLine: data.context.cursorLine, diagnostics: params.get('empty') ? [] : data.context.diagnostics, truncated: false });
  if (params.get('busy') === '1') { send({ type: 'started', requestId: 'preview-1', task: 'explain-topic', mode: 'selection' }); send({ type: 'delta', requestId: 'preview-1', text: 'Partial answer while the request is still running. It keeps arriving here, so this panel has to scroll too.' }); }
  else if (!params.get('empty')) { send({ type: 'result', requestId: 'preview-1', adopt: true, result: data.result, meta: data.meta, historyId: 'h1' }); }
  send({ type: 'screen', screen: params.get('screen') || 'main' });
  if (params.get('live') === '1') send(window.__EIS_DATA__.liveRefresh);
  if (params.get('open') === '1') {
    var show = [].slice.call(document.querySelectorAll('button')).filter(function (b) { return /show all/i.test(b.textContent); })[0];
    if (show) show.click();
  }
  // Report the same numbers the real-window suite reads, so a layout claim here is checkable.
  var active = document.querySelector('.screen[data-active="true"]');
  var scroller = active && active.querySelector('.scroll');
  window.__EIS_LAYOUT__ = {
    innerH: innerHeight, innerW: innerWidth, bodyScrollH: document.body.scrollHeight,
    appClientH: document.getElementById('app').clientHeight,
    scroller: scroller ? { clientH: scroller.clientHeight, scrollH: scroller.scrollHeight, overflowY: getComputedStyle(scroller).overflowY } : null,
  };
})();`;

const text = (body, type = 'text/html; charset=utf-8') => [200, { 'content-type': type, 'cache-control': 'no-store' }, body];

const routes = {
  '/': () => text(SHELL),
  '/frame.html': () => text(FRAME),
  '/driver.js': () => text(`window.__EIS_LAYOUT_SRC__ = 1;\n${DRIVER}`, 'text/javascript; charset=utf-8'),
  '/data.js': () => text(`window.__EIS_DATA__ = ${JSON.stringify(DATA)};`, 'text/javascript; charset=utf-8'),
  '/styles.css': () => text(fs.readFileSync(path.join(WEBVIEW, 'styles.css'), 'utf8'), 'text/css; charset=utf-8'),
  '/client.js': () => text(fs.readFileSync(path.join(WEBVIEW, 'client.js'), 'utf8'), 'text/javascript; charset=utf-8'),
};

function main() {
  for (const file of ['client.js', 'styles.css']) {
    if (!fs.existsSync(path.join(WEBVIEW, file))) {
      console.error(`preview: webview/${file} missing`);
      process.exitCode = 1;
      return;
    }
  }
  const server = http.createServer((req, res) => {
    const route = routes[String(req.url).split('?')[0]];
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    const [status, headers, body] = route();
    res.writeHead(status, headers);
    res.end(body);
  });
  server.listen(PORT, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${PORT}/?screen=setup`;
    console.log(`preview: ${url}`);
    console.log('screens: main | setup | setup&unconfigured=1 | settings | history | audit | main&busy=1');
    if (process.argv.includes('--open')) {
      const opener = process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
      const arg = process.platform === 'win32' ? `url,${url}` : url;
      spawn(opener, [arg], { detached: true, stdio: 'ignore' }).unref();
    }
  });
}

module.exports = { DATA, catalog, RESULT, META };
if (require.main === module) main();
