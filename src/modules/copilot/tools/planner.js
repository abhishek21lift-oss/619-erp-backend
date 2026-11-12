'use strict';
// Deterministic tool selection for the trainer chat.
//
// The model does not choose tools. It never has in this product, and the reason
// is unchanged: the chat models are free-tier OpenRouter models whose
// function-calling support is inconsistent, so a silently mis-shaped call would
// look like a wrong answer rather than a broken feature. What changes here is
// that the selection now feeds a registry with a security pipeline instead of
// six route-inline readers.
//
// Two intents can co-occur ("her attendance and her goals"), so at most two
// tools run. Client-scoped tools are only ever planned when the request already
// has a selected client — the planner cannot introduce one.

/** Tools that require a selected client, resolved by Phase 2 before the run. */
const CLIENT_REQUIRED = new Set([
  'get_client_profile',
  'get_client_goals',
  'get_client_assessments',
  'get_client_progress',
  'get_workout_history',
  'get_active_workout_program',
  'get_attendance_summary',
]);

const MAX_TOOLS = 2;

// Order is priority: the first two matching rules win. Client-scoped rules sit
// before the studio rules so "his attendance" is answered by attendance, not
// by a generic profile read.
const RULES = [
  {
    names: ['get_client_assessments'],
    reason: 'assessments_intent',
    test: /\b(assessments?|par-?q|readiness|posture|mobility|body composition|injuries?|limitations?)\b/i,
  },
  {
    names: ['get_attendance_summary'],
    reason: 'attendance_intent',
    test: /\b(attendance|check-?ins?|present|absent|late|turned up|showed up|showing up|missed sessions?)\b/i,
  },
  {
    names: ['get_active_workout_program'],
    reason: 'active_program_intent',
    test: /\b(programme|program|split|what (is|are) (he|she|they|the client|[a-z]+) (training|working on)|exercises? (today|this week|next))\b/i,
  },
  {
    names: ['get_workout_history'],
    reason: 'workout_history_intent',
    test: /\b(workout history|training history|logged sets|volume|adherence|plateau|regress\w*|personal records?|\bprs?\b)\b/i,
  },
  {
    names: ['get_client_goals'],
    reason: 'goals_intent',
    test: /\b(goals?|aiming for|working towards|target (weight|date))\b/i,
  },
  {
    names: ['get_client_progress'],
    reason: 'progress_intent',
    test: /\b(progress|how (is|are) (he|she|they|[a-z]+) (doing|going)|weight (trend|change)|results)\b/i,
  },
  {
    names: ['get_client_profile'],
    reason: 'profile_intent',
    test: /\b(profile|details|contact|phone|mobile|package|membership|term|renew\w*|expir\w*|end date)\b/i,
  },
  {
    names: ['get_trainer_schedule'],
    reason: 'schedule_intent',
    test: /\b(schedule|agenda|booked|bookings?|diary|appointments?|(today|tomorrow|this week|next week)['’]?s? (sessions?|slots?))\b/i,
  },
  {
    names: ['get_trainer_workload'],
    reason: 'workload_intent',
    test: /\b(workload|how busy|trainer (totals|breakdown|performance)|sessions? (done|completed|missed) (this month|per trainer))\b/i,
  },
  {
    names: ['get_pending_followups'],
    reason: 'followups_intent',
    test: /\b(follow[- ]?ups?|churn|at risk|risk of (leaving|quitting|cancell?ing)|who (should|do) i (call|contact)|reach out|gone quiet|not been in)\b/i,
  },
  {
    // Deliberately not "dues / who owes / unpaid / balance": those are the
    // legacy dues_summary's exact triggers, and its behaviour is preserved.
    names: ['get_membership_alerts'],
    reason: 'membership_alerts_intent',
    test: /\b(expiring|expired|renewals?|membership alerts?|term (ending|ended))\b/i,
  },
];

/**
 * The tools one message asks for, in priority order.
 *
 * @param {string} message
 * @param {{ clientId?: string|null }} [scope]
 * @returns {{ name: string, args: object, reason: string }[]}
 */
function plan(message, { clientId } = {}) {
  const text = String(message ?? '');
  const out = [];

  for (const rule of RULES) {
    if (out.length >= MAX_TOOLS) break;
    if (!rule.test.test(text)) continue;
    for (const name of rule.names) {
      if (out.length >= MAX_TOOLS) break;
      if (CLIENT_REQUIRED.has(name) && !clientId) continue;
      if (out.some((call) => call.name === name)) continue;
      out.push({ name, args: {}, reason: rule.reason });
    }
  }

  return out;
}

module.exports = { plan, CLIENT_REQUIRED, MAX_TOOLS };
