// The safety screen, as the generator route actually applies it.
//
// ── The bug these tests close ─────────────────────────────────────────────
//
// /api/ai/workout/generate took the client's injuries from
// client_fitness_profiles.injuries, then pt_clients.injuries. The first table
// has NO ROWS in production and the second is empty for all 34 clients — so
// the prompt said "Injuries / limitations: none" for every programme this
// studio has ever generated, while 15 PAR-Q forms, 3 mobility screens and 3
// posture screens sat unread in the same database.
//
// The route could not see them because its client loader never selected from
// those tables. It now loads the digital twin, and these tests pin the three
// things that must be true of that:
//
//   · an unscreened client is never described as uninjured;
//   · a blocked exercise never reaches the model at all;
//   · a client the studio explicitly did not clear gets no programme.
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
const { routedStream } = require('../lib/ai/router');

const app = express();
app.use(require('../middleware/requestId'));
app.use(express.json());
app.use('/api/ai', require('../routes/ai'));

const CLIENT = {
  id: 'client-1', name: 'Test Client', gender: 'female', dob: '1992-05-10',
  weight: 65, height: 160, goal: 'muscle_gain', injuries: null,
  workout_experience_level: 'intermediate', frequency: '4',
  health_conditions: null, previous_trainer_experience: false,
};
const ASSESSMENT = { weight: 65, body_fat_pct: 24, bmi: 25, created_at: '2026-07-01T00:00:00Z' };
const GOAL = { goal_type: 'muscle_gain', target_weight: 68 };
const PLAN = {
  name: 'Block', description: 'x', goal: 'muscle_gain', level: 'intermediate',
  weeks: 8, days_per_week: 4, equipment: ['full gym'], warm_up: '', cool_down: '',
  progression_notes: '', weekly_schedule: {}, nutrition_notes: '',
};

/** Real library rows, spelled as the library spells them. */
const BENCH = {
  name: 'Barbell Bench Press - Medium Grip', muscle_group: 'Chest', target_muscle: 'Chest',
  movement_pattern: 'Horizontal Push', equipment: 'Barbell', difficulty: 'beginner',
};
const SQUAT = {
  name: 'Barbell Squat', muscle_group: 'Legs', target_muscle: 'Quadriceps',
  movement_pattern: 'Squat', equipment: 'Barbell', difficulty: 'beginner',
};

const regions = (overrides = {}) => [
  'Neck', 'Shoulders', 'Thoracic Spine', 'Hip', 'Hamstrings', 'Quadriceps', 'Ankles', 'Wrists',
].map((region) => ({ region, score: 3, pain: false, restriction: false, ...(overrides[region] || {}) }));

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

function mockDb({ parq = [], mobility = [], posture = [], exercises = [], sets = [] } = {}) {
  pool.query.mockReset();
  pool.query.mockImplementation((sql) => {
    const rows =
      /FROM pt_clients/.test(sql) ? [CLIENT]
        : /FROM pt_parq_forms/.test(sql) ? parq
          : /FROM pt_mobility_performance_assessments/.test(sql) ? mobility
            : /FROM pt_posture_assessments/.test(sql) ? posture
              : /FROM exercises e/.test(sql) ? exercises
                : /FROM workout_sets s/.test(sql) ? sets
                  : /FROM pt_goals/.test(sql) ? [GOAL]
                    : /FROM pt_assessments/.test(sql) ? [ASSESSMENT]
                      : [];
    return Promise.resolve({ rows });
  });
}

const BODY = { client_id: 'client-1', training_days: 4, duration_weeks: 8 };
const promptOf = () => routedStream.mock.calls[0][0].messages.find((m) => m.role === 'user').content;
const doneOf = (text) => JSON.parse(
  text.split('\n').find((l) => l.startsWith('data: ') && l.includes('"type":"done"')).slice(6),
);

beforeEach(() => {
  routedStream.mockReset();
  routedStream.mockReturnValue(streamOnce(JSON.stringify(PLAN)));
});

