// Editing week 6 of a programme, over HTTP, against a fake that behaves like
// the table.
//
// ── Why a fake table and not SQL assertions ────────────────────────────────
//
// The claim these endpoints make is "an edit to week 6 changes week 6 onwards
// and leaves weeks 1-5 exactly as they were". A test that asserts the UPDATE
// mentions week_number proves nothing about that: the statement can name the
// column and still write the wrong row. So the pool is replaced with a small
// in-memory workout_exercises, and the assertions are about what is IN it
// afterwards.
//
// ── What is actually at risk ───────────────────────────────────────────────
//
// A programme stores week 1 and a rule. A card shown in week 6 therefore
// carries WEEK 1's row id — it has none of its own until the moment week 6 is
// written out. Every one of these endpoints is handed that id. If any of them
// takes it at face value, the trainer edits week 6 and silently rewrites week
// 1, which moves every week of the programme at once. That is the defect this
// file exists for, and it is invisible from the screen: the card shows the
// number that was typed either way.

process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long!!';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const PLAN = 'plan-1';

// ── The fake table ─────────────────────────────────────────────────────────

let rows = [];
let seq = 0;
const PLAN_ROW = {
  id: PLAN, organization_id: ORG_A, name: 'Hypertrophy', duration_weeks: 8,
  progression_type: 'weight', progression_amount: 2.5, progression_every_weeks: 1,
  created_by: 'u-admin', deleted_at: null,
};

/** Rows for one plan/day, in the shape the routes select. */
const forDay = (day) => rows.filter((r) => r.day_of_week === day)
  .sort((a, b) => a.sort_order - b.sort_order);

