/* Explain It Simply — webview client.
 *
 * All model-produced text reaches the DOM through el()/textContent, never
 * innerHTML, so a provider reply cannot inject markup. Pure helpers are exposed
 * on globalThis when there is no document, which lets the repo's check script
 * exercise this file in Node.
 */
(function () {
  'use strict';

  const IS_BROWSER = typeof document !== 'undefined' && typeof window !== 'undefined';
  const vscode = IS_BROWSER && typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;

  // ------------------------------------------------------------- pure helpers

  function escapeText(value) {
    return String(value === null || value === undefined ? '' : value);
  }

  const KEYWORDS = new Set([
    'abstract', 'and', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const',
    'continue', 'def', 'default', 'del', 'do', 'else', 'enum', 'export', 'extends', 'false',
    'finally', 'for', 'func', 'function', 'goto', 'if', 'impl', 'import', 'in', 'interface',
    'is', 'let', 'loop', 'match', 'mut', 'new', 'nil', 'none', 'not', 'null', 'or', 'package',
    'pass', 'private', 'public', 'raise', 'readonly', 'return', 'self', 'static', 'struct',
    'super', 'switch', 'this', 'throw', 'trait', 'true', 'try', 'type', 'typeof', 'unsafe',
    'use', 'var', 'void', 'while', 'with', 'yield',
  ]);

  // Small hand-written tokenizer: good enough to separate strings, comments,
  // numbers and keywords without a highlighter dependency in a webview.
  function tokenizeCode(code, language) {
    const src = escapeText(code);
    const hashComments = /^(python|ruby|shell|bash|yaml|r|yml)$/i.test(language || '');
    const tokens = [];
    let buffer = '';
    let i = 0;

    const flush = (type) => {
      if (buffer) tokens.push({ type: type || 'plain', text: buffer });
      buffer = '';
    };

    while (i < src.length) {
      const ch = src[i];
      const two = src.slice(i, i + 2);

      const lineComment = two === '//' || (hashComments && ch === '#');
      if (lineComment) {
        flush();
        const end = src.indexOf('\n', i);
        const stop = end === -1 ? src.length : end;
        tokens.push({ type: 'com', text: src.slice(i, stop) });
        i = stop;
        continue;
      }
      if (two === '/*') {
        flush();
        const end = src.indexOf('*/', i + 2);
        const stop = end === -1 ? src.length : end + 2;
        tokens.push({ type: 'com', text: src.slice(i, stop) });
        i = stop;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        flush();
        let j = i + 1;
        while (j < src.length) {
          if (src[j] === '\\') { j += 2; continue; }
          if (src[j] === ch) { j += 1; break; }
          if (ch !== '`' && src[j] === '\n') break;
          j += 1;
        }
        tokens.push({ type: 'str', text: src.slice(i, j) });
        i = j;
        continue;
      }
      if (/[0-9]/.test(ch) && !/[A-Za-z0-9_$]/.test(src[i - 1] || '')) {
        flush();
        let j = i;
        while (j < src.length && /[0-9a-fxX._]/.test(src[j])) j += 1;
        tokens.push({ type: 'num', text: src.slice(i, j) });
        i = j;
        continue;
      }
      if (/[A-Za-z_$]/.test(ch)) {
        let j = i;
        while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j += 1;
        const word = src.slice(i, j);
        if (KEYWORDS.has(word.toLowerCase())) {
          flush();
          tokens.push({ type: 'key', text: word });
          i = j;
          continue;
        }
        buffer += word;
        i = j;
        continue;
      }
      buffer += ch;
      i += 1;
    }
    flush();
    return tokens;
  }

  function relTime(ts) {
    if (!ts) return '';
    const seconds = Math.floor((Date.now() - Number(ts)) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
    return new Date(Number(ts)).toLocaleDateString();
  }

  function fmtMs(ms) {
    const n = Number(ms) || 0;
    return n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(n < 10000 ? 1 : 0)} s`;
  }

  function fmtChars(n) {
    const value = Number(n) || 0;
    return value < 1000 ? `${value} chars` : `${(value / 1000).toFixed(1)}k chars`;
  }

  function fmtBytes(n) {
    const value = Number(n) || 0;
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
    return `${(value / 1048576).toFixed(1)} MB`;
  }

  // Sections to show, in reading order, skipping anything the answer lacks.
  function sectionsFor(result) {
    const out = [];
    const layer = (value) => !!value && (String(value.body || '').trim() || (value.points || []).length);
    if (String(result.summary || '').trim()) out.push({ key: 'summary', label: 'Summary', kind: 'prose', text: result.summary });
    if (layer(result.simpleExplanation)) out.push({ key: 'simple', label: result.simpleExplanation.heading || 'Explain it simply', tag: 'SIMPLE', kind: 'layer', layer: result.simpleExplanation });
    if (layer(result.technicalExplanation)) out.push({ key: 'tech', label: result.technicalExplanation.heading || 'Technical breakdown', tag: 'TECH', kind: 'layer', layer: result.technicalExplanation });
    if ((result.howItWorks || []).length) out.push({ key: 'how', label: 'How it works', kind: 'list', items: result.howItWorks, ordered: true });
    if ((result.executionFlow || []).length) out.push({ key: 'flow', label: 'Execution flow', kind: 'steps', items: result.executionFlow });
    if ((result.importantLines || []).length) out.push({ key: 'lines', label: 'Important lines', kind: 'lines', items: result.importantLines });
    if ((result.examples || []).length) out.push({ key: 'examples', label: 'Examples', kind: 'code-list', items: result.examples });
    if (result.example && result.example.code) out.push({ key: 'example', label: 'Example', kind: 'code', item: result.example });
    if (result.code) out.push({ key: 'code', label: 'Result', kind: 'code', item: { code: result.code, language: result.language, title: result.summary } });
    if ((result.dependencies || []).length) out.push({ key: 'deps', label: 'Depends on', kind: 'list', items: result.dependencies });
    if ((result.keyConcepts || []).length) out.push({ key: 'concepts', label: 'Key concepts', kind: 'concepts', items: result.keyConcepts });
    if ((result.potentialIssues || []).length) out.push({ key: 'issues', label: 'Potential issues', tag: 'ISSUES', kind: 'issues', items: result.potentialIssues });
    if ((result.improvements || []).length) out.push({ key: 'better', label: 'Improvements', kind: 'list', items: result.improvements });
    if ((result.changes || []).length) out.push({ key: 'changes', label: 'What changed', kind: 'changes', items: result.changes });
    if ((result.notes || []).length) out.push({ key: 'notes', label: 'Notes', kind: 'list', items: result.notes });
    if ((result.risks || []).length) out.push({ key: 'risks', label: 'Risks', tag: 'ISSUES', kind: 'list', items: result.risks });
    if ((result.commonMistakes || []).length) out.push({ key: 'mistakes', label: 'Common mistakes', kind: 'list', items: result.commonMistakes });
    if ((result.whenToUse || []).length) out.push({ key: 'yes', label: 'When to use', kind: 'list', items: result.whenToUse });
    if ((result.whenNotToUse || []).length) out.push({ key: 'no', label: 'When not to use', kind: 'list', items: result.whenNotToUse });
    if (result.complexity) out.push({ key: 'complexity', label: 'Complexity', kind: 'prose', text: result.complexity });
    if (String(result.keyTakeaway || '').trim()) out.push({ key: 'takeaway', label: 'Key takeaway', kind: 'takeaway', text: result.keyTakeaway });
    if ((result.relatedTopics || []).length) out.push({ key: 'related', label: 'Related topics', kind: 'related', items: result.relatedTopics });
    return out;
  }

  const FOLLOWUPS = {
    topic: [
      { label: 'Simpler', task: 'explain-topic', depth: 'quick' },
      { label: 'Go deeper', task: 'explain-topic', depth: 'deep' },
      { label: 'Example', task: 'give-example' },
      { label: 'Teach me', task: 'teach-me' },
    ],
    code: [
      { label: 'Explain function', task: 'explain-code', mode: 'function' },
      { label: 'Find issues', task: 'find-issues', mode: 'function' },
      { label: 'Simplify', task: 'simplify', mode: 'function' },
      { label: 'Optimize', task: 'optimize', mode: 'function' },
      { label: 'Add comments', task: 'add-comments', mode: 'function' },
      { label: 'Generate test', task: 'generate-test', mode: 'function' },
    ],
  };

  function followupsFor(result) {
    if (result.kind === 'code' || result.kind === 'error' || result.code) return FOLLOWUPS.code;
    return FOLLOWUPS.topic;
  }

  // Plain-text export of a section, for the copy buttons.
  function sectionText(section) {
    switch (section.kind) {
      case 'prose':
      case 'takeaway':
        return section.text;
      case 'layer':
        return [section.layer.body].concat(section.layer.points || []).filter(Boolean).join('\n\n');
      case 'list':
        return section.items.map((item) => `• ${item}`).join('\n');
      case 'steps':
        return section.items.map((item, index) => `${index + 1}. ${item.step}${item.detail ? ` — ${item.detail}` : ''}`).join('\n');
      case 'lines':
        return section.items.map((item) => `${item.line ? `${item.line}: ` : ''}${item.why}`).join('\n');
      case 'concepts':
        return section.items.map((item) => `${item.term}: ${item.meaning}`).join('\n');
      case 'issues':
        return section.items.map((item) => `[${item.severity}] ${item.description}${item.where ? ` (${item.where})` : ''}`).join('\n');
      case 'changes':
        return section.items.map((item) => `${item.what} — ${item.why}`).join('\n');
      case 'code':
        return section.item.code;
      case 'code-list':
        return section.items.map((item) => [item.title, '```' + (item.language || ''), item.code, '```'].filter(Boolean).join('\n')).join('\n\n');
      case 'related':
        return section.items.map((item) => item.name).join(', ');
      default:
        return '';
    }
  }

  // The registry caps the paid tail of a live model list so an aggregator with hundreds
  // of ids stays usable. This box is the way round the cap: what you type filters the
  // list, and text that matches nothing is offered as the id itself — a catalogue can
  // always be older than the provider. The selected model is never filtered away, or
  // the reader cannot see what is actually going to be used.
  function modelOptions(models, filter, selectedId) {
    const list = models || [];
    const typed = String(filter || '').trim();
    const needle = typed.toLowerCase();
    const hits = needle
      ? list.filter((model) => String(model.id).toLowerCase().includes(needle)
        || String(model.name || '').toLowerCase().includes(needle))
      : list.slice();
    // Only text that matches nothing at all is taken for an unknown id; 'app' filtering
    // down to 'apple' must not also offer a model called app.
    if (typed && !hits.length) {
      hits.unshift({ id: typed, name: typed, status: 'unverified', typed: true });
    }
    if (selectedId && !hits.some((model) => model.id === selectedId)) {
      const chosen = list.find((model) => model.id === selectedId);
      if (chosen) hits.unshift(chosen);
    }
    return hits;
  }

  function filterFree(models, freeOnly) {
    const list = models || [];
    return freeOnly ? list.filter((model) => model.free === true) : list;
  }

  function modelLabel(model) {
    const bits = [];
    const name = model.name || model.id;
    // OpenRouter already spells "(free)" into the display name, so adding the word a
    // second time read as "Cohere: North Mini Code (free) — free · 256K".
    if (model.free && !/\bfree\b/i.test(name)) bits.push('free');
    if (model.contextWindow) bits.push(model.contextWindow);
    if (model.status === 'unverified') bits.push('unconfirmed');
    return bits.length ? `${name} — ${bits.join(' · ')}` : name;
  }

  function modelNote(provider) {
    if (!provider) return '';
    if (provider.loadingModels) return 'Reading the live model list from the provider…';
    const models = provider.models || [];
    const free = models.filter((model) => model.free).length;
    const head = provider.liveCount
      ? `${provider.liveCount} ids at the provider, ${provider.freeCount || free} free. Listed here: ${models.length} (${free} free).`
      : `${models.length} curated ids. Free routes rotate, so read the provider's live list.`;
    const hidden = provider.hiddenCount ? ` ${provider.hiddenCount} paid ids are not listed — type the id to use one.` : '';
    return `${head}${hidden} Type in the box above to filter.`;
  }

  const helpers = { escapeText, tokenizeCode, relTime, fmtMs, fmtChars, fmtBytes, sectionsFor, followupsFor, sectionText, modelOptions, modelNote, modelLabel, filterFree, FOLLOWUPS };
  if (!IS_BROWSER) {
    globalThis.EisWebview = helpers;
    return;
  }

  // ---------------------------------------------------------------- state

  const state = {
    screen: 'main',
    catalog: null,
    context: { available: false },
    result: null,
    meta: null,
    historyId: null,
    busy: false,
    audit: null,
    auditing: false,
    auditError: null,
    requestId: null,
    draft: '',
    error: null,
    history: [],
    historyBytes: 0,
    query: '',
    composer: '',
    openSections: new Set(['summary', 'simple', 'tech', 'code', 'example', 'takeaway']),
    collapsedCode: new Set(),
    probe: null,
    setup: { providerId: null, model: null, apiKey: '', revealKey: false, showAll: false, freeOnly: false, filter: '' },
  };

  const post = (message) => { if (vscode) vscode.postMessage(message); };

  // ---------------------------------------------------------------- dom

  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === null || value === undefined || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = String(value);
        else if (key === 'html') throw new Error('raw html is not allowed in the webview');
        else if (key === 'on') {
          for (const [event, handler] of Object.entries(value)) node.addEventListener(event, handler);
        } else if (key.startsWith('data') || key.startsWith('aria') || ['role', 'title', 'type', 'id', 'for', 'href', 'src', 'alt', 'value', 'placeholder', 'rows', 'cols', 'spellcheck', 'autocomplete', 'disabled', 'checked', 'download', 'target', 'rel', 'start', 'open', 'hidden', 'tabindex', 'wrap'].includes(key)) {
          node.setAttribute(camelToDash(key), value === true ? '' : String(value));
        } else node.setAttribute(camelToDash(key), String(value));
      }
    }
    for (const child of [].concat(children === undefined ? [] : children)) {
      if (child === null || child === undefined || child === false) continue;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  function camelToDash(name) {
    return name.replace(/([A-Za-z])([A-Z])/g, (m, a, b) => `${a}-${b.toLowerCase()}`);
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  function icon(name, label) {
    const paths = {
      copy: 'M9 2h7a1 1 0 0 1 1 1v11M5 6h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z',
      refresh: 'M20 12a8 8 0 1 1-2.34-5.66M20 4v4h-4',
      history: 'M12 8v4l3 2M3.05 11a9 9 0 1 1 .5 4M4 15v-4h4',
      gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.6 1.6 0 0 0 .32 1.77l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.6 1.6 0 0 0-1.77-.32 1.6 1.6 0 0 0-1 1.46V22a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1.05-1.46 1.6 1.6 0 0 0-1.77.32l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.6 1.6 0 0 0 .32-1.77 1.6 1.6 0 0 0-1.46-1H2a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.46-1.05 1.6 1.6 0 0 0-.32-1.77l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.6 1.6 0 0 0 1.77.32H9a1.6 1.6 0 0 0 1-1.46V2a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.46 1.6 1.6 0 0 0 1.77-.32l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.6 1.6 0 0 0-.32 1.77V9a1.6 1.6 0 0 0 1.46 1H22a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.46 1z',
      stop: 'M6 6h12v12H6z',
      back: 'M15 18l-6-6 6-6',
      pin: 'M12 17v5M9 3h6l1 6 2 2H6l2-2 1-6z',
      trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
      check: 'M20 6L9 17l-5-5',
      book: 'M4 5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 0-2 2V5z',
      code: 'M8 6l-5 6 5 6M16 6l5 6-5 6',
      x: 'M6 6l12 12M18 6L6 18',
      arrow: 'M5 12h14M13 6l6 6-6 6',
      eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    };
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.6');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', paths[name] || paths.arrow);
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    if (name === 'check' || name === 'stop') path.setAttribute('fill', name === 'stop' ? 'currentColor' : 'none');
    svg.appendChild(path);
    if (label) svg.setAttribute('aria-label', label);
    return svg;
  }

  function button(label, options, children) {
    const opts = options || {};
    return el('button', {
      class: ['btn', opts.primary ? 'primary' : '', opts.quiet ? 'quiet' : '', opts.tiny ? 'tiny' : ''].filter(Boolean).join(' '),
      type: 'button',
      title: opts.title || (opts.icon ? label : null),
      ariaLabel: opts.iconOnly ? label : opts.ariaLabel,
      ariaPressed: opts.pressed === undefined ? null : String(!!opts.pressed),
      disabled: opts.disabled,
      on: { click: opts.onClick },
    }, opts.icon ? [icon(opts.icon, opts.iconOnly ? label : null), opts.iconOnly ? null : el('span', { text: label })] : (children || [label]));
  }

  function codeBlock(code, language, options) {
    const opts = options || {};
    const key = opts.key || `${language}:${code.length}:${code.slice(0, 12)}`;
    const pre = el('pre', { role: 'region', ariaLabel: `${language || 'code'} block` });
    tokenizeCode(code, language).forEach((token) => {
      if (token.type === 'plain') { pre.appendChild(document.createTextNode(token.text)); return; }
      pre.appendChild(el('span', { class: `tok-${token.type}`, text: token.text }));
    });

    const bar = el('div', { class: 'bar' }, [
      el('span', { text: language || 'code' }),
      opts.from ? el('span', { text: `lines ${opts.from}-${opts.to || opts.from}` }) : null,
      el('span', { class: 'grow' }),
      button('Copy', { tiny: true, quiet: true, icon: 'copy', iconOnly: false, onClick: () => { post({ type: 'copy', text: code }); markCopied(); } }),
      opts.collapsible ? button(code.split('\n').length > 24 ? 'Collapse' : 'Hide', {
        tiny: true,
        quiet: true,
        onClick: (event) => {
          const hidden = pre.classList.toggle('hidden');
          if (hidden) state.collapsedCode.add(key); else state.collapsedCode.delete(key);
          event.currentTarget.textContent = hidden ? 'Show' : 'Collapse';
        },
      }) : null,
    ]);

    if (state.collapsedCode.has(key) && opts.collapsible) pre.classList.add('hidden');
    return el('div', { class: 'code' }, [bar, pre]);
  }

  function markCopied() {
    const toast = document.getElementById('copied');
    if (!toast) return;
    toast.textContent = 'Copied';
    toast.setAttribute('data-kind', 'ok');
    clearTimeout(markCopied._timer);
    markCopied._timer = setTimeout(() => { toast.textContent = ''; }, 1600);
  }

  // Transient confirmation for actions that change something outside the panel.
  function notify(text, ok) {
    const toast = document.getElementById('copied');
    if (!toast) return;
    toast.textContent = text;
    toast.setAttribute('data-kind', ok ? 'ok' : 'bad');
    clearTimeout(notify._timer);
    notify._timer = setTimeout(() => { toast.textContent = ''; }, 2600);
  }

  function sectionNode(section, index) {
    const body = el('div', { class: 'body', id: `sec-${section.key}` });
    const open = state.openSections.has(section.key) || (!state.openSections.has(section.key) && index < 2);

    const fillContent = () => {
      clear(body);
      switch (section.kind) {
        case 'prose':
          body.appendChild(el('p', { text: section.text }));
          break;
        case 'takeaway':
          body.appendChild(el('p', { class: 'takeaway', text: section.text }));
          break;
        case 'layer':
          if (section.layer.body) body.appendChild(el('p', { text: section.layer.body }));
          if ((section.layer.points || []).length) {
            body.appendChild(el('ul', {}, section.layer.points.map((point) => el('li', { text: point }))));
          }
          break;
        case 'list':
          body.appendChild(el(section.ordered ? 'ol' : 'ul', {}, section.items.map((item) => el('li', { text: String(item) }))));
          break;
        case 'steps':
          body.appendChild(el('ol', {}, section.items.map((item) => el('li', {}, [
            el('strong', { text: item.step || '' }),
            item.detail ? el('span', { text: ` — ${item.detail}` }) : null,
          ]))));
          break;
        case 'lines':
          body.appendChild(el('ul', {}, section.items.map((item) => el('li', {}, [
            item.line ? el('code', { text: String(item.line) }) : null,
            el('span', { text: item.line ? ` — ${item.why}` : item.why }),
          ]))));
          break;
        case 'concepts':
          body.appendChild(el('dl', { class: 'concepts' }, section.items.map((item) => el('div', {}, [
            el('dt', { text: item.term }),
            el('dd', { text: item.meaning }),
          ]))));
          break;
        case 'issues':
          body.appendChild(el('ul', { class: 'issues' }, section.items.map((item) => el('li', {}, [
            el('span', { class: 'sev', dataSev: item.severity, text: item.severity }),
            el('span', {}, [item.description, item.where ? el('span', { class: 'hint', text: ` (${item.where})` }) : null]),
          ]))));
          break;
        case 'changes':
          body.appendChild(el('ul', {}, section.items.map((item) => el('li', {}, [
            el('strong', { text: item.what }),
            item.why ? el('span', { text: ` — ${item.why}` }) : null,
          ]))));
          break;
        case 'code':
          body.appendChild(codeBlock(section.item.code, section.item.language || (state.result && state.result.language), { collapsible: true, key: section.key }));
          if (section.item.note) body.appendChild(el('p', { class: 'hint', text: section.item.note }));
          break;
        case 'code-list':
          section.items.forEach((item, i) => {
            if (item.title) body.appendChild(el('p', { text: item.title }));
            body.appendChild(codeBlock(item.code, item.language || (state.result && state.result.language), { collapsible: true, key: `${section.key}-${i}` }));
            if (item.note) body.appendChild(el('p', { class: 'hint', text: item.note }));
          });
          break;
        case 'related':
          body.appendChild(el('div', { class: 'rel' }, section.items.map((item) => el('button', {
            type: 'button',
            title: item.why || `Explain ${item.name}`,
            on: { click: () => askTopic(item.name) },
          }, [item.name]))));
          break;
        default:
          break;
      }
      const text = sectionText(section);
      if (text) {
        body.appendChild(el('div', { class: 'row', style: 'display:flex;gap:6px;margin-top:6px' }, [
          button('Copy section', { tiny: true, quiet: true, onClick: () => { post({ type: 'copy', text }); markCopied(); } }),
        ]));
      }
    };

    const head = el('button', {
      class: 'head',
      type: 'button',
      ariaExpanded: String(open),
      ariaControls: `sec-${section.key}`,
      on: {
        click: () => {
          const nowOpen = head.getAttribute('aria-expanded') !== 'true';
          head.setAttribute('aria-expanded', String(nowOpen));
          if (nowOpen) { state.openSections.add(section.key); fillContent(); }
          else state.openSections.delete(section.key);
        },
      },
    }, [
      el('span', { class: 'caret', text: '▾', 'aria-hidden': 'true' }),
      section.tag ? el('span', { class: `tag ${section.tag === 'SIMPLE' ? 'simple' : section.tag === 'TECH' ? 'tech' : 'issue'}`, text: section.tag }) : null,
      el('span', { class: 'label', text: section.label }),
      el('span', { class: 'grow' }),
    ]);

    const wrapper = el('section', { class: 'section', ariaLabel: section.label });
    wrapper.appendChild(head);
    wrapper.appendChild(body);
    if (open) fillContent();
    return wrapper;
  }

  // ---------------------------------------------------------------- screens

  function askTopic(topic) {
    state.composer = topic;
    state.screen = 'main';
    render();
    const box = document.getElementById('composer');
    if (box) { box.value = topic; box.focus(); box.setSelectionRange(topic.length, topic.length); }
    post({ type: 'explain', task: 'explain-topic', mode: 'clipboard', subject: topic, depth: depthValue(), stream: true });
  }

  function depthValue() {
    return (state.catalog && state.catalog.selected.depth) || 'balanced';
  }

  function runTask(task, options) {
    const opts = options || {};
    state.error = null;
    state.busy = true;
    state.draft = '';
    state.stage = 'Reading context…';
    post({
      type: 'explain',
      task,
      mode: opts.mode || 'selection',
      depth: opts.depth || depthValue(),
      subject: opts.subject,
      stream: true,
    });
    render();
  }

  function headerNode() {
    const selected = state.catalog ? state.catalog.selected : { providerId: '—', model: '—', depth: 'balanced' };
    const provider = state.catalog ? state.catalog.providers.find((item) => item.id === selected.providerId) : null;
    const screenTabs = [
      ['main', 'Explain'],
      ['audit', 'Audit'],
      ['history', 'History'],
      ['setup', 'Setup'],
      ['settings', 'Settings'],
    ];

    return el('header', { role: 'banner' }, [
      el('span', { class: 'mark', text: 'Explain It Simply' }),
      el('div', { class: 'seg tabs', role: 'group', ariaLabel: 'View' }, screenTabs.map(([key, label]) => el('button', {
        type: 'button',
        text: label,
        ariaPressed: String(state.screen === key),
        on: { click: () => { state.screen = key; if (key === 'history') post({ type: 'history', action: 'list', query: state.query }); render(); } },
      }))),
      el('span', { class: 'spacer' }),
      el('button', {
        class: 'chip',
        type: 'button',
        title: `${provider ? provider.name : selected.providerId} · ${selected.model}`,
        on: { click: () => { state.screen = 'setup'; render(); } },
      }, [
        el('b', { text: provider ? provider.name.split(' ')[0] : selected.providerId }),
        el('span', { text: selected.model }),
      ]),
      state.busy ? button('Cancel', { quiet: true, icon: 'stop', onClick: () => post({ type: 'cancel' }) }) : null,
    ]);
  }

  // Depth used to sit in the header, where it competed with navigation for the same
  // 40px and pushed the rail's chrome to four rows. It only changes an explanation,
  // so it belongs beside the button that runs one.
  function depthNode() {
    const selected = state.catalog ? state.catalog.selected : { depth: 'balanced' };
    return el('div', { class: 'seg', role: 'group', ariaLabel: 'Explanation depth' }, ['quick', 'balanced', 'deep'].map((depth) => el('button', {
      type: 'button',
      text: depth === 'quick' ? 'Quick' : depth === 'balanced' ? 'Balanced' : 'Deep dive',
      title: `Depth: ${depth}`,
      ariaPressed: String(selected.depth === depth),
      on: { click: () => { post({ type: 'patchPreferences', patch: { depth } }); if (state.catalog) state.catalog.selected.depth = depth; render(); } },
    })));
  }

  function contextNode() {
    const ctx = state.context || {};
    if (!ctx.available) {
      return el('div', { class: 'ctx' }, [el('span', { class: 'warn', text: 'No file open — open a file, or type a topic below.' })]);
    }
    const parts = [];
    parts.push(el('span', { class: 'part', text: ctx.hasSelection ? `selection · ${fmtChars(ctx.selectedChars)}` : 'no selection' }));
    parts.push(el('span', { class: 'part where', text: `${ctx.fileName}:${ctx.cursorLine}` }));
    if (ctx.language) parts.push(el('span', { class: 'part lang', text: ctx.language }));
    parts.push(el('span', { class: 'part lines', text: `${ctx.totalLines} lines` }));
    if (ctx.diagnostics && ctx.diagnostics.length) {
      parts.push(el('span', { class: 'part err', text: `error here: ${ctx.diagnostics[0]}`, title: ctx.diagnostics.join('\n') }));
    }
    if (ctx.truncated) parts.push(el('span', { class: 'part warn', text: 'file too large — reading a part' }));
    const advanced = state.catalog && state.catalog.advanced ? state.catalog.advanced : {};
    parts.push(el('span', { class: 'grow' }));
    parts.push(el('span', { class: 'hint budget', text: `context budget ${fmtChars(advanced.contextCharBudget || 8000)} · file ${advanced.includeCurrentFile ? 'included' : 'not included'}` }));
    parts.push(button('Re-read', { tiny: true, quiet: true, icon: 'refresh', onClick: () => post({ type: 'refreshContext' }) }));
    return el('div', { class: 'ctx', role: 'status', 'aria-live': 'polite' }, parts);
  }

  function composerNode() {
    const box = el('textarea', {
      id: 'composer',
      rows: 3,
      wrap: 'soft',
      spellcheck: 'false',
      placeholder: 'Ask about a concept, or paste code — e.g. "What is a race condition?"',
      ariaLabel: 'Topic or code to explain',
      on: {
        input: (event) => { state.composer = event.target.value; },
        keydown: (event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            submitComposer();
          }
        },
      },
    });
    box.value = state.composer || '';

    return el('div', { class: 'composer' }, [
      box,
      el('div', { class: 'row' }, [
        button('Explain', { primary: true, onClick: submitComposer, disabled: state.busy }),
        el('span', { class: 'hint' }, ['or ', el('kbd', { text: 'Ctrl' }), el('kbd', { text: 'Enter' }), ' to run it']),
        el('span', { class: 'spacer' }),
        state.composer ? button('Clear', { quiet: true, tiny: true, onClick: () => { state.composer = ''; render(); } }) : null,
        depthNode(),
      ]),
    ]);
  }

  function submitComposer() {
    const text = (state.composer || '').trim();
    if (!text) {
      state.error = { code: 'VALIDATION_ERROR', message: 'Type a question or paste some code first.', hint: 'Or select code in the editor and use the buttons below.', recovery: 'none' };
      render();
      return;
    }
    const looksLikeCode = /[{};=]|^\s{2,}|\bfunction\b|\bdef\b|import /.test(text);
    runTask(looksLikeCode ? 'explain-code' : 'explain-topic', { mode: 'clipboard', subject: text });
  }

  function tasksNode() {
    const groups = [
      { label: 'Selection', task: 'explain-code', mode: 'selection' },
      { label: 'Function', task: 'explain-code', mode: 'function' },
      { label: 'Whole file', task: 'explain-code', mode: 'file' },
      { label: 'This error', task: 'explain-error', mode: 'error' },
      { label: 'Find issues', task: 'find-issues', mode: 'function' },
      { label: 'Simplify', task: 'simplify', mode: 'function' },
      { label: 'Optimize', task: 'optimize', mode: 'function' },
      { label: 'Add comments', task: 'add-comments', mode: 'function' },
      { label: 'Test it', task: 'generate-test', mode: 'function' },
      { label: 'Example', task: 'give-example', mode: 'selectionOrPrompt' },
      { label: 'Teach me', task: 'teach-me', mode: 'selectionOrPrompt' },
    ];
    const noEditor = !state.context || !state.context.available;
    return el('div', { class: 'tasks', role: 'group', ariaLabel: 'What to explain' }, groups.map((item) => button(item.label, {
      quiet: true,
      disabled: state.busy || (noEditor && item.mode !== 'selectionOrPrompt'),
      title: noEditor && item.mode !== 'selectionOrPrompt' ? 'Open a file to use this' : undefined,
      onClick: () => runTask(item.task, { mode: item.mode }),
    })));
  }

  function resultNode() {
    const result = state.result;
    const meta = state.meta || {};
    const sections = sectionsFor(result);
    const wrap = el('div', { class: 'result', role: 'region', ariaLabel: 'Explanation' });

    wrap.appendChild(el('h2', { text: result.title }));
    const bits = [];
    if (result.kind) bits.push(result.kind);
    if (meta.depth) bits.push(`${meta.depth} depth`);
    if (meta.model) bits.push(meta.model);
    if (meta.latencyMs) bits.push(fmtMs(meta.latencyMs));
    wrap.appendChild(el('p', { class: 'sub', text: bits.join(' · ') }));

    if (!sections.length) {
      wrap.appendChild(el('p', { class: 'hint', text: 'The provider answered, but nothing readable came back. Try again or use a stronger model.' }));
    }
    sections.forEach((section, index) => wrap.appendChild(sectionNode(section, index)));

    if (result.code) {
      wrap.appendChild(el('div', { class: 'row', style: 'display:flex;gap:6px;margin-top:8px' }, [
        button('Replace my selection', { primary: true, onClick: () => post({ type: 'applyCode', code: result.code }) }),
        button('Copy result', { quiet: true, onClick: () => { post({ type: 'copy', text: result.code }); markCopied(); } }),
      ]));
    }

    wrap.appendChild(el('div', { class: 'row', style: 'display:flex;gap:6px;flex-wrap:wrap;margin-top:10px' },
      followupsFor(result).map((item) => button(item.label, {
        quiet: true,
        tiny: true,
        onClick: () => post({ type: 'followup', task: item.task, depth: item.depth, mode: item.mode }),
      }))));

    if (meta.retries) {
      wrap.appendChild(el('p', { class: 'hint', text: `Retried ${meta.retries}× after a transient provider failure.` }));
    }
    if ((meta.missingFields || []).length) {
      wrap.appendChild(el('p', { class: 'hint', text: `This ${meta.depth} answer is missing: ${meta.missingFields.slice(0, 3).map(shortField).join(', ')}. Try Deep dive.` }));
    }
    return wrap;
  }

  function shortField(path) {
    return String(path).replace(/^\$\./, '').replace(/\[\d+\]/g, '');
  }

  function metaNode() {
    const meta = state.meta;
    if (!meta) return null;
    const context = meta.context || {};
    const rows = (context.manifest || []).map((part) => el('tr', {}, [
      el('td', { text: part.part }),
      el('td', { text: fmtChars(part.chars) }),
      el('td', { text: part.reason || '' }),
    ]));
    return el('div', { class: 'meta' }, [
      el('span', {}, [el('b', { text: meta.providerName || meta.provider }), el('span', { text: ` · ${meta.model}` })]),
      el('span', { text: `depth ${meta.depth}` }),
      el('span', { text: `sent ${fmtChars(context.chars)}` }),
      context.estTokens ? el('span', { text: `~${context.estTokens} tokens` }) : null,
      meta.streaming ? el('span', { text: 'streamed' }) : null,
      meta.usage && meta.usage.outputTokens ? el('span', { text: `${meta.usage.outputTokens} tokens back` }) : null,
      context.truncated ? el('span', { class: 'warn', text: 'context trimmed' }) : null,
      el('span', { class: 'spacer' }),
      el('details', {}, [
        el('summary', { text: 'what was sent' }),
        el('table', {}, [
          el('thead', {}, el('tr', {}, [el('th', { text: 'part' }), el('th', { text: 'size' }), el('th', { text: 'why' })])),
          el('tbody', {}, rows),
        ]),
      ]),
      el('span', { id: 'copied', class: 'status', text: '' }),
      el('button', {
        class: 'btn tiny quiet',
        type: 'button',
        text: 'Regenerate',
        on: { click: () => post({ type: 'followup' }) },
      }),
    ]);
  }

  function emptyNode() {
    const ctx = state.context || {};
    const primary = ctx.available && ctx.hasSelection
      ? 'You have code selected — press Explain Selection.'
      : 'Select some code in VS Code and ask Explain It Simply to break it down.';
    return el('div', { class: 'empty' }, [
      el('strong', { text: primary }),
      el('span', { text: 'Or type a concept above and get two layers: a plain-language one and a technical one.' }),
      el('span', { class: 'hint', text: 'Nothing leaves this machine until you ask. Only the selection and a bounded amount of context are sent.' }),
    ]);
  }

  function errorNode(error) {
    const recovery = error.recovery || 'none';
    const actions = [];
    if (recovery === 'setup') actions.push(button('Open setup', { primary: true, onClick: () => { state.screen = 'setup'; render(); } }));
    if (recovery === 'retry' || recovery === 'change-model') actions.push(button('Try again', { primary: true, onClick: () => post({ type: 'followup' }) }));
    if (recovery === 'change-model') actions.push(button('Change model', { quiet: true, onClick: () => { state.screen = 'setup'; render(); } }));
    if (recovery === 'reduce-context') actions.push(button('Explain a smaller part', { quiet: true, onClick: () => { state.screen = 'settings'; render(); } }));
    actions.push(button('Copy details', { quiet: true, onClick: () => { post({ type: 'copy', text: `${error.code}: ${error.message}` }); markCopied(); } }));

    return el('div', { class: 'err', role: 'alert' }, [
      el('h3', { text: error.hint || 'That did not work.' }),
      el('div', { class: 'why' }, [el('span', { text: error.message || 'Unknown failure.' }), ' ', el('code', { text: error.code || 'UNKNOWN_ERROR' })]),
      el('div', { class: 'row' }, actions),
    ]);
  }

  function busyNode() {
    const stage = state.stage || 'Working…';
    const draft = state.draft
      ? el('pre', { class: 'hint', style: 'white-space:pre-wrap;font-family:var(--sans);margin:0', text: `${state.draft.slice(-600)}` })
      : null;
    return el('div', {}, [
      el('div', { class: 'busy', role: 'status', 'aria-live': 'polite' }, [
        el('div', { class: 'bar' }, el('i')),
        el('span', { text: stage }),
      ]),
      draft,
    ]);
  }

  // ------------------------------------------------------------- setup screen

  function setupNode() {
    const catalog = state.catalog;
    if (!catalog) return el('div', { class: 'scroll' }, el('p', { text: 'Loading providers…' }));
    const chosen = state.setup.providerId || catalog.selected.providerId;
    const provider = catalog.providers.find((item) => item.id === chosen) || catalog.providers[0];
    const hasKey = catalog.keysConfiguredFor.includes(provider.id);
    // The stored model belongs to the stored provider. Falling back to it after the
    // reader picks a different provider would post another vendor's id.
    const resolveModelId = () => state.setup.model
      || (catalog.selected.providerId === provider.id ? catalog.selected.model : provider.defaultModel);
    // Buttons are built once per render and the model field does not re-render while
    // typing, so anything that posts the model calls this at click time.
    const modelId = resolveModelId();

    const showAll = state.setup.showAll === true;

    const form = el('div', { class: 'form' }, [
      el('div', { class: 'field' }, [
        el('label', { text: '1 · Provider' }),
        // One line for the provider in use. Six cards by default turned a two-field
        // job into a wall, and in a 297px rail they pushed the key field off-screen.
        el('div', { class: 'pick', role: 'group', ariaLabel: 'Selected provider' }, [
          el('b', { text: provider.name }),
          el('span', { class: 'meta', text: `${provider.models.length} models · ${provider.freeTier ? 'free tier' : 'paid'}` }),
          el('span', { class: 'grow' }),
          el('span', { class: 'pill', dataKind: hasKey ? 'ok' : 'warn', text: hasKey ? 'key stored' : 'no key yet' }),
        ]),
        button(showAll ? 'Hide the other providers' : `Show all ${catalog.providers.length} providers`, {
          tiny: true, quiet: true,
          onClick: () => { state.setup.showAll = !showAll; render(); },
        }),
        showAll ? el('div', { class: 'cards', role: 'group', ariaLabel: 'Provider' }, catalog.providers.map((item) => el('button', {
          class: 'card',
          type: 'button',
          ariaPressed: String(item.id === provider.id),
          on: { click: () => { state.setup.providerId = item.id; state.setup.model = null; state.setup.showAll = false; render(); } },
        }, [
          el('span', { class: 'name', text: item.name }),
          el('span', { class: 'meta', text: `${item.models.length} models · ${item.freeTier ? 'free tier' : 'paid'}` }),
          el('span', { class: 'meta', text: catalog.keysConfiguredFor.includes(item.id) ? 'key stored ✓' : 'no key yet' }),
        ]))) : null,
        el('span', { class: 'note', text: 'Your key is stored in VS Code secret storage, one per provider.' }),
      ]),

      el('div', { class: 'field' }, [
        el('label', { for: 'model-select', text: '2 · Model' }),
        el('input', {
          id: 'model-filter',
          type: 'text',
          autocomplete: 'off',
          spellcheck: 'false',
          placeholder: 'filter the list, or type a model id to use it as-is',
          ariaLabel: 'Filter models or type a model id',
          value: state.setup.filter || '',
          on: {
            // Typing narrows the list. Text that matches nothing at all is taken to be
            // an id the catalogue does not know yet, so it also becomes the selection.
            input: (event) => {
              const value = event.target.value;
              state.setup.filter = value;
              const list = provider.models || [];
              const needle = value.trim().toLowerCase();
              if (!needle) return;
              const matches = list.some((model) => String(model.id).toLowerCase().includes(needle)
                || String(model.name || '').toLowerCase().includes(needle));
              if (!matches) state.setup.model = value.trim();
            },
          },
        }),
        el('div', { style: 'display:flex;gap:6px' }, [
          el('select', {
            id: 'model-select',
            size: '6',
            class: 'model-list',
            ariaLabel: 'Model',
            on: { change: (event) => { state.setup.model = event.target.value; render(); } },
          }, modelOptions(filterFree(provider.models, state.setup.freeOnly), state.setup.filter, modelId).map((model) => el('option', {
            value: model.id,
            selected: model.id === modelId ? true : null,
            text: modelLabel(model),
          }))),
          el('div', { class: 'stack' }, [
            // Anthropic publishes no model list at all, so an unguarded button here
            // could only ever produce an error toast.
            provider.capabilities && provider.capabilities.listModels
              ? button('Refresh', { quiet: true, icon: 'refresh', title: 'Ask the provider which models this key can use', onClick: () => { state.setup.explicitRefresh = true; state.probe = { kind: 'wait', text: 'Fetching the live model list…' }; post({ type: 'refreshModels', providerId: provider.id }); render(); } })
              : null,
            button('Free only', {
              quiet: true,
              ariaPressed: String(state.setup.freeOnly === true),
              title: 'Show only the ids the provider prices at zero',
              onClick: () => { state.setup.freeOnly = !(state.setup.freeOnly === true); render(); },
            }),
          ]),
        ]),
        el('span', { class: 'note', text: modelNote(provider) }),
      ]),

      el('div', { class: 'field' }, [
        el('label', { for: 'key-input', text: '3 · API key' }),
        el('span', { class: 'note', text: hasKey
          ? 'A key is already stored, so pasting replaces it. Several keys? Separate them with commas: a rate-limited or rejected key rests for a minute and the request moves to the next.'
          : 'Several keys? Paste them separated by commas: when one is rate limited or rejected, the request moves to the next and that key rests for a minute.' }),
        el('div', { style: 'display:flex;gap:6px' }, [
          el('input', {
            id: 'key-input',
            type: state.setup.revealKey ? 'text' : 'password',
            autocomplete: 'off',
            spellcheck: 'false',
            placeholder: provider.keyHint || 'paste key, or several separated by commas',
            ariaLabel: 'API key',
            value: state.setup.apiKey,
            on: { input: (event) => { state.setup.apiKey = event.target.value; } },
          }),
          button(state.setup.revealKey ? 'Hide' : 'Show', {
            quiet: true,
            onClick: () => { state.setup.revealKey = !state.setup.revealKey; render(); },
          }),
        ]),
        el('div', { style: 'display:flex;gap:6px;align-items:center' }, [
          button('Test connection', { quiet: true, disabled: !state.setup.apiKey && !hasKey, onClick: () => { state.probe = { kind: 'wait', text: 'Asking the provider to confirm this key…' }; post({ type: 'probe', providerId: provider.id, model: resolveModelId(), apiKey: state.setup.apiKey }); render(); } }),
          el('a', { href: provider.keyUrl, class: 'hint', style: 'color:var(--link);cursor:pointer', text: `Get a ${provider.name} key`, on: { click: (event) => { event.preventDefault(); post({ type: 'open', url: provider.keyUrl }); } } }),
        ]),
      ]),

      state.probe ? el('div', { class: 'status', dataKind: state.probe.kind, role: 'status', 'aria-live': 'polite', text: state.probe.text }) : null,

      el('div', { style: 'display:flex;gap:6px' }, [
        button('Save and start', {
          primary: true,
          disabled: !state.setup.apiKey && !hasKey,
          onClick: () => post({
            type: 'saveSettings',
            providerId: provider.id,
            model: resolveModelId(),
            apiKey: state.setup.apiKey || undefined,
            proseLanguage: catalog.selected.proseLanguage,
          }),
        }),
        el('span', { class: 'spacer' }),
        button('Cancel', { quiet: true, onClick: () => { state.screen = 'main'; state.probe = null; render(); } }),
      ]),
      !state.setup.apiKey && !hasKey ? el('span', { class: 'note', text: 'Save stays disabled until a key is stored for this provider.' }) : null,
    ]);

    return el('div', { class: 'scroll' }, [
      el('h2', { style: 'font-size:15px;margin:0 0 4px', text: 'Connect a model' }),
      el('p', { class: 'hint', style: 'margin:0 0 14px', text: 'Three steps, and the explanation you asked for runs as soon as it saves.' }),
      form,
    ]);
  }

  // ----------------------------------------------------------- settings screen

  function settingsNode() {
    if (!state.catalog) return el('div', { class: 'scroll' }, el('p', { text: 'Loading…' }));
    const advanced = state.catalog.advanced || {};
    const selected = state.catalog.selected;

    const toggle = (label, description, value, onSet) => el('div', { class: 'opt' }, [
      el('div', { class: 'grow' }, [el('div', { text: label }), el('div', { class: 'desc', text: description })]),
      el('button', {
        class: 'switch',
        type: 'button',
        role: 'switch',
        ariaChecked: String(!!value),
        ariaLabel: label,
        on: { click: () => onSet(!value) },
      }),
    ]);

    return el('div', { class: 'scroll' }, [
      el('div', { class: 'form' }, [
        el('div', { class: 'field' }, [
          el('label', { text: 'Answer language' }),
          el('input', {
            type: 'text',
            value: selected.proseLanguage,
            ariaLabel: 'Language of the prose (code stays as written)',
            on: { change: (event) => post({ type: 'patchPreferences', patch: { proseLanguage: event.target.value } }) },
          }),
          el('span', { class: 'note', text: 'Name any language you like — "French", "Hindi", "Portuguese". Code and identifiers stay unchanged.' }),
        ]),

        el('div', { class: 'field' }, [
          el('label', { text: 'Context sent with a request' }),
          toggle('Surrounding lines', 'A few lines around your selection, within the budget.', advanced.includeSurroundingContext, (next) => post({ type: 'updateAdvanced', key: 'context.surrounding', value: next })),
          toggle('Current file extras', 'Also send imports and the enclosing function of the active file.', advanced.includeCurrentFile, (next) => post({ type: 'updateAdvanced', key: 'context.currentFile', value: next })),
          el('div', { class: 'opt' }, [
            el('div', { class: 'grow' }, [el('div', { text: 'Context budget' }), el('div', { class: 'desc', text: 'Maximum extra characters sent.' })]),
            el('input', {
              type: 'number',
              min: '500',
              max: '60000',
              step: '500',
              value: String(advanced.contextCharBudget || 8000),
              ariaLabel: 'Context budget in characters',
              style: 'width:90px;height:28px;padding:0 6px;border:1px solid var(--input-line);border-radius:var(--r);background:var(--input-bg);color:var(--input-fg)',
              on: { change: (event) => post({ type: 'updateAdvanced', key: 'context.maxCharacters', value: Number(event.target.value) }) },
            }),
          ]),
        ]),

        el('div', { class: 'field' }, [
          el('label', { text: 'Privacy' }),
          toggle('Keep history', 'Store explanations on this machine so you can reopen them.', advanced.historyEnabled, (next) => post({ type: 'updateAdvanced', key: 'privacy.saveHistory', value: next })),
          el('div', { class: 'opt' }, [
            el('div', { class: 'grow' }, [el('div', { text: 'Code retention' }), el('div', { class: 'desc', text: 'How much of your source history keeps.' })]),
            el('select', {
              ariaLabel: 'Code retention',
              on: { change: (event) => post({ type: 'updateAdvanced', key: 'privacy.codeRetention', value: event.target.value }) },
            }, ['none', 'summary', 'snippet'].map((option) => el('option', {
              value: option,
              selected: advanced.codeRetention === option ? true : null,
              text: option,
            }))),
          ]),
          el('div', { class: 'desc', text: `History currently uses ${fmtBytes(state.historyBytes)} on this machine. API keys are never stored in history.` }),
          el('div', { style: 'display:flex;gap:6px;margin-top:6px' }, [
            button('Clear history', { quiet: true, onClick: () => post({ type: 'history', action: 'clear', keepPinned: true }) }),
            button('Advanced settings', { quiet: true, onClick: () => post({ type: 'openSettings' }) }),
          ]),
        ]),
      ]),
    ]);
  }

  // ------------------------------------------------------------ history screen

  function historyNode() {
    const items = state.history || [];
    const list = el('div', { class: 'hist' }, items.length
      ? items.map((item) => el('div', { class: 'item' }, [
        el('button', {
          class: 'open',
          type: 'button',
          on: { click: () => { post({ type: 'history', action: 'open', id: item.id }); state.screen = 'main'; render(); } },
        }, [
          el('div', { class: 't', text: item.title }),
          el('div', { class: 'm' }, [
            el('span', { text: relTime(item.savedAt) }),
            el('span', { text: item.task }),
            item.depth ? el('span', { text: item.depth }) : null,
            el('span', { text: `${item.provider}/${item.model}` }),
            item.hasSubject ? el('span', { text: 'code kept' }) : el('span', { text: 'no code kept' }),
            (item.contextParts || []).length ? el('span', { text: `sent ${item.contextParts.join('+')}` }) : null,
          ]),
        ]),
        el('div', { class: 'acts' }, [
          button(item.pinned ? 'Pinned' : 'Pin', {
            tiny: true,
            quiet: true,
            icon: 'pin',
            iconOnly: true,
            ariaLabel: item.pinned ? 'Unpin' : 'Pin this explanation',
            onClick: () => post({ type: 'history', action: 'pin', id: item.id, pinned: !item.pinned }),
          }),
          button('Delete', { tiny: true, quiet: true, icon: 'trash', iconOnly: true, ariaLabel: 'Delete', onClick: () => post({ type: 'history', action: 'delete', id: item.id }) }),
        ]),
      ]))
      : [el('div', { class: 'empty' }, [
        el('strong', { text: 'No history yet' }),
        el('span', { text: 'Answers you generate are saved here so you can come back to them. Pinned answers are kept when history is cleared.' }),
      ])]);

    return el('div', { class: 'scroll' }, [
      el('div', { class: 'search' }, [
        el('input', {
          type: 'search',
          value: state.query,
          placeholder: 'Search titles and answers',
          ariaLabel: 'Search history',
          on: {
            input: (event) => { state.query = event.target.value; post({ type: 'history', action: 'list', query: state.query }); },
          },
        }),
        button('Search', { quiet: true, onClick: () => post({ type: 'history', action: 'list', query: state.query }) }),
      ]),
      el('div', { class: 'hint', style: 'margin-bottom:8px', text: `${items.length} saved · ${fmtBytes(state.historyBytes)} · retention: ${(state.catalog && state.catalog.advanced && state.catalog.advanced.codeRetention) || 'snippet'}` }),
      list,
    ]);
  }

  // ---------------------------------------------------------------- audit screen

  const SEVERITY_LABEL = { confirmed: 'confirmed', potential: 'potential', recommendation: 'advice' };

  function findingRow(finding) {
    const open = () => post({ type: 'openFile', path: finding.path, line: finding.line });
    return el('div', { class: 'item' }, [
      el('button', {
        class: 'open',
        type: 'button',
        title: `${finding.path}:${finding.line} — open`,
        on: { click: open },
      }, [
        el('div', { class: 't', text: finding.message }),
        el('div', { class: 'm' }, [
          el('span', { class: `sev`, dataSev: finding.severity, text: SEVERITY_LABEL[finding.severity] || finding.severity }),
          el('span', { text: `${finding.path}:${finding.line}` }),
          el('span', { text: finding.rule }),
          finding.evidence ? el('span', { class: 'hint', text: finding.evidence }) : null,
        ]),
      ]),
      button('Open', {
        tiny: true,
        quiet: true,
        onClick: open,
      }),
    ]);
  }

  function auditNode() {
    const report = state.audit;
    const controls = el('div', { class: 'tasks', style: 'padding:10px 0' }, [
      button('Audit project', {
        primary: true,
        disabled: state.auditing,
        onClick: () => { state.auditError = null; post({ type: 'audit', scope: 'workspace' }); },
      }),
      button('Local pass only, no API cost', {
        quiet: true,
        disabled: state.auditing,
        title: 'Runs the same rules without sending any file to a model',
        onClick: () => { state.auditError = null; post({ type: 'audit', scope: 'workspace', aiFiles: 0 }); },
      }),
      button('Audit current file', {
        quiet: true,
        disabled: state.auditing,
        onClick: () => { state.auditError = null; post({ type: 'audit', scope: 'file' }); },
      }),
      button('Clear markers', {
        quiet: true,
        onClick: () => post({ type: 'auditClear' }),
      }),
    ]);

    if (state.auditing) {
      return el('div', { class: 'scroll' }, [
        controls,
        el('div', { class: 'busy', role: 'status', 'aria-live': 'polite' }, [
          el('div', { class: 'bar' }, el('i')),
          el('span', { text: 'Reading files and running local rules…' }),
        ]),
      ]);
    }

    if (state.auditError) {
      return el('div', { class: 'scroll' }, [controls, errorNode(state.auditError)]);
    }

    if (!report) {
      return el('div', { class: 'scroll' }, [
        controls,
        el('div', { class: 'empty' }, [
          el('strong', { text: 'Audit the project you have open' }),
          el('span', { text: 'Rules run locally first — credentials in source, abandoned errors, DOM sinks, unguarded parsing, leftover debuggers, oversized files. Nothing is sent anywhere.' }),
          el('span', { text: 'Then a few files — the ones with the hardest evidence — go to your model for judgement: what the code is for, what breaks, what to fix first.' }),
          el('span', { class: 'hint', text: 'Findings also appear as editor markers, so you can jump to one and ask Explain Error.' }),
        ]),
      ]);
    }

    const stats = report.stats || {};
    const sev = stats.bySeverity || {};
    const wrap = el('div', { class: 'scroll' }, [
      controls,
      el('h2', { style: 'font-size:15px;margin:0 0 4px', text: report.scope && report.scope.fileCount === 1 ? `Audit of ${report.root || 'the open file'}` : `Audit of ${report.root || 'the workspace'}` }),
      el('div', { class: 'meta', style: 'border:0;padding:0 0 8px' }, [
        el('span', {}, [el('b', { text: `${stats.files || 0} files` }), el('span', { text: ` · ${(stats.lines || 0).toLocaleString()} lines` })]),
        el('span', { text: `${sev.confirmed || 0} confirmed` }),
        el('span', { text: `${sev.potential || 0} to review` }),
        el('span', { text: `${sev.recommendation || 0} hygiene` }),
        el('span', { text: `${stats.testRatioPercent || 0}% test files` }),
        el('span', { text: `${(report.rerescan || []).length ? `re-read ${(report.rerescan || []).length} changed` : 'no changes since last audit'}` }),
      ]),
      el('p', { class: 'hint', style: 'margin:0 0 12px', text: report.scope ? report.scope.description : '' }),
    ]);

    if ((report.scope && report.scope.sent || []).length) {
      wrap.appendChild(el('div', { class: 'ctx', style: 'border:0;padding:0 0 10px' }, [
        el('span', { text: `~${report.totals.estimatedTokens} tokens spent · ${report.scope.sent.length} file(s) sent` }),
        ...report.scope.sent.filter((entry) => entry.redacted).map((entry) => el('span', {
          class: 'part',
          text: `${entry.path}: ${entry.redacted} credential(s) removed before sending`,
        })),
        ...report.scope.sent.filter((entry) => entry.truncated).map((entry) => el('span', { class: 'part warn', text: `${entry.path} trimmed` })),
      ]));
    }

    const aiReports = (report.summary && report.summary.ai) || [];
    for (const ai of aiReports) {
      if (ai.error) {
        wrap.appendChild(errorNode(ai.error));
        continue;
      }
      const block = el('section', { class: 'section', ariaLabel: `Model review of ${ai.path}` }, [
        el('div', { class: 'ctx', style: 'border:0;padding:8px 0 4px' }, [
          el('span', { class: 'part', text: ai.path }),
          el('span', { class: 'grow' }),
          el('span', { class: 'hint', text: 'model review' }),
        ]),
        el('div', { class: 'result-title', text: ai.title }),
        ai.summary ? el('p', { text: ai.summary }) : null,
      ]);
      if ((ai.issues || []).length) {
        block.appendChild(el('ul', { class: 'issues' }, ai.issues.map((issue) => el('li', {}, [
          el('span', { class: 'sev', dataSev: issue.severity, text: SEVERITY_LABEL[issue.severity] || issue.severity }),
          el('span', {}, [issue.description, issue.where ? el('span', { class: 'hint', text: ` (${issue.where})` }) : null]),
        ]))));
      }
      if (ai.takeaway) block.appendChild(el('p', { class: 'takeaway', text: ai.takeaway }));
      block.appendChild(el('div', { style: 'display:flex;gap:6px;margin-top:6px' }, [
        button('Explain this file fully', {
          tiny: true,
          quiet: true,
          onClick: () => {
            state.screen = 'main';
            post({ type: 'explain', task: 'explain-code', mode: 'file', stream: true });
          },
        }),
      ]));
      wrap.appendChild(block);
    }

    const findings = report.findings || [];
    if (findings.length) {
      wrap.appendChild(el('h3', { style: 'font-size:12px;margin:14px 0 6px', text: `Local findings (${findings.length}${report.findingsTruncated ? `, ${report.findingsTruncated} more not shown` : ''})` }));
      const list = el('div', { class: 'hist' }, findings.map(findingRow));
      wrap.appendChild(list);
    }

    const copy = button('Copy the report', {
      quiet: true,
      onClick: () => post({
        type: 'copy',
        text: [
          `# Explain It Simply — audit of ${report.root || ''}`,
          report.scope ? report.scope.description : '',
          '',
          ...((report.summary && report.summary.ai) || []).map((ai) => ai.error
            ? `## ${ai.path}\n- review failed: ${ai.error.message || ai.error.code}`
            : `## ${ai.path} — ${ai.title}\n${ai.summary || ''}\n${(ai.issues || []).map((issue) => `- [${issue.severity}] ${issue.description}${issue.where ? ` (${issue.where})` : ''}`).join('\n')}`),
          '',
          ...findings.map((finding) => `- [${finding.severity}] ${finding.path}:${finding.line} ${finding.rule}: ${finding.message}`),
        ].join('\n'),
      }),
    });
    wrap.appendChild(el('div', { style: 'display:flex;gap:6px;margin-top:12px' }, [copy]));
    return wrap;
  }

  // ------------------------------------------------------------------- render

  function render() {
    const root = document.getElementById('app');
    if (!root) return;
    clear(root);
    root.appendChild(headerNode());

    const main = el('main', { role: 'main' });
    const screen = (key, node) => el('div', { class: 'screen', dataActive: String(state.screen === key), role: 'region', ariaLabel: key }, node);

    if (state.screen === 'main') {
      main.appendChild(screen('main', [
        contextNode(),
        composerNode(),
        tasksNode(),
        el('div', { class: 'scroll', id: 'output', tabindex: '-1' }, [
          state.busy ? busyNode() : null,
          state.error ? errorNode(state.error) : null,
          !state.busy && state.result ? resultNode() : null,
          !state.busy && !state.result && !state.error ? emptyNode() : null,
        ]),
        state.result && !state.busy ? metaNode() : null,
      ]));
    } else if (state.screen === 'setup') {
      main.appendChild(screen('setup', [setupNode()]));
    } else if (state.screen === 'settings') {
      main.appendChild(screen('settings', [settingsNode()]));
    } else if (state.screen === 'audit') {
      main.appendChild(screen('audit', [auditNode()]));
    } else {
      main.appendChild(screen('history', [historyNode()]));
    }

    root.appendChild(main);
  }

  // --------------------------------------------------------------- messaging

  // Geometry reporting exists for scripts/vscode-window-check.js: this layout is a flex
  // height chain, and the only way to know whether content below the fold is reachable
  // is to measure it inside a real webview. Nothing in the product sends probe-layout.
  function boxOf(node) {
    if (!node) return null;
    const style = getComputedStyle(node);
    return {
      tag: node.tagName.toLowerCase(),
      id: node.id || undefined,
      cls: node.className || undefined,
      clientH: node.clientHeight,
      scrollH: node.scrollHeight,
      offsetH: node.offsetHeight,
      rectH: Math.round(node.getBoundingClientRect().height),
      overflowY: style.overflowY,
      height: style.height,
      maxHeight: style.maxHeight,
      position: style.position,
      flex: style.flex,
      canScroll: node.scrollHeight > node.clientHeight + 1,
    };
  }

  function layoutReport() {
    const active = document.querySelector('.screen[data-active="true"]');
    const scroller = active ? active.querySelector('.scroll') : null;
    const ancestors = [];
    let node = scroller || active || document.getElementById('app');
    while (node && ancestors.length < 8) {
      ancestors.push(boxOf(node));
      node = node.parentElement;
    }
    // Proof a scroller is really scrollable, not just styled that way: move it and
    // read the position back. An element clipped by an ancestor's overflow stays at 0.
    let scrolledTo = null;
    if (scroller && scroller.scrollHeight > scroller.clientHeight + 1) {
      scroller.scrollTop = 99999;
      scrolledTo = scroller.scrollTop;
      scroller.scrollTop = 0;
    }
    // Widest overflowing descendants: horizontal overflow in a 297px rail is what makes
    // a provider name read as cut off, and only the elements themselves say which.
    const tooWide = [];
    if (scroller) {
      for (const node of scroller.querySelectorAll('*')) {
        if (node.scrollWidth > scroller.clientWidth + 1) {
          tooWide.push(`${node.tagName.toLowerCase()}.${String(node.className).split(' ')[0]}=${node.scrollWidth}`);
          if (tooWide.length >= 6) break;
        }
      }
    }
    return {
      innerH: window.innerHeight,
      innerW: window.innerWidth,
      docClientH: document.documentElement.clientHeight,
      docScrollH: document.documentElement.scrollHeight,
      bodyScrollH: document.body.scrollHeight,
      bodyOverflowY: getComputedStyle(document.body).overflowY,
      appClientH: (document.getElementById('app') || { clientHeight: 0 }).clientHeight,
      screen: active ? active.getAttribute('aria-label') : null,
      scroller: boxOf(scroller),
      scrolledTo,
      tooWide,
      ancestors,
    };
  }

  function handle(message) {
    if (!message || !message.type) return;
    switch (message.type) {
      case 'probe-layout':
        setTimeout(() => post({ type: 'layout', tag: message.tag, ...layoutReport() }), 60);
        return;
      case 'bootstrap':
        state.catalog = message.catalog;
        state.history = message.history || [];
        state.historyBytes = message.historyBytes || 0;
        if (!state.setup.providerId) state.setup.providerId = message.catalog.selected.providerId;
        break;
      case 'context':
        state.context = message;
        break;
      case 'screen':
        // Anything else silently rendered the main screen, so a host asking for
        // Settings or Audit got a wrong answer with no error.
        state.screen = ['main', 'setup', 'settings', 'audit', 'history'].includes(message.screen) ? message.screen : 'main';
        break;
      case 'started':
        state.busy = true;
        state.error = null;
        state.draft = '';
        state.requestId = message.requestId;
        state.stage = message.mode === 'file' ? 'Reading the whole file…' : 'Reading context…';
        break;
      case 'delta':
        // A superseded request still reports how it ended. Accepting that would clear the
        // busy state of the request actually running and hide its Cancel button.
        if (!belongsToView(message)) return;
        state.draft += message.text;
        state.stage = 'Building explanation…';
        break;
      case 'result':
        if (!belongsToView(message)) return;
        if (message.adopt) state.requestId = message.requestId;
        state.busy = false;
        state.result = message.result;
        state.meta = message.meta;
        state.historyId = message.historyId;
        state.error = null;
        state.openSections = new Set(sectionsFor(message.result).slice(0, 3).map((section) => section.key));
        if (message.meta.fromHistory) state.stage = 'Loaded from history';
        break;
      case 'cancelled':
        if (!belongsToView(message)) return;
        state.busy = false;
        state.error = { code: 'CANCELLED', message: 'Cancelled.', hint: 'No answer was kept.', recovery: 'none' };
        break;
      case 'error':
        if (!belongsToView(message)) return;
        state.busy = false;
        state.error = message.error;
        if (message.error && (message.error.recovery === 'setup' || message.error.code === 'CONFIGURATION_ERROR')) state.probe = { kind: 'bad', text: message.error.message };
        break;
      case 'settings.saved':
        state.catalog = message.catalog || state.catalog;
        state.probe = { kind: 'ok', text: 'Saved.' };
        state.screen = 'main';
        state.error = null;
        break;
      case 'probe.result':
        state.probe = message.ok
          ? { kind: 'ok', text: message.modelExists ? 'Key works and the model is available.' : 'Key works, but that model was not found. Pick another.' }
          : { kind: 'bad', text: `${message.hint || 'Failed.'} ${message.message || ''}`.trim() };
        break;
      case 'models.refreshed':
        if (message.ok && state.catalog) {
          const target = state.catalog.providers.find((item) => item.id === message.providerId);
          if (target) {
            target.models = message.models.map((model) => ({
              id: model.id,
              name: model.name,
              status: model.inLiveList === false ? 'unverified' : 'verified',
              free: model.free === true,
              contextWindow: model.contextWindow,
            }));
            target.hiddenCount = message.hiddenCount || 0;
            target.liveCount = message.liveCount || message.models.length;
            target.freeCount = message.freeCount || 0;
            target.liveLoaded = true;
            target.loadingModels = false;
          }
          // The note under the list already reports the counts, so a status line on top
          // of it repeated the same numbers twice — and disagreed, because one counted
          // the ids shown and the other counted the provider's total.
          if (state.setup.explicitRefresh) {
            state.probe = { kind: 'ok', text: `${message.liveCount || message.models.length} ids at ${message.providerId}, ${message.freeCount || 0} free.` };
            state.setup.explicitRefresh = false;
          }
        } else {
          const failed = state.catalog && state.catalog.providers.find((item) => item.id === message.providerId);
          if (failed) failed.loadingModels = false;
          state.probe = { kind: 'bad', text: message.message || 'Could not read the live model list.' };
        }
        break;
      case 'history.list':
        state.history = message.items || [];
        state.historyBytes = message.historyBytes || 0;
        break;
      case 'audit.started':
        state.auditing = true;
        state.auditError = null;
        state.screen = 'audit';
        break;
      case 'audit.result':
        state.auditing = false;
        state.audit = message.report;
        state.auditError = null;
        state.screen = 'audit';
        break;
      case 'audit.cleared':
        state.auditError = null;
        state.audit = null;
        break;
      case 'audit.busy':
        state.auditError = { code: 'VALIDATION_ERROR', message: 'An audit is already running.', hint: 'Wait for it, or cancel it.', recovery: 'none' };
        break;
      case 'audit.cancelled':
        state.auditing = false;
        state.auditError = { code: 'CANCELLED', message: 'Audit cancelled before it reached the model.', hint: 'Nothing was spent.', recovery: 'retry' };
        break;
      case 'request-input':
        state.screen = 'main';
        break;
      case 'apply.result':
        // state.probe is only rendered on the setup screen, so this was invisible where
        // the edit actually happened.
        notify(message.message, !!message.ok);
        break;
      default:
        break;
    }
    maybeLoadModels();
    render();
  }

  // Aggregators rotate their free routes, so the curated ids are only ever a sample of
  // what a key can use. Reading the provider's own list as soon as setup opens for such
  // a provider is what makes a `:free` id findable without knowing to press Refresh.
  const modelListAskedFor = new Set();

  function maybeLoadModels() {
    const catalog = state.catalog;
    if (!catalog || state.screen !== 'setup') return;
    const chosen = state.setup.providerId || catalog.selected.providerId;
    const provider = catalog.providers.find((item) => item.id === chosen);
    if (!provider || !provider.capabilities || !provider.capabilities.listModels) return;
    // A provider that needs credentials to list is not asked before it has any.
    if (!catalog.keysConfiguredFor.includes(provider.id) && !provider.capabilities.listModelsPublic) return;
    if (provider.liveLoaded || modelListAskedFor.has(provider.id)) return;
    modelListAskedFor.add(provider.id);
    provider.loadingModels = true;
    post({ type: 'refreshModels', providerId: provider.id });
  }

  // Which messages describe what this surface is showing. `adopt` marks a replay sent
  // to a surface that joined after the request started (or a history entry being
  // reopened), where there is no matching `started` to have set the id.
  function belongsToView(message) {
    return message.adopt === true || message.requestId === undefined || message.requestId === state.requestId;
  }

  window.addEventListener('message', (event) => handle(event.data));
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.busy) {
      post({ type: 'cancel' });
      return;
    }
    if (event.key === 'Enter' && event.altKey) {
      const box = document.getElementById('composer');
      if (box) { event.preventDefault(); submitComposer(); }
    }
  });

  post({ type: 'ready' });
  render();
})();
