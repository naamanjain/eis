'use strict';
// Webview host: lifecycle, message routing, request ledger. No AI logic, no
// prompt building, no provider knowledge — it delegates to services and pushes
// results back to the panel.

const vscode = require('vscode');
const { getWebviewContent } = require('./webview');
const { Ledger } = require('./shared/pipeline/requestLedger');
const { fromEditor } = require('./services/editorContext');
const registry = require('./shared/providers/registry');

const VIEW_TYPE = 'explainItSimply';
const SIDE_VIEW_ID = 'explainItSimply.sidePanel';
const SIDE_CONTAINER_COMMAND = 'workbench.view.extension.explain-it-simply';

class ExplainPanel {
  static current = undefined;
  // The sidebar view, once VS Code has resolved it. Commands prefer it because it
  // is where the reader is already looking.
  static sideWebview = undefined;

  static showInSidePanel() {
    if (!ExplainPanel.sideWebview) return false;
    vscode.commands.executeCommand(SIDE_CONTAINER_COMMAND);
    return true;
  }

  // Called by the webview view provider when the Activity Bar view appears.
  static attachSideView(view, context, services) {
    ExplainPanel.sideWebview = view.webview;
    const hub = ExplainPanel.ensureContext(context, services);
    hub._services = services;
    hub._addSurface(view.webview);
    view.webview.html = getWebviewContent(view.webview, context);
    view.onDidDispose(() => {
      // Clear the static first: _removeSurface disposes the hub when nothing is left,
      // and a stale reference here would keep a dead hub alive.
      if (ExplainPanel.sideWebview === view.webview) ExplainPanel.sideWebview = undefined;
      hub._removeSurface(view.webview);
    });
    return hub;
  }

