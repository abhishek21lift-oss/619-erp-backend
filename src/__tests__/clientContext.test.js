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
  loadDigitalTwin, describeTwin, limitationsLine, adherenceInputs,
} = require('../modules/pt-os/client-context');

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
function mockPool({ client = CLIENT, tables = {} } = {}) {
  const seen = [];
  pool.query.mockReset();
  pool.query.mockImplementation((sql) => {
    seen.push(sql);
    if (/FROM pt_clients/.test(sql)) return Promise.resolve({ rows: client ? [client] : [] });
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
          { exercise_name: 'Barbell Squat', weight_kg: 60, reps: 8, rpe: null, rir: null, completed: true, session_date: '2026-09-01', muscle_group: 'Legs' },
          { exercise_name: 'Barbell Squat', weight_kg: 60, reps: 8, rpe: null, rir: null, completed: false, session_date: '2026-09-01', muscle_group: 'Legs' },
        ],
      },
    });
    const twin = await loadDigitalTwin('cl-1', 'org-1');
    expect(twin.history.has_history).toBe(true);
    expect(twin.history.totals.sets).toBe(1);
    expect(twin.history.totals.sets_not_completed).toBe(1);
    // Weekly volume rides on the same rows rather than a second query.
    expect(twin.rules.volume.groups[0]).toMatchObject({ group: 'Legs', latest_sets: 1 });
  });

  it('counts a set whose exercise was typed free-hand as unattributable', async () => {
    mockPool({
      tables: {
        workout_sets: [
          { exercise_name: 'Bulgarian split squats', weight_kg: 15, reps: 10, completed: true, session_date: '2026-09-01', muscle_group: null },
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
        { exercise_name: 'Barbell Squat', weight_kg: 60, reps: 8, completed: true, session_date: '2026-09-01', muscle_group: 'Legs' },
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
