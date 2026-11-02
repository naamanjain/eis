/* Explain It Simply — web app.
 *
 * Talks to the real backend only: no canned answers, no timer-based fake
 * loading. Model text is inserted with textContent (never innerHTML), so an
 * answer containing markup is inert.
 */
(function () {
  'use strict';

  const el = (id) => document.getElementById(id);
  const KEYWORDS = new Set(('abstract and as async await break case catch class const continue def default del do else enum export '
    + 'extends finally for func function goto if implements import in instanceof interface let loop match mut new nil none not or package '
    + 'private public raise readonly return self static struct super switch this throw trait true try typeof unsafe use var void while with yield')
    .split(' '));

  const state = {
    kind: 'topic',
    depth: 'balanced',
    language: '',
    catalog: null,
    busy: false,
    controller: null,
    last: null,
    token: sessionStorage.getItem('eis.token') || '',
    mic: null,
    listening: false,
  };

  const TOPIC_CHIPS = ['What is a race condition?', 'How does HTTPS actually work?', 'What is Big O, in practice?', 'Explain database indexes', 'What is a closure?'];
  const CODE_CHIPS = ['function debounce(fn, ms) {}', 'SELECT * FROM users WHERE id = 1;', 'def fib(n):\n    return n if n < 2 else fib(n-1) + fib(n-2)'];

  // ------------------------------------------------------------- utilities

  function build(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === null || value === undefined || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = String(value);
        else if (key === 'on') Object.entries(value).forEach(([event, handler]) => node.addEventListener(event, handler));
        else node.setAttribute(key.replace(/([A-Z])/g, (m) => `-${m.toLowerCase()}`), value === true ? '' : String(value));
      }
    }
    [].concat(children === undefined ? [] : children).forEach((child) => {
      if (child === null || child === undefined || child === false) return;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  function tokenize(code, language) {
    const src = String(code || '');
    const hashComment = /^(python|ruby|shell|yaml|r)$/i.test(language || '');
    const out = [];
    let buffer = '';
    let i = 0;
    const flush = (type) => {
      if (buffer) out.push({ type: type || 'plain', text: buffer });
      buffer = '';
    };
    while (i < src.length) {
      const two = src.slice(i, i + 2);
      if (two === '//' || (hashComment && src[i] === '#')) {
        flush();
        const end = src.indexOf('\n', i);
        const stop = end === -1 ? src.length : end;
        out.push({ type: 'com', text: src.slice(i, stop) });
        i = stop;
        continue;
      }
      if (two === '/*') {
        flush();
        const end = src.indexOf('*/', i + 2);
        const stop = end === -1 ? src.length : end + 2;
        out.push({ type: 'com', text: src.slice(i, stop) });
        i = stop;
        continue;
      }
      const ch = src[i];
      if (ch === '"' || ch === "'" || ch === '`') {
        flush();
        let j = i + 1;
        while (j < src.length) {
          if (src[j] === '\\') { j += 2; continue; }
          if (src[j] === ch) { j += 1; break; }
          if (ch !== '`' && src[j] === '\n') break;
          j += 1;
        }
        out.push({ type: 'str', text: src.slice(i, j) });
        i = j;
        continue;
      }
      if (/[0-9]/.test(ch) && !/[A-Za-z0-9_$]/.test(src[i - 1] || '')) {
        flush();
        let j = i;
        while (j < src.length && /[0-9a-fx._]/.test(src[j])) j += 1;
        out.push({ type: 'num', text: src.slice(i, j) });
        i = j;
        continue;
      }
      if (/[A-Za-z_$]/.test(ch)) {
        let j = i;
        while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j += 1;
        const word = src.slice(i, j);
        if (KEYWORDS.has(word.toLowerCase())) {
          flush();
          out.push({ type: 'key', text: word });
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
    return out;
  }

  function codeBlock(code, language) {
    const pre = build('pre', { 'aria-label': `${language || 'code'} sample` });
    tokenize(code, language).forEach((token) => {
      pre.appendChild(token.type === 'plain'
        ? document.createTextNode(token.text)
        : build('span', { class: `tok-${token.type}`, text: token.text }));
    });
    const copy = build('button', { class: 'button tiny quiet', type: 'button', text: 'Copy' });
    copy.addEventListener('click', () => copyText(code, copy));
    return build('figure', { class: 'code' }, [
      build('div', { class: 'bar' }, [build('span', { text: language || 'code' }), build('span', { class: 'grow' }), copy]),
      pre,
    ]);
  }

  function copyText(text, button) {
    const done = (ok) => {
      if (!button) return;
      button.textContent = ok ? 'Copied' : 'Press Ctrl+C';
      setTimeout(() => { button.textContent = 'Copy'; }, 1500);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(() => done(true), () => done(false));
      return;
    }
    const area = build('textarea', { style: 'position:fixed;top:-1000px', text });
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (error) {
      ok = false;
    }
    area.remove();
    done(ok);
  }

  function fmtChars(value) {
    const n = Number(value) || 0;
    return n < 1000 ? `${n} chars` : `${(n / 1000).toFixed(1)}k chars`;
  }

  // --------------------------------------------------------------- rendering

  function sectionsFor(result) {
    const out = [];
    const has = (layer) => layer && (String(layer.body || '').trim() || (layer.points || []).length);
    if (String(result.summary || '').trim()) out.push({ key: 'summary', label: 'Summary', kind: 'prose', text: result.summary });
    if (has(result.simpleExplanation)) out.push({ key: 'simple', label: result.simpleExplanation.heading || 'Explain it simply', tag: 'simple', kind: 'layer', layer: result.simpleExplanation, lead: true });
    if (has(result.technicalExplanation)) out.push({ key: 'tech', label: result.technicalExplanation.heading || 'Technical breakdown', tag: 'tech', kind: 'layer', layer: result.technicalExplanation });
    if ((result.howItWorks || []).length) out.push({ key: 'how', label: 'How it works', kind: 'list', items: result.howItWorks, ordered: true });
    if ((result.executionFlow || []).length) out.push({ key: 'flow', label: 'Execution flow', kind: 'steps', items: result.executionFlow });
    if ((result.importantLines || []).length) out.push({ key: 'lines', label: 'Important lines', kind: 'lines', items: result.importantLines });
    if (result.code) out.push({ key: 'result', label: 'Result', kind: 'code', item: { code: result.code, language: result.language } });
    if ((result.examples || []).length) out.push({ key: 'examples', label: 'Examples', kind: 'codes', items: result.examples });
    if (result.example && result.example.code) out.push({ key: 'example', label: 'Example', kind: 'code', item: result.example });
    if ((result.dependencies || []).length) out.push({ key: 'deps', label: 'Depends on', kind: 'list', items: result.dependencies });
    if ((result.keyConcepts || []).length) out.push({ key: 'concepts', label: 'Key concepts', kind: 'concepts', items: result.keyConcepts });
    if ((result.potentialIssues || []).length) out.push({ key: 'issues', label: 'Potential issues', tag: 'issue', kind: 'issues', items: result.potentialIssues });
    if ((result.improvements || []).length) out.push({ key: 'improve', label: 'Improvements', kind: 'list', items: result.improvements });
    if ((result.changes || []).length) out.push({ key: 'changes', label: 'What changed', kind: 'changes', items: result.changes });
    if ((result.notes || []).length) out.push({ key: 'notes', label: 'Notes', kind: 'list', items: result.notes });
    if ((result.risks || []).length) out.push({ key: 'risks', label: 'Risks', tag: 'issue', kind: 'list', items: result.risks });
    if ((result.commonMistakes || []).length) out.push({ key: 'mistakes', label: 'Common mistakes', kind: 'list', items: result.commonMistakes });
    if ((result.whenToUse || []).length) out.push({ key: 'when', label: 'When to use', kind: 'list', items: result.whenToUse });
    if ((result.whenNotToUse || []).length) out.push({ key: 'whennot', label: 'When not to use', kind: 'list', items: result.whenNotToUse });
    if (result.complexity) out.push({ key: 'complexity', label: 'Complexity', kind: 'prose', text: result.complexity });
    if (String(result.keyTakeaway || '').trim()) out.push({ key: 'takeaway', label: 'Key takeaway', kind: 'takeaway', text: result.keyTakeaway });
    if ((result.relatedTopics || []).length) out.push({ key: 'related', label: 'Related topics', kind: 'related', items: result.relatedTopics });
    return out;
  }

  function sectionAsText(section) {
    switch (section.kind) {
      case 'prose':
      case 'takeaway': return section.text;
      case 'layer': return [section.layer.body].concat(section.layer.points || []).filter(Boolean).join('\n\n');
      case 'list': return section.items.map((item) => `• ${item}`).join('\n');
      case 'steps': return section.items.map((item, i) => `${i + 1}. ${item.step}${item.detail ? ` — ${item.detail}` : ''}`).join('\n');
      case 'lines': return section.items.map((item) => `${item.line ? `${item.line}: ` : ''}${item.why}`).join('\n');
      case 'concepts': return section.items.map((item) => `${item.term}: ${item.meaning}`).join('\n');
      case 'issues': return section.items.map((item) => `[${item.severity}] ${item.description}${item.where ? ` (${item.where})` : ''}`).join('\n');
      case 'changes': return section.items.map((item) => `${item.what} — ${item.why}`).join('\n');
      case 'code': return section.item.code;
      case 'codes': return section.items.map((item) => item.code).join('\n\n');
      case 'related': return section.items.map((item) => item.name).join(', ');
      default: return '';
    }
  }

  function renderSection(section) {
    const body = build('div', { class: 'body' });
    const text = sectionAsText(section);
    const copy = build('button', { class: 'button tiny quiet', type: 'button', text: 'Copy' });
    copy.addEventListener('click', () => copyText(text, copy));

    const head = build('button', {
      class: 'collapse',
      type: 'button',
      'aria-expanded': 'true',
      'aria-controls': `body-${section.key}`,
    }, [
      build('span', { class: 'caret', text: '▾', 'aria-hidden': 'true' }),
      section.tag ? build('span', { class: `tag ${section.tag}`, text: section.tag === 'issue' ? 'REVIEW' : section.tag.toUpperCase() }) : null,
      build('span', { class: 'name', text: section.label }),
    ]);

    switch (section.kind) {
      case 'prose':
        body.appendChild(build('p', { text: section.text }));
        break;
      case 'takeaway':
        body.appendChild(build('p', { class: 'takeaway', text: section.text }));
        break;
      case 'layer':
        if (section.layer.body) body.appendChild(build('p', { class: section.lead ? 'lead' : null, text: section.layer.body }));
        if ((section.layer.points || []).length) {
          body.appendChild(build('ul', {}, section.layer.points.map((point) => build('li', { text: point }))));
        }
        break;
      case 'list':
        body.appendChild(build(section.ordered ? 'ol' : 'ul', {}, section.items.map((item) => build('li', { text: String(item) }))));
        break;
      case 'steps':
        body.appendChild(build('ol', {}, section.items.map((item) => build('li', {}, [
          build('strong', { text: item.step || '' }),
          item.detail ? build('span', { text: ` — ${item.detail}` }) : null,
        ]))));
        break;
      case 'lines':
        body.appendChild(build('ul', {}, section.items.map((item) => build('li', {}, [
          item.line ? build('code', { text: String(item.line) }) : null,
          build('span', { text: item.line ? ` — ${item.why}` : item.why }),
        ]))));
        break;
      case 'concepts':
        body.appendChild(build('dl', { class: 'concepts' }, section.items.map((item) => build('div', {}, [
          build('dt', { text: item.term }),
          build('dd', { text: item.meaning }),
        ]))));
        break;
      case 'issues':
        body.appendChild(build('ul', { class: 'issues' }, section.items.map((item) => build('li', {}, [
          build('span', { class: 'sev', 'data-sev': item.severity || 'uncertain', text: item.severity || 'uncertain' }),
          build('span', {}, [item.description, item.where ? build('span', { class: 'hint', text: ` (${item.where})` }) : null]),
        ]))));
        break;
      case 'changes':
        body.appendChild(build('ul', {}, section.items.map((item) => build('li', {}, [
          build('strong', { text: item.what }),
          item.why ? build('span', { text: ` — ${item.why}` }) : null,
        ]))));
        break;
      case 'code':
        body.appendChild(codeBlock(section.item.code, section.item.language || state.language));
        if (section.item.note) body.appendChild(build('p', { class: 'hint', text: section.item.note }));
        break;
      case 'codes':
        section.items.forEach((item) => {
          if (item.title) body.appendChild(build('p', { text: item.title }));
          body.appendChild(codeBlock(item.code, item.language || state.language));
          if (item.note) body.appendChild(build('p', { class: 'hint', text: item.note }));
        });
        break;
      case 'related':
        body.appendChild(build('div', { class: 'chips' }, section.items.map((item) => {
          const chip = build('button', { class: 'chip', type: 'button', text: item.name, title: item.why || `Explain ${item.name}` });
          chip.addEventListener('click', () => askText(item.name, 'topic'));
          return chip;
        })));
        break;
      default:
        break;
    }

    body.id = `body-${section.key}`;
    if (text) body.appendChild(build('div', { style: 'margin-top:8px' }, copy));

    head.addEventListener('click', () => {
      const open = head.getAttribute('aria-expanded') !== 'true';
      head.setAttribute('aria-expanded', String(open));
      body.hidden = !open;
    });

    return build('section', { class: 'block', 'aria-label': section.label }, [head, body]);
  }

  const FOLLOWUPS = {
    topic: [
      { label: 'Explain simpler', depth: 'quick' },
      { label: 'Go deeper', depth: 'deep' },
      { label: 'Give an example', task: 'give-example' },
      { label: 'Teach me', task: 'teach-me' },
    ],
    code: [
      { label: 'Find issues', task: 'find-issues' },
      { label: 'Simplify', task: 'simplify' },
      { label: 'Optimize', task: 'optimize' },
      { label: 'Add comments', task: 'add-comments' },
      { label: 'Generate a test', task: 'generate-test' },
      { label: 'Give an example', task: 'give-example' },
    ],
  };

  function renderResult(payload, meta) {
    const output = el('output');
    output.textContent = '';
    const result = payload;
    output.appendChild(build('h1', { class: 'title', text: result.title }));
    const bits = [
      meta.task ? String(meta.task).replace(/-/g, ' ') : '',
      `${meta.depth} depth`,
      `${meta.provider}/${meta.model}`,
    ].filter(Boolean);
    output.appendChild(build('p', { class: 'subhead', text: bits.join(' · ') }));

    const sections = sectionsFor(result);
    if (!sections.length) {
      output.appendChild(build('p', { class: 'hint', text: 'The provider answered, but there was nothing readable in it. Try again, or pick a different depth.' }));
    }
    sections.forEach((section) => output.appendChild(renderSection(section)));

    const followRow = build('div', { class: 'followups', role: 'group', 'aria-label': 'Continue from this answer' });
    (result.kind === 'code' || result.code ? FOLLOWUPS.code : FOLLOWUPS.topic).forEach((item) => {
      const button = build('button', { class: 'button quiet tiny', type: 'button', text: item.label });
      button.addEventListener('click', () => followUp(item));
      followRow.appendChild(button);
    });
    const again = build('button', { class: 'button quiet tiny', type: 'button', text: 'Regenerate' });
    again.addEventListener('click', () => runRequest(state.last));
    followRow.appendChild(again);
    output.appendChild(followRow);

    const metaRow = build('div', { class: 'meta' });
    metaRow.appendChild(build('span', {}, [build('b', { text: 'sent ' }), fmtChars(meta.context && meta.context.chars)]));
    if (meta.usage && meta.usage.outputTokens) metaRow.appendChild(build('span', {}, [build('b', { text: 'answer ' }), `${meta.usage.outputTokens} tokens`]));
    if (meta.latencyMs) metaRow.appendChild(build('span', {}, [build('b', { text: 'took ' }), `${(meta.latencyMs / 1000).toFixed(1)}s`]));
    if (meta.context && meta.context.truncated) metaRow.appendChild(build('span', { text: 'context was trimmed to fit' }));
    if ((meta.missingFields || []).length) metaRow.appendChild(build('span', { text: `this depth wanted ${meta.missingFields.length} more field(s)` }));
    const copyAll = build('button', { class: 'button tiny quiet', type: 'button', text: 'Copy the whole answer' });
    copyAll.addEventListener('click', () => copyText(sections.map(sectionAsText).filter(Boolean).join('\n\n'), copyAll));
    metaRow.appendChild(copyAll);
    output.appendChild(metaRow);
  }

  const RECOVERY = {
    CONFIGURATION_ERROR: { text: 'This server is not configured with a provider key. Nothing you type can work until its operator sets one.', action: null },
    AUTHENTICATION_ERROR: { text: 'The provider rejected this server’s key, so no answer could be made.', action: null },
    RATE_LIMIT_ERROR: { text: 'This server is rate limited so one visitor cannot spend the whole key. Wait, then try again.', action: 'retry' },
    CONTEXT_TOO_LARGE: { text: 'That is too much text for one request. Explain a smaller part — one function is usually the sweet spot.', action: 'shorten' },
    PROVIDER_ERROR: { text: 'The provider refused this model or request. Choosing a different depth sometimes helps.', action: 'retry' },
    MALFORMED_RESPONSE: { text: 'The model answered in a shape the server could not read. Regenerating usually fixes it.', action: 'retry' },
    TIMEOUT_ERROR: { text: 'The provider took too long. Try a Quick answer or regenerate.', action: 'retry' },
    NETWORK_ERROR: { text: 'The server could not reach the provider.', action: 'retry' },
    VALIDATION_ERROR: { text: 'The request was not valid, so nothing was generated and nothing was spent.', action: 'fix' },
    CANCELLED: { text: 'Cancelled.', action: null },
    UNKNOWN_ERROR: { text: 'Something unexpected happened on the server.', action: 'retry' },
  };

  function renderError(error, context) {
    const output = el('output');
    if (!context.keepAnswer) output.textContent = '';
    // An error replaces the previous one instead of stacking under it. Two rejected
    // submissions are still one problem, and a pile of identical alerts buries both
    // the retry button and the answer that is kept above them.
    output.querySelectorAll('.alert').forEach((node) => node.remove());
    const known = RECOVERY[error.code] || RECOVERY.UNKNOWN_ERROR;
    const card = build('div', { class: 'alert', role: 'alert' }, [
      build('h3', { text: known.text }),
      build('p', {}, [error.message || 'No further detail was returned.', ' ', build('code', { class: 'hint', text: error.code || 'UNKNOWN_ERROR' })]),
    ]);
    const row = build('div', { class: 'row' });
    if (known.action === 'retry' && state.last) {
      const retry = build('button', { class: 'button primary', type: 'button', text: 'Try again' });
      retry.addEventListener('click', () => runRequest(state.last));
      row.appendChild(retry);
    }
    if (known.action === 'shorten') {
      const shorter = build('button', { class: 'button quiet', type: 'button', text: 'Retry as a Quick answer' });
      shorter.addEventListener('click', () => runRequest({ ...state.last, depth: 'quick' }));
      row.appendChild(shorter);
    }
    if (known.action === 'fix') {
      el('subject').focus();
    }
    const copy = build('button', { class: 'button quiet', type: 'button', text: 'Copy details' });
    copy.addEventListener('click', () => copyText(`${error.code}: ${error.message}`, copy));
    row.appendChild(copy);
    card.appendChild(row);
    output.appendChild(card);
  }

  function setStatus(text) {
    const status = el('status');
    if (!text) {
      status.hidden = true;
      return;
    }
    status.hidden = false;
    el('status-text').textContent = text;
  }

  // ---------------------------------------------------------------- requests

  async function loadCatalog() {
    try {
      const res = await fetch('api/catalog');
      if (!res.ok) throw new Error(`catalog ${res.status}`);
      const catalog = await res.json();
      state.catalog = catalog;
      const provider = catalog.providers.find((item) => item.id === catalog.selected.providerId);
      el('provider-chip').textContent = `${provider ? provider.name : catalog.selected.providerId} · ${catalog.selected.model}`;
      const note = el('privacy-note');
      if (note) {
        note.textContent = `Runs on ${provider ? provider.name : catalog.selected.providerId} (${catalog.selected.model}). `
          + `${catalog.streaming ? 'Answers stream in as they arrive.' : 'Answers arrive complete.'}`
          + (catalog.requiresToken ? ' This deployment asks for an access token.' : '');
      }
      const select = el('language');
      if (select && select.options.length <= 1) {
        ['javascript', 'typescript', 'python', 'java', 'go', 'rust', 'c', 'cpp', 'csharp', 'php', 'ruby', 'sql', 'shell', 'html', 'css', 'other']
          .forEach((value) => select.appendChild(build('option', { value, text: value })));
      }
      renderChips();
    } catch (error) {
      const chip = el('provider-chip');
      if (chip) chip.textContent = 'backend unreachable';
      const note = el('privacy-note');
      if (note) note.textContent = 'The explanation backend is not reachable right now, so nothing can be sent.';
      renderChips();
    }
  }

  function renderChips() {
    const box = el('chips');
    if (!box) return;
    box.textContent = '';
    (state.kind === 'code' ? CODE_CHIPS : TOPIC_CHIPS).forEach((text) => {
      const chip = build('button', { class: 'chip', type: 'button', text });
      chip.addEventListener('click', () => {
        el('subject').value = text;
        askText(text, state.kind);
      });
      box.appendChild(chip);
    });
  }

  function currentRequest() {
    return {
      subject: el('subject').value.trim(),
      task: state.kind === 'code' ? 'explain-code' : 'explain-topic',
      depth: state.depth,
      language: state.kind === 'code' ? el('language').value : '',
      kind: state.kind,
    };
  }

  function askText(text, kind) {
    state.kind = kind || state.kind;
    syncKindControls();
    el('subject').value = text;
    runRequest({ ...currentRequest(), subject: text });
  }

  function followUp(item) {
    if (!state.last) return;
    runRequest({
      subject: state.last.subject,
      task: item.task || (state.last.kind === 'code' ? 'explain-code' : 'explain-topic'),
      depth: item.depth || state.last.depth,
      language: state.last.language,
      kind: state.last.kind,
    });
  }

  async function runRequest(request) {
    if (!request || !request.subject) {
      setStatus('');
      renderError({ code: 'VALIDATION_ERROR', message: 'Type a question or paste some code first.' }, { keepAnswer: true });
      return;
    }
    if (state.busy) return;
    state.busy = true;
    state.last = request;
    el('go').disabled = true;
    el('stop').hidden = false;
    setStatus('Reading your request…');

    const controller = new AbortController();
    state.controller = controller;
    const started = Date.now();

    try {
      const payload = await postExplain(request, controller.signal, (piece, buffer) => {
        setStatus('Building the explanation…');
        showDraft(buffer);
      });
      setStatus('');
      renderResult(payload.result, payload.meta);
    } catch (error) {
      setStatus('');
      if (error.name === 'AbortError') {
        el('output').textContent = '';
        renderError({ code: 'CANCELLED', message: 'Cancelled — no answer was kept.' }, { keepAnswer: false });
      } else {
        el('output').textContent = '';
        renderError(mapFailure(error), { keepAnswer: false });
      }
    } finally {
      state.busy = false;
      state.controller = null;
      el('go').disabled = false;
      el('stop').hidden = true;
      const took = Date.now() - started;
      el('footnote').textContent = took > 1000 ? `Last round trip: ${(took / 1000).toFixed(1)}s` : '';
    }
  }

  function mapFailure(error) {
    if (error && error.code) return error;
    if (error instanceof TypeError) {
      return { code: 'NETWORK_ERROR', message: 'The browser could not reach this server.', retryable: true };
    }
    return { code: 'UNKNOWN_ERROR', message: String((error && error.message) || error).slice(0, 200) };
  }

  // Uses SSE when the backend advertises it and the browser can read a stream;
  // otherwise a plain POST. No timers are used to pad either path.
  async function postExplain(request, signal, onDelta) {
    const body = JSON.stringify({
      subject: request.subject,
      task: request.task,
      depth: request.depth,
      language: request.language,
    });
    const headers = { 'Content-Type': 'application/json' };
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    const canStream = state.catalog && state.catalog.streaming && typeof ReadableStream === 'function' && window.fetch;

    const res = await fetch(canStream ? 'api/explain/stream' : 'api/explain', {
      method: 'POST',
      headers,
      body,
      signal,
    });

    if (res.status === 401 && state.catalog && state.catalog.requiresToken && !state.token) {
      const token = window.prompt('This endpoint needs an access token. Paste it:');
      if (token) {
        state.token = token.trim();
        sessionStorage.setItem('eis.token', state.token);
        return postExplain(request, signal, onDelta);
      }
    }

    const contentType = res.headers.get('content-type') || '';
    if (res.ok && contentType.includes('text/event-stream') && res.body) {
      const events = await readSse(res.body, onDelta, signal);
      const failed = events.find((event) => event.name === 'error');
      if (failed) throw { code: failed.data.code || 'PROVIDER_ERROR', message: failed.data.message || 'The stream failed.' };
      const done = events.find((event) => event.name === 'result');
      if (!done) throw { code: 'MALFORMED_RESPONSE', message: 'The stream ended before an answer arrived.' };
      return done.data;
    }

    let parsed = null;
    try {
      parsed = await res.json();
    } catch (error) {
      throw { code: 'MALFORMED_RESPONSE', message: `The server replied with ${res.status} and no readable body.` };
    }
    if (!res.ok || !parsed || parsed.ok === false) {
      const err = (parsed && parsed.error) || {};
      throw { code: err.code || `HTTP_${res.status}`, message: err.message || `The server responded ${res.status}.`, status: res.status };
    }
    return parsed;
  }

  async function readSse(body, onDelta, signal) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const events = [];
    let raw = '';
    for (;;) {
      if (signal.aborted) break;
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const nameMatch = /event: (\S+)/.exec(frame);
        const dataMatch = /data: ([\s\S]+)/.exec(frame);
        if (!nameMatch || !dataMatch) continue;
        let data = null;
        try {
          data = JSON.parse(dataMatch[1]);
        } catch (error) {
          continue;
        }
        events.push({ name: nameMatch[1], data });
        if (nameMatch[1] === 'delta') {
          raw += data.text;
          onDelta(data.text, raw);
        }
      }
    }
    return events;
  }

  function showDraft(raw) {
    const output = el('output');
    if (!output.querySelector('.draft')) {
      output.textContent = '';
      output.appendChild(build('p', { class: 'hint', text: 'Answer arriving — the structured version replaces this preview when it validates.' }));
      output.appendChild(build('pre', { class: 'draft hint', style: 'white-space:pre-wrap;font-family:var(--mono);font-size:.8rem', text: '' }));
    }
    output.querySelector('.draft').textContent = raw.slice(-900);
  }

  // -------------------------------------------------------------------- voice

  function setupVoice() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const button = el('mic');
    const note = el('mic-note');
    if (!Recognition) {
      button.disabled = true;
      button.setAttribute('aria-disabled', 'true');
      note.textContent = 'Dictation is not supported in this browser — Chrome, Edge or Safari work.';
      return;
    }
    note.textContent = '';
    button.addEventListener('click', () => {
      if (state.listening) {
        stopVoice('Cancelled — nothing was entered.');
        return;
      }
      state.mic = new Recognition();
      state.mic.lang = navigator.language || 'en-US';
      state.mic.interimResults = true;
      state.mic.continuous = false;
      state.mic.onstart = () => {
        state.listening = true;
        button.setAttribute('aria-pressed', 'true');
        el('mic-label').textContent = 'Listening';
        setStatus('Listening — speak your question.');
      };
      state.mic.onresult = (event) => {
        const transcript = Array.from(event.results).map((result) => result[0].transcript).join('');
        el('subject').value = transcript;
      };
      state.mic.onerror = (event) => {
        const reasons = { 'not-allowed': 'The browser blocked microphone access.', 'no-speech': 'No speech was detected.', 'service-not-allowed': 'Dictation is unavailable in this context.', aborted: 'Dictation stopped.' };
        stopVoice(reasons[event.error] || `Dictation failed (${event.error}).`);
      };
      state.mic.onend = () => {
        if (!state.listening) return;
        stopVoice(el('subject').value.trim() ? 'Heard you. Press Explain when ready.' : 'Nothing was captured.');
        if (el('subject').value.trim()) runRequest(currentRequest());
      };
      try {
        state.mic.start();
      } catch (error) {
        stopVoice('Dictation could not start.');
      }
    });
  }

  function stopVoice(message) {
    state.listening = false;
    el('mic').setAttribute('aria-pressed', 'false');
    el('mic-label').textContent = 'Speak';
    if (state.mic) {
      try {
        state.mic.stop();
      } catch (error) {
        /* already stopped */
      }
      state.mic = null;
    }
    setStatus('');
    el('mic-note').textContent = message || '';
  }

  // ------------------------------------------------------------------- wiring

  function syncKindControls() {
    el('kind-topic').setAttribute('aria-pressed', String(state.kind === 'topic'));
    el('kind-code').setAttribute('aria-pressed', String(state.kind === 'code'));
    el('language').hidden = state.kind !== 'code';
    el('subject').spellcheck = state.kind !== 'code';
    el('ask-label').textContent = state.kind === 'code' ? 'Code to explain' : 'Concept or question';
    el('subject').placeholder = state.kind === 'code'
      ? 'Paste the function, script or query you want explained.'
      : 'e.g. What is a race condition, and why does it bite in JavaScript servers?';
    renderChips();
  }

  function boot() {
    if (!el('go')) return;
    el('go').addEventListener('click', () => runRequest(currentRequest()));
    el('stop').addEventListener('click', () => {
      if (state.controller) {
        state.controller.abort();
        setStatus('');
      }
    });
    el('kind-topic').addEventListener('click', () => { state.kind = 'topic'; syncKindControls(); });
    el('kind-code').addEventListener('click', () => { state.kind = 'code'; syncKindControls(); });
    document.querySelectorAll('[data-depth]').forEach((button) => {
      button.addEventListener('click', () => {
        state.depth = button.getAttribute('data-depth');
        document.querySelectorAll('[data-depth]').forEach((other) => other.setAttribute('aria-pressed', String(other === button)));
      });
    });
    el('subject').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        runRequest(currentRequest());
      }
      if (event.key === 'Escape' && state.busy && state.controller) state.controller.abort();
    });
    const empty = el('output');
    empty.textContent = '';
    empty.appendChild(build('div', { class: 'empty' }, [
      build('h2', { text: 'Ask, then read the layer you need' }),
      build('p', { class: 'hint', text: 'Type a concept or paste code above. Every answer comes in two layers — a plain-language one and a technical one — and Deep dive adds mechanism, examples, concepts and the mistakes people actually make.' }),
      build('p', { class: 'hint', text: 'Nothing is sent until you press Explain.' }),
    ]));
    setupVoice();
    syncKindControls();
    loadCatalog();
  }

  if (typeof document !== 'undefined' && document.getElementById('go')) boot();
  if (typeof window !== 'undefined') window.EisApp = { sectionsFor, tokenize, sectionAsText, RECOVERY, currentRequest };
})();
