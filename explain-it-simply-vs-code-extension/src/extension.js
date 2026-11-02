'use strict';
// Activation and command wiring. Commands only decide *what* to explain; the
// panel and services decide how. Nothing here touches providers or prompts.

const vscode = require('vscode');
const fs = require('fs');
const { ExplainPanel, SIDE_VIEW_ID, SIDE_CONTAINER_COMMAND } = require('./panel');
const { SidePanelProvider } = require('./sidePanel');
const { SettingsManager } = require('./state/settings');
const { ExplainService } = require('./services/aiService');
const { HistoryService } = require('./services/historyService');
const { ProjectAuditService } = require('./services/projectAudit');
const { hasDiagnostics } = require('./services/editorContext');

const CONTEXT_HAS_DIAGNOSTIC = 'explainItSimply.hasDiagnostic';
const CONTEXT_HAS_SELECTION = 'explainItSimply.hasSelection';
const CONTEXT_HAS_WORKSPACE = 'explainItSimply.hasWorkspace';

function activate(context) {
  const logger = createLogger(context);
  const settings = new SettingsManager(context, SettingsManager.workspaceConfiguration(vscode));
  const history = new HistoryService(context, settings);
  const ai = new ExplainService({ settings, history, logger });
  const diagnostics = vscode.languages.createDiagnosticCollection('explain-it-simply');
  context.subscriptions.push(diagnostics);
  const audit = new ProjectAuditService({
    vscode,
    workspace: vscode.workspace,
    fs: { readFile: (file) => Promise.resolve(fs.readFileSync(file)), statSync: (file) => fs.statSync(file) },
    settings,
    ai,
    logger,
    stateStore: context.workspaceState,
    diagnosticsCollection: diagnostics,
  });
  const services = { settings, history, ai, audit, logger };

  const open = () => ExplainPanel.createOrShow(context, services);

  // The Activity Bar entry. VS Code resolves the view the first time it is shown,
  // and the hub then treats it as one more surface for the same state.
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SIDE_VIEW_ID, new SidePanelProvider(context, services), {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  function workspaceRoot() {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length ? folders[0] : null;
  }

  // One entry point per command: open the panel, then ask it to run a task.
  const run = async (task, mode, extra = {}) => {
    const panel = open();
    if (!settings.isConfigured() || !(await settings.getApiKey(settings.preferences.providerId))) {
      panel.showSetupWizard();
      panel.requestExplain({ task, mode, ...extra, pendingWithoutKey: true });
      return;
    }
    await panel.requestExplain({ task, mode, ...extra });
  };

  const commands = [
    ['explainItSimply.auditProject', async (options = {}) => {
      const panel = open();
      if (!workspaceRoot()) {
        vscode.window.showErrorMessage('Explain It Simply: open a folder to audit a project.');
        return undefined;
      }
      return panel.requestAudit({ scope: 'workspace', ...options });
    }, 'Audit Project (findings stay local; only a few files are sent)'],
    ['explainItSimply.auditFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('Explain It Simply: no active file to audit.');
        return undefined;
      }
      const panel = open();
      return panel.requestAudit({ scope: 'file', target: editor.document.uri });
    }, 'Audit Current File'],
    ['explainItSimply.clearAuditDiagnostics', () => {
      audit.clearDiagnostics();
      vscode.window.showInformationMessage('Explain It Simply: audit markers cleared.');
    }, 'Clear Audit Markers'],
    ['explainItSimply.openPanel', () => open(), 'Open Explain It Simply'],
    ['explainItSimply.openSidePanel', () => vscode.commands.executeCommand(SIDE_CONTAINER_COMMAND), 'Open Explain It Simply in Sidebar'],
    ['explainItSimply.openPanelInEditor', () => ExplainPanel.createOrShowEditor(context, services), 'Open Explain It Simply in Editor Area'],
    ['explainItSimply.explainSelection', () => run('explain-code', 'selection'), 'Explain Selection'],
    ['explainItSimply.explainFunction', () => run('explain-code', 'function'), 'Explain Function'],
    ['explainItSimply.explainFile', () => run('explain-code', 'file'), 'Explain File'],
    ['explainItSimply.explainError', () => run('explain-error', 'error'), 'Explain Error'],
    ['explainItSimply.explainTopic', () => run('explain-topic', 'prompt'), 'Explain a Topic'],
    ['explainItSimply.teachMe', () => run('teach-me', 'selectionOrPrompt'), 'Teach Me'],
    ['explainItSimply.simplifyCode', () => run('simplify', 'function'), 'Simplify Code'],
    ['explainItSimply.findIssues', () => run('find-issues', 'function'), 'Find Issues'],
    ['explainItSimply.optimizeCode', () => run('optimize', 'function'), 'Optimize Code'],
    ['explainItSimply.addComments', () => run('add-comments', 'function'), 'Add Comments'],
    ['explainItSimply.generateTest', () => run('generate-test', 'function'), 'Generate Test'],
    ['explainItSimply.generateExample', () => run('give-example', 'selectionOrPrompt'), 'Generate Example'],
    ['explainItSimply.refreshModels', async () => {
      const result = await ai.refreshModels();
      const models = (result.models || []).filter((model) => !model.fromLiveList);
      vscode.window.showInformationMessage(
        result.ok
          ? `Explain It Simply: ${models.length} verified models for ${result.providerId}.`
          : `Explain It Simply: could not list models — ${result.message}`,
      );
    }, 'Refresh Model List'],
    ['explainItSimply.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:explain-it-simply.explain-it-simply'), 'Open Advanced Settings'],
    ['explainItSimply.resetSettings', async () => {
      await settings.clear();
      vscode.window.showInformationMessage('Explain It Simply: API keys and choices cleared.');
      open().showSetupWizard();
    }, 'Reset API Settings'],
    ['explainItSimply.clearHistory', async () => {
      await history.clear({ keepPinned: true });
      vscode.window.showInformationMessage('Explain It Simply: history cleared (pinned items kept).');
    }, 'Clear History'],
  ];

  for (const [id, handler] of commands) {
    context.subscriptions.push(vscode.commands.registerCommand(id, async (...args) => {
      try {
        await handler(...args);
      } catch (error) {
        logger.appendLine(`command.fail ${id} ${error && error.message}`);
        vscode.window.showErrorMessage(`Explain It Simply: ${error && error.message ? error.message : 'command failed.'}`);
      }
    }));
  }

  // Context keys let the menu show only the commands that can work here.
  const updateContextKeys = () => {
    const editor = vscode.window.activeTextEditor;
    const hasSelection = !!(editor && !editor.selection.isEmpty);
    const diagnostic = hasDiagnostics(vscode, editor);
    vscode.commands.executeCommand('setContext', CONTEXT_HAS_SELECTION, hasSelection);
    vscode.commands.executeCommand('setContext', CONTEXT_HAS_DIAGNOSTIC, diagnostic);
    vscode.commands.executeCommand('setContext', CONTEXT_HAS_WORKSPACE, !!workspaceRoot());
  };
  updateContextKeys();
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(updateContextKeys),
    vscode.window.onDidChangeTextEditorSelection(updateContextKeys),
  );

  // Settings changed in VS Code → the panel's advanced view must refresh.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('explainItSimply')) return undefined;
      if (ExplainPanel.current) ExplainPanel.current._postContextState();
      return undefined;
    }),
  );

  // Deliberately no UI work at activation: the panel opens when asked for.
  // `surfaces()` exists so the real-window suite can prove the sidebar view attached
  // to the same hub instead of a second copy of the UI.
  return {
    services,
    openPanel: open,
    surfaces: () => (ExplainPanel.current ? [...ExplainPanel.current._surfaces] : []),
  };
}

function createLogger(context) {
  const channel = vscode.window.createOutputChannel('Explain It Simply', { log: true });
  context.subscriptions.push(channel);
  return {
    appendLine: (line) => channel.appendLine(line),
    channel,
  };
}

function deactivate() {}

module.exports = { activate, deactivate, CONTEXT_HAS_DIAGNOSTIC, CONTEXT_HAS_SELECTION };
