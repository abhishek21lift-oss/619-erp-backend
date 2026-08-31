'use strict';
// AI intent routing — maps natural language queries to business tools

const TOOLS = [
  {
    name: 'attendance_summary',
    patterns: [/\b(attendance|check-?in|checked in|present|absent|came to|who came)\b/i],
  },
  {
    name: 'revenue_summary',
    patterns: [/\b(revenue|earnings|income|collections?|money|collect|collected)\b/i],
  },
  {
    name: 'dues_summary',
    patterns: [/\b(outstanding|pending)\s+dues?\b|\bwho owes\b|\b(unpaid|still has not paid|paid)\b|\bbalance\s+(due|owed)\b/i],
  },
  {
    name: 'trainer_roster',
    patterns: [/\b(list|how many|who are the|show me all)\b.*\btrainers?\b/i],
  },
  {
    name: 'client_stats',
    patterns: [/\b(how many|count of|number of)\b.*\b(client|clients|member|members|active)\b/i],
  },
  {
    name: 'search_exercises',
    patterns: [/\bexercises?\b.*\b(for|targeting|that work|to (train|hit))\b|\bworkout\s+(move|exercise)s?\b/i],
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
