'use strict';
const { routedChat } = require('../../ai/router');

const SYSTEM_PROMPT = `You are an entity extractor for a gym management system.
Extract named entities from the user's message. Return ONLY valid JSON with this schema:
{
  "client_name": "string or null",
  "trainer_name": "string or null",
  "amount": "number or null",
  "currency": "INR",
  "date": "YYYY-MM-DD or relative string like 'tomorrow'/'today' or null",
  "time": "HH:MM or descriptive like '7am'/'morning' or null",
  "duration_months": "number or null",
  "package_name": "string or null",
  "phone": "string or null",
  "message_text": "string or null (for communication agents)",
  "count": "number or null",
  "action": "one of: checkin|checkout|book|cancel|pay|renew|assign|send|generate|report|search|analyze or null"
}
Return null for any field not present. No prose, no markdown, no code fences.`;

/**
 * Extract structured entities from a natural-language message using LLM.
 * Falls back to an empty entity set on any failure.
 * @returns {{ client_name, trainer_name, amount, date, time, duration_months, package_name, phone, message_text, count, action }}
 */
async function extractEntities(message) {
  if (!message?.trim()) return emptyEntities();

  try {
    const result = await routedChat({
      intent:      'audit',
      messages:    [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: message },
      ],
      temperature: 0,
      max_tokens:  200,
    });

    const json = tryParseJSON(result.content);
    if (json && typeof json === 'object') {
      return { ...emptyEntities(), ...json };
    }
  } catch { /* log and return empty */ }

  return emptyEntities();
}

function emptyEntities() {
  return {
    client_name:      null,
    trainer_name:     null,
    amount:           null,
    currency:         'INR',
    date:             null,
    time:             null,
    duration_months:  null,
    package_name:     null,
    phone:            null,
    message_text:     null,
    count:            null,
    action:           null,
  };
}

function tryParseJSON(text) {
  try { return JSON.parse(text); } catch { /* ignore */ }
  const m = text.match(/\{[\s\S]+\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* ignore */ } }
  return null;
}

module.exports = { extractEntities };
