'use strict';
// Persistent history in globalState. What gets stored is governed by the privacy
// settings: an explanation can be kept without keeping the user's source code.
// API keys are never part of a history entry, and any key-shaped string that
// somehow arrives in the text is scrubbed.

const STORE_KEY = 'eis.history';
const MAX_SUMMARY_CHARS = 160;

const KEY_SHAPED = [
  /AIza[0-9A-Za-z_-]{20,}/g,
  /sk-(?!ant)[A-Za-z0-9_-]{20,}/g,
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /gsk_[A-Za-z0-9_-]{20,}/g,
];

function scrub(value) {
  if (typeof value !== 'string') return value;
  return KEY_SHAPED.reduce((text, pattern) => text.replace(pattern, '[redacted-key]'), value);
}

function scrubDeep(value) {
  if (typeof value === 'string') return scrub(value);
  if (Array.isArray(value)) return value.map(scrubDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (/api.?key|token|secret|authorization/i.test(key)) continue;
      out[key] = scrubDeep(child);
    }
    return out;
  }
  return value;
}

// codeRetention decides how much of the input survives in storage.
function subjectExcerpt(input, retention) {
  if (!input) return '';
  if (retention === 'none') return '';
  const language = input.language ? ` (${input.language})` : '';
  if (retention === 'summary') {
    return scrub(`${input.fileName || 'untitled'}${language}: ${String(input.subject || '').slice(0, MAX_SUMMARY_CHARS)}`);
  }
  return scrub(String(input.subject || '').slice(0, 4000));
}

class HistoryService {
  constructor(context, settingsManager) {
    this._state = context.globalState;
    this._settings = settingsManager;
  }

  _readAll() {
    const stored = this._state.get(STORE_KEY);
    return Array.isArray(stored) ? stored : [];
  }

  async list({ query = '', pinnedOnly = false } = {}) {
    if (!this._settings.advanced.historyEnabled) return [];
    const items = this._readAll();
    const needle = String(query).trim().toLowerCase();
    return items
      .filter((item) => (pinnedOnly ? item.pinned : true))
      .filter((item) => {
        if (!needle) return true;
        const haystack = `${item.title} ${item.excerpt} ${item.subject}`.toLowerCase();
        return haystack.includes(needle);
      });
  }

  async get(id) {
    return this._readAll().find((item) => item.id === id) || null;
  }

  async add({ request, result, meta, input }) {
    const advanced = this._settings.advanced;
    if (!advanced.historyEnabled || advanced.historyLimit === 0) return null;

    const entry = {
      id: meta.requestId || `h-${Date.now()}`,
      savedAt: Date.now(),
      task: request.task,
      kind: result.kind || request.kind,
      depth: request.depth,
      provider: meta.provider,
      model: meta.model,
      title: result.title,
      // Kept separately from `result` so the privacy setting is auditable.
      subject: subjectExcerpt(input, advanced.codeRetention),
      // The preview is derived from model text, so it is scrubbed like the rest.
      excerpt: scrub(String(result.summary || result.keyTakeaway || '').slice(0, MAX_SUMMARY_CHARS)),
      result: scrubDeep(result),
      pinned: false,
      contextParts: (meta.context?.manifest || []).map((part) => part.part),
      tokenEstimate: meta.context?.estTokens || 0,
    };

    const items = [entry, ...this._readAll()];
    const kept = items.filter((item, index, all) => all.findIndex((other) => other.id === item.id) === index);
    // Pinned items never fall off the end of the list.
    const limit = Math.max(1, advanced.historyLimit);
    const pinned = kept.filter((item) => item.pinned);
    const rest = kept.filter((item) => !item.pinned);
    const next = [...pinned.slice(0, limit), ...rest.slice(0, Math.max(0, limit - Math.min(pinned.length, limit)))];
    await this._state.update(STORE_KEY, next);
    return entry;
  }

  async remove(id) {
    await this._state.update(STORE_KEY, this._readAll().filter((item) => item.id !== id));
  }

  async clear({ keepPinned = false } = {}) {
    const items = this._readAll();
    await this._state.update(STORE_KEY, keepPinned ? items.filter((item) => item.pinned) : []);
  }

  async setPinned(id, pinned) {
    const items = this._readAll().map((item) => (item.id === id ? { ...item, pinned: !!pinned } : item));
    await this._state.update(STORE_KEY, items);
  }

  async count() {
    return this._readAll().length;
  }

  sizeBytes() {
    // The panel labels this "bytes"; a UTF-16 string length is not that, and the
    // difference is large for non-ASCII source.
    return Buffer.byteLength(JSON.stringify(this._readAll()), 'utf8');
  }
}

module.exports = { HistoryService, STORE_KEY, subjectExcerpt, scrub, scrubDeep };
