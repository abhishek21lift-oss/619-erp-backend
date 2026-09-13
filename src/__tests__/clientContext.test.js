// Assembling one client, once, for everything that needs to know about them.
//
// ── What these tests defend ───────────────────────────────────────────────
//
// Three things, in descending order of how bad it would be to get wrong.
//
// 1. Tenant isolation. This module reads eleven tables for one client. The
//    parent pt_clients check is org-scoped and awaited ALONE, before any of
//    them — so a client_id belonging to another studio returns null with no
//    child query issued, and cannot even be timed against those tables. The
//    first test asserts the absence of those queries, not just the null.
//
// 2. That an unscreened client never reads as a healthy one. This is the
//    failure the whole digital twin exists to prevent: a model handed an
//    empty limitation list will write a programme as though the client were
//    clear, and there is no way to tell from the plan afterwards.
//
// 3. That the generator stops saying "Injuries: none". It took that from
//    pt_clients.injuries, empty for all 34 production clients, while PAR-Q,
//    posture and mobility sat unread in the same database.
'use strict';

jest.mock('../db/pool', () => ({ query: jest.fn() }));

const pool = require('../db/pool');
const {
  loadDigitalTwin, describeTwin, limitationsLine, adherenceInputs, screenPlanExercises,
  resolveLandmarks,
} = require('../modules/pt-os/client-context');
const { buildConstraints } = require('../modules/pt-os/programming-rules');

const CLIENT = {
  id: 'cl-1', name: 'Test Client', gender: 'male', dob: '1995-01-01',
  goal: 'strength', injuries: null, notes: null,
  workout_experience_level: 'intermediate', health_conditions: null,
  organization_id: 'org-1',
};

/** The eight mobility regions, all clean unless overridden. */
const regions = (overrides = {}) => [
  'Neck', 'Shoulders', 'Thoracic Spine', 'Hip', 'Hamstrings', 'Quadriceps', 'Ankles', 'Wrists',
].map((region) => ({ region, score: 3, pain: false, restriction: false, ...(overrides[region] || {}) }));

/**
 * A pool that answers each query by what it selects from.
 *
 * `rows` maps a table name to the rows that table should return; anything not
 * named answers empty, which is the production-normal case for most of these.
 */
function mockPool({ client = CLIENT, tables = {}, landmarks = [] } = {}) {
  const seen = [];
  pool.query.mockReset();
  pool.query.mockImplementation((sql) => {
    seen.push(sql);
    if (/FROM pt_clients/.test(sql)) return Promise.resolve({ rows: client ? [client] : [] });
    // The studio's weekly set ranges, resolved once per twin.
    if (/FROM muscle_volume_landmarks/.test(sql)) return Promise.resolve({ rows: landmarks });
    for (const [table, rows] of Object.entries(tables)) {
      if (new RegExp(`FROM ${table}\\b`).test(sql)) return Promise.resolve({ rows });
    }
    return Promise.resolve({ rows: [] });
  });
  return seen;
}

const LIB = [
  { name: 'Barbell Bench Press - Medium Grip', muscle_group: 'Chest', target_muscle: 'Chest', movement_pattern: 'Horizontal Push', equipment: 'Barbell', difficulty: 'beginner' },
  { name: 'Barbell Squat', muscle_group: 'Legs', target_muscle: 'Quadriceps', movement_pattern: 'Squat', equipment: 'Barbell', difficulty: 'beginner' },
];

describe('tenant isolation', () => {
  it('reads nothing about a client belonging to another studio', async () => {
    const seen = mockPool({ client: null });
    const twin = await loadDigitalTwin('cl-other', 'org-1');

    expect(twin).toBeNull();
    // The property that matters. One query ran, it was the org-scoped parent
    // check, and no child table was touched — so the probe cannot be timed
    // against pt_parq_forms or workout_sets either.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/FROM pt_clients/);
    for (const table of ['pt_parq_forms', 'workout_sets', 'pt_mobility_performance_assessments']) {
      expect(seen.join(' ')).not.toContain(table);
    }
  });

  it('scopes the parent lookup by organization', async () => {
    mockPool();
    await loadDigitalTwin('cl-1', 'org-1');
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/organization_id = \$2/);
    expect(params).toEqual(['cl-1', 'org-1']);
  });
});