function runQuery(sqlRaw, params = []) {
  const sql = String(sqlRaw).replace(/\s+/g, ' ').trim();

  if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql)) return { rows: [], rowCount: 0 };

  if (/^SELECT wp\.\* FROM workout_plans/i.test(sql)) return { rows: [PLAN_ROW], rowCount: 1 };
  if (/FROM workout_plans wp WHERE/i.test(sql)) return { rows: [PLAN_ROW], rowCount: 1 };
  if (/FOR UPDATE/i.test(sql)) return { rows: [{ id: PLAN }], rowCount: 1 };

  // materialiseWeek: has this week been written yet?
  if (/^SELECT 1 FROM workout_exercises WHERE workout_plan_id = \$1 AND day_of_week = \$2 AND week_number = \$3/i.test(sql)) {
    const hit = rows.filter((r) => r.day_of_week === params[1] && r.week_number === params[2]);
    return { rows: hit.slice(0, 1).map(() => ({ '?column?': 1 })), rowCount: hit.length ? 1 : 0 };
  }

  // materialiseWeek: the whole day, every week.
  if (/^SELECT id, exercise_id, day_of_week, week_number, sort_order/i.test(sql)) {
    return { rows: forDay(params[1]).map((r) => ({ ...r })), rowCount: 0 };
  }

  // materialiseWeek: write the resolved week out.
  if (/^INSERT INTO workout_exercises .* jsonb_to_recordset/i.test(sql)) {
    const incoming = JSON.parse(params[3]);
    for (const r of incoming) {
      rows.push({
        ...r, id: `mat-${++seq}`, workout_plan_id: params[0],
        day_of_week: params[1], week_number: params[2],
      });
    }
    return { rows: [], rowCount: incoming.length };
  }

  // Plain add.
  if (/^INSERT INTO workout_exercises/i.test(sql)) {
    const [id, planId, exerciseId, day, sets, reps, rest, notes,
      targetWeight, tempo, rpe, warmupSets, supersetGroup, config, week] = params;
    const siblings = rows.filter((r) => r.day_of_week === day && r.week_number === week);
    rows.push({
      id, workout_plan_id: planId, exercise_id: exerciseId, day_of_week: day,
      week_number: week, sets, reps, rest_seconds: rest, notes,
      target_weight: targetWeight, tempo, rpe, warmup_sets: warmupSets,
      superset_group: supersetGroup, config,
      sort_order: siblings.length ? Math.max(...siblings.map((r) => r.sort_order)) + 1 : 0,
    });
    return { rows: [{ id }], rowCount: 1 };
  }

  if (/^SELECT day_of_week FROM workout_exercises WHERE id = \$1/i.test(sql)) {
    const row = rows.find((r) => r.id === params[0]);
    return { rows: row ? [{ day_of_week: row.day_of_week }] : [], rowCount: row ? 1 : 0 };
  }

  // rowForWeek: the named row.
  if (/^SELECT id, day_of_week, week_number, sort_order, exercise_id FROM workout_exercises WHERE id = \$1/i.test(sql)) {
    const row = rows.find((r) => r.id === params[0]);
    return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
  }

  // rowForWeek: that day's rows in the requested week. Also the reorder check.
  if (/FROM workout_exercises WHERE workout_plan_id = \$1 AND day_of_week = \$2 AND week_number = \$3/i.test(sql)) {
    return { rows: rows.filter((r) => r.day_of_week === params[1] && r.week_number === params[2]).map((r) => ({ ...r })), rowCount: 0 };
  }

  if (/^UPDATE workout_exercises SET/i.test(sql) && /WHERE id = \$1/i.test(sql)) {
    const row = rows.find((r) => r.id === params[0]);
    if (!row) return { rows: [], rowCount: 0 };
    // Apply `col = $n` assignments positionally, the way the driver would.
    const assignments = sql.slice(sql.indexOf('SET ') + 4, sql.indexOf(' WHERE')).split(', ');
    for (const a of assignments) {
      const [col, ph] = a.split(' = ');
      row[col.trim()] = params[Number(ph.trim().replace('$', '')) - 1];
    }
    return { rows: [{ id: row.id }], rowCount: 1 };
  }

  // Reorder.
  if (/^UPDATE workout_exercises AS we SET sort_order/i.test(sql)) {
    params[0].forEach((id, i) => {
      const row = rows.find((r) => r.id === id);
      if (row) row.sort_order = i;
    });
    return { rows: [], rowCount: params[0].length };
  }

  if (/^DELETE FROM workout_exercises WHERE workout_plan_id = \$1 AND week_number = \$2/i.test(sql)) {
    const before = rows.length;
    rows = rows.filter((r) => r.week_number !== params[1]);
    return { rows: [], rowCount: before - rows.length };
  }

  if (/^DELETE FROM workout_exercises WHERE id = \$1/i.test(sql)) {
    const row = rows.find((r) => r.id === params[0]);
    rows = rows.filter((r) => r.id !== params[0]);
    return { rows: row ? [{ id: row.id }] : [], rowCount: row ? 1 : 0 };
  }

  // The projection every write re-reads through.
  if (/we\.id, we\.exercise_id, e\.name/i.test(sql) && /WHERE we\.id = \$1/i.test(sql)) {
    const row = rows.find((r) => r.id === params[0]);
    return { rows: row ? [{ ...row, name: 'Squat' }] : [], rowCount: row ? 1 : 0 };
  }

  // The plan-detail read: every row, every week.
  if (/we\.id, we\.exercise_id, e\.name/i.test(sql)) {
    return {
      rows: [...rows].sort((a, b) => a.day_of_week - b.day_of_week || a.sort_order - b.sort_order)
        .map((r) => ({ ...r, name: 'Squat' })),
      rowCount: rows.length,
    };
  }

  return { rows: [], rowCount: 0 };
}

jest.mock('../db/pool', () => {
  const query = jest.fn();
  return { query, connect: jest.fn(async () => ({ query, release: () => {} })) };
});

let mockUser;
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  adminOrManager: (_req, _res, next) => next(),
  adminManagerOrTrainer: (_req, _res, next) => next(),
}));
jest.mock('../lib/screeningGate', () => ({
  checkScreeningGate: jest.fn(async () => ({ blocked: null, warnings: [] })),
}));

