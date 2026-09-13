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
function mockDb({ history = [] } = {}) {
  pool.query.mockReset();
  pool.query.mockImplementation((sql) => {
    // Programming memory: the proposal ledger this generation reads and writes.
    if (/INSERT INTO ai_workout_generations/.test(sql)) {
      return Promise.resolve({ rows: [{ id: 'gen-1' }] });
    }
    if (/FROM ai_workout_generations/.test(sql)) return Promise.resolve({ rows: history });
    if (/FROM muscle_volume_landmarks/.test(sql)) return Promise.resolve({ rows: [] });
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

describe('programming memory', () => {
  /** A stored proposal whose saved plan dropped the bench press. */
  const pastRow = () => ({
    id: 'g-old',
    created_at: '2026-08-01T00:00:00Z',
    quality_score: 100,
    revised: false,
    proposed_plan: {
      weekly_schedule: {
        Monday: { exercises: [{ name: 'Bench Press' }, { name: 'Barbell Squat' }] },
      },
    },
    accepted_plan_id: 'plan-old',
    accepted_at: '2026-08-01T01:00:00Z',
    accepted_exercises: ['Barbell Squat', 'Dumbbell Bench Press'],
  });

  it('records every proposal, accepted or not, with its screen frozen', async () => {
    mockDb();
    routedStream.mockReturnValue(streamOnce(JSON.stringify(planWith(['Barbell Squat', 'Barbell Squat']))));

    const res = await request(app).post('/api/ai/workout/generate').send(BODY);
    const done = doneOf(res.text);

    const insert = pool.query.mock.calls.find(([sql]) => /INSERT INTO ai_workout_generations/.test(sql));
    expect(insert).toBeDefined();
    // 95 generations had produced 9 live plans when this was added. The
    // proposals nobody accepts are the ones with something to say, so the row
    // is written before anyone has decided anything.
    expect(done.generation_id).toBe('gen-1');

    const params = insert[1];
    expect(params[2]).toBe('client-1');
    // The screen is stored as it stood for THIS generation rather than
    // recomputed later against rules that have since changed.
    expect(JSON.parse(params[9])).toMatchObject({ screened: true, gate: { cleared: true } });
  });

  it('tells the next generation what the trainer changed last time', async () => {
    mockDb({ history: [pastRow(), pastRow()] });
    routedStream.mockReturnValue(streamOnce(JSON.stringify(planWith(['Barbell Squat', 'Barbell Squat']))));

    await request(app).post('/api/ai/workout/generate').send(BODY);
    const prompt = routedStream.mock.calls[0][0].messages.find((m) => m.role === 'user').content;

    expect(prompt).toContain('WHAT THIS TRAINER DID WITH YOUR LAST SUGGESTIONS');
    expect(prompt).toContain('Repeatedly REMOVED from your proposals: Bench Press (2x)');
    expect(prompt).toContain('Repeatedly ADDED by the trainer: Dumbbell Bench Press (2x)');
    // Memory feeds selection, never permission.
    expect(prompt).toContain('preferences, not permissions');
  });

  it('puts the safety screen ahead of the trainer\'s preferences', async () => {
    mockDb({ history: [pastRow(), pastRow()] });
    routedStream.mockReturnValue(streamOnce(JSON.stringify(planWith(['Barbell Squat', 'Barbell Squat']))));

    await request(app).post('/api/ai/workout/generate').send(BODY);
    const prompt = routedStream.mock.calls[0][0].messages.find((m) => m.role === 'user').content;

    // A preference read before a constraint is a preference that can override
    // one. Ordering is not the only guard — describeMemory says so in words —
    // but it is the cheapest.
    const screen = prompt.indexOf('SAFETY SCREEN');
    const mem = prompt.indexOf('WHAT THIS TRAINER DID WITH YOUR LAST SUGGESTIONS');
    const goals = prompt.indexOf('CLIENT AUTHORITATIVE DATA:');
    expect(screen).toBeLessThan(mem);
    // And specifically BETWEEN the screen and the goals, which is what the
    // route claims. Pinned because a preference pushed to the end of a long
    // prompt, below every instruction, reads as an afterthought — a placement
    // that satisfies "safety first" while quietly costing the memory its
    // weight.
    expect(mem).toBeLessThan(goals);
  });

  it('says nothing about memory for a client with no proposal history', async () => {
    mockDb({ history: [] });
    routedStream.mockReturnValue(streamOnce(JSON.stringify(planWith(['Barbell Squat', 'Barbell Squat']))));

    await request(app).post('/api/ai/workout/generate').send(BODY);
    const prompt = routedStream.mock.calls[0][0].messages.find((m) => m.role === 'user').content;
    expect(prompt).not.toContain('WHAT THIS TRAINER DID WITH YOUR LAST SUGGESTIONS');
  });

  it('still generates when the ledger is unreadable', async () => {
    mockDb();
    pool.query.mockImplementationOnce(() => Promise.resolve({ rows: [CLIENT] }));
    const original = pool.query.getMockImplementation();
    pool.query.mockImplementation((sql) => (/ai_workout_generations/.test(sql)
      ? Promise.reject(new Error('ledger down'))
      : original(sql)));
    routedStream.mockReturnValue(streamOnce(JSON.stringify(planWith(['Barbell Squat', 'Barbell Squat']))));

    const res = await request(app).post('/api/ai/workout/generate').send(BODY);
    // The trainer has their plan either way. Bookkeeping must not cost a
    // generation they waited thirty seconds for.
    expect(res.status).toBe(200);
    expect(doneOf(res.text).data).toBeTruthy();
    expect(doneOf(res.text).generation_id).toBeNull();
  });
});
