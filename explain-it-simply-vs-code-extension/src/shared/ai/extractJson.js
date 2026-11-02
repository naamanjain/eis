/* Vendored from ../shared/ai/extractJson.js — do not edit here; run `npm run vendor`. */
'use strict';
// Safe extraction of the JSON object a model was asked to produce. Never trusts
// "looks like JSON": the reply is scanned for one balanced object, respecting
// strings and escapes, and anything else is a MalformedResponseError.

const { MalformedResponseError, truncate, redactSecrets } = require('../errors');

function stripFences(text) {
  return String(text == null ? '' : text)
    .trim()
    .replace(/^```(?:json|javascript|js)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

// Returns the first complete {...} object, scanning with brace depth that
// ignores braces inside string literals.
function findJsonObject(text) {
  const source = String(text);
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (char === '}') {
      if (depth === 0) return null; // closing brace before any opening one
      depth -= 1;
      if (depth === 0 && start !== -1) return source.slice(start, i + 1);
    }
  }
  return null;
}

// A reply cut off at a token limit often has everything except the final brace;
// closing it is safe because every field we require arrives before that point.
function salvageTruncated(candidate) {
  const opens = (candidate.match(/{/g) || []).length;
  const closes = (candidate.match(/}/g) || []).length;
  let repaired = candidate.replace(/,\s*$/, '');
  const trailingQuote = (repaired.match(/"/g) || []).length;
  if (trailingQuote % 2 === 1) repaired += '"';
  if (opens > closes) return `${repaired}${'}'.repeat(opens - closes)}`;
  return null;
}

function extractJsonObject(rawText, { providerId = null, secrets = [] } = {}) {
  const stripped = stripFences(rawText);
  if (!stripped) {
    throw new MalformedResponseError('The provider returned an empty answer.', providerId);
  }

  const candidate = findJsonObject(stripped);
  // Redact before quoting. A provider that echoes the request back can put key material
  // into the reply, and this snippet is the one part of a malformed answer that reaches
  // a log, an API error body and the panel. `secrets` was already a parameter here and
  // was never used; that gap is the reason for this line.
  const snippet = truncate(redactSecrets(stripped, secrets), 220);

  if (!candidate) {
    // A reply cut off by the provider's token limit has an opening brace and no
    // closing one; repair it only if that produces something we can validate.
    const firstOpen = stripped.indexOf('{');
    if (firstOpen !== -1) {
      const tail = stripped.slice(firstOpen);
      for (const attempt of [tail, tail.replace(/,\s*$/, '')]) {
        const repaired = salvageTruncated(attempt);
        if (!repaired) continue;
        try {
          return JSON.parse(repaired);
        } catch (error) {
          // keep the original failure reason for the user
        }
      }
    }
    throw new MalformedResponseError(
      `The answer is not JSON. Start of reply: ${snippet}`,
      providerId,
    );
  }

  try {
    return JSON.parse(candidate);
  } catch (error) {
    throw new MalformedResponseError(
      `The answer is not valid JSON. Start of reply: ${snippet}`,
      providerId,
    );
  }
}

module.exports = { extractJsonObject, findJsonObject, stripFences, salvageTruncated };
