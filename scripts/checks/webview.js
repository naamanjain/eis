'use strict';
// Webview render gate: the panel's client script is executed against a minimal
// DOM, so these checks read what actually rendered rather than grepping source.
// A screen that throws on open would fail here, not only in a real VS Code window.

const fs = require('fs');
const path = require('path');

function makeNode(tag) {
  const node = {
    tag,
    attrs: {},
    children: [],
    listeners: {},
    className: '',
    textContent: '',
    setAttribute(name, value) { this.attrs[name] = String(value); },
    appendChild(child) { this.children.push(child); return child; },
    removeChild(child) { this.children = this.children.filter((item) => item !== child); },
    addEventListener(type, handler) { (this.listeners[type] = this.listeners[type] || []).push(handler); },
  };
  Object.defineProperty(node, 'firstChild', { get() { return this.children[0] || null; } });
  return node;
}

function walk(node, out = []) {
  for (const child of node.children || []) {
    out.push(child);
    walk(child, out);
  }
  return out;
}

// textContent of a subtree: fake-DOM nodes store text on the leaf they were given.
function textOf(node) {
  if (node.textContent) return node.textContent;
  return walk(node, []).map((child) => child.textContent).filter(Boolean).join(' ');
}

function mount({ EXT_DIR }) {
  const root = makeNode('div');
  // The toast host: markCopied()/notify() write it, so a check can read it.
  const copied = makeNode('div');
  const byId = { app: root, copied };
  const document = {
    body: makeNode('body'),
    createElement: (tag) => makeNode(tag),
    createElementNS: (_ns, tag) => makeNode(tag),
    createTextNode: (text) => {
      const node = makeNode('#text');
      node.textContent = String(text);
      return node;
    },
    getElementById: (id) => byId[id] || null,
  };
  const posted = [];
  const handlers = {};
  globalThis.document = document;
  globalThis.window = { addEventListener: (type, handler) => { handlers[type] = handler; } };
  globalThis.acquireVsCodeApi = () => ({ postMessage: (message) => posted.push(message) });

  const source = fs.readFileSync(path.join(EXT_DIR, 'webview', 'client.js'), 'utf8');
  new Function(source)();

  return {
    root,
    posted,
    byId: (id) => byId[id] || null,
    send: (data) => handlers.message({ data }),
    key: (data) => handlers.keydown({ ...data, preventDefault() {} }),
    dispose() {
      delete globalThis.document;
      delete globalThis.window;
      delete globalThis.acquireVsCodeApi;
    },
  };
}

