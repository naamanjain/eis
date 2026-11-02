/* Vendored from ../shared/schema/explanation.js — do not edit here; run `npm run vendor`. */
'use strict';
// Explanation v2: the stable internal representation. Optional by design — a
// Quick answer and a Deep Dive are the same type with different required fields,
// and a code explanation carries analysis the topic one never should.

const { validate } = require('./jsonSchema');
const { normalizeList } = require('./util');

const DEPTHS = ['quick', 'balanced', 'deep'];
const KINDS = ['topic', 'code', 'error'];

const SEVERITIES = ['confirmed', 'potential', 'recommendation', 'uncertain'];

const LIMITS = {
  points: 8,
  listItems: 8,
  relatedTopics: 6,
  title: 120,
  body: 6000,
};

const LAYER = {
  type: 'object',
  properties: {
    heading: { type: 'string', description: 'Short section heading' },
    body: { type: 'string', maxLength: LIMITS.body, description: 'The prose of this section' },
    points: {
      type: 'array',
      maxItems: LIMITS.points,
      description: 'Optional bullet points',
      items: { type: 'string', maxLength: 400 },
    },
  },
};

const BASE_PROPERTIES = {
  title: { type: 'string', minLength: 1, maxLength: LIMITS.title, description: 'Descriptive title, max 8 words' },
  summary: { type: 'string', maxLength: 400, description: 'One or two sentence preview' },
  simpleExplanation: { ...LAYER, description: 'Plain-language explanation with an everyday analogy, no jargon' },
  technicalExplanation: { ...LAYER, description: 'Precise technical explanation using correct terminology' },
  keyTakeaway: { type: 'string', maxLength: 400, description: 'The single most important thing to remember' },
  relatedTopics: {
    type: 'array',
    maxItems: LIMITS.relatedTopics,
    items: {
      type: 'object',
      properties: {
        name: { type: 'string', maxLength: 80 },
        why: { type: 'string', maxLength: 200 },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
};

const TOPIC_EXTRA_PROPERTIES = {
  howItWorks: {
    type: 'array', maxItems: LIMITS.listItems, description: 'Ordered mechanism steps',
    items: { type: 'string', maxLength: 400 },
  },
  examples: {
    type: 'array', maxItems: LIMITS.listItems,
    items: {
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: 120 },
        language: { type: 'string', maxLength: 30 },
        code: { type: 'string', maxLength: 3000 },
        note: { type: 'string', maxLength: 400 },
      },
      required: ['code'],
      additionalProperties: false,
    },
  },
  keyConcepts: {
    type: 'array', maxItems: LIMITS.listItems,
    items: {
      type: 'object',
      properties: {
        term: { type: 'string', maxLength: 80 },
        meaning: { type: 'string', maxLength: 400 },
      },
      required: ['term', 'meaning'],
      additionalProperties: false,
    },
  },
  commonMistakes: {
    type: 'array', maxItems: LIMITS.listItems,
    items: { type: 'string', maxLength: 400 },
  },
  whenToUse: { type: 'array', maxItems: LIMITS.listItems, items: { type: 'string', maxLength: 400 } },
  whenNotToUse: { type: 'array', maxItems: LIMITS.listItems, items: { type: 'string', maxLength: 400 } },
};

const CODE_EXTRA_PROPERTIES = {
  language: { type: 'string', maxLength: 30, description: 'Language the analysed code is written in' },
  executionFlow: {
    type: 'array', maxItems: LIMITS.listItems, description: 'What happens, in order',
    items: {
      type: 'object',
      properties: {
        step: { type: 'string', maxLength: 200 },
        detail: { type: 'string', maxLength: 400 },
      },
      required: ['step'],
      additionalProperties: false,
    },
  },
  importantLines: {
    type: 'array', maxItems: LIMITS.listItems,
    items: {
      type: 'object',
      properties: {
        line: { type: 'string', maxLength: 200, description: 'Line number or short code excerpt' },
        why: { type: 'string', maxLength: 400 },
      },
      required: ['why'],
      additionalProperties: false,
    },
  },
  dependencies: {
    type: 'array', maxItems: LIMITS.listItems, description: 'Imports, libraries or services this code relies on',
    items: { type: 'string', maxLength: 200 },
  },
  potentialIssues: {
    type: 'array', maxItems: LIMITS.listItems,
    items: {
      type: 'object',
      properties: {
        severity: { type: 'string', enum: SEVERITIES, description: 'confirmed | potential | recommendation | uncertain' },
        description: { type: 'string', maxLength: 500 },
        where: { type: 'string', maxLength: 200 },
      },
      required: ['severity', 'description'],
      additionalProperties: false,
    },
  },
  improvements: {
    type: 'array', maxItems: LIMITS.listItems,
    items: { type: 'string', maxLength: 400 },
  },
  complexity: {
    type: 'string', maxLength: 200, description: 'Time/space cost, e.g. "O(n) time, O(1) space"',
  },
  example: {
    type: 'object',
    properties: {
      title: { type: 'string', maxLength: 120 },
      language: { type: 'string', maxLength: 30 },
      code: { type: 'string', maxLength: 3000 },
    },
    required: ['code'],
    additionalProperties: false,
  },
};

// Which fields each (kind, depth) demands. Everything not required may be absent.
const REQUIRED = {
  topic: {
    quick: ['title', 'simpleExplanation', 'keyTakeaway'],
    balanced: ['title', 'simpleExplanation', 'technicalExplanation', 'keyTakeaway'],
    deep: ['title', 'summary', 'simpleExplanation', 'technicalExplanation', 'howItWorks', 'examples', 'keyConcepts', 'commonMistakes', 'keyTakeaway', 'relatedTopics'],
  },
  code: {
    quick: ['title', 'simpleExplanation', 'keyTakeaway'],
    balanced: ['title', 'simpleExplanation', 'technicalExplanation', 'executionFlow', 'keyTakeaway'],
    deep: ['title', 'summary', 'simpleExplanation', 'technicalExplanation', 'executionFlow', 'importantLines', 'dependencies', 'potentialIssues', 'improvements', 'complexity', 'keyTakeaway'],
  },
};
REQUIRED.error = REQUIRED.code;

function propertiesFor(kind) {
  if (kind === 'topic') return { ...BASE_PROPERTIES, ...TOPIC_EXTRA_PROPERTIES };
  return { ...BASE_PROPERTIES, ...CODE_EXTRA_PROPERTIES };
}

function schemaFor(kind = 'topic', depth = 'balanced') {
  const required = (REQUIRED[kind] || REQUIRED.topic)[depth] || REQUIRED[kind].balanced;
  const properties = propertiesFor(kind);
  const filtered = {};
  for (const key of Object.keys(properties)) {
    // Never ask a Quick answer for deep-only fields.
    if (depth === 'quick' && !required.includes(key) && key !== 'relatedTopics') continue;
    filtered[key] = properties[key];
  }
  return {
    type: 'object',
    properties: filtered,
    required,
    additionalProperties: false,
  };
}

// A heading is a label, not a paragraph. Models routinely paste the body into
// `heading` (seen live with nemotron on 2026-10-16), which the panel would then
// render as a wall of title text.
function headingOf(value, fallback) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return fallback;
  if (raw.length <= 90) return raw;
  // Prefer the first sentence: a word-truncated fragment reads worse than a clean one.
  const sentence = /^.{12,89}[.!?](?=\s|$)/.exec(raw);
  if (sentence) return sentence[0].trim();
  const cut = raw.slice(0, 90);
  const at = cut.lastIndexOf(' ');
  return `${(at > 40 ? cut.slice(0, at) : cut).replace(/[.,;:]$/, '')}…`;
}

