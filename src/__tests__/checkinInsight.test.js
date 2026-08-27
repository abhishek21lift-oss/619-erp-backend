// A short, advisory read of a client's weekly check-ins — everything except
// the model call, same split as coach-ai.test.js and for the same reason:
// what goes into the prompt and what is allowed back out are the parts that
// can be wrong, and both are pure functions here.
'use strict';

const {
  generateCheckinInsight, buildFacts, parseInsight, SYSTEM_PROMPT,
} = require('../modules/pt-os/checkin-insight');

const CLIENT = { name: 'Ratnam Yadav' };

const CHECKINS = [
  { weight: 74.2, mood: 'good', sleep_hours: 7, water_glasses: 6, client_notes: null, created_at: '2026-08-01T00:00:00Z' },
  { weight: 73.5, mood: 'tired', sleep_hours: 5, water_glasses: null, client_notes: 'Rough week at work', created_at: '2026-08-08T00:00:00Z' },
];

describe('buildFacts — the prompt carries the gaps, not just the readings', () => {
  const facts = buildFacts({ client: CLIENT, checkins: CHECKINS });

  it('includes the readings that exist', () => {
    expect(facts).toContain('Ratnam Yadav');
    expect(facts).toContain('weight 74.2kg');
    expect(facts).toContain('mood tired');
    expect(facts).toContain('sleep 5h');
    expect(facts).toContain('Rough week at work');
  });

  it('names a missing field as not logged rather than omitting it', () => {
    expect(facts).toContain('water not logged'); // the second check-in's water_glasses is null
  });

  it('survives an empty client and an empty check-in list', () => {
    expect(() => buildFacts({ client: null, checkins: [] })).not.toThrow();
    expect(buildFacts({ client: null, checkins: [] })).toContain('0 total');
  });
});

describe('SYSTEM_PROMPT — the rules that matter are stated', () => {
  it('forbids inventing a value and requires plain honesty when nothing stands out', () => {
    expect(SYSTEM_PROMPT).toMatch(/[Nn]ever state a number or fact that is not in the check-ins/);
    expect(SYSTEM_PROMPT).toMatch(/say so plainly rather than manufacturing a concern/);
    expect(SYSTEM_PROMPT).toMatch(/no medical advice/i);
  });
});

describe('parseInsight — what is allowed back out', () => {
  it('reads a clean reply', () => {
    const out = parseInsight('{"summary":"Sleep dropped this week.","notable_change":"Sleep fell from 7h to 5h.","suggested_action":"Ask about workload."}');
    expect(out).toEqual({
      summary: 'Sleep dropped this week.',
      notable_change: 'Sleep fell from 7h to 5h.',
      suggested_action: 'Ask about workload.',
    });
  });

  it('digs the JSON out of prose and fences, which models add unasked', () => {
    const wrapped = 'Sure!\n```json\n{"summary":"Stable week.","notable_change":null,"suggested_action":null}\n```';
    expect(parseInsight(wrapped)).toEqual({ summary: 'Stable week.', notable_change: null, suggested_action: null });
  });

  it('treats a missing summary as no usable insight at all', () => {
    expect(parseInsight('{"notable_change":"x","suggested_action":"y"}')).toBeNull();
    expect(parseInsight('{"summary":"   "}')).toBeNull();
  });

  it('normalises a blank notable_change/suggested_action to null rather than an empty string', () => {
    const out = parseInsight('{"summary":"Fine.","notable_change":"","suggested_action":"   "}');
    expect(out.notable_change).toBeNull();
    expect(out.suggested_action).toBeNull();
  });

  it('returns null for junk instead of throwing', () => {
    for (const junk of ['', 'no json here', '{broken', null, undefined, 42]) {
      expect(parseInsight(junk)).toBeNull();
    }
  });
});

describe('generateCheckinInsight', () => {
  const args = { client: CLIENT, checkins: CHECKINS };

  it('returns the model\'s insight when it obeys the contract', async () => {
    const chat = jest.fn().mockResolvedValue({
      content: '{"summary":"Sleep dropped.","notable_change":"5h vs usual 7h.","suggested_action":"Check in about stress."}',
      model: 'test-model',
    });
    const out = await generateCheckinInsight({ ...args, chat });
    expect(out.available).toBe(true);
    expect(out.summary).toBe('Sleep dropped.');
    expect(out.model).toBe('test-model');
  });

  it('sends the facts and asks for a moderate temperature, under the checkin intent', async () => {
    const chat = jest.fn().mockResolvedValue({ content: '{"summary":"Stable."}' });
    await generateCheckinInsight({ ...args, chat });
    const call = chat.mock.calls[0][0];
    expect(call.messages[0].content).toBe(SYSTEM_PROMPT);
    expect(call.messages[1].content).toContain('Ratnam Yadav');
    expect(call.intent).toBe('checkin');
    expect(call.temperature).toBeLessThanOrEqual(0.5);
  });

  it('is unavailable, not broken, when every model is down', async () => {
    // No rule-based substitute exists for "what changed in the notes" — the
    // card simply does not appear, it does not show something invented.
    const chat = jest.fn().mockRejectedValue(new Error('ALL_MODELS_FAILED'));
    const out = await generateCheckinInsight({ ...args, chat });
    expect(out).toEqual({ available: false, reason: 'ai_unavailable' });
  });

  it('is unavailable when the model replies with nothing usable', async () => {
    const chat = jest.fn().mockResolvedValue({ content: 'I could not determine anything.' });
    const out = await generateCheckinInsight({ ...args, chat });
    expect(out).toEqual({ available: false, reason: 'unparseable_response' });
  });
});
