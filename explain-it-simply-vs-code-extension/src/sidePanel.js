'use strict';
// Activity Bar surface. VS Code owns the view's lifecycle; this hands the resolved
// webview to the shared panel hub, so the sidebar and the editor panel show the same
// state rather than two independent copies of the UI.

const vscode = require('vscode');
const { ExplainPanel } = require('./panel');

class SidePanelProvider {
  constructor(context, services) {
    this._context = context;
    this._services = services;
  }

  resolveWebviewView(view) {
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._context.extensionUri, 'webview')],
    };
    const hub = ExplainPanel.attachSideView(view, this._context, this._services);
    // A view can be hidden and shown again without being rebuilt; the editor context
    // may have moved on while it was collapsed.
    view.onDidChangeVisibility(() => {
      if (view.visible) hub._postContextState();
    });
  }
}

module.exports = { SidePanelProvider };
