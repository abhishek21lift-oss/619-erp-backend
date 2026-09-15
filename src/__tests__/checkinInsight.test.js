'use strict';
// The check-in insight is allowed to say nothing. It is not allowed to invent.
//
// This endpoint existed in the frontend for some time with no backend behind
// it: api.pt.checkinInsight() POSTed to /api/pt-os/clients/:id/checkin-insight,
// which was never a route, so the card answered "Could not get an insight" on
// every press. It is implemented now, and what is pinned here is the half that
// matters — that a model's reply is validated before a trainer reads it, and
// that every way of having no answer produces a shaped "nothing to show"
// rather than an error or a guess.

const {
  generateCheckinInsight, buildFacts, parseInsight, MIN_CHECKINS, MAX_WEEKS,
} = require('../modules/pt-os/checkin-ai');

/** A chat() that returns exactly what the test hands it. */
const says = (content, model = 'vendor/m') => async () => ({ content, model });

const week = (n) => `2026-0${n}-01`;
const checkin = (over = {}) => ({
  week_start_date: week(1), weight: 80, mood: 'good', sleep_hours: 7,
  water_glasses: null, workout_count: 3, calories_avg: null, adherence_pct: 80,
  stress_level: null, energy_level: null, soreness_level: null,
  trainer_notes: null, client_notes: null, ...over,
});

const GOOD = JSON.stringify({
  summary: 'Adherence held at 80% while sleep fell from 7h to 5h.',
  notable_change: 'Sleep dropped 2h between the weeks of 2026-01-01 and 2026-02-01.',
  suggested_action: 'Ask about sleep before adding volume next week.',
});

describe('having nothing to say', () => {
  it('needs more than one check-in before there is a trend', async () => {
    const out = await generateCheckinInsight({ checkins: [checkin()], chat: says(GOOD) });
    expect(out.available).toBe(false);
    expect(out.checkins_count).toBe(1);
  });

  it('answers at exactly MIN_CHECKINS, so the boundary is not off by one', async () => {
    const atThreshold = Array.from({ length: MIN_CHECKINS }, (_, i) =>
      checkin({ week_start_date: week(i + 1) }));
    const out = await generateCheckinInsight({ checkins: atThreshold, chat: says(GOOD) });
    expect(out.available).toBe(true);
  });

  it('treats no check-ins the same way, rather than calling the model', async () => {
    const chat = jest.fn();
    const out = await generateCheckinInsight({ checkins: [], chat });
    expect(out.available).toBe(false);
    // Spending a model call to be told there is no history would be paying for
    // an answer the row count already gave.
    expect(chat).not.toHaveBeenCalled();
  });

  it('reports the provider being down as nothing to show, not as a failure', async () => {
    const out = await generateCheckinInsight({
      checkins: [checkin(), checkin({ week_start_date: week(2) })],
      chat: async () => { throw new Error('all models unreachable'); },
    });
    // Resolves. A card that throws on a provider outage teaches the trainer
    // that the feature is broken.
    expect(out.available).toBe(false);
    expect(out.reason).toMatch(/unavailable/i);
  });

  it.each([
    ['prose with no JSON at all', 'Sleep is down a bit, I would ask about it.'],
    ['JSON that does not parse', '{"summary": "unterminated'],
    ['valid JSON with an empty summary', JSON.stringify({ summary: '   ', notable_change: 'x' })],
    ['valid JSON with no summary key', JSON.stringify({ notable_change: 'Sleep fell 2h' })],
  ])('refuses %s', async (_label, content) => {
    const out = await generateCheckinInsight({
      checkins: [checkin(), checkin({ week_start_date: week(2) })],
      chat: says(content),
    });
    expect(out.available).toBe(false);
    // Specifically: no half-built object reaches the card.
    expect(out.summary).toBeUndefined();
    expect(out.notable_change).toBeUndefined();
  });
});

describe('a usable reply', () => {
  it('passes through the three fields and the model that wrote them', async () => {
    const out = await generateCheckinInsight({
      checkins: [checkin(), checkin({ week_start_date: week(2), sleep_hours: 5 })],
      chat: says(GOOD),
    });
    expect(out).toMatchObject({
      available: true,
      summary: 'Adherence held at 80% while sleep fell from 7h to 5h.',
      notable_change: expect.stringContaining('Sleep dropped 2h'),
      suggested_action: expect.stringContaining('Ask about sleep'),
      model: 'vendor/m',
    });
  });

  it('keeps the optional fields optional rather than inventing them', () => {
    const parsed = parseInsight(JSON.stringify({ summary: 'Weight is flat.' }));
    expect(parsed).toEqual({
      summary: 'Weight is flat.',
      notable_change: null,
      suggested_action: null,
    });
  });

  it('survives a model that wraps its JSON in a fence', () => {
    const parsed = parseInsight('```json\n' + GOOD + '\n```');
    expect(parsed?.summary).toMatch(/Adherence held/);
  });
});

describe('the prompt only ever contains rows that exist', () => {
  const two = [
    checkin({ week_start_date: week(2), sleep_hours: 5, weight: 79 }),
    checkin({ week_start_date: week(1), sleep_hours: 7, weight: 80 }),
  ];

  it('orders oldest first, so the trend is not described backwards', () => {
    const facts = buildFacts(two);
    expect(facts.indexOf(week(1))).toBeLessThan(facts.indexOf(week(2)));
  });

  it('omits a metric nobody recorded instead of printing it as zero', () => {
    const facts = buildFacts(two);
    // water_glasses and calories_avg are null on both rows. Rendering either
    // as 0 is the easiest way to get a confident sentence about dehydration.
    expect(facts).not.toMatch(/water 0/);
    expect(facts).not.toMatch(/calories 0/);
  });

  it('names the never-recorded metrics so the model does not assume they are fine', () => {
    const facts = buildFacts(two);
    expect(facts).toMatch(/NEVER RECORDED/);
    expect(facts).toMatch(/stress_level/);
    expect(facts).toMatch(/Do not comment on these/);
  });

  it('includes notes but does not let one essay crowd out the other weeks', () => {
    const facts = buildFacts([
      checkin({ week_start_date: week(1), client_notes: 'x'.repeat(5000) }),
      checkin({ week_start_date: week(2), trainer_notes: 'shoulder still sore' }),
    ]);
    expect(facts).toMatch(/shoulder still sore/);
    expect(facts.length).toBeLessThan(2000);
  });

  it('shows at most MAX_WEEKS of history', async () => {
    let seen = '';
    const many = Array.from({ length: 30 }, (_, i) =>
      checkin({ week_start_date: `2026-01-${String(i + 1).padStart(2, '0')}` }));
    await generateCheckinInsight({
      checkins: many,
      chat: async ({ messages }) => { seen = messages[1].content; return { content: GOOD }; },
    });
    expect(seen).toMatch(new RegExp(`WEEKLY CHECK-INS \\(${MAX_WEEKS},`));
  });
});