  // Always an editor-area panel, even when the sidebar view is live: wide answers
  // are easier to read in a second column, and some readers want that every time.
  static createOrShowEditor(context, services) {
    const existing = ExplainPanel.current;
    if (existing && existing._panel && !existing._disposed) {
      existing._panel.reveal(existing._panel.viewColumn || vscode.ViewColumn.Beside, true);
      existing._services = services;
      return existing;
    }
    const column = vscode.window.activeTextEditor
      ? vscode.ViewColumn.Beside
      : vscode.ViewColumn.Active;

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      'Explain It Simply',
      { viewColumn: column, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'webview')],
      },
    );
    const hub = ExplainPanel.ensureContext(context, services);
    hub._services = services;
    hub._panel = panel;
    hub._addSurface(panel.webview);
    panel.webview.html = getWebviewContent(panel.webview, context);
    hub._disposables.push(
      panel.onDidDispose(() => {
        // Clear the reference first: _removeSurface disposes the hub only when no
        // surface is left, and a live sidebar view must keep it alive.
        if (hub._panel === panel) hub._panel = null;
        hub._removeSurface(panel.webview);
      }),
    );
    return hub;
  }

  static ensureContext(context, services) {
    if (!ExplainPanel.current || ExplainPanel.current._disposed) {
      ExplainPanel.current = new ExplainPanel(null, context, services);
    }
    return ExplainPanel.current;
  }

  // The surface a command should answer in: an open editor panel wins (the reader
  // put it there), then the sidebar view, then a fresh editor panel.
  static createOrShow(context, services) {
    const hub = ExplainPanel.current;
    if (hub && !hub._disposed && hub._panel) {
      hub._panel.reveal(hub._panel.viewColumn || vscode.ViewColumn.Beside, true);
      hub._services = services;
      return hub;
    }
    if (ExplainPanel.sideWebview) {
      ExplainPanel.showInSidePanel();
      if (hub) hub._services = services;
      return hub;
    }
    return ExplainPanel.createOrShowEditor(context, services);
  }

  constructor(panel, context, services) {
    this._panel = panel;
    this._context = context;
    this._services = services;
    this._ledger = new Ledger();
    this._disposables = [];
    this._disposed = false;
    this._lastTarget = null;
    this._lastRequest = null;
    this._lastResult = null;
    this._pendingIntent = null;
    this._auditing = false;
    // Every open surface shows the same state: closing one must not strand a result.
    this._surfaces = new Set();
    // Subscriptions owned by surfaces are tracked so closing a panel releases its
    // listener instead of leaving it on the extension's emitter.
    this._surfaceListeners = new Map();
    if (panel) this._addSurface(panel.webview);

    this._disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        this._lastActiveEditor = editor || this._lastActiveEditor;
        if (editor) this._postContextState();
      }),
      vscode.workspace.onDidChangeTextDocument(() => this._postContextState()),
      vscode.window.onDidChangeTextEditorSelection(() => this._postContextState()),
    );

    this._lastActiveEditor = vscode.window.activeTextEditor;
  }

  _addSurface(webview) {
    if (!webview || this._surfaces.has(webview)) return;
    this._pruneDeadSurfaces();
    this._surfaces.add(webview);
    this._surfaceListeners.set(
      webview,
      webview.onDidReceiveMessage((message) => this._onMessage(message, webview)),
    );
  }

  // Reading html throws on a disposed webview, which makes it a side-effect-free
  // liveness probe. A dead surface would otherwise swallow every broadcast.
  _pruneDeadSurfaces() {
    for (const webview of [...this._surfaces]) {
      try {
        void webview.html;
      } catch (error) {
        this._dropSurface(webview);
      }
    }
  }

  _dropSurface(webview) {
    this._surfaces.delete(webview);
    const subscription = this._surfaceListeners.get(webview);
    if (subscription) {
      try {
        subscription.dispose();
      } catch (error) {
        /* already released with the surface */
      }
      this._surfaceListeners.delete(webview);
    }
  }

  _removeSurface(webview) {
    this._dropSurface(webview);
    // Only a surface that has not been disposed may keep the hub alive.
    if (!this._surfaces.size && !ExplainPanel.sideWebview && !this._panel) this.dispose();
  }

  // ---- helpers -----------------------------------------------------------

  get _editor() {
    // The webview takes focus, so activeTextEditor can be null while the user is
    // still looking at a file. Fall back to the last editor we saw.
    return vscode.window.activeTextEditor || this._lastActiveEditor || null;
  }

  _post(message) {
    if (this._disposed) return;
    for (const webview of [...this._surfaces]) this._postTo(webview, message);
  }

  _postTo(webview, message) {
    const drop = (error) => {
      // VS Code reports a dead webview here. Losing that surface beats losing the
      // message for the surfaces that are still alive.
      this._services.logger.appendLine(`surface.dropped ${error && error.message}`);
      this._dropSurface(webview);
    };
    try {
      const sent = webview.postMessage(message);
      // postMessage hands back a thenable: a rejection means the same thing as a
      // throw, and an unhandled one would surface as a spurious extension error.
      if (sent && typeof sent.then === 'function') sent.then(() => undefined, drop);
    } catch (error) {
      drop(error);
    }
  }

  _capture(mode) {
    const editor = this._editor;
    if (!editor) return null;
    const captured = fromEditor(vscode, editor, mode);
    if (!captured) return null;
    this._lastTarget = {
      uri: editor.document.uri,
      range: editor.selection,
      version: editor.document.version,
      fileName: captured.fileName,
      language: captured.language,
    };
    return captured;
  }

  async _postContextState() {
    const editor = this._editor;
    if (!editor) {
      this._post({ type: 'context', available: false, reason: 'no-editor' });
      return;
    }
    const document = editor.document;
    const selection = editor.selection;
    const selectedChars = selection && !selection.isEmpty
      ? document.getText(selection).length
      : 0;
    const diagnostics = await Promise.resolve(
      require('./services/editorContext').diagnosticsNear(vscode, document, selection.active.line),
    );
    this._post({
      type: 'context',
      available: true,
      fileName: document.fileName.split(/[\\/]/).pop(),
      language: document.languageId,
      hasSelection: selectedChars > 0,
      selectedChars,
      totalLines: document.lineCount,
      cursorLine: selection.active.line + 1,
      diagnostics: diagnostics.slice(0, 3),
      truncated: document.getText().length > require('./services/editorContext').MAX_DOCUMENT_CHARS,
    });
  }

  async _bootstrap(source) {
    const catalog = await this._services.ai.catalog();
    const history = await this._services.history.list({});
    this._post({
      type: 'bootstrap',
      catalog,
      history: history.map(toListItem),
      historyBytes: this._services.history.sizeBytes(),
    });
    await this._postContextState();
    if (!source) return undefined;
    // A surface that joins late must show what the other one already shows, or it sits
    // on the empty state while an answer is on screen beside it.
    const running = this._ledger.currentId();
    if (running) {
      this._postTo(source, {
        type: 'started',
        requestId: running,
        task: (this._lastRequest || {}).task,
        depth: (this._lastRequest || {}).depth,
        mode: (this._lastRequest || {}).mode,
      });
    }
    if (!running && this._lastResult) {
      this._postTo(source, {
        type: 'result',
        requestId: (this._lastResult.meta && this._lastResult.meta.requestId) || null,
        adopt: true,
        result: this._lastResult.result,
        meta: this._lastResult.meta,
        historyId: this._lastResult.historyId,
      });
    }
    if (this._pendingScreen) {
      const screen = this._pendingScreen;
      this._pendingScreen = null;
      this._postTo(source, { type: 'screen', screen, adopt: true });
    }
    return undefined;
  }

  // ---- message routing ---------------------------------------------------

  async _onMessage(message, source) {
    if (!message || typeof message.type !== 'string') return;
    try {
      switch (message.type) {
        case 'ready':
          return await this._bootstrap(source);
        case 'explain':
          return await this._run(message);
        case 'followup':
          return await this._followUp(message);
        case 'cancel':
          return this._ledger.cancelAll('You cancelled the request.');
        case 'refreshContext':
          return await this._postContextState();
        case 'saveSettings':
          return await this._saveSettings(message);
        case 'probe':
          return await this._probe(message);
        case 'patchPreferences':
          return await this._patchPreferences(message.patch || {});
        case 'updateAdvanced':
          return await this._updateAdvanced(message.key, message.value);
        case 'refreshModels':
          return await this._refreshModels(message.providerId);
        case 'audit':
          return await this._runAudit(message);
        case 'auditClear':
          this._services.audit.clearDiagnostics();
          return this._post({ type: 'audit.cleared' });
        case 'history':
          return await this._history(message);
        case 'openFile':
          return this._openFile(message.path, message.line);
        case 'copy':
          return vscode.env.clipboard.writeText(String(message.text || ''));
        case 'applyCode':
          return await this._applyCode(String(message.code || ''));
        case 'open':
          return this._openUrl(String(message.url || ''));
        case 'showSetup':
          return this._post({ type: 'screen', screen: 'setup' });
        case 'openSettings':
          // Reuse the contributed command rather than a second copy of the target id,
          // so the real-window check that resolves delegated commands covers this path.
          return vscode.commands.executeCommand('explainItSimply.openSettings');
        default:
          return this._post({
            type: 'error',
            error: { code: 'VALIDATION_ERROR', message: `Unknown command '${message.type}'.`, recovery: 'none', hint: 'The panel and extension are out of step; reload the window.' },
          });
      }
    } catch (error) {
      this._services.logger.appendLine(`panel.fail ${error && error.message}`);
      return this._post({
        type: 'error',
        error: { code: 'UNKNOWN_ERROR', message: 'The extension hit an unexpected error.', recovery: 'retry', hint: 'See the Explain It Simply output channel for details.' },
      });
    }
  }

  async _run(message) {
    const mode = message.mode || (message.subject ? 'clipboard' : 'selection');
    const captured = mode === 'clipboard'
      ? {
        subject: String(message.subject || ''),
        language: String(message.language || ''),
        fileName: '',
        cursorLine: null,
        fullDocument: '',
        diagnostics: '',
      }
      : this._capture(mode);

    if (!captured || !String(captured.subject || '').trim()) {
      return this._post({
        type: 'error',
        requestId: null,
        error: {
          code: 'VALIDATION_ERROR',
          message: mode === 'selection'
            ? 'Select some code first — or switch to the Topic tab and type a question.'
            : mode === 'function'
              ? 'No function found around the cursor. Select the code you mean instead.'
              : 'There is nothing open to explain.',
          hint: 'Pick something to explain, then ask again.',
          recovery: 'none',
        },
      });
    }

    this._lastRequest = { task: message.task, depth: message.depth, mode };
    const token = this._ledger.begin(`${message.task}:${message.depth || 'auto'}`);
    const buffer = message.stream ? { parts: [] } : null;

    this._post({ type: 'started', requestId: token.id, task: message.task, depth: message.depth || null, mode });

    const outcome = await this._services.ai.explain({
      task: message.task,
      input: captured,
      depth: message.depth,
      token,
      onDelta: message.stream ? (piece) => this._post({ type: 'delta', requestId: token.id, text: piece }) : null,
    });

    if (buffer) void buffer;
    if (outcome.cancelled) return this._post({ type: 'cancelled', requestId: token.id });
    if (!outcome.ok) return this._post({ type: 'error', requestId: token.id, error: outcome.error });

    this._lastResult = outcome;
    return this._post({
      type: 'result',
      requestId: token.id,
      result: outcome.result,
      meta: outcome.meta,
      historyId: outcome.historyId,
      durationMs: outcome.durationMs,
    });
  }

  async _followUp(message) {
    // Follow-ups reuse the previous subject so "go deeper" does not require the
    // user to reselect code.
    const task = message.task || (this._lastRequest && this._lastRequest.task);
    const depth = message.depth || (this._lastRequest && this._lastRequest.depth);
    if (!this._lastRequest && !message.subject) {
      return this._post({ type: 'error', error: { code: 'VALIDATION_ERROR', message: 'Explain something first, then use the follow-up actions.', recovery: 'none', hint: 'Select code or ask a topic question.' } });
    }
    return this._run({
      task,
      depth,
      mode: message.subject ? 'clipboard' : (message.mode || (this._lastRequest || {}).mode || 'selection'),
      subject: message.subject,
      stream: true,
    });
  }

  async _saveSettings(message) {
    try {
      await this._services.ai.saveSettings({
        providerId: message.providerId,
        model: message.model,
        apiKey: message.apiKey,
        depth: message.depth,
        proseLanguage: message.proseLanguage,
      });
      const catalog = await this._services.ai.catalog();
      this._post({ type: 'settings.saved', catalog, providerId: message.providerId });
      this._post({ type: 'screen', screen: 'main' });
      await this.runPendingIntent();
    } catch (error) {
      this._post({ type: 'error', error: this._services.ai._toFailure(error, { apiKey: message.apiKey, providerId: message.providerId, model: message.model }) });
    }
  }

  async _probe(message) {
    const result = await this._services.ai.probeConfiguration({
      providerId: message.providerId,
      model: message.model,
      apiKey: message.apiKey,
    });
    this._post({ type: 'probe.result', providerId: message.providerId, model: message.model, ...result });
  }

  async _patchPreferences(patch) {
    const preferences = await this._services.settings.patch(patch);
    this._post({ type: 'settings.saved', catalog: await this._services.ai.catalog(), preferences });
  }

  // Only these keys may be written from the webview; anything else is refused so
  // a compromised panel cannot rewrite arbitrary VS Code settings.
  static WRITABLE = [
    'context.surrounding',
    'context.currentFile',
    'context.maxCharacters',
    'ai.requestTimeoutSeconds',
    'ai.maxRetries',
    'ai.structuredOutput',
    'privacy.saveHistory',
    'privacy.codeRetention',
    'privacy.historyLimit',
    'audit.maxFiles',
    'audit.aiFiles',
    'audit.maxSendChars',
    'audit.showDiagnostics',
  ];

  async _updateAdvanced(key, value) {
    if (!ExplainPanel.WRITABLE.includes(key)) {
      this._post({ type: 'error', error: { code: 'VALIDATION_ERROR', message: `Setting '${key}' cannot be changed from the panel.`, recovery: 'none' } });
      return;
    }
    const config = vscode.workspace.getConfiguration('explainItSimply');
    await config.update(key, value, vscode.ConfigurationTarget.Global);
    this._post({ type: 'settings.saved', catalog: await this._services.ai.catalog(), advanced: this._services.settings.advanced });
  }

  async _refreshModels(providerId) {    const result = await this._services.ai.refreshModels(providerId);
    this._post({ type: 'models.refreshed', providerId: providerId || this._services.settings.preferences.providerId, ...result });
  }

  async _history(message) {
    const service = this._services.history;
    switch (message.action) {
      case 'list': {
        const items = await service.list({ query: message.query || '' });
        this._post({ type: 'history.list', items: items.map(toListItem), historyBytes: service.sizeBytes() });
        return undefined;
      }
      case 'open': {
        const entry = await service.get(message.id);
        if (!entry) {
          this._post({ type: 'error', error: { code: 'VALIDATION_ERROR', message: 'That history entry is no longer stored.', recovery: 'none' } });
          return undefined;
        }
        this._post({ type: 'result', requestId: `history:${entry.id}`, adopt: true, result: entry.result, meta: { provider: entry.provider, model: entry.model, depth: entry.depth, task: entry.task, requestId: entry.id, fromHistory: true, context: { manifest: (entry.contextParts || []).map((part) => ({ part })) } } });
        return undefined;
      }
      case 'pin':
        await service.setPinned(message.id, !!message.pinned);
        break;
      case 'delete':
        await service.remove(message.id);
        break;
      case 'clear':
        await service.clear({ keepPinned: !!message.keepPinned });
        break;
      default:
        return undefined;
    }
    const items = await service.list({});
    this._post({ type: 'history.list', items: items.map(toListItem), historyBytes: service.sizeBytes() });
  }

  async _applyCode(code) {
    if (!code.trim()) return undefined;
    const target = this._lastTarget;
    if (!target || !target.range || !target.range.start || !target.range.end) {
      this._post({ type: 'error', error: { code: 'VALIDATION_ERROR', message: 'Nothing to replace — the code you explained is no longer open.', recovery: 'none' } });
      return undefined;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(target.uri, target.range, code);
    const applied = await vscode.workspace.applyEdit(edit);
    this._post({ type: 'apply.result', ok: applied, message: applied ? 'Replaced the selection. Undo with Ctrl+Z.' : 'Could not apply the change.' });
  }

  // A finding's file path comes from the analyzer, but treat it as untrusted:
  // anything outside the opened workspace folders is refused.
  async _openFile(relativePath, line) {
    const folders = vscode.workspace.workspaceFolders || [];
    if (!folders.length || typeof relativePath !== 'string' || !relativePath.trim()) {
      this._post({ type: 'error', error: { code: 'VALIDATION_ERROR', message: 'No workspace folder is open, so the file cannot be shown.', recovery: 'none' } });
      return;
    }
    const cleaned = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
    if (cleaned.split('/').includes('..')) {
      this._post({ type: 'error', error: { code: 'VALIDATION_ERROR', message: 'That audit path is outside the workspace.', recovery: 'none' } });
      return;
    }
    for (const folder of folders) {
      const candidate = vscode.Uri.joinPath(folder.uri, ...cleaned.split('/'));
      try {
        await vscode.workspace.fs.stat(candidate);
        const document = await vscode.workspace.openTextDocument(candidate);
        const target = Math.max(0, (Number(line) || 1) - 1);
        await vscode.window.showTextDocument(document, {
          selection: new vscode.Range(target, 0, target, 0),
          preview: true,
        });
        return;
      } catch (error) {
        // try the next workspace folder
      }
    }
    this._post({ type: 'error', error: { code: 'VALIDATION_ERROR', message: `Could not find '${cleaned}' in the open workspace.`, recovery: 'none' } });
  }

  _openUrl(url) {
    // Only the provider key pages the registry knows about.
    const allowed = registry.listProviders().map((provider) => provider.keyUrl);
    if (!allowed.includes(url)) {
      this._post({ type: 'error', error: { code: 'VALIDATION_ERROR', message: 'That link is not on the allowed list.', recovery: 'none' } });
      return;
    }
    vscode.env.openExternal(vscode.Uri.parse(url));
  }

  // Commands enter here so an audit started from the editor menu still surfaces
  // its result in the panel.
  async requestAudit(options = {}) {
    return this._runAudit(options);
  }

  async _runAudit(message = {}) {
    if (this._auditing) {
      this._post({ type: 'audit.busy' });
      return undefined;
    }
    const scope = message.scope || 'workspace';
    let target = message.target;
    if (scope === 'file' && !(target && (target.fsPath || target.path))) {
      // The webview has no idea which file is open, so "audit this file" without a
      // target would silently fall through to the whole workspace and spend the key
      // across every file. Resolve it here, from the editor the reader is looking at.
      const editor = this._editor;
      if (!editor) {
        this._post({
          type: 'error',
          error: { code: 'VALIDATION_ERROR', message: 'No file is open to audit.', hint: 'Open a file, then use Audit Current File.', recovery: 'none' },
        });
        return undefined;
      }
      target = editor.document.uri;
    }
    const token = this._ledger.begin(`audit:${scope}`);
    this._auditing = true;
    this._post({
      type: 'audit.started',
      requestId: token.id,
      scope,
      aiFiles: message.aiFiles,
    });
    try {
      const report = await this._services.audit.audit({
        scope,
        target,
        aiFiles: message.aiFiles,
        token: { signal: token.signal, isCurrent: token.isCurrent },
      });
      if (!token.isCurrent()) return this._post({ type: 'audit.cancelled', requestId: token.id });
      return this._post({ type: 'audit.result', requestId: token.id, report });
    } catch (error) {
      this._services.logger.appendLine(`audit.fail ${error && error.message}`);
      return this._post({
        type: 'error',
        requestId: token.id,
        error: { code: 'UNKNOWN_ERROR', message: 'The audit could not finish. See the output channel for details.', recovery: 'retry', hint: 'Audit failed part way through.' },
      });
    } finally {
      this._auditing = false;
    }
  }

  showSetupWizard() {
    // The webview has not loaded yet when a command asks for setup, and messages
    // sent before its own 'ready' are lost. Remember the screen; _bootstrap replays it.
    this._pendingScreen = 'setup';
    this._post({ type: 'screen', screen: 'setup' });
  }

  // Command entry point. Modes that need typed input ask the panel for it
  // instead of inventing a subject.
  async requestExplain({ task, mode = 'selection', depth, pendingWithoutKey = false }) {
    if (mode === 'prompt' || mode === 'selectionOrPrompt') {
      const captured = mode === 'selectionOrPrompt' ? this._capture('selection') : null;
      if (captured && captured.subject.trim()) {
        return this._run({ task, mode: 'selection', depth, stream: true });
      }
      if (pendingWithoutKey) this._pendingIntent = { task, mode, depth };
      return this._post({
        type: 'request-input',
        task,
        depth,
        reason: mode === 'selectionOrPrompt' ? 'nothing selected' : 'topic question needed',
      });
    }
    if (pendingWithoutKey) {
      // Remember the intent so finishing setup runs it immediately.
      this._pendingIntent = { task, mode, depth };
      return undefined;
    }
    return this._run({ task, mode, depth, stream: true });
  }

  async runPendingIntent() {
    const intent = this._pendingIntent;
    if (!intent) return undefined;
    this._pendingIntent = null;
    return this._run({ ...intent, stream: true });
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._ledger.cancelAll('The panel was closed.');
    if (ExplainPanel.current === this) ExplainPanel.current = undefined;
    // A dead hub must not keep owning the sidebar view.
    ExplainPanel.sideWebview = undefined;
    for (const subscription of this._surfaceListeners.values()) subscription.dispose();
    this._surfaceListeners.clear();
    this._surfaces.clear();
    while (this._disposables.length) {
      const item = this._disposables.pop();
      if (item && typeof item.dispose === 'function') item.dispose();
    }
  }
}

function toListItem(entry) {
  return {
    id: entry.id,
    title: entry.title,
    excerpt: entry.excerpt,
    task: entry.task,
    kind: entry.kind,
    depth: entry.depth,
    provider: entry.provider,
    model: entry.model,
    savedAt: entry.savedAt,
    pinned: !!entry.pinned,
    hasSubject: !!entry.subject,
    contextParts: entry.contextParts || [],
  };
}

module.exports = { ExplainPanel, VIEW_TYPE, SIDE_VIEW_ID, SIDE_CONTAINER_COMMAND };
