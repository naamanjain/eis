'use strict';
// Prompt system. Tasks and depths are data, not code paths: adding an action
// means adding an entry here plus (usually) nothing else. The list of fields the
// model is asked for is derived from the schema module, so prompt and validator
// cannot drift apart.

const { schemaFor, DEPTHS } = require('../schema/explanation');
const { CODE_CHANGE_SCHEMA } = require('../schema/codeChange');
const { toStrictProviderSchema } = require('../schema/jsonSchema');

const DEPTH_INSTRUCTIONS = {
  quick: 'Answer in at most 3 short sentences. Include only the fields marked required. Keep it tight enough to read in 15 seconds.',
  balanced: 'Give a clear simple layer and a technical layer. Required fields only. Roughly 120-200 words of prose total.',
  deep: 'Produce a complete study note: mechanism, a concrete example, the concepts involved, and the mistakes people actually make. Every required field must be filled with specific content, not filler.',
};

const FIELD_HELP = {
  title: 'a descriptive title of at most 8 words',
  summary: 'one or two sentences that preview the answer',
  simpleExplanation: 'plain language, an everyday analogy, no jargon, 3-5 sentences',
  technicalExplanation: 'precise terminology; put the discrete facts in `points`',
  keyTakeaway: 'one sentence: the thing to remember',
  howItWorks: 'ordered mechanism steps',
  examples: 'concrete examples, each with runnable `code`',
  keyConcepts: 'the vocabulary this depends on, as term + meaning',
  commonMistakes: 'mistakes people actually make here',
  whenToUse: 'situations where this is the right choice',
  whenNotToUse: 'situations where this is the wrong choice',
  relatedTopics: 'concepts worth learning next, each with `name` and `why`',
  language: 'the language of the analysed code',
  executionFlow: 'what happens at runtime, in order, as {step, detail}',
  importantLines: 'the lines that matter, as {line, why}',
  dependencies: 'imports, libraries or services this code relies on',
  potentialIssues: 'issues found, as {severity, description, where}. severity MUST be one of confirmed, potential, recommendation, uncertain — never present a guess as a fact',
  improvements: 'concrete ways to improve it',
  complexity: 'time and space cost, e.g. "O(n) time, O(1) space"',
  example: 'one usage example as {title, language, code}',
  code: 'the full rewritten source, no markdown fences',
  changes: 'what you changed and why, as {what, why}',
  notes: 'anything the reader must know about the result',
  risks: 'behaviour that could change or break',
};

const TASKS = {
  'explain-topic': {
    label: 'Explain a topic',
    contract: 'explanation',
    kind: 'topic',
    ask: 'Explain the following so a developer can act on it.',
  },
  'explain-code': {
    label: 'Explain code',
    contract: 'explanation',
    kind: 'code',
    ask: 'Explain what this code does, how it runs, and what is worth noticing in it.',
  },
  'explain-error': {
    label: 'Explain an error',
    contract: 'explanation',
    kind: 'error',
    ask: 'Explain this error: what it means, why it happens here, and how to fix it.',
  },
  'find-issues': {
    label: 'Find issues',
    contract: 'explanation',
    kind: 'code',
    ask: 'Review this code for defects and risks. Every entry in `potentialIssues` must be labelled with its evidence level: confirmed only when the code proves it, potential when it likely is, recommendation as advice, uncertain when you cannot tell.',
  },
  'teach-me': {
    label: 'Teach me',
    contract: 'explanation',
    kind: 'topic',
    depthFloor: 'deep',
    ask: 'Turn this into a short lesson: concept, simple layer, technical layer, an example, the common mistake, and what to learn next.',
  },
  'give-example': {
    label: 'Generate example',
    contract: 'code-change',
    ask: 'Write a minimal, runnable example that demonstrates this, and explain the important parts.',
  },
  simplify: {
    label: 'Simplify code',
    contract: 'code-change',
    ask: 'Simplify this code without changing what it does. Remove indirection and duplication.',
  },
  optimize: {
    label: 'Optimize code',
    contract: 'code-change',
    ask: 'Make this code more efficient. Name the cost you are removing.',
  },
  'add-comments': {
    label: 'Add comments',
    contract: 'code-change',
    ask: 'Add comments that explain intent, not syntax. Comment the non-obvious lines only.',
  },
  'generate-test': {
    label: 'Generate test',
    contract: 'code-change',
    ask: 'Write tests for this code, covering the normal path and the edge cases that actually matter.',
  },
};