describe('the twin the generator is handed', () => {
  it('reads the assessments the generator never read', async () => {
    const seen = mockPool({
      tables: {
        pt_parq_forms: [{
          assessment_date: '2026-08-01', workout_gate_status: 'cleared', risk_level: 'low',
          past_history: { knee_pain: true }, current_health: {},
        }],
        pt_mobility_performance_assessments: [{
          assessment_date: '2026-08-01',
          body_regions: regions({ Shoulders: { pain: true } }),
        }],
        pt_posture_assessments: [{ front_issues: ['Rounded Shoulders'] }],
      },
    });

    const twin = await loadDigitalTwin('cl-1', 'org-1', { exercises: LIB });

    // All three tables are now in the generator's read set. Before this module
    // none of them were.
    const all = seen.join(' ');
    for (const table of ['pt_parq_forms', 'pt_posture_assessments', 'pt_mobility_performance_assessments', 'workout_sets']) {
      expect(all).toContain(table);
    }
    expect(twin.rules.gate.cleared).toBe(true);
    expect(twin.rules.library.blocked.map((e) => e.name)).toEqual(['Barbell Bench Press - Medium Grip']);
    expect(twin.rules.library.caution.map((e) => e.name)).toEqual(['Barbell Squat']);
  });

  it('composes the training history from logged sets', async () => {
    mockPool({
      tables: {
        workout_sets: [
          { exercise_name: 'Barbell Squat', weight_kg: 60, reps: 8, rpe: null, rir: null, completed: true, session_date: '2026-09-01', target_muscle: 'Quadriceps' },
          { exercise_name: 'Barbell Squat', weight_kg: 60, reps: 8, rpe: null, rir: null, completed: false, session_date: '2026-09-01', target_muscle: 'Quadriceps' },
        ],
      },
    });
    const twin = await loadDigitalTwin('cl-1', 'org-1');
    expect(twin.history.has_history).toBe(true);
    expect(twin.history.totals.sets).toBe(1);
    expect(twin.history.totals.sets_not_completed).toBe(1);
    // Weekly volume rides on the same rows rather than a second query.
    expect(twin.rules.volume.muscles[0]).toMatchObject({ muscle: 'Quadriceps', latest_sets: 1 });
  });

  it('counts a set whose exercise was typed free-hand as unattributable', async () => {
    mockPool({
      tables: {
        workout_sets: [
          { exercise_name: 'Bulgarian split squats', weight_kg: 15, reps: 10, completed: true, session_date: '2026-09-01', target_muscle: null },
        ],
      },
    });
    const twin = await loadDigitalTwin('cl-1', 'org-1');
    // Real production shape: 29 of 408 completed sets do not join the library.
    expect(twin.rules.volume.unattributable_sets).toBe(1);
    expect(twin.history.totals.sets).toBe(1);
  });
});

describe('adherence inputs', () => {
  it('answers nothing when no plan prescribes anything', () => {
    // 24 of the 29 production clients with a logged session have no active
    // assignment. Scoring them 0% would report a trainer's un-assigned plan as
    // a client's failure to turn up.
    expect(adherenceInputs(null, [{ status: 'completed' }], 12)).toEqual({});
    expect(adherenceInputs({ planned_days_count: 0 }, [], 12)).toEqual({});
  });

  it('prescribes only across the weeks the plan has actually run', () => {
    const twoWeeksAgo = new Date(Date.now() - 15 * 86400000).toISOString().slice(0, 10);
    const out = adherenceInputs(
      { planned_days_count: 3, duration_weeks: 12, start_date: twoWeeksAgo },
      [{ status: 'completed' }, { status: 'completed' }, { status: 'skipped' }],
      12,
    );
    // A plan that began a fortnight ago has prescribed 6 sessions, not 36.
    // Charging it the whole window would invent a missed-session problem.
    expect(out).toEqual({ prescribed: 6, completed: 2 });
  });

  it('counts complete weeks only, so a week in progress is not yet owed', () => {
    const threeDays = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    // Rounding up here would tell a trainer their client had missed three
    // sessions on the Wednesday of a plan that started Sunday.
    expect(adherenceInputs({ planned_days_count: 3, duration_weeks: 12, start_date: threeDays }, [], 12))
      .toEqual({ prescribed: 0, completed: 0 });
  });

  it('never prescribes past the plan\'s own duration', () => {
    const longAgo = new Date(Date.now() - 200 * 86400000).toISOString().slice(0, 10);
    const out = adherenceInputs({ planned_days_count: 4, duration_weeks: 6, start_date: longAgo }, [], 12);
    expect(out.prescribed).toBe(24);
  });
});

