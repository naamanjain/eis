#!/usr/bin/env node
'use strict';
/* Launch a real, disposable VS Code window and run src/test/realWindow.js inside its
 * extension host. Node built-ins only; nothing is installed.
 *
 *   npm run check:vscode
 *
 * Isolated profile + extension dir, so the developer's own VS Code state is untouched.
 * A window opens on screen for a few seconds; that is the test running.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const EXT_DIR = path.join(ROOT, 'explain-it-simply-vs-code-extension');
const SUITE = path.join(EXT_DIR, 'src', 'test', 'realWindow.js');
const RUN_ID = `eis-vscode-window-${process.pid}`;
const BASE = path.join(os.tmpdir(), RUN_ID);
const PROFILE = path.join(BASE, 'profile');
const EXTS = path.join(BASE, 'extensions');
const WS = path.join(BASE, 'workspace');
const TIMEOUT_MS = Number(process.env.EIS_VSCODE_TIMEOUT_MS || 180000);

function findCode() {
  const candidates = [];
  if (process.env.EIS_CODE_BIN) candidates.push(process.env.EIS_CODE_BIN);
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    candidates.push(
      path.join(local, 'Programs', 'Microsoft VS Code', 'Code.exe'),
      path.join(pf, 'Microsoft VS Code', 'Code.exe'),
    );
    // where.exe is a real binary, so no shell is needed (and none of the path
    // quoting that a shell would introduce).
    const which = spawnSync('where.exe', ['code'], { encoding: 'utf8' });
    for (const line of String(which.stdout || '').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) candidates.push(path.resolve(path.dirname(trimmed), '..'));
    }
  } else {
    candidates.push('/Applications/Visual Studio Code.app/Contents/MacOS/Electron', '/usr/bin/code', '/snap/bin/code');
  }
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

function writeFixture() {
  // A credential-shaped string that cannot be a real key, and one unguarded parse.
  const planted = 'AIza' + 'F'.repeat(35);
  fs.writeFileSync(
    path.join(WS, 'demo.js'),
    [
      'export function loadConfig(raw) {',
      `  const apiKey = '${planted}';`,
      '  const parsed = JSON.parse(raw);',
      '  return { apiKey, parsed };',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  return planted;
}

function main() {
  const fromPackage = process.argv.includes('--from-package');
  const code = findCode();
  if (!code) {
    console.log('EISFAIL driver :: no VS Code executable found (set EIS_CODE_BIN)');
    console.log('EISDONE');
    process.exitCode = 1;
    return;
  }
  for (const dir of [PROFILE, EXTS, WS]) fs.mkdirSync(dir, { recursive: true });
  writeFixture();

  // Which copy runs: the working tree, or the files inside the packaged .vsix.
  let extensionPath = EXT_DIR;
  let mode = 'development path (working tree)';
  if (fromPackage) {
    const vsix = fs.readdirSync(EXT_DIR).filter((name) => name.endsWith('.vsix')).sort().at(-1);
    if (!vsix) {
      console.log('EISFAIL driver :: no .vsix found, run npm run package:ext first');
      console.log('EISDONE');
      process.exitCode = 1;
      return;
    }
    const staged = path.join(BASE, 'package');
    const unzipped = path.join(staged, 'x');
    fs.mkdirSync(staged, { recursive: true });
    const zip = path.join(staged, 'pkg.zip');
    fs.copyFileSync(path.join(EXT_DIR, vsix), zip);
    // A .vsix is a zip; PowerShell is the only archive tool guaranteed on Windows.
    const expand = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${unzipped}' -Force`,
    ], { encoding: 'utf8', timeout: 120000 });
    if (expand.status !== 0) {
      console.log(`EISFAIL driver :: cannot open ${vsix} :: ${String(expand.stderr || '').slice(0, 200)}`);
      console.log('EISDONE');
      process.exitCode = 1;
      return;
    }
    extensionPath = path.join(unzipped, 'extension');
    // Fail loudly on a missing file rather than letting the suite report a mystery crash.
    const required = [
      'package.json', 'README.md', 'src/extension.js', 'src/panel.js', 'src/sidePanel.js',
      'webview/client.js', 'webview/styles.css', 'resources/sidebar.svg',
      'src/shared/index.js', 'src/shared/providers/registry.js', 'src/shared/audit/localFindings.js',
    ];
    const missing = required.filter((rel) => !fs.existsSync(path.join(extensionPath, rel)));
    if (missing.length) {
      console.log(`EISFAIL driver :: ${vsix} is missing ${missing.join(', ')}`);
      console.log('EISDONE');
      process.exitCode = 1;
      return;
    }
    if (fs.existsSync(path.join(extensionPath, 'src', 'test'))) {
      console.log('EISFAIL driver :: the .vsix ships src/test (excluded in .vscodeignore?)');
      console.log('EISDONE');
      process.exitCode = 1;
      return;
    }
    mode = `packaged artifact (${vsix})`;
  }
  const args = [
    `--user-data-dir=${PROFILE}`,
    `--extensions-dir=${EXTS}`,
    '--disable-extensions',
    '--disable-workspace-trust',
    '--skip-release-notes',
    '--disable-updates',
    `--extensionDevelopmentPath=${extensionPath}`,
    `--extensionTestsPath=${SUITE}`,
    WS,
  ];
  console.log(`# running the suite against: ${mode}`);
  console.log(`# ${code}`);
  console.log(`# profile=${BASE}`);

  const childEnv = { ...process.env, EIS_KEEP_PROFILE: BASE };
  // Electron honours ELECTRON_RUN_AS_NODE: with it set, Code.exe is a plain Node binary and rejects
  // every app flag with "bad option", then exits 9. Agents and Electron-packaged callers export it,
  // so the suite must not inherit it — and the failure below prints the reason, because silently
  // reporting "window exited early" hides exactly this class of environment problem.
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(code, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv });
  let buffer = '';
  let done = false;
  const results = [];
  const diagnostics = [];

  const handle = (chunk) => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      if (line.startsWith('EIS')) {
        console.log(line);
        if (/^EIS(PASS|FAIL|RESULT|DONE)/.test(line)) results.push(line);
        if (line === 'EISDONE') {
          done = true;
          // The window quits itself once the test path returns; only force it if it
          // hangs, so a slow-but-clean run is not reported as a failure.
          setTimeout(() => {
            if (child.exitCode === null) {
              if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
              else { try { child.kill(); } catch (error) { /* gone */ } }
            }
          }, 15000).unref();
        }
      } else if (diagnostics.length < 12) {
        // Everything the editor writes that is not a marker. Kept for the failure report only,
        // so a run that never started can say why instead of reporting an empty pass count.
        diagnostics.push(line);
      }
    }
  };
  child.stdout.on('data', handle);
  child.stderr.on('data', handle);

  const finish = (reason) => {
    if (finish.done) return;
    finish.done = true;
    clearTimeout(timer);
    try { process.kill(-child.pid); } catch (error) { /* windows */ }
    const passed = results.filter((line) => line.startsWith('EISPASS')).length;
    const failed = results.filter((line) => line.startsWith('EISFAIL')).length;
    console.log(`# ${reason}: ${passed} passed, ${failed} failed (${results.length} markers)`);
    if (!done) console.log('EISFAIL driver :: the suite never reported EISDONE');
    if (!done && diagnostics.length) {
      console.log('# what the editor said instead (first lines, non-marker output):');
      for (const line of diagnostics) console.log(`#   ${line}`);
    }
    if (!process.env.EIS_KEEP) fs.rmSync(BASE, { recursive: true, force: true, maxRetries: 3 });
    else console.log(`# kept at ${BASE}`);
    process.exitCode = done && failed === 0 ? 0 : 1;
  };

  const timer = setTimeout(() => finish(`timeout after ${TIMEOUT_MS}ms`), TIMEOUT_MS);
  child.on('exit', (code) => finish(done ? `suite reported, window closed (exit ${code})` : `window exited early (exit ${code})`));
}

main();
