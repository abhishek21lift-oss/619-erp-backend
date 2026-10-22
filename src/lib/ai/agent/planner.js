'use strict';
// Which tools does this question need?
//
// Deterministic pattern matching, not a model call. Three reasons, in order of
// how much they matter:
//
//   1. COST. "When does their package expire?" should cost one ERP read and
//      one model call. Asking a model which tools to use first doubles the
//      model calls on every question to decide something a regex answers.
//   2. DATA MINIMISATION. Fetching everything and letting the model sort it
//      out sends a client's medical notes to a provider to answer a question
//      about a renewal date. The cheapest way not to leak a field is not to
//      retrieve it.
//   3. TESTABILITY. A pure function from text to tool names can be asserted
//      exactly. A model's tool choice can only be sampled.
//
// This mirrors the ERP's own decision: the tool registry chose pattern matching
// over native function calling because the free-tier models in use emit
// tool_calls unreliably. Same constraint, same answer, and the two stay
// comparable.
//
// The cost of determinism is honest: a phrasing nobody anticipated falls to the
// default. So the default is the broad summary set rather than nothing — an
// unrecognised question gets a well-grounded general answer instead of "I don't
// know", and the model is told which tools ran so it can say what it lacked.

const RULES = [
  // Methodology, policy and protocol questions are about the STUDIO, not the
  // client: answer them from the approved corpus (audit P1-1). First, because a
  // "policy on X" question must not lose its only knowledge read to the cap.
  { re: /\b(policy|protocol|method|guideline|standard|procedure|sop|rule)\b/i,
    tools: ['search_knowledge'] },

  // Money and package status.
  { re: /\b(package|expir\w*|renew\w*|subscription|validity|valid till|end date|kab tak|khatam)\b/i,
    tools: ['getClientProfile', 'getClientSubscriptions'] },
  { re: /\b(payment|paid|due|dues|balance|outstanding|invoice|fees?|paisa|baki)\b/i,
    tools: ['getClientProfile', 'getClientPayments'] },
  { re: /\b(renewal history|renewed|past renewals)\b/i,
    tools: ['getClientRenewals'] },

  // Training and physical state.
  { re: /\b(attendance|attend|present|absent|missed|no.?show|inactive|coming|aaya|aayi)\b/i,
    tools: ['getClientAttendance'] },
  { re: /\b(workout|session|training|programme|program|exercise|routine|plan)\b/i,
    tools: ['getClientTrainingBrief'] },
  { re: /\b(injur\w*|pain|posture|mobility|par.?q|limitation\w*|restriction\w*|medical)\b/i,
    tools: ['getClientTrainingBrief'] },
  { re: /\b(measure|weight|body fat|bodyfat|waist|chest|hips|assessment|inch|kg)\b/i,
    tools: ['getClientSummary'] },
  { re: /\b(goal|target|aim|objective)\b/i,
    tools: ['getClientSummary'] },
  { re: /\b(progress|improve|change|trend|better|worse|since)\b/i,
    tools: ['getClientSummary', 'getClientAttendance'] },

  // Contact.
  { re: /\b(call|contact|phone|mobile|number|message|communicat\w*|follow.?up|whatsapp)\b/i,
    tools: ['getClientProfile', 'getClientCommunication'] },

  // Whole-picture asks — the "give me everything" family.
  { re: /\b(summar\w*|overview|status report|full picture|everything|brief me|complete status|kaisa hai)\b/i,
    tools: ['getClientSummary', 'getClientProfile', 'getClientAttendance', 'getClientTrainingBrief'] },
  { re: /\b(focus|concern|worry|risk|next session|discuss|should i|what to do|advice)\b/i,
    tools: ['getClientSummary', 'getClientAttendance', 'getClientTrainingBrief'] },
];

/** Unrecognised questions still get grounded — see the header. */
const DEFAULT_TOOLS = ['getClientSummary', 'getClientProfile'];

/** Never fan out further than this in one turn, whatever the rules matched. */
const MAX_TOOLS = 4;

/**
 * @param {string} message  The trainer's question, verbatim.
 * @returns {{tools: string[], matched: boolean}}
 */
function planTools(message) {
  const text = String(message || '');
  const picked = [];

  for (const rule of RULES) {
    if (!rule.re.test(text)) continue;
    for (const t of rule.tools) if (!picked.includes(t)) picked.push(t);
  }

  if (!picked.length) return { tools: [...DEFAULT_TOOLS], matched: false };
  return { tools: picked.slice(0, MAX_TOOLS), matched: true };
}

/**
 * Cheap questions should not be billed as reasoning. Kept alongside the rules
 * so a new rule and its intent are chosen together.
 */
function planIntent(message) {
  const text = String(message || '');
  if (/\b(summar\w*|overview|status report|full picture|brief me)\b/i.test(text)) return 'summary';
  if (/\b(progress|analy\w*|why|should i|focus|concern|compare|trend)\b/i.test(text)) return 'analysis';
  if (/\b(when|what is|who|how many|expire|due|balance|number)\b/i.test(text)) return 'lookup';
  return 'analysis';
}

module.exports = { planTools, planIntent, RULES, DEFAULT_TOOLS, MAX_TOOLS };