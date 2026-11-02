'use strict';
// Assembles the panel HTML. The UI lives in ../../webview/ as real files
// (styles.css, client.js) loaded through asWebviewUri, so there is no nested
// template literal to escape and the webview can run a strict CSP with no
// inline scripts.

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const ASSET_DIR = path.join(__dirname, '..', '..', 'webview');

function getWebviewContent(webview, context) {
  const root = context.extensionUri ? context.extensionUri : vscode.Uri.file(path.join(__dirname, '..', '..'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(root, 'webview', 'styles.css'));
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(root, 'webview', 'client.js'));
  const cspSource = webview.cspSource;

  // Verify the assets exist at build time rather than shipping a blank panel.
  for (const file of ['styles.css', 'client.js']) {
    if (!fs.existsSync(path.join(ASSET_DIR, file))) {
      throw new Error(`webview asset missing: webview/${file}`);
    }
  }

  const policy = [
    `default-src 'none'`,
    // 'unsafe-inline' for styles is required, not careless: webview/client.js renders 23 inline
    // `style` attributes through el(), and CSP3 has no nonce-less way to allow a style attribute.
    // The workbench also injects its own theme <style> block into every webview. Scripting is
    // protected a different way — there is no inline script at all — so script-src below stays
    // clean. Removing this allowance means moving those 23 declarations into classes in
    // styles.css, which is real work, not a config change.
    `style-src ${cspSource} 'unsafe-inline'`,
    `script-src ${cspSource}`,
    `font-src ${cspSource}`,
    `img-src ${cspSource} data:`,
    // The client renders text nodes and posts messages through acquireVsCodeApi(); it opens
    // no fetch, XMLHttpRequest, WebSocket or EventSource. So it needs no network at all, and
    // 'none' is asserted by a gate rather than left as an allowance nobody claimed.
    `connect-src 'none'`,
    // base-uri and form-action are not covered by default-src, so they are stated. A <base>
    // tag would repath every relative URI in the document, and a form would POST somewhere.
    `base-uri 'none'`,
    `form-action 'none'`,
    `object-src 'none'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${policy}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="dark light">
<title>Explain It Simply</title>
<link rel="stylesheet" href="${styleUri}">
</head>
<body>
<div id="app"></div>
<noscript><p>Explain It Simply needs JavaScript enabled in the webview.</p></noscript>
<script src="${scriptUri}"></script>
</body>
</html>`;
}

module.exports = { getWebviewContent, ASSET_DIR };