describe('an unscreened client', () => {
  it('is never described to the model as having no injuries', async () => {
    mockDb({});
    const res = await request(app).post('/api/ai/workout/generate').send(BODY);

    expect(res.status).toBe(200);
    const prompt = promptOf();
    // The old behaviour, verbatim, for every client in production.
    expect(prompt).not.toContain('Injuries / limitations: none');
    expect(prompt).toContain('Injuries / limitations: UNKNOWN — nobody has screened this client');
    expect(prompt).toContain('NOBODY HAS SCREENED THIS CLIENT');
  });

  it('still gets a programme, because refusing would break the feature for most of the roster', async () => {
    // 19 of 34 production clients have no PAR-Q. Blocking them outright would
    // take a working feature away from more than half the studio on day one,
    // so generation proceeds and the prompt carries the warning instead.
    mockDb({});
    const res = await request(app).post('/api/ai/workout/generate').send(BODY);
    expect(res.status).toBe(200);
    expect(doneOf(res.text).screen.screened).toBe(false);
  });
});

describe('a client the studio did not clear', () => {
  it('gets no programme at all', async () => {
    mockDb({ parq: [{ workout_gate_status: 'referred', risk_level: 'high', past_history: {}, current_health: {} }] });
    const res = await request(app).post('/api/ai/workout/generate').send(BODY);

    // Someone looked at this client and said not yet. Generating anyway would
    // be this route overruling the trainer who filled the form in.
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_CLEARED');
    expect(res.body.gate).toBe('referred');
    expect(routedStream).not.toHaveBeenCalled();
  });
});

describe('the exercise screen', () => {
  it('omits a blocked exercise from the prompt entirely', async () => {
    mockDb({
      parq: [{ workout_gate_status: 'cleared', past_history: {}, current_health: {} }],
      mobility: [{ body_regions: regions({ Shoulders: { pain: true } }) }],
      exercises: [BENCH, SQUAT],
    });
    const res = await request(app).post('/api/ai/workout/generate').send(BODY);
    expect(res.status).toBe(200);

    const prompt = promptOf();
    const library = prompt.slice(prompt.indexOf('EXERCISE LIBRARY (AUTHORIZED AND SCREENED):'));
    // Not "sent with a do-not-use note" — absent. A prohibition the model has
    // to hold in working memory across a long generation is one it can drop
    // once, and the once is a client pressing on a painful shoulder.
    expect(library).not.toContain(BENCH.name);
    expect(library).toContain(SQUAT.name);
  });

  it('tells the trainer what was removed and why', async () => {
    mockDb({
      parq: [{ workout_gate_status: 'cleared', past_history: {}, current_health: {} }],
      mobility: [{ body_regions: regions({ Shoulders: { pain: true } }) }],
      exercises: [BENCH, SQUAT],
    });
    const res = await request(app).post('/api/ai/workout/generate').send(BODY);

    const { screen } = doneOf(res.text);
    // A plan that arrives with no provenance has to be taken on faith, and the
    // point of deciding by rule was that it could be checked.
    expect(screen.excluded_exercises).toEqual([
      { name: BENCH.name, reasons: ['mobility.body_regions: Shoulders: pain'] },
    ]);
    expect(screen.constraints[0]).toMatchObject({ verdict: 'block', region: 'shoulder' });
    expect(screen.gate.cleared).toBe(true);
    expect(screen.screened).toBe(true);
  });

  it('carries the real findings into the injuries line', async () => {
    mockDb({
      parq: [{ workout_gate_status: 'cleared', past_history: { knee_pain: true, joint_problems: true }, current_health: {} }],
      exercises: [SQUAT],
    });
    await request(app).post('/api/ai/workout/generate').send(BODY);

    const prompt = promptOf();
    expect(prompt).toContain('knee (caution, from parq.past_history)');
    expect(prompt).toContain('joint problems');
  });
});

describe('the training history', () => {
  it('reaches the prompt, and refuses a trend it cannot support', async () => {
    mockDb({
      parq: [{ workout_gate_status: 'cleared', past_history: {}, current_health: {} }],
      sets: [
        { exercise_name: 'Barbell Squat', weight_kg: 60, reps: 8, completed: true, session_date: '2026-09-01', muscle_group: 'Legs' },
        { exercise_name: 'Barbell Squat', weight_kg: 62.5, reps: 8, completed: true, session_date: '2026-09-03', muscle_group: 'Legs' },
      ],
    });
    await request(app).post('/api/ai/workout/generate').send(BODY);

    const prompt = promptOf();
    expect(prompt).toContain('WHAT THIS CLIENT HAS ACTUALLY DONE');
    expect(prompt).toContain('Barbell Squat: 2 sessions');
    // Two sessions is not a trend, and the prompt says so rather than letting
    // the model read a 2.5kg jump as progress.
    expect(prompt).toContain('NO lift has enough sessions logged for a trend');
  });
});
