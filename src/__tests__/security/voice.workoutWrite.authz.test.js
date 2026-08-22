// Phase 5 — "Hey Siri, create a workout for Rahul."
//
// The first WRITE on the voice surface, and the first thing on it that can
// change a person's training. Four properties carry the whole design, and each
// fails silently if it regresses:
//
//   1. PREPARING SAVES NOTHING. One voice command must never persist a plan.
//   2. CONFIRM TAKES AN ID AND NOTHING ELSE. If a caller can put exercises on
//      the confirm request, the PAR-Q gate and the contraindication filter are
//      decoration — whatever they removed comes back on the second call.
//   3. THE DRAFT IS SINGLE-USE, AND IT IS THE CLAIM THAT ENFORCES IT. Two
//      confirmations must produce one plan, not two.
//   4. CONTRAINDICATED EXERCISES ARE NEVER OFFERED. Not "filtered later" —
//      never among the candidates, so nothing can select one.
//
// Asserted against what reached the pool, not just the response body: "no plan
// was created" is exactly what a broken test also reports when the handler
// returned early for the wrong reason.

'use strict';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';
const DRAFT_ID = '33333333-3333-4333-8333-333333333333';
const CLIENT_ID = 'ptc-rahul';

const mockLog = [];
let mockResponder;

jest.mock('../../db/pool', () => {
  const query = jest.fn(async (sql, params) => {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    mockLog.push({ sql: flat, params });
    const rows = mockResponder(flat, params);
    return { rows, rowCount: rows.length };
  });
  return {
    query,
    // The confirm path runs in a transaction; the same responder answers both
    // so a test can assert on every statement regardless of which handle ran it.
    connect: jest.fn(async () => ({ query, release: jest.fn() })),
  };
});

jest.mock('../../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

// The model is never reached in these tests. Phase 5's safety properties must
// hold on the deterministic path, which is the one that runs when the API is
// unconfigured — i.e. the path most studios are actually on.
let mockChat = jest.fn(async () => { throw new Error('no model configured'); });
jest.mock('../../lib/ai/router', () => ({
  routedChat: (...a) => mockChat(...a),
  routedStream: jest.fn(),
}));

let mockUser;
jest.mock('../../middleware/auth', () => {
  const actual = jest.requireActual('../../middleware/auth');
  return {
    ...actual,
    auth: (req, res, next) => {
      if (!mockUser) return res.status(401).json({ error: 'Unauthorized' });
      req.user = mockUser;
      next();
    },
    adminOnly: (_req, _res, next) => next(),
  };
});

const express = require('express');
const request = require('supertest');
const { errorHandler } = require('../../middleware/errorHandler');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/voice', require('../../routes/voice'));
  a.use(errorHandler);
  return a;
}

const PREPARE = '/api/voice/workouts/prepare';
const CONFIRM = '/api/voice/workouts/confirm';
const prepare = (body = { client_id: CLIENT_ID }) => request(app()).post(PREPARE).send(body);
const confirm = (body = { draft_id: DRAFT_ID }) => request(app()).post(CONFIRM).send(body);

// What reached the database, by statement.
const q = (re) => mockLog.find((x) => re.test(x.sql));
const all = (re) => mockLog.filter((x) => re.test(x.sql));
const planInsert       = () => q(/INSERT INTO workout_plans/i);
const exerciseInserts  = () => all(/INSERT INTO workout_exercises/i);
const assignInsert     = () => q(/INSERT INTO workout_assignments/i);
const draftInsert      = () => q(/INSERT INTO voice_workout_drafts/i);
const draftClaim       = () => q(/UPDATE voice_workout_drafts SET status = 'confirmed'/i);
const candidateQuery   = () => q(/FROM exercises WHERE is_active = TRUE/i);
const parqQuery        = () => q(/FROM pt_parq_forms/i);

