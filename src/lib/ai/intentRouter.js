'use strict';
// AI intent routing — maps natural language queries to business tools

const TOOLS = [
  {
    name: 'attendance_summary',
    patterns: [/\b(attendance|check-?in|checked in|present|absent|came)\b/i],
  },
  {
    name: 'revenue_summary',
    patterns: [/\b(revenue|earnings|income|collection|collect|collected|money)\b/i],
  },
  {
    name: 'dues_summary',
    patterns: [/\b(outstanding|pending|dues?|who.*owes|unpaid|paid|balance.*due)\b/i],
  },
  {
    name: 'trainer_roster',
    patterns: [/\b(trainer|trainers)\b.*\b(list|how many|who are|show)\b|\b(show|list|how many|who are)\b.*\b(trainer|trainers)\b/i],
  },
  {
    name: 'client_stats',
    patterns: [/\b(how many|count of|number of)\b.*\b(client|clients|member|members|active|active members)\b/i],
  },
  {
    name: 'search_exercises',
    patterns: [/\b(exercise|workout)\b.*\b(for|targeting|hypertrophy|that work|train|hit)\b|\b(workout|exercise)s?\s+(move|exercise)\b/i],
  },
];

/**
 * Pattern-matches `message` against every tool and returns the names of
 * tools whose patterns match, in order.
 *
 * This is used for unit testing the pattern-matching logic independently
 * of the full tool execution pipeline (auth checks, database queries, etc).
 */
function inferToolHints(message) {
  const hints = [];
  for (const tool of TOOLS) {
    for (const pattern of tool.patterns) {
      if (pattern.test(message)) {
        hints.push(tool.name);
        break; // Each tool appears at most once, even if multiple patterns match
      }
    }
  }
  return hints;
}

module.exports = { inferToolHints };