function listTasks() {
  return Object.entries(TASKS).map(([id, task]) => ({ id, label: task.label, contract: task.contract, kind: task.kind }));
}

function getTask(taskId) {
  return TASKS[taskId] ? { id: taskId, ...TASKS[taskId] } : null;
}

function normaliseDepth(depth) {
  return DEPTHS.includes(depth) ? depth : 'balanced';
}

function effectiveDepth(taskId, depth) {
  const task = getTask(taskId);
  const requested = normaliseDepth(depth);
  if (!task) return requested;
  if (task.depthFloor && DEPTHS.indexOf(requested) < DEPTHS.indexOf(task.depthFloor)) return task.depthFloor;
  return requested;
}

function schemaForTask(taskId, depth) {
  const task = getTask(taskId) || TASKS['explain-topic'];
  if (task.contract === 'code-change') return CODE_CHANGE_SCHEMA;
  return schemaFor(task.kind, effectiveDepth(taskId, depth));
}

// The field list sent to the model, derived from the schema it will be checked
// against. Required first, then optional.
function describeFields(schema) {
  const required = new Set(schema.required || []);
  const lines = [];
  for (const [key, child] of Object.entries(schema.properties || {})) {
    const help = FIELD_HELP[key] || child.description || key;
    lines.push(`${required.has(key) ? 'REQUIRED' : 'optional'} ${key}: ${help}`);
  }
  return lines;
}

function providerSchemaFor(schema) {
  return toStrictProviderSchema(schema);
}

function buildMessages({ task, depth, context, language: proseLanguage, audience }) {
  const taskDef = getTask(task) || TASKS['explain-topic'];
  const activeDepth = effectiveDepth(task.id || task, depth);
  const schema = schemaForTask(task.id || task, activeDepth);
  const fields = describeFields(schema);

  const system = [
    'You are Explain It Simply — an explanation layer for developers and people learning to code.',
    'You are precise, you prefer concrete examples over adjectives, and you never pad.',
    'Never invent facts. If something cannot be determined from what you were given, say so in the relevant field.',
    `Depth: ${activeDepth}. ${DEPTH_INSTRUCTIONS[activeDepth]}`,
    `Reply with a single JSON object and nothing else: no markdown, no code fences, no commentary before or after.`,
    `Strings must contain plain text. Use double quotes, escape newlines as \\n.`,
    proseLanguage && proseLanguage !== 'en'
      ? `Write all prose fields in ${proseLanguage}. Keep code, identifiers, file names and API names in their original form.`
      : '',
    audience ? `Write for: ${audience}.` : '',
    '',
    'Fields:',
    ...fields,
  ].filter(Boolean).join('\n');

  const blocks = [];
  blocks.push(`${taskDef.ask}\n\n${'"""'}\n${context.subject}\n${'"""'}`);
  if (context.diagnostics) blocks.push(`Reported error:\n${'""'}\n${context.diagnostics}\n${'""'}`);
  if (context.contextText) {
    blocks.push(`Additional context that was included (this is the whole extent of what you may assume about the file — do not claim anything about code you were not shown):\n${context.contextText}`);
  }
  if (context.fileName) blocks.push(`File: ${context.fileName}${context.language ? ` (${context.language})` : ''}`);
  else if (context.language) blocks.push(`Language: ${context.language}`);
  if (context.truncated) blocks.push('Note: some content was truncated to fit the request budget.');

  return {
    system,
    user: blocks.join('\n\n'),
    schema,
    // Each adapter projects this into the dialect its own API accepts.
    depth: activeDepth,
    contract: taskDef.contract,
    kind: taskDef.kind || null,
  };
}

module.exports = {
  DEPTH_INSTRUCTIONS,
  FIELD_HELP,
  TASKS,
  listTasks,
  getTask,
  normaliseDepth,
  effectiveDepth,
  schemaForTask,
  describeFields,
  providerSchemaFor,
  buildMessages,
};