const ADMIN_A   = { id: 'u-a', name: 'Admin A', role: 'admin', organization_id: ORG_A, trainer_id: null };
const ADMIN_B   = { id: 'u-b', name: 'Admin B', role: 'admin', organization_id: ORG_B, trainer_id: null };
const OTHER_A   = { id: 'u-a2', name: 'Admin A2', role: 'admin', organization_id: ORG_A, trainer_id: null };
const MANAGER_A = { id: 'u-mg', name: 'Manager A', role: 'manager', organization_id: ORG_A, trainer_id: null };
const TRAINER_A = { id: 'u-t', name: 'Trainer A', role: 'trainer', organization_id: ORG_A, trainer_id: 'trn-a' };
const RECEPT_A  = { id: 'u-rc', name: 'Reception', role: 'reception', organization_id: ORG_A, trainer_id: null };
const MEMBER_A  = { id: 'u-m', name: 'Client', role: 'member', organization_id: ORG_A };

const SAFE_EXERCISES = [
  { id: 'ex-squat',  name: 'Back Squat',    muscle_group: 'Legs',      difficulty: 'beginner', contraindications: [], sets_default: 3, reps_default: 10, rest_seconds: 90 },
  { id: 'ex-lunge',  name: 'Walking Lunge', muscle_group: 'Legs',      difficulty: 'beginner', contraindications: [], sets_default: 3, reps_default: 12, rest_seconds: 60 },
  { id: 'ex-bench',  name: 'Bench Press',   muscle_group: 'Chest',     difficulty: 'beginner', contraindications: [], sets_default: 3, reps_default: 8,  rest_seconds: 90 },
  { id: 'ex-row',    name: 'Barbell Row',   muscle_group: 'Back',      difficulty: 'beginner', contraindications: [], sets_default: 3, reps_default: 10, rest_seconds: 90 },
  { id: 'ex-press',  name: 'Overhead Press', muscle_group: 'Shoulders', difficulty: 'beginner', contraindications: [], sets_default: 3, reps_default: 8, rest_seconds: 90 },
];
const KNEE_RISKY = {
  id: 'ex-jump', name: 'Box Jump', muscle_group: 'Legs', difficulty: 'intermediate',
  contraindications: ['knee injury', 'acl'], sets_default: 3, reps_default: 8, rest_seconds: 60,
};

const CLIENT_ROW = {
  id: CLIENT_ID, name: 'Rahul Sharma', goal: 'muscle_gain',
  health_conditions: null, injuries: null,
  workout_experience_level: 'beginner', preferred_training_days: 'Mon, Wed, Fri',
  plan_name: 'Push Pull Legs', plan_goal: 'muscle_gain',
  plan_difficulty: 'beginner', plan_id: 'wp-1',
};

const DRAFT_BODY = {
  plan: {
    name: "Rahul's 4-day plan", goal: 'muscle_gain', difficulty: 'beginner',
    duration_weeks: 4, sessions_per_week: 4,
    based_on_plan_id: 'wp-1', based_on_plan_name: 'Push Pull Legs',
  },
  exercises: SAFE_EXERCISES.map((e, i) => ({
    exercise_id: e.id, name: e.name, muscle_group: e.muscle_group,
    day_of_week: (i % 4) + 1, sort_order: 0, sets: 3, reps: 10, rest_seconds: 60,
  })),
};

/**
 * The default world: the client is this studio's, screening is clear, the
 * library holds five safe exercises, and a pending draft exists to confirm.
 */
function world(o = {}) {
  const {
    owned = true, trainerOwns = true, client = CLIENT_ROW,
    exercises = SAFE_EXERCISES, parq = [], claim = [{
      id: DRAFT_ID, client_id: CLIENT_ID, draft: DRAFT_BODY, source: 'derived',
    }], liveExercises = null,
  } = o;

  return (sql) => {
    if (/SELECT 1 FROM pt_clients WHERE id = \$1 AND trainer_id/i.test(sql)) return trainerOwns ? [{ '?column?': 1 }] : [];
    if (/SELECT 1 FROM pt_clients/i.test(sql)) return owned ? [{ '?column?': 1 }] : [];
    if (/FROM pt_parq_forms/i.test(sql)) return parq;
    if (/FROM pt_consent|informed_consent/i.test(sql)) return [{ id: 'c-1', status: 'completed' }];
    if (/FROM pt_clients c LEFT JOIN LATERAL/i.test(sql)) return client ? [client] : [];
    if (/FROM workout_sessions/i.test(sql)) return [{ sessions: 12, last_session: '2026-08-01' }];
    if (/FROM exercises WHERE is_active = TRUE/i.test(sql)) return exercises;
    if (/SELECT id FROM exercises/i.test(sql)) {
      return (liveExercises ?? exercises).map((e) => ({ id: e.id }));
    }
    if (/INSERT INTO voice_workout_drafts/i.test(sql)) {
      return [{ id: DRAFT_ID, expires_at: new Date(Date.now() + 1800e3).toISOString() }];
    }
    if (/UPDATE voice_workout_drafts SET status = 'confirmed'/i.test(sql)) return claim;
    return [];
  };
}