describe('what the model is actually told', () => {
  const twinWith = async (tables, opts = {}) => {
    mockPool({ tables });
    return loadDigitalTwin('cl-1', 'org-1', { exercises: LIB, ...opts });
  };

  it('warns, in words, that nobody has screened an unassessed client', async () => {
    const text = describeTwin(await twinWith({}));
    // The single most important line in the prompt. Without it an empty
    // limitation list reads as a clean bill of health.
    expect(text).toContain('NOBODY HAS SCREENED THIS CLIENT');
    expect(text).toContain('means nothing was looked at, NOT that nothing is wrong');
  });

  it('says "screened and clear" when that is what actually happened', async () => {
    const text = describeTwin(await twinWith({
      pt_parq_forms: [{ assessment_date: '2026-08-01', workout_gate_status: 'cleared', past_history: {}, current_health: {} }],
      pt_mobility_performance_assessments: [{ body_regions: regions() }],
    }));
    expect(text).toContain('This client HAS been screened');
    expect(text).not.toContain('NOBODY HAS SCREENED');
  });

  it('puts the safety screen before anything about goals', async () => {
    const text = describeTwin(await twinWith({
      pt_mobility_performance_assessments: [{ body_regions: regions({ Shoulders: { pain: true } }) }],
    }));
    // A model that reads the goal first has already started writing the wrong
    // programme by the time it reaches the limitation.
    expect(text.indexOf('SAFETY SCREEN')).toBe(0);
    expect(text.indexOf('SAFETY SCREEN')).toBeLessThan(text.indexOf('WHAT THIS CLIENT HAS ACTUALLY DONE'));
  });

  it('names the excluded exercises and why', async () => {
    const text = describeTwin(await twinWith({
      pt_mobility_performance_assessments: [{ body_regions: regions({ Shoulders: { pain: true } }) }],
    }));
    expect(text).toContain('EXCLUDED Barbell Bench Press - Medium Grip');
    expect(text).toContain('mobility.body_regions: Shoulders: pain');
  });

  it('refuses to let a model call an untracked client a beginner', async () => {
    const text = describeTwin(await twinWith({}));
    expect(text).toContain('No sets have ever been logged');
    expect(text).toContain('do not describe them as a beginner');
  });

  it('forbids a progression claim the data cannot support', async () => {
    const text = describeTwin(await twinWith({
      workout_sets: [
        { exercise_name: 'Barbell Squat', weight_kg: 60, reps: 8, completed: true, session_date: '2026-09-01', target_muscle: 'Quadriceps' },
      ],
    }));
    // One session. The engine says so rather than letting the model guess.
    expect(text).toContain('NO lift has enough sessions logged for a trend');
  });

  it('reports which deload triggers could not be evaluated', async () => {
    const text = describeTwin(await twinWith({}));
    // Production today: RPE on 4 of 520 sets and zero weekly check-ins, so
    // three of the four triggers are structurally blind. A prompt that said
    // only "deload: not indicated" would be claiming a check nobody ran.
    expect(text).toMatch(/Deload: not indicated \(\d of 4 triggers could be evaluated\)/);
    expect(text).toContain('cannot tell —');
  });
});

