'use strict';
const { routedChat } = require('../../ai/router');

// Static keyword → department routing (fast path, no LLM needed).
// Keys are lowercase keywords; values are department agent names.
const KEYWORD_ROUTES = {
  // Attendance
  checkin:     'attendance', 'check-in': 'attendance', checkout: 'attendance',
  'check out': 'attendance', attendance: 'attendance', absent:   'attendance',
  absences:    'attendance', present:    'attendance', qr:       'attendance',
  'check in':  'attendance', marked:     'attendance', 'staff attendance': 'attendance',

  // Client / Member
  client:    'client', member:   'client', members:  'client',
  clients:   'client', profile:  'client', diabetic: 'client',
  health:    'client', medical:  'client', contact:  'client',
  inactive:  'client', overweight:'client',

  // Trainer
  trainer:  'trainer', trainers: 'trainer', assign:   'trainer',
  assigned: 'trainer', coaching: 'trainer', 'pt trainer': 'trainer',

  // Session / Booking
  session:  'session', sessions:  'session', book:    'session',
  booking:  'session', bookings:  'session', schedule:'session',
  'pt session': 'session', cancel: 'session', appointment: 'session',

  // Finance / Payments
  payment:  'finance', payments: 'finance', pay:     'finance',
  paid:     'finance', invoice:  'finance', invoices:'finance',
  due:      'finance', dues:     'finance', fee:     'finance',
  fees:     'finance', revenue:  'finance', collect: 'finance',
  payout:   'finance', commission:'finance', outstanding: 'finance',
  'unpaid': 'finance', 'balance': 'finance',

  // Subscription / Renewal
  renewal:     'subscription', renew:       'subscription',
  subscription:'subscription', subscriptions:'subscription',
  expire:      'subscription', expired:     'subscription',
  expiring:    'subscription', package:     'subscription',

  // Communication / Notifications
  whatsapp:  'communication', message:   'communication',
  notify:    'communication', reminder:  'communication',
  reminders: 'communication', email:     'communication',
  sms:       'communication', broadcast: 'communication',
  send:      'communication', notification: 'communication',

  // Progress / Assessment
  progress:   'progress', assessment: 'progress', weight:   'progress',
  body:       'progress', checkin:    'progress', goals:    'progress',
  strength:   'progress', measurement:'progress', photos:   'progress',

  // AI Coach
  workout:  'aicoach', diet:    'aicoach', nutrition: 'aicoach',
  exercise: 'aicoach', meal:    'aicoach', program:   'aicoach',
  plan:     'aicoach', 'meal plan': 'aicoach', 'workout plan': 'aicoach',

  // Business Insights
  insight:    'insights', insights:   'insights', analytics: 'insights',
  report:     'insights', reports:    'insights', summary:   'insights',
  trend:      'insights', trends:     'insights', statistics:'insights',
  performance:'insights', dashboard:  'insights', kpi:       'insights',
};

/**
 * Detect which department(s) a natural-language message is directed at.
 *
 * Fast path: keyword matching.
 * Slow path: LLM classification (used when keywords give no match or low confidence).
 *
 * Returns: { departments: string[], intent: string, confidence: 'high'|'medium'|'low', method: 'keyword'|'llm' }
 */
async function detectIntent(message) {
  const lower = message.toLowerCase();
  const found  = new Map(); // department → hit count

  for (const [keyword, dept] of Object.entries(KEYWORD_ROUTES)) {
    if (lower.includes(keyword)) {
      found.set(dept, (found.get(dept) || 0) + 1);
    }
  }

  if (found.size > 0) {
    const sorted = [...found.entries()].sort((a, b) => b[1] - a[1]);
    const departments = sorted.map(([dept]) => dept);
    return {
      departments,
      intent:     departments[0],
      confidence: sorted[0][1] >= 2 ? 'high' : 'medium',
      method:     'keyword',
    };
  }

  // LLM fallback for ambiguous messages
  return detectIntentViaLLM(message);
}

async function detectIntentViaLLM(message) {
  const VALID_DEPTS = ['attendance','client','trainer','session','finance',
                       'subscription','communication','progress','aicoach','insights','general'];
  try {
    const result = await routedChat({
      intent: 'audit',
      messages: [
        {
          role: 'system',
          content: `You are an intent classifier for a gym management system.
Classify the user's message into one or more of these departments:
attendance, client, trainer, session, finance, subscription, communication, progress, aicoach, insights, general

Respond ONLY with valid JSON: {"departments":["dept1"],"intent":"primary_dept","confidence":"high|medium|low"}
No prose, no markdown.`,
        },
        { role: 'user', content: message },
      ],
      temperature: 0,
      max_tokens:  80,
    });

    const json = tryParseJSON(result.content);
    if (json?.departments?.length) {
      return { ...json, method: 'llm' };
    }
  } catch { /* fall through */ }

  return { departments: ['general'], intent: 'general', confidence: 'low', method: 'fallback' };
}

function tryParseJSON(text) {
  try { return JSON.parse(text); } catch { /* ignore */ }
  const m = text.match(/\{[\s\S]+\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* ignore */ } }
  return null;
}

module.exports = { detectIntent };
