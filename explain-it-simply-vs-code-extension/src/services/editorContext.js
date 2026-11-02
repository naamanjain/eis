'use strict';
// Reads what the editor actually has: selection, the function under the caret,
// the whole file, or the diagnostics on the current line. Only this module talks
// to the VS Code text APIs for input gathering.

const { enclosingBlock } = require('../shared/context/contextEngine');

const MODES = ['selection', 'function', 'file', 'error', 'clipboard'];

function lineOf(editor) {
  return editor && editor.selection && editor.selection.active ? editor.selection.active.line : 0;
}

function diagnosticsNear(vscode, document, line) {
  const all = vscode.languages.getDiagnostics(document.uri) || [];
  const relevant = all.filter((entry) => {
    if (entry.severity === vscode.DiagnosticSeverity?.Information) return false;
    const startLine = entry.range?.start?.line ?? 0;
    const endLine = entry.range?.end?.line ?? startLine;
    return line >= startLine - 1 && line <= endLine + 1;
  });
  return relevant.map((entry) => {
    const where = entry.range ? `line ${entry.range.start.line + 1}` : 'file';
    const code = entry.code ? ` [${typeof entry.code === 'object' ? entry.code.value : entry.code}]` : '';
    return `${where}: ${entry.message}${code}`;
  });
}

function hasDiagnostics(vscode, editor) {
  if (!editor) return false;
  const entries = vscode.languages.getDiagnostics(editor.document.uri) || [];
  return entries.some((entry) => entry.severity !== vscode.DiagnosticSeverity?.Hint);
}

// Explicitly bounded: a 2 MB file is not silently forwarded.
const MAX_DOCUMENT_CHARS = 400_000;

function fromEditor(vscode, editor, mode = 'selection') {
  if (!editor || !editor.document) return null;
  const document = editor.document;
  const fullDocument = document.getText().length > MAX_DOCUMENT_CHARS
    ? `${document.getText().slice(0, MAX_DOCUMENT_CHARS)}\n// …file truncated for reading…`
    : document.getText();
  const language = document.languageId || '';
  const fileName = document.fileName.split(/[\\/]/).pop();
  const cursorLine = lineOf(editor);
  const selection = editor.selection;
  const selectedText = selection && !selection.isEmpty ? document.getText(selection) : '';

  let subject = '';
  switch (mode) {
    case 'selection':
      subject = selectedText;
      break;
    case 'function': {
      if (selectedText.trim()) {
        subject = selectedText;
        break;
      }
      const block = enclosingBlock(fullDocument, cursorLine, language);
      if (block) {
        subject = fullDocument.replace(/\r\n/g, '\n').split('\n').slice(block.start, block.end + 1).join('\n');
      }
      break;
    }
    case 'file':
      subject = fullDocument;
      break;
    case 'error': {
      const messages = diagnosticsNear(vscode, document, cursorLine);
      if (messages.length) {
        subject = messages.join('\n');
        break;
      }
      subject = selectedText; // no diagnostic: explain what is highlighted instead
      break;
    }
    default:
      subject = selectedText;
  }

  return {
    subject: subject || '',
    language,
    fileName,
    cursorLine,
    fullDocument: mode === 'file' ? '' : fullDocument,
    diagnostics: mode === 'error' ? subject : '',
    uri: document.uri.toString(),
    isEmptyFile: mode === 'file' && !fullDocument.trim(),
  };
}

module.exports = { MODES, MAX_DOCUMENT_CHARS, fromEditor, hasDiagnostics, diagnosticsNear, lineOf };
