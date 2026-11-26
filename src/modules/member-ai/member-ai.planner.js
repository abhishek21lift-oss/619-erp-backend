'use strict';
// Deterministic question planner for the member assistant.
//
// ── Why pattern matching, not model tool-calling ───────────────────────────
//
// The same three reasons as the trainer AI Coach (see AGENTS.md §3.1): cost,
// data minimisation and testability. Here data minimisation matters most — a
// member's payment history, PAR-Q status and check-in notes are only read when
// the question actually needs them.
//
// The cost is honest: an unanticipated phrasing falls back to the profile
// alone, and the model is told which tools ran so it can say what it lacked.

const MAX_TOOLS = 4;

// Only a bare greeting skips tools entirely. Anything else gets at least the
// profile, so the model always knows who it is talking to.
const GREETING = /^(hi|hello|hey|namaste|thanks|thank you|ok|okay)[\s!.,]*$/i;

// "Tell my trainer…" / "ask the coach…" — a draft is only allowed when the
// member names both an action and a recipient near each other.
const DRAFT_VERB = /\b(message|msg|tell|ask|inform|remind|bhej|bol|bata)/i;
const DRAFT_TARGET = /trainer|coach|studio/i;
const DRAFT_WINDOW = 40;

// Lookups read as a single fact; everything else is analysis or advice.
const LOOKUP = /when|what is|what's|how many|how much|kab|kitna|kaunsa|where/i;

// Order matters: tools are added in this order, then capped at MAX_TOOLS.
const RULES = [
  {
    tools: ['getMyWorkout'],
    test: /workout|training|exercise|programme|program|routine|aaj kya kar|kya karun|kya karna/i,
  },
  {
    tools: ['getMyDiet'],
    test: /\bdiet\b|\bmeal\b|\bfood\b|\beat\b|lunch|dinner|breakfast|snack|calorie|protein|khana|khaana|nashta/i,
  },
  {
    tools: ['getMyCheckins'],
    test: /check.?in|\bmy week\b|\bthis week\b|\blast week\b|week (go|went|kaisa)|sleep|stress|energy|soreness|mood|neend|thakan/i,
  },
  {
    tools: ['getMyMeasurements', 'getMyCheckins'],
    test: /\bweight\b|measure|body fat|waist|chest|progress|trend|vajan|wajan|\binch(es)?\b|\bkg\b/i,
  },
  {
    tools: ['getMyAttendance'],
    test: /attendance|\battend|streak|missed|aaya|aayi|gaya/i,
  },
  {
    tools: ['getMyMembership', 'getMyPayments'],
    test: /payment|\bpaid\b|\bdues?\b|balance|outstanding|invoice|\bfees?\b|paisa|paise|baki/i,
  },
  {
    tools: ['getMyMembership'],
    test: /membership|renew|expir|package|subscription|validity|kab tak|khatam/i,
  },
  {
    tools: ['getMyBookings'],
    test: /booking|\bbook|session|slot|reschedule|cancel|appointment/i,
  },
  {
    tools: ['getMyForms'],
    test: /\bforms?\b|consent|par.?q|waiver|signed/i,
  },
];

/**
 * True when an action verb and a recipient appear within a short window,
 * in either order. The window keeps "I told the front desk my trainer's name"
 * from opening a draft the member did not ask for.
 */
function wantsDraft(text) {
  const verb = DRAFT_VERB.exec(text);
  if (!verb) return false;
  const targetRe = new RegExp(DRAFT_TARGET.source, 'gi');
  let target;
  while ((target = targetRe.exec(text)) !== null) {
    if (Math.abs(target.index - verb.index) <= DRAFT_WINDOW) return true;
  }
  return false;
}

/**
 * Map a member's message to at most MAX_TOOLS self-scoped tools.
 *
 * `allowDraft` is permission, not instruction: the prompt decides whether a
 * draft is actually useful, and the service strips any draft the model returns
 * when this flag is false.
 */
function planMemberQuestion(message) {
  const text = String(message || '');
  if (GREETING.test(text.trim())) {
    return { tools: [], allowDraft: false, intent: 'member_chat', matched: true };
  }

  const allowDraft = wantsDraft(text);
  const tools = [];
  const add = (name) => {
    if (!tools.includes(name)) tools.push(name);
  };

  if (allowDraft) add('getMyProfile');

  let matched = false;
  for (const rule of RULES) {
    if (rule.test.test(text)) {
      matched = true;
      rule.tools.forEach(add);
    }
  }

  // An unrecognised question still gets the profile, but `matched` tells the
  // prompt that it is answering without the specific record.
  if (!matched) add('getMyProfile');

  const capped = tools.slice(0, MAX_TOOLS);
  const intent = capped.length > 0 && LOOKUP.test(text) ? 'member_lookup' : 'member_chat';

  return { tools: capped, allowDraft, intent, matched };
}

module.exports = { planMemberQuestion, RULES, MAX_TOOLS };
