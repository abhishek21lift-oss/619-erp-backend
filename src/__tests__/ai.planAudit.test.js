// The generated plan, checked against the rules that shaped it.
//
// ── What the route must guarantee ─────────────────────────────────────────
//
// Stage 3 made the model's INPUT safe. This is about its OUTPUT: the model
// writes free text, and telling it not to use an exercise is not the same as
// it not using one. These tests pin the loop end to end — a prescribed
// exclusion is caught, one revision is spent on it, a revision that makes
// things worse is thrown away, and no part of the second-opinion machinery
// can cost the trainer the generation they already waited for.
'use strict';

const request = require('supertest');
const express = require('express');

process.env.OPENROUTER_API_KEY = 'test-key';

jest.mock('../db/pool', () => ({ query: jest.fn() }));
jest.mock('../lib/ai/embeddings', () => ({
  embedText: jest.fn().mockResolvedValue(new Array(384).fill(0.1)),
  embedBatch: jest.fn().mockResolvedValue([new Array(384).fill(0.1)]),
  toVectorLiteral: jest.fn((v) => `[${v.join(',')}]`),
  EMBEDDING_DIM: 384,
}));
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = { id: 'u1', role: 'admin', organization_id: 'org-1' }; next(); },
  adminOnly: (_req, _res, next) => next(),
  adminOrManager: (_req, _res, next) => next(),
}));
jest.mock('../lib/ai/router', () => ({ routedStream: jest.fn(), routedChat: jest.fn() }));
jest.mock('../lib/ai/models', () => ({ models: { primary: 'primary-model' } }));
jest.mock('../lib/ai/usage', () => ({
  logUsage: jest.fn().mockResolvedValue(undefined),
  getUserUsage: jest.fn(), getModelStats: jest.fn(),
}));

const pool = require('../db/pool');
const { routedStream, routedChat } = require('../lib/ai/router');

const app = express();
app.use(require('../middleware/requestId'));
app.use(express.json());
app.use('/api/ai', require('../routes/ai'));

const CLIENT = {
  id: 'client-1', name: 'Test Client', gender: 'female', dob: '1992-05-10',
  weight: 65, height: 160, goal: 'muscle_gain', injuries: null,
  workout_experience_level: 'intermediate', frequency: '2',
  health_conditions: null, previous_trainer_experience: false,
};
const GOAL = { goal_type: 'muscle_gain', target_weight: 68 };
const ASSESSMENT = { weight: 65, body_fat_pct: 24, bmi: 25, created_at: '2026-07-01T00:00:00Z' };

/** Library rows, spelled as the library spells them. */
const BENCH = {
  name: 'Bench Press', muscle_group: 'Chest', body_part: 'Chest', target_muscle: 'Chest',
  movement_pattern: 'Horizontal Push', equipment: 'Barbell', difficulty: 'beginner',
};
const SQUAT = {
  name: 'Barbell Squat', muscle_group: 'Legs', body_part: 'Legs', target_muscle: 'Quadriceps',
  movement_pattern: 'Squat', equipment: 'Barbell', difficulty: 'beginner',
};

const regions = (o = {}) => [
  'Neck', 'Shoulders', 'Thoracic Spine', 'Hip', 'Hamstrings', 'Quadriceps', 'Ankles', 'Wrists',
].map((region) => ({ region, score: 3, pain: false, restriction: false, ...(o[region] || {}) }));

const ex = (name) => ({
  name, prescription_type: 'SETS_REPS', sets: 4, reps: '8-10',
  rir_or_rpe: 'RIR 2', tempo: '3-1-1-0', rest_seconds: 120,
});

const planWith = (names) => ({
  name: 'Block', description: 'x', goal: 'muscle_gain', level: 'intermediate',
  weeks: 8, days_per_week: names.length, equipment: ['Barbell'],
  warm_up: 'ramp sets', cool_down: 'stretch',
  progression_notes: 'add 2.5kg weekly',
  weekly_schedule: Object.fromEntries(
    names.map((n, i) => [['Monday', 'Thursday'][i] || `Day${i}`,
      { name: 'S', focus: 'f', exercises: [ex(n)] }]),
  ),
  nutrition_notes: '',
});