describe('the limitations line that replaces the empty column', () => {
  const twinWith = async (tables, client = CLIENT) => {
    mockPool({ client, tables });
    return loadDigitalTwin('cl-1', 'org-1');
  };

  it('says UNKNOWN rather than none for an unscreened client', async () => {
    // What the generator sent for every client in production: "none".
    expect(limitationsLine(await twinWith({}))).toBe('UNKNOWN — nobody has screened this client');
  });

  it('reports findings the empty column never held', async () => {
    const line = limitationsLine(await twinWith({
      pt_mobility_performance_assessments: [{ body_regions: regions({ Hip: { pain: true }, Ankles: { restriction: true } }) }],
      pt_parq_forms: [{ workout_gate_status: 'cleared', past_history: { joint_problems: true }, current_health: {} }],
    }));
    expect(line).toContain('hip (block, from mobility.body_regions)');
    expect(line).toContain('ankle (caution, from mobility.body_regions)');
    expect(line).toContain('joint problems');
  });

  it('still carries free text a trainer typed on the client record', async () => {
    const line = limitationsLine(await twinWith(
      { pt_parq_forms: [{ workout_gate_status: 'cleared', past_history: {}, current_health: {} }] },
      { ...CLIENT, injuries: 'torn rotator cuff 2024, cleared by physio' },
    ));
    // Empty for all 34 production clients, but a trainer who typed there meant
    // it, so it is carried rather than replaced.
    expect(line).toContain('torn rotator cuff 2024');
  });

  it('distinguishes screened-and-clear from unscreened', async () => {
    const line = limitationsLine(await twinWith({
      pt_parq_forms: [{ workout_gate_status: 'cleared', past_history: {}, current_health: {} }],
      pt_mobility_performance_assessments: [{ body_regions: regions() }],
    }));
    expect(line).toBe('none found — the client has been screened and is clear');
  });
});

