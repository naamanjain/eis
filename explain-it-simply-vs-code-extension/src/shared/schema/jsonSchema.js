/* Vendored from ../shared/schema/jsonSchema.js — do not edit here; run `npm run vendor`. */
'use strict';
// A deliberately small JSON-Schema subset validator. Zero dependencies, because
// it has to run inside the VS Code extension host as well as the web server.
// Supports: type (incl. unions), properties, required, items, enum,
// additionalProperties:false, min/max Length, min/max Items, nullable, descriptions.

const TYPES = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: (v) => typeof v === 'number' && Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  object: (v) => !!v && typeof v === 'object' && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  null: (v) => v === null,
};

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

// Returns { valid, errors[], coerced } — `coerced` is the value with salvageable
// type fixes applied (e.g. a one-item array where a string was expected).
function validate(value, schema, pathLabel = '$') {
  const errors = [];
  const coerced = coerce(value, schema);
  check(coerced, schema, pathLabel, errors);
  return { valid: errors.length === 0, errors, coerced };
}

function coerce(value, schema) {
  const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (typeof value === 'string' && allowed.includes('array') && schema.items) {
    // Models sometimes answer a list question with one blob of text.
    return value.trim() ? [value.trim()] : [];
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && allowed.includes('array') && schema.items) {
    return [value];
  }
  if (typeof value === 'number' && allowed.includes('string')) return String(value);
  if (typeof value === 'boolean' && allowed.includes('string')) return value ? 'yes' : 'no';
  return value;
}

function check(value, schema, pathLabel, errors) {
  if (value === undefined) {
    errors.push(`${pathLabel}: missing`);
    return;
  }
  const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${pathLabel}: '${String(value)}' is not one of ${schema.enum.join(', ')}`);
    return;
  }
  if (allowed.length && !allowed.some((t) => (TYPES[t] || (() => false))(value))) {
    errors.push(`${pathLabel}: expected ${allowed.join(' | ')}, got ${typeOf(value)}`);
    return;
  }
  if (value === null) return;

  if (schema.type === 'string' || (allowed.includes('string') && typeof value === 'string')) {
    if (schema.minLength != null && value.length < schema.minLength) errors.push(`${pathLabel}: shorter than ${schema.minLength}`);
    if (schema.maxLength != null && value.length > schema.maxLength) errors.push(`${pathLabel}: longer than ${schema.maxLength}`);
  }

  if (Array.isArray(value) && schema.items) {
    if (schema.minItems != null && value.length < schema.minItems) errors.push(`${pathLabel}: fewer than ${schema.minItems} items`);
    if (schema.maxItems != null && value.length > schema.maxItems) errors.push(`${pathLabel}: more than ${schema.maxItems} items`);
    value.forEach((item, i) => check(item, schema.items, `${pathLabel}[${i}]`, errors));
  }

  if (TYPES.object(value) && schema.properties) {
    for (const key of schema.required || []) {
      if (value[key] === undefined || value[key] === null || value[key] === '') {
        errors.push(`${pathLabel}.${key}: required`);
      }
    }
    for (const [key, child] of Object.entries(schema.properties)) {
      if (value[key] !== undefined) check(value[key], child, `${pathLabel}.${key}`, errors);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in schema.properties)) errors.push(`${pathLabel}.${key}: unexpected field`);
      }
    }
  }
}

// Providers that enforce a schema (OpenAI strict mode) require every property to
// be present in `required` and forbid extras; optional fields become nullable.
function toStrictProviderSchema(schema) {
  const walk = (node) => {
    const out = {};
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (node.type) {
      out.type = node.enum ? node.type : types[0];
      if (node.enum) out.type = Array.isArray(node.type) ? node.type[0] : node.type;
    }
    if (node.enum) out.enum = [...node.enum, null];
    if (node.description) out.description = node.description;
    if (node.items) out.items = walk(node.items);
    if (node.properties) {
      out.properties = {};
      const required = [];
      for (const [key, child] of Object.entries(node.properties)) {
        out.properties[key] = walk(child);
        required.push(key);
      }
      out.required = required;
      out.additionalProperties = false;
    }
    return out;
  };
  const strict = walk(schema);
  // Any property that is optional in our contract becomes nullable upstream.
  const markNullable = (node) => {
    if (node && node.properties) {
      for (const child of Object.values(node.properties)) {
        if (child && child.type !== 'null') child.nullable = true;
        markNullable(child);
      }
    }
    if (node && node.items) markNullable(node.items);
  };
  markNullable(strict);
  return strict;
}

// Google's responseSchema accepts a narrower dialect: no additionalProperties,
// no nullable, no union types — sending them is rejected by the API, so the
// schema is projected to exactly what that endpoint supports.
function toGoogleSchema(schema) {
  const walk = (node) => {
    if (!node || typeof node !== 'object') return node;
    const types = Array.isArray(node.type) ? node.type : [node.type];
    const out = {};
    if (node.type) out.type = types.filter((t) => t !== 'null')[0] || 'string';
    if (node.description) out.description = node.description;
    if (node.enum) out.enum = node.enum.filter((value) => value !== null);
    if (node.items) out.items = walk(node.items);
    if (node.properties) {
      out.properties = {};
      for (const [key, child] of Object.entries(node.properties)) out.properties[key] = walk(child);
      if (Array.isArray(node.required) && node.required.length) out.required = node.required;
    }
    return out;
  };
  return walk(schema);
}

module.exports = { validate, toStrictProviderSchema, toGoogleSchema, TYPES, typeOf };