function normalizeLayer(value, fallbackHeading) {
  if (typeof value === 'string') {
    return { heading: fallbackHeading, body: value.trim(), points: [] };
  }
  if (!value || typeof value !== 'object') return { heading: fallbackHeading, body: '', points: [] };
  const body = typeof value.body === 'string' ? value.body : typeof value.content === 'string' ? value.content : '';
  const points = Array.isArray(value.points)
    ? value.points.filter((p) => typeof p === 'string' && p.trim()).slice(0, LIMITS.points)
    : [];
  // Older replies (and some models) put bullets inline as "• item" lines.
  const inline = body.includes('\n•') || body.includes('• ') || body.includes('- ');
  if (inline && body) {
    const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
    const prose = [];
    for (const line of lines) {
      if (/^[-•*]\s+/.test(line)) points.push(line.replace(/^[-•*]\s+/, '').trim());
      else prose.push(line);
    }
    return {
      heading: headingOf(value.heading, fallbackHeading),
      body: prose.join(' ').trim(),
      points: points.filter(Boolean).slice(0, LIMITS.points),
    };
  }
  return {
    heading: headingOf(value.heading, fallbackHeading),
    body: body.trim(),
    points: points.filter(Boolean),
  };
}

// Accepts anything the model returned, keeps what is valid, drops what is not.
// Never invents content.
function normalize(raw, kind = 'topic', depth = 'balanced') {
  const source = raw && typeof raw === 'object' ? raw : {};
  // Every field below is optional and several are deleted again after being set, so
  // `out` is a partially-built bag rather than a fixed shape. The real contract is
  // enforced by validateExplanation() against the JSON schema, not by this literal.
  /** @type {Record<string, any>} */
  const out = {
    version: 2,
    kind,
    depth,
    title: typeof source.title === 'string' && source.title.trim()
      ? source.title.trim().slice(0, LIMITS.title)
      : 'Explanation',
    simpleExplanation: normalizeLayer(source.simpleExplanation || source.eli5, 'Explain it simply'),
    technicalExplanation: normalizeLayer(source.technicalExplanation || source.technical, 'Technical breakdown'),
    keyTakeaway: typeof source.keyTakeaway === 'string' ? source.keyTakeaway.trim().slice(0, 400) : '',
  };
  if (typeof source.summary === 'string' && source.summary.trim()) out.summary = source.summary.trim().slice(0, 400);

  const optionalStrings = ['howItWorks', 'commonMistakes', 'whenToUse', 'whenNotToUse', 'improvements', 'dependencies'];
  for (const key of optionalStrings) {
    const list = normalizeList(source[key]);
    if (list) out[key] = list;
  }

  if (Array.isArray(source.examples) && source.examples.length) out.examples = normalizeList(source.examples);
  if (Array.isArray(source.keyConcepts) && source.keyConcepts.length) out.keyConcepts = normalizeList(source.keyConcepts);
  if (Array.isArray(source.relatedTopics) && source.relatedTopics.length) {
    // normalizeList() answers `undefined` when every entry was empty, so an all-empty
    // list like [null] has to be treated as no list — chaining onto it threw a raw
    // TypeError instead of a clean malformed-answer error.
    const topics = normalizeList(source.relatedTopics, LIMITS.relatedTopics) || [];
    out.relatedTopics = topics
      .map((t) => (typeof t === 'string' ? { name: t.slice(0, 80) } : t))
      .filter((t) => t && typeof t.name === 'string' && t.name.trim());
    if (!out.relatedTopics.length) delete out.relatedTopics;
  }

  if (kind !== 'topic') {
    if (Array.isArray(source.executionFlow) && source.executionFlow.length) out.executionFlow = normalizeList(source.executionFlow);
    if (Array.isArray(source.importantLines) && source.importantLines.length) out.importantLines = normalizeList(source.importantLines);
    if (Array.isArray(source.potentialIssues) && source.potentialIssues.length) {
      const issues = normalizeList(source.potentialIssues) || [];
      out.potentialIssues = issues.map((issue) => {
        if (typeof issue === 'string') return { severity: 'potential', description: issue };
        const severity = SEVERITIES.includes(issue.severity) ? issue.severity : 'uncertain';
        return { severity, description: String(issue.description || '').slice(0, 500), where: issue.where ? String(issue.where).slice(0, 200) : undefined };
      });
      if (!out.potentialIssues.length) delete out.potentialIssues;
    }
    if (typeof source.complexity === 'string' && source.complexity.trim()) out.complexity = source.complexity.trim().slice(0, 200);
    if (source.example && typeof source.example === 'object') out.example = source.example;
    if (typeof source.language === 'string' && source.language.trim()) out.language = source.language.trim().slice(0, 30);
  }

  for (const key of Object.keys(out)) {
    if (out[key] === undefined || out[key] === '' || (Array.isArray(out[key]) && !out[key].length)) delete out[key];
  }
  // Presence is not content: a layer with neither prose nor bullets is a gap the
  // reader should be told about, not an answer that passed. Checked before the
  // empty-points cleanup below, which removes the key this reads.
  const simple = out.simpleExplanation;
  if (simple && !simple.body && !(simple.points || []).length) delete out.simpleExplanation;
  else if (simple && !simple.points.length) delete simple.points;
  if (out.technicalExplanation) {
    if (!out.technicalExplanation.points.length) delete out.technicalExplanation.points;
    if (!out.technicalExplanation.body && !out.technicalExplanation.points) delete out.technicalExplanation;
  }
  return out;
}