beforeEach(() => {
  mockLog.length = 0;
  mockUser = ADMIN_A;
  mockResponder = world();
  mockChat = jest.fn(async () => { throw new Error('no model configured'); });
});

// ── A. Preparing saves nothing ────────────────────────────────────────────
describe('A. prepare never persists a workout', () => {
  test('a successful prepare returns a draft and saves no plan', async () => {
    const res = await prepare();
    expect(res.status).toBe(201);
    expect(res.body.saved).toBe(false);
    expect(res.body.draft_id).toBe(DRAFT_ID);
    // The property, asserted at the database and not at the response:
    expect(planInsert()).toBeUndefined();
    expect(exerciseInserts()).toHaveLength(0);
    expect(assignInsert()).toBeUndefined();
  });

  test('the only rows it writes are the draft and its audit trail', async () => {
    await prepare();
    expect(draftInsert()).toBeDefined();
    // activity_log is expected — that is the audit row. What must NOT appear
    // is any workout table.
    expect([...new Set(all(/^INSERT INTO/i).map((x) => x.sql.split(' ')[2]))].sort())
      .toEqual(['activity_log', 'voice_workout_drafts']);
  });

  test('the spoken sentence asks rather than reports', async () => {
    const res = await prepare();
    expect(res.body.spoken).toMatch(/Shall I save it\?$/);
    expect(res.body.spoken).toContain('I prepared a 4-day workout for Rahul');
    expect(res.body.spoken).toContain('based on their current programme, Push Pull Legs');
  });

  test('no basis is claimed when the client has no active programme', async () => {
    mockResponder = world({ client: { ...CLIENT_ROW, plan_name: null, plan_id: null, plan_difficulty: null } });
    const res = await prepare();
    expect(res.body.spoken).not.toMatch(/based on/i);
  });
});

// ── B. Authorization ──────────────────────────────────────────────────────
describe('B. authorization', () => {
  test('no session is 401', async () => {
    mockUser = null;
    expect((await prepare()).status).toBe(401);
  });

  test.each([['admin', ADMIN_A], ['manager', MANAGER_A], ['trainer', TRAINER_A]])(
    '%s may prepare', async (_l, u) => {
      mockUser = u;
      expect((await prepare()).status).toBe(201);
    });

  test('reception may READ the voice surface but not author a workout', async () => {
    mockUser = RECEPT_A;
    const res = await prepare();
    expect(res.status).toBe(403);
    expect(draftInsert()).toBeUndefined();
  });

  test('a gym member is refused', async () => {
    mockUser = MEMBER_A;
    expect((await prepare()).status).toBe(403);
  });

  test('reception cannot confirm either', async () => {
    mockUser = RECEPT_A;
    const res = await confirm();
    expect(res.status).toBe(403);
    expect(draftClaim()).toBeUndefined();
    expect(planInsert()).toBeUndefined();
  });

  test('a trainer may not author for a colleague\'s client', async () => {
    mockUser = TRAINER_A;
    mockResponder = world({ trainerOwns: false });
    const res = await prepare();
    expect(res.status).toBe(404);
    expect(draftInsert()).toBeUndefined();
  });
});