const request = require('supertest');
const express = require('express');
const pool = require('../db/pool');

const app = express();
app.use(express.json());
app.use('/api/workouts', require('../routes/workouts'));

const ADMIN = { id: 'u-admin', role: 'admin', organization_id: ORG_A, trainer_id: null };

/** Week 1 Monday: squat 60kg, bench 40kg. The whole programme, as stored. */
const seed = () => {
  rows = [
    { id: 'w1-squat', workout_plan_id: PLAN, exercise_id: 'x-squat', day_of_week: 1, week_number: 1, sort_order: 0, sets: 4, reps: 8, rest_seconds: 90, notes: null, target_weight: 60, tempo: null, rpe: 7, warmup_sets: 1, superset_group: null, config: null },
    { id: 'w1-bench', workout_plan_id: PLAN, exercise_id: 'x-bench', day_of_week: 1, week_number: 1, sort_order: 1, sets: 3, reps: 10, rest_seconds: 60, notes: null, target_weight: 40, tempo: null, rpe: 7, warmup_sets: 1, superset_group: null, config: null },
  ];
  seq = 0;
};

const weekRows = (w) => rows.filter((r) => r.week_number === w).sort((a, b) => a.sort_order - b.sort_order);
const squatIn = (w) => weekRows(w).find((r) => r.exercise_id === 'x-squat');

beforeEach(() => {
  mockUser = ADMIN;
  seed();
  pool.query.mockReset();
  pool.query.mockImplementation(async (sql, params) => runQuery(sql, params));
});

// ── Editing a week that does not exist yet ────────────────────────────────

describe('editing a computed week', () => {
  it('writes the week out before editing it, and edits THAT row', async () => {
    // The client is holding week 1's id, because that is all week 6 has.
    const res = await request(app)
      .patch(`/api/workouts/plans/${PLAN}/exercises/w1-squat`)
      .send({ target_weight: 50, week_number: 6 });

    expect(res.status).toBe(200);
    expect(squatIn(6).target_weight).toBe(50);
    expect(squatIn(6).id).not.toBe('w1-squat');
  });

  it('leaves week 1 exactly as it was', async () => {
    // The defect this whole file exists for.
    await request(app)
      .patch(`/api/workouts/plans/${PLAN}/exercises/w1-squat`)
      .send({ target_weight: 50, week_number: 6 });

    expect(squatIn(1).target_weight).toBe(60);
    expect(squatIn(1).id).toBe('w1-squat');
  });

  it('brings the whole day across, not just the edited exercise', async () => {
    // resolveWeek treats a week's rows as the complete answer for that day.
    // Materialising one row would delete the rest of Monday from week 6.
    await request(app)
      .patch(`/api/workouts/plans/${PLAN}/exercises/w1-squat`)
      .send({ target_weight: 50, week_number: 6 });

    expect(weekRows(6)).toHaveLength(2);
    expect(weekRows(6).map((r) => r.exercise_id)).toEqual(['x-squat', 'x-bench']);
  });

  it('materialises at the week’s own numbers, not week 1’s', async () => {
    // Week 6 of "+2.5kg a week" is 60 + 12.5 = 72.5 for the squat. The bench,
    // untouched by the edit, must arrive at ITS week-6 number — 52.5 — or the
    // edit quietly deloads the rest of the day back to week 1.
    await request(app)
      .patch(`/api/workouts/plans/${PLAN}/exercises/w1-squat`)
      .send({ target_weight: 50, week_number: 6 });

    expect(weekRows(6).find((r) => r.exercise_id === 'x-bench').target_weight).toBe(52.5);
  });

  it('does not write the week twice when a second field is edited', async () => {
    await request(app).patch(`/api/workouts/plans/${PLAN}/exercises/w1-squat`)
      .send({ target_weight: 50, week_number: 6 });
    await request(app).patch(`/api/workouts/plans/${PLAN}/exercises/w1-bench`)
      .send({ reps: 12, week_number: 6 });

    expect(weekRows(6)).toHaveLength(2);
    expect(weekRows(6).find((r) => r.exercise_id === 'x-bench').reps).toBe(12);
  });

  it('resolves a STALE week-1 id to the week’s row on a later save', async () => {
    // The builder's autosave queues by row id. An edit queued before the week
    // was written still carries week 1's id when it flushes — and taking that
    // id at face value would land the second keystroke on week 1.
    await request(app).patch(`/api/workouts/plans/${PLAN}/exercises/w1-squat`)
      .send({ target_weight: 50, week_number: 6 });
    await request(app).patch(`/api/workouts/plans/${PLAN}/exercises/w1-squat`)
      .send({ target_weight: 55, week_number: 6 });

    expect(squatIn(6).target_weight).toBe(55);
    expect(squatIn(1).target_weight).toBe(60);
    expect(weekRows(6)).toHaveLength(2);
  });
});

