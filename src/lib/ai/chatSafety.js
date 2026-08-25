'use strict';

// src/lib/ai/chatSafety.js — AI Coach message classification (P0-3).
//
// The AI Coach chat endpoint used to hand every message straight to the model
// with only a generic "refer to a healthcare professional" line in the system
// prompt. This module adds a deterministic, risk-tiered classification of the
// trainer's message BEFORE the model is called:
//
//   high_risk  → medical emergency / crisis signals — refuse, redirect to
//                emergency care or a physician. The model is not called.
//   medical    → medical-adjacent topic (condition, medication, diagnosis,
//                pain, pregnancy) — the model still answers, but with an
//                explicit boundary appended to the system prompt: no
//                diagnosis, no dose guidance, refer to a professional.
//   fitness    → everything else — normal coaching.
//
// The classification is signal-based (specific phrases), never naive keyword
// blocking. The message "override today's workout" is not "override a medical
// gate" and must NOT be flagged; only concrete crisis/emergency phrasing is.
// See P0-5 (input moderation) for the separate prompt-injection classifier —
// this module is about WHAT the user is asking, not about hostile intent.

// ── High-risk (crisis / medical emergency) signals ──────────────────────────
// Any match refuses the answer outright and redirects to emergency care.
// The patterns are deliberately concrete: crisis and emergency phrasing, not
// generic medical vocabulary. "chest pain" is an emergency prompt; "cardio
// plan" is not.

const HIGH_RISK_PATTERNS = [
  // self-harm / suicide / crisis
  /suicid/i,
  /\bkill\s+(myself|myself)\b/i,
  /self[- ]?harm/i,
  /\bwant(?:s)?\s+to\s+die\b/i,
  /cut(?:ting)?\s+(?:my|their)\s+wrist/i,
  /end\s+(?:my|their)\s+life/i,
  // cardiac / respiratory emergencies
  /\bchest\s+pain\b/i,
  /heart\s+attack/i,
  /(?:can'?t|cannot)\s+(?:breathe|breath)\b/i,
  /\bnot\s+breathing\b/i,
  /shortness\s+of\s+breath\b/i,
  /\b(?:stroke|seizure|convulsion)\b/i,
  /anaphylax/i,
  /\bunconscious\b/i,
  // other emergencies
  /severe\s+bleeding/i,
  /overdos/i,
  /\bpoison/i,
  /pass(?:ing|ed)\s+out\b/i,
  /faint(?:ing|ed)?\b/i,
];

// ── Medical-boundary signals ────────────────────────────────────────────────
// Any match keeps the answer but appends a medical boundary to the system
// prompt. Order matters at classification time: high-risk is checked first.
const MEDICAL_PATTERNS = [
  /diagnos/i,
  /medication/i,
  /prescription/i,
  /\btake\s+\w+\s+(?:for|to)/i,       // "take aspirin for…"
  /\bdiabet/i,
  /hypertension|high\s+blood\s+pressure/i,
  /\basthma/i,
  /symptom/i,
  /\bdoctor\b/i,
  /\bphysician\b/i,
  /knee\s+pain|shoulder\s+pain|back\s+pain|joint\s+pain|hip\s+pain/i,
  /heart\s+condition/i,
  /\bcardiac\b/i,
  /\bpregnan/i,
  /\bepileps/i,
  /\binjur/i,
  /\banxiety\b|\bdepression\b/i,
];

// ── Boundary instructions ──────────────────────────────────────────────────
// Appended to the system prompt when a medical-adjacent message is detected.
// Unlike the generic coach line, this is concrete about what the model may
// and may not do, and it is added only when the topic actually warrants it —
// a plan/calorie question does not carry the same boundary overhead as a
// "is this knee pain normal?" question.
const MEDICAL_BOUNDARY =
  'The user\'s message touches a medical-adjacent topic. Do NOT diagnose conditions, ' +
  'prescribe or adjust medication or dosage, interpret symptoms, or declare a ' +
  'client "safe" for activity. Acknowledge the topic, give general non-medical ' +
  'context a qualified professional may use, and recommend the client consult a ' +
  'qualified physician or healthcare provider for anything specific. Never claim ' +
  'to be a doctor.';

// ── Classifier ──────────────────────────────────────────────────────────────

function classifyChatMessage(message) {
  if (!message) return { category: 'fitness', signals: [], boundary: null };
  const text = String(message);

  const highRisk = HIGH_RISK_PATTERNS.filter((re) => re.test(text)).map((re) => re.source);
  if (highRisk.length) {
    return { category: 'high_risk', signals: highRisk, boundary: null };
  }

  const medical = MEDICAL_PATTERNS.filter((re) => re.test(text)).map((re) => re.source);
  if (medical.length) {
    return { category: 'medical', signals: medical, boundary: MEDICAL_BOUNDARY };
  }

  return { category: 'fitness', signals: [], boundary: null };
}

// ── Redirection message for high-risk refusals ─────────────────────────────
// Shown to the trainer in place of a model answer. Deliberately does not
// repeat or echo the crisis content back — the point is to redirect, not to
// engage.
function highRiskRedirect(category) {
  return {
    code: 'SAFETY_HIGH_RISK',
    message: 'This question looks like a medical emergency or crisis situation. '
      + 'This assistant cannot help with that. Please contact emergency services '
      + 'immediately, and consult a qualified physician. If someone is in danger, '
      + 'do not wait — call your local emergency number now.',
  };
}

module.exports = {
  classifyChatMessage,
  highRiskRedirect,
  MEDICAL_BOUNDARY,
  HIGH_RISK_PATTERNS,
  MEDICAL_PATTERNS,
};