/** Shoulder pain on the mobility screen: blocks Bench Press, allows the squat. */
function mockDb() {
  pool.query.mockReset();
  pool.query.mockImplementation((sql) => {
    const rows =
      /FROM pt_clients/.test(sql) ? [CLIENT]
        : /FROM pt_parq_forms/.test(sql)
          ? [{ workout_gate_status: 'cleared', past_history: {}, current_health: {} }]
          : /FROM pt_mobility_performance_assessments/.test(sql)
            ? [{ body_regions: regions({ Shoulders: { pain: true } }) }]
            // The audit's own library lookup, by normalised name — a different
            // query from the prompt's retrieval, and the one that makes
            // "was a blocked exercise prescribed" answerable at all.
            : /FROM exercises\s+WHERE/.test(sql) ? [BENCH, SQUAT]
              : /FROM exercises e/.test(sql) ? []
                : /FROM pt_goals/.test(sql) ? [GOAL]
                  : /FROM pt_assessments/.test(sql) ? [ASSESSMENT]
                    : [];
    return Promise.resolve({ rows });
  });
}

function streamOnce(text) {
  const meta = { model: 'primary-model', tier: 'primary', used_fallback: false };
  let sent = false; let done = false;
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        if (done) return Promise.resolve({ done: true, value: meta });
        if (!sent) { sent = true; return Promise.resolve({ done: false, value: text }); }
        done = true;
        return Promise.resolve({ done: true, value: meta });
      },
    }),
  };
}

const BODY = { client_id: 'client-1', training_days: 2, duration_weeks: 8 };
const doneOf = (text) => JSON.parse(
  text.split('\n').find((l) => l.startsWith('data: ') && l.includes('"type":"done"')).slice(6),
);
/** The revision call, if one was made — identified by its assistant turn. */
const revisionCall = () => routedChat.mock.calls
  .map(([a]) => a).find((a) => a.messages.some((m) => m.role === 'assistant'));
const critiqueCall = () => routedChat.mock.calls
  .map(([a]) => a).find((a) => m0(a).includes('second strength coach'));
const m0 = (a) => a.messages[0].content;

beforeEach(() => {
  mockDb();
  routedStream.mockReset();
  routedChat.mockReset();
  routedChat.mockResolvedValue({ content: '{"critique":[],"verdict":"sound"}', model: 'm' });
});

describe('a plan that prescribes a blocked exercise', () => {
  it('is caught, and one revision is spent replacing it', async () => {
    routedStream.mockReturnValue(streamOnce(JSON.stringify(planWith(['Bench Press', 'Barbell Squat']))));
    // The revision returns the same plan with the excluded movement swapped.
    routedChat.mockImplementation(({ messages }) => Promise.resolve({
      content: messages.some((m) => m.role === 'assistant')
        ? JSON.stringify(planWith(['Barbell Squat', 'Barbell Squat']))
        : '{"critique":[],"verdict":"sound"}',
      model: 'm',
    }));

    const res = await request(app).post('/api/ai/workout/generate').send(BODY);
    expect(res.status).toBe(200);

    const done = doneOf(res.text);
    expect(done.audit.revised).toBe(true);
    expect(done.audit.counts.critical).toBe(0);
    expect(done.quality.score).toBe(100);
    // The instruction named the exercise and the reason, not "improve it".
    expect(revisionCall().messages.at(-1).content).toContain('Bench Press is excluded');
    expect(revisionCall().messages.at(-1).content).toContain('Shoulders: pain');
  });

  it('ships the violation visibly when the revision does not fix it', async () => {
    routedStream.mockReturnValue(streamOnce(JSON.stringify(planWith(['Bench Press', 'Barbell Squat']))));
    // A model that ignored an explicit replace instruction once usually
    // ignores it twice. One revision, then the finding ships and the trainer
    // decides — rather than a loop turning one bad generation into four.
    routedChat.mockImplementation(({ messages }) => Promise.resolve({
      content: messages.some((m) => m.role === 'assistant')
        ? JSON.stringify(planWith(['Bench Press', 'Barbell Squat']))
        : '{"critique":[],"verdict":"sound"}',
      model: 'm',
    }));

    const res = await request(app).post('/api/ai/workout/generate').send(BODY);
    const done = doneOf(res.text);

    expect(done.audit.counts.critical).toBe(1);
    expect(done.audit.violations[0]).toMatchObject({
      rule: 'blocked_exercise_prescribed', exercise: 'Bench Press', where: 'Monday #1',
    });
    expect(done.quality.components.safety).toBe(0);
    // Exactly one revision was attempted.
    expect(routedChat.mock.calls.filter(([a]) => a.messages.some((m) => m.role === 'assistant')))
      .toHaveLength(1);
  });

  it('throws away a revision that fixed the exercise and broke the block', async () => {
    routedStream.mockReturnValue(streamOnce(JSON.stringify(planWith(['Bench Press', 'Barbell Squat']))));
    routedChat.mockImplementation(({ messages }) => {
      if (!messages.some((m) => m.role === 'assistant')) {
        return Promise.resolve({ content: '{"critique":[],"verdict":"sound"}', model: 'm' });
      }
      // Shoulder fixed, but the warm-up and progression are gone and it is
      // down to one day. Newer is not better, and shipping it because it is
      // newer would make the loop a liability.
      const worse = planWith(['Barbell Squat']);
      worse.warm_up = '';
      worse.progression_notes = '';
      return Promise.resolve({ content: JSON.stringify(worse), model: 'm' });
    });

    const res = await request(app).post('/api/ai/workout/generate').send(BODY);
    const done = doneOf(res.text);

    expect(done.audit.revised).toBe(false);
    // The original is what ships, with its own violation still reported.
    expect(done.data.weekly_schedule.Monday.exercises[0].name).toBe('Bench Press');
    expect(done.audit.counts.critical).toBe(1);
  });
});

