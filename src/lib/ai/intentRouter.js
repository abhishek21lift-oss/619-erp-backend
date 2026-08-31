'use strict';

// Deterministic intent hints for the existing application-layer AI tools.
// This is intentionally small and dependency-free: it improves routing without
// adding another LLM call, changing models, or changing tenant/security code.

const INTENT_PATTERNS = [
  { tool: 'attendance_summary', patterns: [
    /\battendance\b/i, /\bcheck[- ]?ins?\b/i, /\bchecked in\b/i,
    /\bwho (?:came|showed up|was present)\b/i, /\bwho (?:was|were) absent\b/i,
    /\bhow many (?:people|clients|members) (?:came|attended|showed up)\b/i,
  ]},
  { tool: 'revenue_summary', patterns: [
    /\brevenue\b/i, /\bearnings?\b/i, /\bincome\b/i, /\bcollections?\b/i,
    /\bhow much (?:did we|have we) (?:make|made|collect|collected)\b/i,
    /\bmoney (?:made|collected|received)\b/i,
  ]},
  { tool: 'dues_summary', patterns: [
    /\boutstanding (?:dues?|payments?|balances?)\b/i,
    /\bpending (?:dues?|payments?|balances?)\b/i, /\bwho owes\b/i,
    /\bunpaid\b/i, /\bwho (?:has|have) not paid\b/i,
    /\bclients? (?:with|having) (?:dues?|arrears?|balance)\b/i,
  ]},
  { tool: 'trainer_roster', patterns: [
    /\b(?:list|show|display) (?:all )?trainers?\b/i,
    /\bhow many trainers?\b/i, /\bwho are (?:the )?trainers?\b/i,
  ]},
  { tool: 'client_stats', patterns: [
    /\bhow many (?:active )?(?:clients?|members?)\b/i,
    /\b(?:active|expired|expiring|frozen) (?:clients?|members?)\b/i,
    /\bclient (?:count|statistics|stats)\b/i,
  ]},
  { tool: 'search_exercises', patterns: [
    /\bexercise(?:s)?\b.*\b(?:for|target|targeting|work|train|hit)\b/i,
    /\b(?:exercise|workout) (?:for|to target|to train|to hit)\b/i,
  ]},
];

function inferToolHints(message) {
  const text = String(message || '');
  const hints = [];
  for (const rule of INTENT_PATTERNS) {
    if (rule.patterns.some((pattern) => pattern.test(text))) hints.push(rule.tool);
  }
  return hints;
}

module.exports = { inferToolHints };