// ── C. Cross-organization ─────────────────────────────────────────────────
describe('C. cross-organization access', () => {
  test('another studio\'s client is 404, NOT 403', async () => {
    mockResponder = world({ owned: false });
    mockUser = ADMIN_B;
    const res = await prepare();
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  test('a foreign client is refused before anything about them is read', async () => {
    mockResponder = world({ owned: false });
    await prepare();
    expect(candidateQuery()).toBeUndefined();
    expect(draftInsert()).toBeUndefined();
    expect(q(/FROM pt_clients c LEFT JOIN LATERAL/i)).toBeUndefined();
  });

  test('the draft is stamped with the caller\'s own org', async () => {
    await prepare();
    expect(draftInsert().params[0]).toBe(ORG_A);
  });

  test('the exercise library is scoped to the caller\'s org', async () => {
    await prepare();
    expect(candidateQuery().params).toContain(ORG_A);
    expect(candidateQuery().sql).toMatch(/organization_id IS NULL OR organization_id = \$1/);
  });

  test('confirming another studio\'s draft claims nothing', async () => {
    mockUser = ADMIN_B;
    mockResponder = world({ claim: [] });
    const res = await confirm();
    expect(res.status).toBe(409);
    expect(planInsert()).toBeUndefined();
    // The org id is part of the claim's WHERE clause, not a check after it.
    expect(draftClaim().params).toContain(ORG_B);
  });

  test('the claim is keyed on org AND creator, not the id alone', async () => {
    await confirm();
    const claim = draftClaim();
    expect(claim.sql).toMatch(/AND organization_id = \$2/);
    expect(claim.sql).toMatch(/AND created_by = \$3/);
    expect(claim.params).toEqual([DRAFT_ID, ORG_A, 'u-a']);
  });

  test('a colleague in the same studio cannot confirm someone else\'s draft', async () => {
    mockUser = OTHER_A;
    mockResponder = world({ claim: [] });
    const res = await confirm();
    expect(res.status).toBe(409);
    expect(planInsert()).toBeUndefined();
    expect(draftClaim().params[2]).toBe('u-a2');
  });
});

// ── D. Confirmation bypass ────────────────────────────────────────────────
describe('D. confirmation cannot be bypassed', () => {
  test('confirm rejects any body field other than draft_id', async () => {
    const res = await confirm({
      draft_id: DRAFT_ID,
      exercises: [{ exercise_id: 'ex-evil', day_of_week: 1, sets: 99 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
    expect(planInsert()).toBeUndefined();
  });

  test('a plan name cannot be smuggled in', async () => {
    const res = await confirm({ draft_id: DRAFT_ID, plan: { name: 'x' } });
    expect(res.status).toBe(400);
  });

  test('a client_id cannot be smuggled in', async () => {
    const res = await confirm({ draft_id: DRAFT_ID, client_id: 'ptc-someone-else' });
    expect(res.status).toBe(400);
  });

  test('a malformed draft_id never reaches the database', async () => {
    const res = await confirm({ draft_id: 'not-a-uuid' });
    expect(res.status).toBe(400);
    expect(draftClaim()).toBeUndefined();
  });

  test('the saved exercises are the draft\'s, never the request\'s', async () => {
    await confirm();
    const ids = exerciseInserts().map((x) => x.params[2]);
    expect(ids.sort()).toEqual(SAFE_EXERCISES.map((e) => e.id).sort());
  });

  test('prepare rejects unknown fields too', async () => {
    const res = await prepare({ client_id: CLIENT_ID, organization_id: ORG_B });
    expect(res.status).toBe(400);
  });
});

// ── E. Single use ─────────────────────────────────────────────────────────
describe('E. a draft is single-use', () => {
  test('the claim requires status pending and an unexpired draft', async () => {
    await confirm();
    expect(draftClaim().sql).toMatch(/AND status = 'pending'/);
    expect(draftClaim().sql).toMatch(/AND expires_at > NOW\(\)/);
  });

  test('the claim happens BEFORE the plan is inserted', async () => {
    await confirm();
    expect(mockLog.indexOf(draftClaim())).toBeLessThan(mockLog.indexOf(planInsert()));
  });

  test('a second confirmation saves nothing and says so', async () => {
    mockResponder = world({ claim: [] });
    const res = await confirm();
    expect(res.status).toBe(409);
    expect(res.body.saved).toBe(false);
    expect(planInsert()).toBeUndefined();
    expect(res.body.spoken).toMatch(/prepare it again/i);
  });

  test('an unclaimable draft rolls back rather than committing', async () => {
    mockResponder = world({ claim: [] });
    await confirm();
    expect(q(/^ROLLBACK$/i)).toBeDefined();
    expect(q(/^COMMIT$/i)).toBeUndefined();
  });

  test('every rejection reason gives the same response', async () => {
    // Expired, already confirmed, not yours and nonexistent are one 409 with
    // one sentence — distinguishing them would let a caller probe draft ids.
    mockResponder = world({ claim: [] });
    const res = await confirm();
    expect(res.body.error.code).toBe('DRAFT_NOT_CONFIRMABLE');
  });
});

// ── F. Safety: PAR-Q ──────────────────────────────────────────────────────
describe('F. the screening gate', () => {
  test('a medically blocked client cannot have a workout prepared', async () => {
    mockResponder = world({ parq: [{ workout_gate_status: 'blocked' }] });
    const res = await prepare();
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PARQ_BLOCKED');
    expect(draftInsert()).toBeUndefined();
    expect(candidateQuery()).toBeUndefined();
  });

  test('the block is spoken as a fact about clearance, not as a failure', async () => {
    mockResponder = world({ parq: [{ workout_gate_status: 'blocked' }] });
    const res = await prepare();
    expect(res.body.spoken).toMatch(/medically blocked/i);
    expect(res.body.spoken).toMatch(/clearance/i);
  });

  test('the gate is RE-RUN at confirm time, against live data', async () => {
    await confirm();
    expect(parqQuery()).toBeDefined();
    expect(mockLog.indexOf(parqQuery())).toBeLessThan(mockLog.indexOf(planInsert()));
  });

  test('a client blocked AFTER preparing is not saved', async () => {
    mockResponder = world({ parq: [{ workout_gate_status: 'blocked' }] });
    const res = await confirm();
    expect(res.status).toBe(403);
    expect(res.body.saved).toBe(false);
    expect(planInsert()).toBeUndefined();
    expect(q(/^ROLLBACK$/i)).toBeDefined();
  });
});

// ── G. Safety: contraindications ──────────────────────────────────────────
describe('G. contraindicated exercises are never offered', () => {
  const INJURED = { ...CLIENT_ROW, injuries: 'ACL tear, knee injury 2024' };

  test('a conflicting exercise is excluded from the draft', async () => {
    mockResponder = world({ client: INJURED, exercises: [...SAFE_EXERCISES, KNEE_RISKY] });
    const res = await prepare();
    const ids = res.body.preview.exercises.map((e) => e.exercise_id);
    expect(ids).not.toContain('ex-jump');
  });

  test('the exclusion is reported with its reason, not silently dropped', async () => {
    mockResponder = world({ client: INJURED, exercises: [...SAFE_EXERCISES, KNEE_RISKY] });
    const res = await prepare();
    expect(res.body.excluded).toHaveLength(1);
    expect(res.body.excluded[0]).toMatchObject({
      exercise_id: 'ex-jump', name: 'Box Jump', contraindication: 'knee injury',
    });
  });

  test('the trainer is TOLD something was withheld, before being asked to save', async () => {
    mockResponder = world({ client: INJURED, exercises: [...SAFE_EXERCISES, KNEE_RISKY] });
    const res = await prepare();
    const spoken = res.body.spoken;
    expect(spoken).toMatch(/left out one exercise that conflicts/i);
    expect(spoken.indexOf('left out')).toBeLessThan(spoken.indexOf('Shall I save'));
  });

  test('matching works when the CLIENT text contains the contraindication', async () => {
    mockResponder = world({
      client: { ...CLIENT_ROW, health_conditions: 'previous knee injury, since cleared' },
      exercises: [...SAFE_EXERCISES, KNEE_RISKY],
    });
    const res = await prepare();
    expect(res.body.preview.exercises.map((e) => e.exercise_id)).not.toContain('ex-jump');
  });

  test('a client with no restrictions loses nothing', async () => {
    mockResponder = world({ exercises: [...SAFE_EXERCISES, KNEE_RISKY] });
    const res = await prepare();
    expect(res.body.excluded).toHaveLength(0);
  });

  test('when everything conflicts, it refuses rather than shipping an empty plan', async () => {
    mockResponder = world({ client: INJURED, exercises: [KNEE_RISKY] });
    const res = await prepare();
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('NO_SAFE_EXERCISES');
    expect(res.body.spoken).toMatch(/conflicts with something on their medical record/i);
    expect(draftInsert()).toBeUndefined();
  });
});

// ── H. Exercise validation ────────────────────────────────────────────────
describe('H. only real library exercises are used', () => {
  test('the candidate query excludes archived, deleted and private rows', async () => {
    await prepare();
    const sql = candidateQuery().sql;
    expect(sql).toMatch(/is_active = TRUE/);
    expect(sql).toMatch(/deleted_at IS NULL/);
    expect(sql).toMatch(/archived_at IS NULL/);
    expect(sql).toMatch(/visibility IN \('public','organization'\)/);
  });

  test('a hallucinated exercise id from the model is discarded', async () => {
    mockChat = jest.fn(async () => ({
      content: JSON.stringify({
        days: [
          { focus: 'Legs', exercise_ids: ['ex-squat', 'ex-does-not-exist'] },
          { focus: 'Chest', exercise_ids: ['ex-bench'] },
        ],
      }),
    }));
    const res = await prepare({ client_id: CLIENT_ID, days: 2 });
    const ids = res.body.preview.exercises.map((e) => e.exercise_id);
    expect(ids).toContain('ex-squat');
    expect(ids).not.toContain('ex-does-not-exist');
  });

  test('a model choosing a CONTRAINDICATED id cannot reintroduce it', async () => {
    // The filter runs before the model sees the list, so the id is not in
    // `allowed` and resolves to nothing — the model has no way back in.
    mockResponder = world({
      client: { ...CLIENT_ROW, injuries: 'knee injury' },
      exercises: [...SAFE_EXERCISES, KNEE_RISKY],
    });
    mockChat = jest.fn(async () => ({
      content: JSON.stringify({
        days: [
          { focus: 'Legs', exercise_ids: ['ex-jump', 'ex-squat'] },
          { focus: 'Chest', exercise_ids: ['ex-bench'] },
        ],
      }),
    }));
    const res = await prepare({ client_id: CLIENT_ID, days: 2 });
    expect(res.body.preview.exercises.map((e) => e.exercise_id)).not.toContain('ex-jump');
  });

  test('the model is never sent the client\'s medical text', async () => {
    mockResponder = world({ client: { ...CLIENT_ROW, injuries: 'ACL tear', health_conditions: 'hypertension' } });
    mockChat = jest.fn(async () => ({ content: '{}' }));
    await prepare();
    const sent = JSON.stringify(mockChat.mock.calls[0][0]);
    expect(sent).not.toMatch(/ACL tear/i);
    expect(sent).not.toMatch(/hypertension/i);
  });

  test('exercises are re-validated at confirm, and stale ones dropped', async () => {
    mockResponder = world({ liveExercises: SAFE_EXERCISES.slice(0, 3) });
    const res = await confirm();
    expect(res.status).toBe(201);
    expect(exerciseInserts()).toHaveLength(3);
    expect(res.body.exercise_count).toBe(3);
  });

  test('a draft whose exercises have all vanished is refused, not saved empty', async () => {
    mockResponder = world({ liveExercises: [] });
    const res = await confirm();
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('EXERCISES_UNAVAILABLE');
    expect(planInsert()).toBeUndefined();
    expect(q(/^ROLLBACK$/i)).toBeDefined();
  });
});

// ── I. Failed generation ──────────────────────────────────────────────────
describe('I. generation failure', () => {
  test('an empty library is a 422 with a sentence, not a 500', async () => {
    mockResponder = world({ exercises: [] });
    const res = await prepare();
    expect(res.status).toBe(422);
    expect(res.body.spoken).toBeTruthy();
    expect(draftInsert()).toBeUndefined();
  });

  test('a model failure falls back to the deterministic selection', async () => {
    mockChat = jest.fn(async () => { throw new Error('502 from provider'); });
    const res = await prepare();
    expect(res.status).toBe(201);
    expect(res.body.preview.source).toBe('derived');
    expect(res.body.preview.exercises.length).toBeGreaterThan(0);
  });

  test('unparseable model output falls back rather than saving nonsense', async () => {
    mockChat = jest.fn(async () => ({ content: 'Sure! Here is a plan: do squats.' }));
    const res = await prepare();
    expect(res.status).toBe(201);
    expect(res.body.preview.source).toBe('derived');
  });

  test('a partial model answer falls back rather than shipping a short week', async () => {
    mockChat = jest.fn(async () => ({
      content: JSON.stringify({ days: [{ focus: 'Legs', exercise_ids: ['ex-squat'] }] }),
    }));
    const res = await prepare({ client_id: CLIENT_ID, days: 4 });
    expect(res.body.preview.source).toBe('derived');
  });
});

// ── J. Bounds ─────────────────────────────────────────────────────────────
describe('J. the plan size is bounded', () => {
  test('an absurd day count is clamped, not honoured', async () => {
    const res = await prepare({ client_id: CLIENT_ID, days: 40 });
    expect(res.status).toBe(201);
    expect(res.body.preview.days).toBe(6);
  });

  test('a day count beyond the schema is rejected outright', async () => {
    const res = await prepare({ client_id: CLIENT_ID, days: 5000 });
    expect(res.status).toBe(400);
  });

  test('zero days is rejected', async () => {
    expect((await prepare({ client_id: CLIENT_ID, days: 0 })).status).toBe(400);
  });

  test('the default is four days', async () => {
    const res = await prepare();
    expect(res.body.preview.days).toBe(4);
  });
});

// ── K. Audit ──────────────────────────────────────────────────────────────
describe('K. audit', () => {
  const auditActions = () => all(/INSERT INTO activity_log/i)
    .flatMap((x) => x.params.filter((p) => typeof p === 'string' && p.startsWith('voice.')));

  test('preparing writes an audit row naming the action', async () => {
    expect((await prepare()).status).toBe(201);
    expect(auditActions()).toContain('voice.workouts.prepare');
  });

  test('confirming writes its own audit row', async () => {
    expect((await confirm()).status).toBe(201);
    expect(auditActions()).toContain('voice.workouts.confirm');
  });

  test('a refused confirmation is audited too', async () => {
    mockResponder = world({ claim: [] });
    await confirm();
    expect(auditActions()).toContain('voice.workouts.confirm.rejected');
  });

  test('a medical block is audited', async () => {
    mockResponder = world({ parq: [{ workout_gate_status: 'blocked' }] });
    await prepare();
    // checkScreeningGate logs its own block, and the route logs the voice one.
    expect(auditActions()).toContain('voice.workouts.prepare.blocked');
  });

  test('the prepare audit records what was generated and what was withheld', async () => {
    mockResponder = world({
      client: { ...CLIENT_ROW, injuries: 'knee injury' },
      exercises: [...SAFE_EXERCISES, KNEE_RISKY],
    });
    await prepare();
    const row = all(/INSERT INTO activity_log/i)
      .find((x) => x.params.includes('voice.workouts.prepare'));

    // The detail is stored as a JSON string parameter; parse it rather than
    // substring-matching a doubly-escaped blob.
    const payload = row.params
      .filter((v) => typeof v === 'string' && v.startsWith('{'))
      .map((v) => JSON.parse(v))
      .find((o) => o.channel === 'voice');

    expect(payload).toMatchObject({
      client_id: CLIENT_ID,
      days: 4,
      source: 'derived',
      exercise_count: 5,
      excluded_count: 1,
      based_on_plan_id: 'wp-1',
    });
  });

  test('the saved plan records who created it and which studio owns it', async () => {
    await confirm();
    const params = planInsert().params;
    expect(params).toContain('u-a');
    expect(params).toContain(ORG_A);
  });

  test('the draft is linked to the plan it became', async () => {
    await confirm();
    const link = q(/UPDATE voice_workout_drafts SET workout_plan_id/i);
    expect(link).toBeDefined();
    expect(link.params[1]).toBe(DRAFT_ID);
  });

  test('a confirmed plan is assigned to the client, not left floating', async () => {
    await confirm();
    expect(assignInsert()).toBeDefined();
    expect(assignInsert().params).toContain(CLIENT_ID);
  });
});
