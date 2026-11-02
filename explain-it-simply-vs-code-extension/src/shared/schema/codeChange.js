/* Vendored from ../shared/schema/codeChange.js — do not edit here; run `npm run vendor`. */
'use strict';
// CodeChange: the contract for actions that rewrite code (simplify, optimize,
// comment, test) rather than explain it. Kept separate from Explanation so the
// UI never has to guess whether `code` exists.

const { normalizeList } = require('./util');

const LIMITS = {
  code: 20_000,
  note: 500,
  items: 10,
};

const CODE_CHANGE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', maxLength: 120, description: 'What changed, max 8 words' },
    language: { type: 'string', maxLength: 30, description: 'Language of the returned code' },
    summary: { type: 'string', maxLength: 600, description: 'One or two sentences about the change' },
    code: { type: 'string', maxLength: LIMITS.code, description: 'The full rewritten code, no markdown fences' },
    changes: {
      type: 'array', maxItems: LIMITS.items, description: 'What you changed, one entry per change',
      items: {
        type: 'object',
        properties: {
          what: { type: 'string', maxLength: 300 },
          why: { type: 'string', maxLength: LIMITS.note },
        },
        required: ['what', 'why'],
        additionalProperties: false,
      },
    },
    notes: { type: 'array', maxItems: LIMITS.items, items: { type: 'string', maxLength: LIMITS.note } },
    risks: { type: 'array', maxItems: LIMITS.items, items: { type: 'string', maxLength: LIMITS.note } },
  },
  required: ['title', 'code'],
  additionalProperties: false,
};

function normalizeCodeChange(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const code = typeof source.code === 'string' ? source.code.trim() : '';
  const out = {
    version: 1,
    kind: 'code-change',
    title: typeof source.title === 'string' && source.title.trim() ? source.title.trim().slice(0, 120) : 'Rewritten code',
    code,
  };
  if (typeof source.language === 'string' && source.language.trim()) out.language = source.language.trim().slice(0, 30);
  if (typeof source.summary === 'string' && source.summary.trim()) out.summary = source.summary.trim().slice(0, 600);
  const changes = normalizeList(source.changes, LIMITS.items);
  if (changes) {
    out.changes = changes.map((c) => (typeof c === 'string'
      ? { what: c.slice(0, 300), why: '' }
      : { what: String(c.what || '').slice(0, 300), why: String(c.why || '').slice(0, LIMITS.note) }));
  }
  const notes = normalizeList(source.notes, LIMITS.items);
  if (notes) out.notes = notes;
  const risks = normalizeList(source.risks, LIMITS.items);
  if (risks) out.risks = risks;
  return out;
}

module.exports = { CODE_CHANGE_SCHEMA, CODE_CHANGE_LIMITS: LIMITS, normalizeCodeChange };