async function run(ctx) {
  const { check, assert, setGroup, SHARED, EXT_DIR } = ctx;
  const registry = require(path.join(SHARED, 'providers/registry.js'));
  setGroup('webview');

  // Navigate the way a reader does, so a broken tab is caught rather than bypassed.
  const clickTab = (ui, label) => {
    const button = walk(ui.root).find((node) => node.tag === 'button'
      && new RegExp(label, 'i').test(textOf(node)));
    assert.ok(button, `no '${label}' control rendered`);
    button.listeners.click[0]({ preventDefault() {}, target: button });
    return button;
  };

  const catalog = (providerId) => ({
    ...registry.toPublicConfig(),
    selected: { providerId, model: registry.defaultModelFor(providerId) },
    keysConfiguredFor: [providerId],
  });

  const openRouter = () => {
    const live = ['ghost/model'];
    for (let i = 0; i < 461; i++) live.push(`vendor/model-${i}`);
    return { live, merged: registry.mergeLiveModels('openrouter', live) };
  };

  const MODEL_SAMPLE = {
    version: 2,
    kind: 'topic',
    depth: 'balanced',
    title: 'Recursion',
    summary: 'A function that calls itself.',
    simpleExplanation: { heading: 'Simply', body: 'It repeats itself until it stops.', points: ['Base case first'] },
    technicalExplanation: { heading: 'Technically', body: 'Stack frames.', points: [] },
    keyTakeaway: 'Every recursive call needs a stopping condition.',
  };

  await check('the setup screen folds the provider list and renders every provider', () => {
    const ui = mount(ctx);
    try {
      ui.send({ type: 'bootstrap', catalog: catalog('google'), history: [], historyBytes: 0 });
      ui.send({ type: 'screen', screen: 'setup' });
      const providers = registry.listProviders();
      const cardsNow = () => walk(ui.root).filter((node) => node.className === 'card');
      // Collapsed by default: six cards in a 297px rail pushed the key field two
      // screens down, which is what read as "complicated".
      assert.strictEqual(cardsNow().length, 0, 'the provider wall is open by default');
      assert.ok(walk(ui.root).some((node) => node.className === 'pick'), 'no selected-provider row rendered');

      for (const [index, provider] of providers.entries()) {
        clickTab(ui, 'Show all');
        const cards = cardsNow();
        assert.strictEqual(cards.length, providers.length, `rendered ${cards.length} provider cards for ${providers.length} providers`);
        // Clicking the card is the only way to switch: it must re-render, not post.
        cards[index].listeners.click[0]({});
        assert.strictEqual(cardsNow().length, 0, `${provider.id}: the wall stayed open after a pick`);
        const nodes = walk(ui.root);
        const select = nodes.find((node) => node.tag === 'select' && node.attrs.id === 'model-select');
        assert.ok(select, `${provider.id}: no model dropdown rendered`);
        assert.strictEqual(
          select.children.length,
          provider.models.length,
          `${provider.id}: dropdown shows ${select.children.length}, catalogue has ${provider.models.length}`,
        );
        const chosen = select.children.filter((node) => node.attrs.selected === 'true');
        assert.strictEqual(chosen.length, 1, `${provider.id}: ${chosen.length} options marked selected`);
        // The pre-existing bug this caught: switching provider kept the stored model,
        // which belongs to a different vendor, and posted it as the new one.
        assert.ok(
          provider.models.some((model) => model.id === chosen[0].attrs.value),
          `${provider.id}: selected ${chosen[0].attrs.value} is another provider's model`,
        );
        const key = nodes.find((node) => node.tag === 'input' && node.attrs.id === 'key-input');
        assert.strictEqual(key.attrs.type, 'password', `${provider.id}: the key field is not masked`);
        assert.ok(
          nodes.some((node) => node.textContent.includes(provider.name)),
          `${provider.id}: the provider name is missing from its own setup panel`,
        );
      }
    } finally {
      ui.dispose();
    }
  });

  await check('a 462-model live list renders as 43 options plus a typed-id field', () => {
    const ui = mount(ctx);
    try {
      const { live, merged } = openRouter();
      ui.send({ type: 'bootstrap', catalog: catalog('openrouter'), history: [], historyBytes: 0 });
      ui.send({ type: 'screen', screen: 'setup' });
      const before = walk(ui.root).find((node) => node.tag === 'select' && node.attrs.id === 'model-select');
      assert.strictEqual(before.children.length, registry.listModels('openrouter').length, 'curated list was padded');

      ui.send({
        type: 'models.refreshed',
        ok: true,
        providerId: 'openrouter',
        models: merged.models,
        hiddenCount: merged.hiddenCount,
      });
      const nodes = walk(ui.root);
      const select = nodes.find((node) => node.tag === 'select' && node.attrs.id === 'model-select');
      assert.strictEqual(live.length, 462);
      assert.strictEqual(
        select.children.length,
        registry.listModels('openrouter').length + registry.LIVE_DISPLAY_CAP,
        `a ${live.length}-id response rendered ${select.children.length} options`,
      );
      const note = nodes.filter((node) => node.className === 'note').map((node) => node.textContent).join(' | ');
      assert.ok(
        note.includes(`${merged.hiddenCount} paid ids are not listed`),
        `surplus not surfaced to the reader: ${note}`,
      );
      const typed = nodes.find((node) => node.tag === 'input' && node.attrs.id === 'model-filter');
      assert.ok(typed, 'no field for filtering or typing a model id');

      // Typing an id that exists only upstream has to become a selectable option.
      typed.listeners.input[0]({ target: { value: 'google/gemma-4-31b-it:free' } });
      ui.send({ type: 'screen', screen: 'setup' });
      const reopened = walk(ui.root).find((node) => node.tag === 'select' && node.attrs.id === 'model-select');
      const chosen = reopened.children.find((node) => node.attrs.value === 'google/gemma-4-31b-it:free');
      assert.ok(chosen, 'a typed id vanished from the dropdown');
      assert.match(chosen.textContent, /unconfirmed/, 'a typed id was not marked unverified');
      // el() stringifies props, and any non-empty `selected` value selects an option.
      assert.strictEqual(chosen.attrs.selected, 'true', 'the typed id was not the selected option');
    } finally {
      ui.dispose();
    }
  });

  await check('the model box labels free routes, filters, and can show only them', () => {
    const ui = mount(ctx);
    try {
      ui.send({ type: 'bootstrap', catalog: catalog('openrouter'), history: [], historyBytes: 0 });
      ui.send({ type: 'screen', screen: 'setup' });
      ui.send({
        type: 'models.refreshed',
        ok: true,
        providerId: 'openrouter',
        liveCount: 470,
        freeCount: 3,
        hiddenCount: 408,
        models: [
          { id: 'anthropic/claude-sonnet-5.5', name: 'Claude Sonnet 5.5', free: false, contextWindow: '1M' },
          { id: 'cohere/north-mini-code:free', name: 'Cohere: North Mini Code (free)', free: true, contextWindow: '256K' },
          { id: 'nvidia/nemotron-3.5-super-vl:free', name: 'Nemotron 3.5 Super VL', free: true, contextWindow: '128K' },
          { id: 'poolside/laguna-s:free', name: 'Laguna S', free: true, contextWindow: '32K' },
        ],
      });
      const labels = () => walk(ui.root).filter((node) => node.tag === 'option').map((node) => node.textContent);
      assert.ok(
        labels().some((text) => /Nemotron 3\.5 Super VL — free · 128K/.test(text)),
        `free routes not labelled: ${labels().join(' | ')}`,
      );
      assert.ok(
        !labels().some((text) => /\(free\).*—.*\bfree\b/i.test(text)),
        `the word free is repeated in one row: ${labels().join(' | ')}`,
      );
      assert.ok(
        labels().some((text) => /Cohere: North Mini Code \(free\) — 256K/.test(text)),
        `a provider whose name already says free was still tagged: ${labels().join(' | ')}`,
      );
      const notes = () => walk(ui.root).filter((node) => node.className === 'note').map((node) => node.textContent).join(' ');
      assert.match(notes(), /470 ids at the provider, 3 free\. Listed here: 4 \(3 free\)/);
      assert.match(notes(), /408 paid ids are not listed/);

      // Typing narrows the list without stealing the selection.
      const box = walk(ui.root).find((node) => node.tag === 'input' && node.attrs.id === 'model-filter');
      box.listeners.input[0]({ target: { value: 'laguna' } });
      ui.send({ type: 'screen', screen: 'setup' });
      assert.deepStrictEqual(
        labels().map((text) => text.split(' —')[0]),
        ['Claude Sonnet 5.5', 'Laguna S'],
        `the filter box did not narrow to the match: ${labels().join(' | ')}`,
      );

      const freeOnly = walk(ui.root).find((node) => node.tag === 'button' && /Free only/.test(textOf(node)));
      assert.ok(freeOnly, 'no free-only control');
      freeOnly.listeners.click[0]({ preventDefault() {}, target: freeOnly });
      const remaining = labels();
      assert.ok(remaining.length, 'free-only emptied the list');
      assert.ok(remaining.every((text) => /free/.test(text)), `free-only kept a paid id: ${remaining.join(' | ')}`);
    } finally {
      ui.dispose();
    }
  });

  await check('the settings screen posts no control the host must reject', () => {
    const ui = mount(ctx);
    try {
      ui.send({ type: 'bootstrap', catalog: catalog('openrouter'), history: [], historyBytes: 0 });
      ui.send({ type: 'screen', screen: 'settings' });
      const advanced = walk(ui.root).find((node) => node.tag === 'button' && /Advanced settings/.test(textOf(node)));
      assert.ok(advanced, 'the Advanced settings control disappeared from the settings screen');
      const before = ui.posted.length;
      advanced.listeners.click[0]({ preventDefault() {}, target: advanced });
      const sent = ui.posted.slice(before);
      assert.ok(sent.some((message) => message.type === 'openSettings'),
        `clicking Advanced settings posted ${JSON.stringify(sent)} instead of opening settings`);
      // The host allowlists every open URL against the provider key pages, so an empty
      // url is not a no-op — it is a guaranteed error toast on a visible button.
      assert.ok(!sent.some((message) => message.type === 'open' && !message.url),
        'a button posted an empty open URL, which the allowlist always rejects');
    } finally {
      ui.dispose();
    }
  });

  await check('the model list offers Refresh only to providers that can list models', () => {
    // Anthropic publishes no model endpoint, so an unconditional Refresh button there
    // was a control that could only fail.
    for (const [id, canList] of [['anthropic', false], ['openrouter', true], ['google', true]]) {
      const ui = mount(ctx);
      try {
        ui.send({ type: 'bootstrap', catalog: catalog(id), history: [], historyBytes: 0 });
        ui.send({ type: 'screen', screen: 'setup' });
        const has = walk(ui.root).some((node) => node.tag === 'button' && /Refresh/.test(textOf(node)));
        assert.strictEqual(has, canList, `${id}: Refresh rendered=${has} but provider listModels=${canList}`);
      } finally {
        ui.dispose();
      }
    }
  });

  await check('a typed id is posted as the chosen model when saving', () => {
    const ui = mount(ctx);
    try {
      ui.send({ type: 'bootstrap', catalog: catalog('openrouter'), history: [], historyBytes: 0 });
      ui.send({ type: 'screen', screen: 'setup' });
      const nodes = walk(ui.root);
      const typed = nodes.find((node) => node.tag === 'input' && node.attrs.id === 'model-filter');
      typed.listeners.input[0]({ target: { value: 'moonshotai/kimi-k3' } });
      const key = nodes.find((node) => node.tag === 'input' && node.attrs.id === 'key-input');
      // Built at runtime: a literal here would look like a real key to the secret scan.
      key.listeners.input[0]({ target: { value: ['sk', '-or-', 'typedfixture'].join('') } });
      const save = walk(ui.root).find(
        (node) => node.tag === 'button' && /save and start/i.test(textOf(node)),
      );
      assert.ok(save, 'no save button rendered');
      save.listeners.click[0]({});
      const saved = ui.posted.filter((message) => message.type === 'saveSettings').pop();
      assert.ok(saved, 'saving posted nothing');
      assert.strictEqual(saved.model, 'moonshotai/kimi-k3', 'the typed id was not what got saved');
      assert.strictEqual(saved.providerId, 'openrouter');
    } finally {
      ui.dispose();
    }
  });

  await check('model text becomes text nodes, never markup', () => {
    const ui = mount(ctx);
    try {
      const hostile = { ...MODEL_SAMPLE, title: '<img src=x onerror=alert(1)>' };
      ui.send({ type: 'bootstrap', catalog: catalog('google'), history: [], historyBytes: 0 });
      ui.send({ type: 'started', requestId: 'r1', mode: 'selection' });
      ui.send({ type: 'result', requestId: 'r1', result: hostile, meta: { requestId: 'r1', provider: 'google', model: 'gemini-3.8-flash' }, historyId: 'h1' });
      const nodes = walk(ui.root);
      assert.ok(
        nodes.some((node) => node.textContent === '<img src=x onerror=alert(1)>'),
        'the hostile title was not rendered as literal text',
      );
      assert.ok(
        !nodes.some((node) => node.tag === 'img' || node.tag === 'script'),
        'a tag was created from model text',
      );
      assert.ok(nodes.some((node) => node.attrs.role === 'region'), 'the result region lost its role');
    } finally {
      ui.dispose();
    }
  });

  await check('every tab renders with a result, an error and nothing at all', () => {
    const ui = mount(ctx);
    try {
      ui.send({ type: 'bootstrap', catalog: catalog('google'), history: [{ id: 'h1', title: 'Recursion', provider: 'google', model: 'gemini-3.8-flash', at: Date.now() }], historyBytes: 120 });
      for (const label of ['Explain', 'Audit', 'History', 'Setup', 'Settings']) {
        clickTab(ui, label);
        assert.ok(walk(ui.root).length > 10, `${label}: rendered an empty screen`);
      }
      ui.send({ type: 'started', requestId: 'r2', mode: 'selection' });
      ui.send({
        type: 'error',
        error: { code: 'MODEL_UNAVAILABLE', message: 'This model is unavailable.', recovery: 'change-model', retryable: false },
      });
      ui.send({ type: 'screen', screen: 'main' });
      const nodes = walk(ui.root);
      assert.ok(nodes.some((node) => node.textContent.includes('This model is unavailable.')), 'the error text was not shown');
      assert.ok(
        nodes.some((node) => node.tag === 'button' && /change model/i.test(textOf(node))),
        'the error offered no way to change model',
      );
    } finally {
      ui.dispose();
    }
  });
  await check('the layout chain bounds the document so nothing is clipped', () => {
    const css = fs.readFileSync(path.join(EXT_DIR, 'webview', 'styles.css'), 'utf8');
    const client = fs.readFileSync(path.join(EXT_DIR, 'webview', 'client.js'), 'utf8');
    const rule = (selector) => {
      const match = new RegExp(`(?:^|\\n)${selector}\\s*\\{([^}]*)\\}`).exec(css);
      return match ? match[1] : '';
    };
    // body clips, so every flex item between it and the scroller has to promise it can
    // shrink. A missing min-height:0 makes the item content-sized and the overflow
    // unreachable — measured in a real window as a 1308px #app in a 662px sidebar.
    assert.match(css, /\nbody\s*\{[^}]*overflow:\s*hidden/, 'body no longer clips, so the chain is not the scroller');
    assert.match(rule('#app'), /display:\s*flex/, '#app is not a flex column, so main never gets a bounded height');
    assert.match(rule('#app'), /flex:[^;]*1[^;]*auto|min-height:\s*0/, '#app is not free to shrink to the viewport');
    assert.match(rule('#app'), /min-height:\s*0/, '#app has no min-height: 0 and will overflow the clipped body');
    assert.match(rule('main'), /min-height:\s*0/, 'main has no min-height: 0');
    assert.match(rule('.screen'), /min-height:\s*0/, 'the active screen has no min-height: 0');
    assert.match(rule('.scroll'), /overflow:\s*auto/, '.scroll is not the scroller');
    // Sideways it is the same failure: a row flex item will not shrink below its
    // min-content width, so one long <select> label measured 343px inside a 297px rail
    // and cut the right edge off every card.
    assert.match(rule('main'), /min-width:\s*0/, 'main can refuse to shrink below its content width');
    assert.match(rule('.screen'), /min-width:\s*0/, 'the screen can refuse to shrink below its content width');
    assert.match(rule('.field input, \\.field select'), /min-width:\s*0/, 'a long option can widen the whole screen');
    // View mode used to be guessed from body attributes VS Code does not set; the chain
    // above is the same for both surfaces, which a real window now measures.
    assert.ok(!/as-view/.test(css) && !/as-view/.test(client), 'the as-view mechanism came back');
    assert.match(rule('.cards'), /minmax\(150px/, 'provider cards lost their grid');
  });

  await check('a superseded request cannot cancel the one on screen', () => {
    const ui = mount(ctx);
    try {
      ui.send({ type: 'bootstrap', catalog: catalog('google'), history: [], historyBytes: 0 });
      ui.send({ type: 'started', requestId: 'r1', mode: 'selection' });
      ui.send({ type: 'started', requestId: 'r2', mode: 'file' });
      ui.send({ type: 'cancelled', requestId: 'r1' });
      const nodes = walk(ui.root);
      const cancel = nodes.find((node) => node.tag === 'button' && /cancel/i.test(textOf(node)));
      assert.ok(cancel, 'the live request lost its Cancel button when an older one was cancelled');
      const texts = nodes.map((node) => node.textContent).filter(Boolean);
      assert.ok(!texts.some((text) => /Cancelled\.$/.test(text)), 'the stale cancellation was shown over the live run');
      // A terminal message for the CURRENT request must still be honoured.
      ui.send({ type: 'cancelled', requestId: 'r2' });
      const after = walk(ui.root).map((node) => node.textContent).filter(Boolean);
      assert.ok(after.some((text) => /Cancelled\./.test(text)), 'the real cancellation was ignored');
    } finally {
      ui.dispose();
    }
  });

  await check('an adopted result renders even with no matching start', () => {
    const ui = mount(ctx);
    try {
      ui.send({ type: 'bootstrap', catalog: catalog('google'), history: [], historyBytes: 0 });
      // Reopening history (or a surface joining late) has no `started` to match on.
      ui.send({ type: 'result', requestId: 'history:abc', adopt: true, result: MODEL_SAMPLE, meta: { requestId: 'history:abc', fromHistory: true } });
      assert.ok(walk(ui.root).some((node) => node.textContent === 'Recursion'), 'an adopted result was dropped');
      // Without adopt, a foreign request id must stay ignored.
      const fresh = mount(ctx);
      try {
        fresh.send({ type: 'bootstrap', catalog: catalog('google'), history: [], historyBytes: 0 });
        fresh.send({ type: 'result', requestId: 'someone-elses', result: { ...MODEL_SAMPLE, title: 'Should Not Appear' }, meta: {} });
        assert.ok(!walk(fresh.root).some((node) => node.textContent === 'Should Not Appear'), 'a stale result overwrote the screen');
      } finally {
        fresh.dispose();
      }
    } finally {
      ui.dispose();
    }
  });

  await check('the surrounding-lines switch shows the value settings actually report', () => {
    const ui = mount(ctx);
    try {
      const withAdvanced = { ...catalog('google'), advanced: { includeSurroundingContext: true } };
      ui.send({ type: 'bootstrap', catalog: withAdvanced, history: [], historyBytes: 0 });
      clickTab(ui, 'Settings');
      const switches = walk(ui.root).filter((node) => node.attrs.role === 'switch');
      const surrounding = switches.find((node) => /surrounding/i.test(node.attrs['aria-label'] || ''));
      assert.ok(surrounding, 'no surrounding-lines switch rendered');
      assert.strictEqual(surrounding.attrs['aria-checked'], 'true', 'the switch ignored the real setting');
      const off = mount(ctx);
      try {
        off.send({ type: 'bootstrap', catalog: { ...catalog('google'), advanced: { includeSurroundingContext: false } }, history: [], historyBytes: 0 });
        clickTab(off, 'Settings');
        const offSwitch = walk(off.root).filter((node) => node.attrs.role === 'switch').find((node) => /surrounding/i.test(node.attrs['aria-label'] || ''));
        assert.strictEqual(offSwitch.attrs['aria-checked'], 'false', 'the switch cannot show off');
      } finally {
        off.dispose();
      }
    } finally {
      ui.dispose();
    }
  });

  await check('applying a rewrite reports back where the reader is looking', () => {
    const ui = mount(ctx);
    try {
      ui.send({ type: 'bootstrap', catalog: catalog('google'), history: [], historyBytes: 0 });
      ui.send({ type: 'apply.result', ok: true, message: 'Replaced the selection. Undo with Ctrl+Z.' });
      const toast = ui.byId('copied');
      assert.strictEqual(toast.textContent, 'Replaced the selection. Undo with Ctrl+Z.', 'the apply result was not surfaced');
      assert.strictEqual(toast.attrs['data-kind'], 'ok', 'a successful apply was not marked ok');
    } finally {
      ui.dispose();
    }
  });
}

module.exports = { run, mount, walk, textOf };
