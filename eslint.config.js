'use strict';
// ESLint flat config. Deliberately small: the goal is catching real errors in a
// dependency-free codebase, not restyling it. Rules were added only where they flag a
// defect class this repository has actually hit, and no rule is switched off wholesale.
//
//   npm run lint
//
// The vendored mirror under explain-it-simply-vs-code-extension/src/shared is excluded:
// it is a byte copy of shared/ guarded by `npm run vendor:check`, so linting it twice
// would double the noise without widening coverage.

const js = require('@eslint/js');

const nodeGlobals = {
  require: 'readonly',
  module: 'writable',
  exports: 'writable',
  process: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  Buffer: 'readonly',
  console: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  globalThis: 'readonly',
  global: 'readonly',
  structuredClone: 'readonly',
  // Node 18+ / 21+ ship these as real globals; the http client and the CDP probe use them.
  WebSocket: 'readonly',
  TextDecoder: 'readonly',
  TextEncoder: 'readonly',
  performance: 'readonly',
};

const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  getComputedStyle: 'readonly',
  MessageEvent: 'readonly',
  Event: 'readonly',
  requestAnimationFrame: 'readonly',
  acquireVsCodeApi: 'readonly',
  fetch: 'readonly',
  localStorage: 'readonly',
  sessionStorage: 'readonly',
  matchMedia: 'readonly',
};

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'out/**',
      'dist/**',
      '**/*.vsix',
      'explain-it-simply-vs-code-extension/src/shared/**',
      'coverage/**',
      '**/*.min.js',
    ],
  },
  {
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
      globals: nodeGlobals,
    },
    rules: {
      // Spread first. Writing `rules: { … }` alone REPLACES the recommended set rather than
      // adding to it — a mistake that silently dropped ~30 checks (no-cond-assign,
      // no-sparse-arrays, valid-typeof, use-isnan and the rest) while the config still looked
      // like it enabled recommended. The Phase 2 diff review caught it by probing a file that
      // should have failed.
      ...js.configs.recommended.rules,
      // Errors this repository has actually been bitten by.
      'no-undef': 'error',
      'no-unused-vars': ['error', { args: 'after-used', caughtErrors: 'none', ignoreRestSiblings: true, argsIgnorePattern: '^_' }],
      // A missing await on an async assertion is the classic way a check passes while
      // testing nothing.
      'no-async-promise-executor': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-fallthrough': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-else-if': 'error',
      'no-self-compare': 'error',
      'no-unsafe-negation': 'error',
      'no-unsafe-optional-chaining': 'error',
      // The verification harness is the only code allowed to build a function from a
      // string; everywhere else it is the pattern that turns data into code.
      'no-new-func': 'error',
      'no-return-await': 'off',
      strict: ['error', 'global'],
    },
  },
  {
    // The webview client and the browser bundle run without Node and talk to the VS Code
    // host through acquireVsCodeApi().
    files: [
      'explain-it-simply-vs-code-extension/webview/**/*.js',
      'explain-it-simply-website/public/**/*.js',
    ],
    languageOptions: {
      sourceType: 'script',
      globals: { ...browserGlobals, ...nodeGlobals },
    },
    rules: {
      // These files are served as classic scripts, so each one opens its whole body with
      // `'use strict'` inside its IIFE rather than at file scope. That keeps strictness
      // with the code it applies to and does not leak into sibling scripts on the page,
      // which is the intended pattern here — not a defect to report.
      strict: 'off',
    },
  },
  {
    // The in-host suite is loaded by VS Code's extension host, not by a browser.
    files: ['explain-it-simply-vs-code-extension/src/test/**/*.js'],
    languageOptions: { globals: { ...nodeGlobals, vscode: 'readonly' } },
  },
  {
    // The offline verification harness loads webview/client.js by evaluating its source
    // against a fake DOM, which is the only way to assert on rendered state without a
    // browser. The string is read from this repository's own tracked file, never from
    // user input, so the exemption is scoped to scripts/ and nothing else.
    files: ['scripts/**/*.js'],
    rules: { 'no-new-func': 'off' },
  },
];