// Strips fields the active depth never asked for, so a model that over-answers
// cannot make a Quick result look like a Deep Dive.
function applyDepthBudget(explanation) {
  if (explanation.depth === 'quick') {
    for (const key of ['howItWorks', 'examples', 'keyConcepts', 'commonMistakes', 'whenToUse', 'whenNotToUse', 'executionFlow', 'importantLines', 'dependencies', 'potentialIssues', 'improvements', 'complexity', 'example', 'summary', 'relatedTopics']) {
      delete explanation[key];
    }
    delete explanation.technicalExplanation;
  }
  if (explanation.depth === 'balanced') {
    for (const key of ['howItWorks', 'keyConcepts', 'commonMistakes', 'whenToUse', 'whenNotToUse']) {
      delete explanation[key];
    }
  }
  return explanation;
}

function validateExplanation(explanation, kind, depth) {
  // The envelope the pipeline adds is not part of the answer contract the model
  // is asked for, so validate the content without it.
  const {
    version, kind: _kind, depth: _depth, ...content
  } = explanation;
  return validate(content, schemaFor(kind, depth));
}

module.exports = {
  DEPTHS,
  KINDS,
  SEVERITIES,
  LIMITS,
  LAYER,
  REQUIRED,
  schemaFor,
  propertiesFor,
  normalize,
  normalizeLayer,
  applyDepthBudget,
  validateExplanation,
};