describe('a clean plan', () => {
  it('is not sent for revision at all', async () => {
    routedStream.mockReturnValue(streamOnce(JSON.stringify(planWith(['Barbell Squat', 'Barbell Squat']))));
    const res = await request(app).post('/api/ai/workout/generate').send(BODY);

    const done = doneOf(res.text);
    expect(done.audit.counts).toMatchObject({ critical: 0, major: 0, minor: 0 });
    expect(done.audit.revised).toBe(false);
    expect(revisionCall()).toBeUndefined();
    // The critic still runs — it answers what a rule cannot.
    expect(critiqueCall()).toBeDefined();
  });
});

describe('the second opinion is advisory', () => {
  it('keeps the rules and the critic in separate fields', async () => {
    routedStream.mockReturnValue(streamOnce(JSON.stringify(planWith(['Barbell Squat', 'Barbell Squat']))));
    routedChat.mockResolvedValue({
      content: JSON.stringify({
        critique: [{ severity: 'medium', point: 'No horizontal pulling all week', because: 'both days are squat-led' }],
        verdict: 'workable',
      }),
      model: 'm',
    });

    const done = doneOf((await request(app).post('/api/ai/workout/generate').send(BODY)).text);
    // A list that mixes "prescribes a blocked exercise" with "the accessory
    // volume looks high to me" teaches the reader to skim both.
    expect(done.audit.violations).toEqual([]);
    expect(done.critique).toEqual([
      { severity: 'medium', point: 'No horizontal pulling all week', because: 'both days are squat-led' },
    ]);
    expect(done.critique_verdict).toBe('workable');
  });

  it('never costs the trainer the generation when it fails', async () => {
    routedStream.mockReturnValue(streamOnce(JSON.stringify(planWith(['Barbell Squat', 'Barbell Squat']))));
    routedChat.mockRejectedValue(new Error('every model down'));

    const res = await request(app).post('/api/ai/workout/generate').send(BODY);
    const done = doneOf(res.text);

    expect(res.status).toBe(200);
    expect(done.data).toBeTruthy();
    // The audit is the part that must always run; it needs no model at all.
    expect(done.audit.counts.exercises).toBe(2);
    expect(done.quality.score).toBe(100);
    expect(done.critique).toEqual([]);
  });

  it('survives a revision failure without losing the first plan', async () => {
    routedStream.mockReturnValue(streamOnce(JSON.stringify(planWith(['Bench Press', 'Barbell Squat']))));
    routedChat.mockRejectedValue(new Error('timeout'));

    const done = doneOf((await request(app).post('/api/ai/workout/generate').send(BODY)).text);
    expect(done.data.weekly_schedule.Monday.exercises[0].name).toBe('Bench Press');
    expect(done.audit.counts.critical).toBe(1);
    expect(done.audit.revised).toBe(false);
  });
});

describe('what the audit could not check', () => {
  it('reports an exercise the library does not hold, rather than clearing it', async () => {
    routedStream.mockReturnValue(streamOnce(JSON.stringify(planWith(['Overhead Press', 'Barbell Squat']))));
    const done = doneOf((await request(app).post('/api/ai/workout/generate').send(BODY)).text);

    // Fuzzy matching resolves this to "Overhead Lat" in the real library — a
    // lat exercise clearing a shoulder-loading press for a client whose
    // shoulder is why it would be excluded. Abstaining is visible; guessing
    // wrong is not.
    expect(done.audit.unverified).toEqual([{ day: 'Monday', position: 1, name: 'Overhead Press' }]);
    expect(done.audit.violations).toEqual([]);
    expect(done.quality.components.evidence).toBeLessThan(10);
  });
});
