'use strict';

const base = require('./tools.original');
const { inferToolHints } = require('./intentRouter');

const DATE_HINTS = /\b(?:today|yesterday|tomorrow|this|last|next)\s+(?:day|week|month|year|quarter)\b|\b(?:today|yesterday|tomorrow)\b|\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\b\d{4}-\d{1,2}(?:-\d{1,2})?\b/gi;
const MUSCLES = ['chest','back','shoulders','biceps','triceps','legs','quads','quadriceps','hamstrings','glutes','calves','core','abs','abdominals','arms','forearms','traps','lats'];

function dateContext(message) {
  const matches = String(message || '').match(DATE_HINTS);
  return matches ? matches.join(' ') : '';
}

function canonicalMessage(tool, original) {
  const dates = dateContext(original);
  if (tool === 'attendance_summary') return `attendance ${dates}`.trim();
  if (tool === 'revenue_summary') return `revenue ${dates}`.trim();
  if (tool === 'dues_summary') return 'outstanding dues';
  if (tool === 'trainer_roster') return 'list trainers';
  if (tool === 'client_stats') return 'how many clients';
  if (tool === 'search_exercises') {
    const lower = String(original || '').toLowerCase();
    const muscle = MUSCLES.find((m) => lower.includes(m)) || 'chest';
    return `exercises for ${muscle}`;
  }
  return original;
}

async function runTools(req, message) {
  const existing = await base.runTools(req, message);
  const hints = inferToolHints(message);
  if (!hints.length) return existing;

  const existingNames = new Set(existing.toolNames || []);
  const missing = hints.filter((tool) => {
    const label = (base.TOOLS.find((t) => t.name === tool) || {}).label;
    return label && !existingNames.has(label);
  }).slice(0, 2);

  if (!missing.length) return existing;

  const additions = [];
  for (const tool of missing) {
    const result = await base.runTools(req, canonicalMessage(tool, message));
    if (result.contextText) additions.push(result.contextText);
    for (const name of result.toolNames || []) existingNames.add(name);
  }

  const addedNames = missing
    .map((tool) => (base.TOOLS.find((t) => t.name === tool) || {}).label)
    .filter(Boolean)
    .filter((name) => !(existing.toolNames || []).includes(name));

  return {
    toolNames: [...(existing.toolNames || []), ...addedNames].slice(0, 2),
    contextText: [existing.contextText, ...additions].filter(Boolean).join('\n\n'),
  };
}

module.exports = { ...base, runTools };