describe('screening the exercises a plan actually named', () => {
  /**
   * The four names that collide under normalisation, as production holds them.
   *
   * They were checked when the matcher was written: of 890 exercises exactly
   * four normalise onto another, every pair shares one target_muscle — and
   * every pair DIFFERS in equipment. "Leg Press" is both a Bodyweight row and
   * a Machine row, so with an equipment filter one blocks and one allows.
   */
  const LEG_PRESS_BODYWEIGHT = {
    name: 'Leg Press', muscle_group: 'Legs', target_muscle: 'Quadriceps',
    movement_pattern: 'General', equipment: 'Bodyweight', difficulty: 'beginner',
  };
  const LEG_PRESS_MACHINE = { ...LEG_PRESS_BODYWEIGHT, equipment: 'Machine' };

  const screenFor = (equipment) => buildConstraints({
    parq: { workout_gate_status: 'cleared', past_history: {}, current_health: {} },
    equipment,
  });

  function mockLibrary(rows) {
    pool.query.mockReset();
    pool.query.mockImplementation((sql) => Promise.resolve({
      rows: /FROM exercises/.test(sql) ? rows : [],
    }));
  }

  it('takes the stricter verdict when two library rows share a name', async () => {
    mockLibrary([LEG_PRESS_BODYWEIGHT, LEG_PRESS_MACHINE]);
    const out = await screenPlanExercises(['Leg Press'], {
      orgId: 'org-1', userId: 'u1', screen: screenFor(['Bodyweight']),
    });
    // A studio with no machines has no machine leg press. Letting the
    // bodyweight twin clear the name would hand the client an exercise the
    // gym does not have — and on a safety constraint rather than an equipment
    // one, it would clear an exercise the rules excluded.
    expect(out.get('leg press').verdict).toBe('block');
  });

  it('does not invent a verdict when neither row is constrained', async () => {
    mockLibrary([LEG_PRESS_BODYWEIGHT, LEG_PRESS_MACHINE]);
    const out = await screenPlanExercises(['Leg Press'], {
      orgId: 'org-1', userId: 'u1', screen: screenFor(null),
    });
    expect(out.get('leg press').verdict).toBe('allow');
  });

  it('returns nothing for a name the library does not hold', async () => {
    mockLibrary([]);
    const out = await screenPlanExercises(['Overhead Press'], {
      orgId: 'org-1', userId: 'u1', screen: screenFor(null),
    });
    // Absent from the map, so the audit reports it unverified rather than
    // clearing it — see plan-critic.js on why fuzzy matching is unsafe here.
    expect(out.size).toBe(0);
  });

  it('fails closed without an org or a user', async () => {
    mockLibrary([LEG_PRESS_MACHINE]);
    for (const args of [{ orgId: null, userId: 'u1' }, { orgId: 'org-1', userId: null }]) {
      const out = await screenPlanExercises(['Leg Press'], { ...args, screen: screenFor(null) });
      expect(out.size).toBe(0);
    }
    // Nothing was cleared by an unscoped read, because no read happened.
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('queries by normalised name through the library\'s own tenancy predicate', async () => {
    mockLibrary([]);
    await screenPlanExercises(['  BENCH-PRESS ', 'Bench Press'], {
      orgId: 'org-1', userId: 'u1', screen: screenFor(null),
    });
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/organization_id IS NULL OR \(organization_id = \$1::uuid AND created_by = \$2\)/);
    // Both spellings collapse to one lookup value.
    expect(params[2]).toEqual(['bench press']);
    // The COLUMN has to be folded the same way the parameter was. Comparing a
    // normalised parameter against a raw name matches nothing for any name
    // carrying punctuation — which fails safe (everything unverified) and
    // silently guts the audit's reach, so it is pinned rather than trusted.
    expect(sql).toMatch(/regexp_replace\(lower\(btrim\(name\)\), '\[\^a-z0-9\]\+', ' ', 'g'\) = ANY/);
  });
});

describe('the studio\'s own volume ranges', () => {
  // The defect this replaced: programming-rules.js hardcoded weekly set ranges
  // keyed on the coarse muscle_group, while muscle_volume_landmarks already
  // held finer ones a trainer edits in analytics/LandmarkEditor. A studio that
  // tuned its ranges saw them honoured on the analytics screen and silently
  // ignored by the programming engine.

  const rowsFor = (rows) => {
    pool.query.mockReset();
    pool.query.mockImplementation(() => Promise.resolve({ rows }));
  };

  it('asks for the studio\'s rows as well as the platform defaults', async () => {
    rowsFor([]);
    await resolveLandmarks('org-1');
    const [sql, params] = pool.query.mock.calls[0];
    const flat = String(sql).replace(/\s+/g, ' ');
    // Without the org half of this predicate the query returns only the
    // seeded defaults, and every studio override is invisible — which is
    // exactly the bug being fixed.
    expect(flat).toMatch(/organization_id IS NULL OR \(\$1::uuid IS NOT NULL AND organization_id = \$1\)/);
    expect(params).toEqual(['org-1']);
  });

  it('lets the studio\'s row win over the platform default', async () => {
    rowsFor([]);
    await resolveLandmarks('org-1');
    const flat = String(pool.query.mock.calls[0][0]).replace(/\s+/g, ' ');
    // DISTINCT ON keeps the FIRST row per muscle, so the NULL organization —
    // the shared default — has to sort last for "mine, else the shared one" to
    // hold. NULLS FIRST silently reverses the precedence and the override
    // never applies. The same ordering workout-log.routes.js has always used.
    expect(flat).toMatch(/DISTINCT ON \(target_muscle\)/);
    expect(flat).toMatch(/ORDER BY target_muscle, organization_id NULLS LAST/);
  });

  it('keys on the library\'s spelling, not the table\'s', async () => {
    // The table stores "middle back"; exercises.target_muscle says
    // "Middle Back", and the set rows carry the library's spelling. Keying on
    // the raw value means every multi-word muscle silently loses its range.
    rowsFor([
      { target_muscle: 'middle back', mev_sets: 8, mrv_sets: 25 },
      { target_muscle: 'chest', mev_sets: 8, mrv_sets: 22 },
    ]);
    const out = await resolveLandmarks('org-1');
    expect([...out.keys()].sort()).toEqual(['Chest', 'Middle Back']);
    expect(out.get('Middle Back')).toEqual({ mev_sets: 8, mrv_sets: 25 });
  });

  it('passes the resolved ranges into the twin\'s volume verdict', async () => {
    mockPool({
      tables: {
        workout_sets: [
          { exercise_name: 'Lat Pulldown', weight_kg: 40, reps: 10, completed: true, session_date: '2026-09-01', target_muscle: 'Lats' },
        ],
      },
      landmarks: [{ target_muscle: 'lats', mev_sets: 10, mrv_sets: 25 }],
    });
    const twin = await loadDigitalTwin('cl-1', 'org-1');
    // One set against a minimum of ten. The verdict exists only because the
    // studio's range reached the engine.
    expect(twin.rules.volume.below).toEqual(['Lats']);
    expect(twin.rules.volume.muscles[0]).toMatchObject({ muscle: 'Lats', mev_sets: 10 });
  });
});


describe('when did this client last actually train', () => {
  const { sweepRoster, TRAINING_HAPPENED } = require('../modules/pt-os/client-context');

  // ── The wrong answer this replaced ───────────────────────────────────────
  //
  // `last_session` was MAX(session_date) WHERE status = 'completed'. Measured
  // on production the day it changed: 22 sessions held logged sets while
  // sitting in 'in_progress', and one client who had trained the previous day
  // was reported as 41 days silent — which on a GONE_DAYS threshold of 21
  // renders to the trainer as "Paying, and stopped coming. Contact them this
  // week." Two more clients had sets logged and no completed session at all,
  // so they read as "Paid but has never trained".
  //
  // The conflation: workout_sessions.status is a UI workflow state — did
  // somebody tap Finish — and the schema lets it be set with no evidence (17
  // of 54 completed production sessions hold zero sets). Whether the client
  // TRAINED is answered by a logged set.

  const sqlOf = (re) => pool.query.mock.calls.map(([s]) => String(s).replace(/\s+/g, ' '))
    .find((s) => re.test(s));

  beforeEach(() => {
    pool.query.mockReset();
    pool.query.mockResolvedValue({ rows: [] });
  });

  it('counts a session the trainer marked complete', () => {
    expect(TRAINING_HAPPENED.replace(/\s+/g, ' ')).toContain("ws.status = 'completed'");
  });

  it('also counts a session that carries a logged set', () => {
    // The half that was missing. A set is somebody standing in the gym putting
    // a number in; no workflow tap is more authoritative than that.
    const one = TRAINING_HAPPENED.replace(/\s+/g, ' ');
    expect(one).toMatch(/OR EXISTS/);
    expect(one).toMatch(/JOIN workout_sets s ON s\.session_exercise_id = wse\.id/);
    expect(one).toMatch(/WHERE wse\.session_id = ws\.id/);
  });

  it('is the definition the roster sweep actually uses', async () => {
    await sweepRoster('org-1', { today: '2026-09-13' });
    const clientSql = sqlOf(/FROM pt_clients c/);
    expect(clientSql).toMatch(/MAX\(ws\.session_date\)/);
    // Not a second copy of the rule written out again beside it.
    expect(clientSql).toContain(TRAINING_HAPPENED.replace(/\s+/g, ' '));
  });

  it('never narrows back to completed alone', async () => {
    await sweepRoster('org-1', { today: '2026-09-13' });
    const clientSql = sqlOf(/FROM pt_clients c/);
    // The exact shape of the bug: a bare status test with nothing beside it.
    expect(clientSql).not.toMatch(/client_id = c\.id AND ws\.status = 'completed'\) AS last_session/);
  });

  it('keeps the sweep org-scoped while it is at it', async () => {
    await sweepRoster('org-1', { today: '2026-09-13' });
    expect(sqlOf(/FROM pt_clients c/)).toMatch(/c\.organization_id = \$1/);
  });

  it('does not widen the counters that measure a prescription', () => {
    // Deliberately narrow. recomputeAssignmentProgress and the public stats
    // count COMPLETED sessions against what a plan asked for; silently
    // swapping this definition in would change what a studio's progress bar
    // and public numbers mean, and that needs its own evidence.
    const fs = require('fs');
    const path = require('path');
    const log = fs.readFileSync(
      path.join(__dirname, '..', 'modules', 'pt-os', 'workout-log.routes.js'), 'utf8',
    );
    expect(log).toMatch(/ws\.status = 'completed'\) AS completed_count/);
  });
});
