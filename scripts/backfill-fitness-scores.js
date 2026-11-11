'use strict';
// Backfill the 100-point fitness scores for rows written before the framework.
//
//   node scripts/backfill-fitness-scores.js            # dry-run, writes nothing
//   node scripts/backfill-fitness-scores.js --apply    # writes, one tx per batch
//
// Scores only: the stored clinical labels (bp_category, bmi_category, vo2_max,
// *_category, BMR, lean/fat mass) are read, never rewritten. Resumable: rows
// already at scoring_formula_version 2 are skipped, so an interrupted run can
// simply be started again.
//
// The inputs are the stored columns and payloads, and age is today's age from
// the client's DOB — exactly what progress.routes.js demographics() uses, so
// the writer and the backfill cannot disagree.

const scoring = require('../src/modules/progress/fitness-scoring');
const flexibilityProtocol = require('../src/modules/progress/flexibility-protocol');

const BATCH = 200;

const SELECT_SQL = `
  SELECT a.*, c.dob, c.gender
    FROM pt_assessments a
    JOIN pt_clients c ON c.id = a.client_id
   WHERE a.scoring_formula_version < 2 AND a.id > $1
   ORDER BY a.id
   LIMIT $2`;

const UPDATE_SQL = `
  UPDATE pt_assessments SET
    bp_points = $1, anthropometric_points = $2, body_composition_score = $3,
    cardio_score_computed = $4, strength_score_computed = $5, endurance_score_computed = $6,
    mobility_score_computed = $7, overall_points = $8, overall_max = $9,
    overall_fitness_score = $10, health_risk_score = NULL, scoring_formula_version = 2
  WHERE id = $11`;

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
};

const obj = (v) => {
  if (!v) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return null; }
};

/** Today's age from DOB, the same rule demographics() uses; null if unknown. */
function ageFromDob(dob) {
  if (!dob) return null;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date();
  return today.getFullYear() - d.getFullYear()
    - (today < new Date(today.getFullYear(), d.getMonth(), d.getDate()) ? 1 : 0);
}

/** The stored percentile when present, else a fresh K11 classification. */
function strengthDetail(test, row, exercise, age, gender) {
  if (!test || typeof test !== 'object') return null;
  if (test.k11_percentile != null) return { percentile: test.k11_percentile, category: null };
  const oneRm = test.isDirect === true
    ? num(test.direct1RM)
    : scoring.calc1RM(num(test.weightKg), num(test.reps), test.formula === 'brzycki' ? 'brzycki' : 'epley');
  return scoring.classifyStrengthDetail(oneRm, num(row.weight), exercise || null, gender, age);
}

function stepResults(row) {
  const gender = row.gender;
  const age = ageFromDob(row.dob);
  const strengthData = obj(row.strength_test_data) || {};
  const fd = obj(row.flexibility_test_data) || {};
  const flexibility = flexibilityProtocol.isRecordedBattery(fd)
    ? scoring.scoreFlexibilityPoints(flexibilityProtocol.deriveFlexibility(fd), null)
    : scoring.scoreFlexibilityPoints(null, num(row.mobility_score_computed));

  return {
    bp: scoring.scoreBpPoints(row.bp_category),
    anthropometric: scoring.scoreAnthropometricPoints({
      bmi: num(row.bmi),
      waistIliacCm: num(row.waist_iliac_cm),
      waistCm: num(row.waist_cm),
      waistHipRatio: num(row.waist_hip_ratio),
    }, gender),
    bodyComposition: scoring.scoreBodyCompositionPoints(num(row.body_fat_pct), gender),
    cardio: scoring.scoreCardioPoints(row.cardio_category),
    strength: scoring.scoreStrengthBattery(
      strengthDetail(strengthData.test1, row, row.strength_exercise, age, gender),
      strengthDetail(strengthData.test2, row, row.strength_exercise_2, age, gender),
    ),
    endurance: scoring.scoreEnduranceBatteryPoints(row.endurance_category, row.endurance_category_2),
    flexibility,
  };
}

function updateParams(row) {
  const steps = stepResults(row);
  const total = scoring.computeTotalScore(steps);
  return {
    max: total.max,
    params: [
      steps.bp.points, steps.anthropometric.points, steps.bodyComposition.points,
      steps.cardio.points, steps.strength.points, steps.endurance.points,
      steps.flexibility.points, total.points, total.max, total.score, row.id,
    ],
  };
}

async function backfillScores({ pool, apply = false } = {}) {
  let scanned = 0;
  let updated = 0;
  let skipped = 0;
  let after = '';

  for (;;) {
    const { rows } = await pool.query(SELECT_SQL, [after, BATCH]);
    if (!rows.length) break;
    scanned += rows.length;
    after = rows[rows.length - 1].id;

    const plans = rows.map((row) => ({ row, ...updateParams(row) }));
    skipped += plans.filter((p) => p.max === 0).length;
    if (!apply) continue;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const plan of plans) {
        await client.query(UPDATE_SQL, plan.params);
        if (plan.max > 0) updated += 1;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
      throw err;
    }
    client.release();
  }

  return { scanned, updated, skipped };
}

module.exports = { backfillScores, UPDATE_SQL, SELECT_SQL };

if (require.main === module) {
  const apply = process.argv.includes('--apply');
  const pool = require('../src/db/pool');
  backfillScores({ pool, apply })
    .then((result) => {
      console.log(`${apply ? 'applied' : 'dry-run'}: scanned ${result.scanned}, updated ${result.updated}, unscored ${result.skipped}`);
      if (!apply) console.log('no rows written; re-run with --apply to write');
      return pool.end();
    })
    .catch((err) => {
      console.error(err.message);
      pool.end().finally(() => process.exitCode = 1);
    });
}