// ── Week 1 is unchanged in every respect ──────────────────────────────────

describe('editing week 1', () => {
  it('edits the row in place, as it always did', async () => {
    const res = await request(app)
      .patch(`/api/workouts/plans/${PLAN}/exercises/w1-squat`)
      .send({ target_weight: 65 });

    expect(res.status).toBe(200);
    expect(squatIn(1).target_weight).toBe(65);
    expect(rows).toHaveLength(2);                    // nothing materialised
  });

  it('does not materialise when week 1 is named explicitly', async () => {
    await request(app).patch(`/api/workouts/plans/${PLAN}/exercises/w1-squat`)
      .send({ target_weight: 65, week_number: 1 });
    expect(rows).toHaveLength(2);
  });
});

// ── Adding and removing in a later week ───────────────────────────────────

describe('adding an exercise to a later week', () => {
  it('adds it to that week only', async () => {
    const res = await request(app)
      .post(`/api/workouts/plans/${PLAN}/exercises`)
      .send({ exercise_id: 'x-row', day_of_week: 1, week_number: 4 });

    expect(res.status).toBe(201);
    expect(weekRows(4).map((r) => r.exercise_id)).toEqual(['x-squat', 'x-bench', 'x-row']);
    expect(weekRows(1).map((r) => r.exercise_id)).toEqual(['x-squat', 'x-bench']);
  });

  it('appends after that week’s own last slot', async () => {
    await request(app).post(`/api/workouts/plans/${PLAN}/exercises`)
      .send({ exercise_id: 'x-row', day_of_week: 1, week_number: 4 });
    expect(weekRows(4).find((r) => r.exercise_id === 'x-row').sort_order).toBe(2);
  });

  it('still writes week 1 when no week is named', async () => {
    // Every existing caller, including the add-exercises page.
    await request(app).post(`/api/workouts/plans/${PLAN}/exercises`)
      .send({ exercise_id: 'x-row', day_of_week: 1 });
    expect(weekRows(1)).toHaveLength(3);
    expect(rows.filter((r) => r.week_number !== 1)).toHaveLength(0);
  });
});

describe('removing an exercise from a later week', () => {
  it('removes it from that week and leaves week 1 whole', async () => {
    const res = await request(app)
      .delete(`/api/workouts/plans/${PLAN}/exercises/w1-bench?week=5`);

    expect(res.status).toBe(200);
    expect(weekRows(5).map((r) => r.exercise_id)).toEqual(['x-squat']);
    expect(weekRows(1).map((r) => r.exercise_id)).toEqual(['x-squat', 'x-bench']);
  });

  it('deletes outright when no week is named', async () => {
    await request(app).delete(`/api/workouts/plans/${PLAN}/exercises/w1-bench`);
    expect(rows.map((r) => r.id)).toEqual(['w1-squat']);
  });
});

