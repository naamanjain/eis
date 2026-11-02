/* Vendored from ../shared/schema/util.js — do not edit here; run `npm run vendor`. */
'use strict';

// Keeps only real entries and enforces an upper bound on model-supplied lists.
function normalizeList(value, max = 8) {
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((item) => item !== null && item !== undefined && item !== '').slice(0, max);
  return list.length ? list : undefined;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

module.exports = { normalizeList, firstString };
