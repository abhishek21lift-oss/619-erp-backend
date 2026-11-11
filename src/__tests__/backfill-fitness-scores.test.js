'use strict';

const { backfillScores } = require('../../scripts/backfill-fitness-scores');

function fakePool(rows) {
  const queries = [];
  const state = { rows: rows.map((r) => ({ ...r })), connects: 0 };
  const applyUpdate = (params) => {
    const id = params[params.length - 1];
    const row = state.rows.find((r) => r.id === id);
    if (row) row.scoring_formula_version = 2;
  };
  return {
    queries,
    state,
    get connects() { return state.connects; },
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      queries.push({ sql: text, params });
      if (/FROM pt_assessments a/i.test(text)) {
        const after = params[0];
        return {
          rows: state.rows
            .filter((r) => r.id > after && r.scoring_formula_version < 2)
            .sort((a, b) => a.id - b.id)
            .slice(0, params[1]),
        };
      }
      return { rows: [] };
    },
    async connect() {
      state.connects += 1;
      return {
        async query(sql, params = []) {
          const text = String(sql).replace(/\s+/g, ' ').trim();
          queries.push({ sql: text, params });
          if (/^UPDATE pt_assessments/i.test(text)) applyUpdate(params);
          return { rows: [] };
        },
        release() {},
      };
    },
  };
}

const row1 = {
  id: 2,
  scoring_formula_version: 1,
  dob: '1990-01-01',
  gender: 'Male',
  bp_category: 'Normal',
  bmi: 22,
  waist_iliac_cm: 85,
  waist_cm: 80,
  waist_hip_ratio: 0.9,
  body_fat_pct: 12,
  cardio_category: 'Good',
  endurance_category: 'Excellent',
  endurance_category_2: null,
  weight: 80,
  strength_exercise: 'Bench Press',
  strength_exercise_2: null,
  strength_test_data: { test1: { k11_percentile: 90 } },
  mobility_score_computed: 80,
  flexibility_test_data: { test1: { score: 8 }, test2: { score: 8 } },
};

const rowNoDob = {
  id: 3,
  scoring_formula_version: 1,
  dob: null,
  gender: 'Male',
  bp_category: 'Elevated',
  bmi: null,
  waist_iliac_cm: null,
  waist_cm: null,
  waist_hip_ratio: null,
  body_fat_pct: null,
  cardio_category: null,
  endurance_category: null,
  endurance_category_2: null,
  weight: 80,
  strength_exercise: 'Bench Press',
  strength_exercise_2: null,
  strength_test_data: { test1: { weightKg: 60, reps: 5, formula: 'epley', isDirect: false } },
  mobility_score_computed: null,
  flexibility_test_data: {},
};

const updateFor = (pool, id) => {
  const q = pool.queries.find((x) => /^UPDATE pt_assessments/i.test(x.sql) && x.params[x.params.length - 1] === id);
  if (!q) return null;
  const set = q.sql.match(/UPDATE pt_assessments SET ([\s\S]*?) WHERE/i)[1];
  const cols = {};
  for (const part of set.split(',')) {
    const m = part.trim().match(/^(\w+)\s*=\s*\$(\d+)/);
    if (m) cols[m[1]] = q.params[Number(m[2]) - 1];
  }
  if (/health_risk_score\s*=\s*NULL/i.test(set)) cols.health_risk_score = null;
  if (/scoring_formula_version\s*=\s*2/i.test(set)) cols.scoring_formula_version = 2;
  return cols;
};

test('dry-run scans but never writes', async () => {
  const pool = fakePool([row1]);
  const result = await backfillScores({ pool, apply: false });
  expect(result.scanned).toBe(1);
  expect(result.updated).toBe(0);
  expect(pool.queries.some((q) => /^UPDATE pt_assessments/i.test(q.sql))).toBe(false);
  expect(pool.connects).toBe(0);
});

test('apply writes the seven steps, totals and the formula version', async () => {
  const pool = fakePool([row1]);
  const result = await backfillScores({ pool, apply: true });
  expect(result.scanned).toBe(1);
  expect(result.updated).toBe(1);
  const cols = updateFor(pool, 2);
  expect(cols).toMatchObject({
    bp_points: 10,
    anthropometric_points: 10,
    body_composition_score: 15,
    cardio_score_computed: 16,
    strength_score_computed: 7.5,
    endurance_score_computed: 7.5,
    mobility_score_computed: 12,
    overall_points: 78,
    overall_max: 85,
    overall_fitness_score: 92,
    health_risk_score: null,
    scoring_formula_version: 2,
  });
});

test('the update never rewrites stored clinical labels', async () => {
  const pool = fakePool([row1]);
  await backfillScores({ pool, apply: true });
  const sql = pool.queries.find((q) => /^UPDATE pt_assessments/i.test(q.sql)).sql;
  expect(sql).not.toMatch(/bp_category|bmi_category|waist_risk|whr_risk|vo2_max|strength_category|endurance_category|lean_body_mass|bmr/i);
});

test('a second run finds nothing and stays idempotent', async () => {
  const pool = fakePool([row1]);
  await backfillScores({ pool, apply: true });
  const again = await backfillScores({ pool, apply: true });
  expect(again.scanned).toBe(0);
  expect(again.updated).toBe(0);
});

test('a row with no date of birth leaves age-split steps unscored', async () => {
  const pool = fakePool([rowNoDob]);
  await backfillScores({ pool, apply: true });
  const cols = updateFor(pool, 3);
  expect(cols.strength_score_computed).toBeNull();
  expect(cols.bp_points).toBe(7);
  expect(cols.overall_max).toBe(10);
  expect(cols.overall_fitness_score).toBe(70);
});