describe('reordering a later week', () => {
  it('reorders that week, mapping the ids the client is holding', async () => {
    const res = await request(app)
      .put(`/api/workouts/plans/${PLAN}/days/1/order?week=3`)
      .send({ exercise_ids: ['w1-bench', 'w1-squat'] });

    expect(res.status).toBe(200);
    expect(weekRows(3).map((r) => r.exercise_id)).toEqual(['x-bench', 'x-squat']);
    expect(weekRows(1).map((r) => r.exercise_id)).toEqual(['x-squat', 'x-bench']);
  });

  it('rejects a list that is not exactly the day', async () => {
    const res = await request(app)
      .put(`/api/workouts/plans/${PLAN}/days/1/order?week=3`)
      .send({ exercise_ids: ['w1-bench'] });
    expect(res.status).toBe(400);
  });
});

// ── Putting a week back on the rule ───────────────────────────────────────

describe('resetting a week', () => {
  it('deletes that week’s rows so it derives again', async () => {
    await request(app).patch(`/api/workouts/plans/${PLAN}/exercises/w1-squat`)
      .send({ target_weight: 50, week_number: 6 });
    expect(weekRows(6)).toHaveLength(2);

    const res = await request(app).delete(`/api/workouts/plans/${PLAN}/weeks/6`);
    expect(res.status).toBe(200);
    expect(weekRows(6)).toHaveLength(0);
    expect(weekRows(1)).toHaveLength(2);
  });

  it('refuses to reset week 1, which is the programme itself', async () => {
    const res = await request(app).delete(`/api/workouts/plans/${PLAN}/weeks/1`);
    expect(res.status).toBe(400);
    expect(weekRows(1)).toHaveLength(2);
  });
});

// ── Reading a plan back ───────────────────────────────────────────────────

describe('reading the plan', () => {
  it('returns only week 1 on the base view, once a later week exists', async () => {
    await request(app).patch(`/api/workouts/plans/${PLAN}/exercises/w1-squat`)
      .send({ target_weight: 50, week_number: 6 });

    const res = await request(app).get(`/api/workouts/plans/${PLAN}`);
    expect(res.status).toBe(200);
    expect(res.body.exercises).toHaveLength(2);
    expect(res.body.exercises.map((e) => e.target_weight)).toEqual([60, 40]);
  });

  it('reports which weeks have been edited', async () => {
    await request(app).patch(`/api/workouts/plans/${PLAN}/exercises/w1-squat`)
      .send({ target_weight: 50, week_number: 6 });

    const res = await request(app).get(`/api/workouts/plans/${PLAN}`);
    expect(res.body.override_weeks).toEqual([6]);
  });

  it('serves the edited numbers for that week, and the climb after it', async () => {
    await request(app).patch(`/api/workouts/plans/${PLAN}/exercises/w1-squat`)
      .send({ target_weight: 50, week_number: 6 });

    const six = await request(app).get(`/api/workouts/plans/${PLAN}?week=6`);
    expect(six.body.week_source).toBe('override');
    expect(six.body.exercises.find((e) => e.exercise_id === 'x-squat').target_weight).toBe(50);

    const seven = await request(app).get(`/api/workouts/plans/${PLAN}?week=7`);
    expect(seven.body.anchor_week).toBe(6);
    expect(seven.body.exercises.find((e) => e.exercise_id === 'x-squat').target_weight).toBe(52.5);
  });

  it('leaves the weeks before the edit deriving from week 1', async () => {
    await request(app).patch(`/api/workouts/plans/${PLAN}/exercises/w1-squat`)
      .send({ target_weight: 50, week_number: 6 });

    const five = await request(app).get(`/api/workouts/plans/${PLAN}?week=5`);
    expect(five.body.anchor_week).toBe(1);
    expect(five.body.exercises.find((e) => e.exercise_id === 'x-squat').target_weight).toBe(70);
  });
});
