#!/usr/bin/env node
'use strict';
// Phase 4 — D1–D25 ownership audit.
//
// Reads, never writes. The transaction is opened READ ONLY, so a mistake in a
// query here fails instead of changing a client's record. Run it against a
// restored production dump, a replica, or the Phase 4 production-shaped
// fixture; the output is the same table.
//
//   DATABASE_URL=... node scripts/phase4-audit-ownership.js
//   node scripts/phase4-audit-ownership.js --url ... --org <uuid> --json out.json
//
// Four numbers per duplicate:
//
//   owner_present  the owning module has a value
//   legacy_only    the owner has nothing and a pre-move column does
//   conflict       both hold a value and they disagree
//   stale          the owner's newest row is older than STALE_AFTER_DAYS
//
// A conflict is not automatically a bug: old rows were written before the move
// and both values were true on their own dates. It is the size of the cleanup,
// not a verdict.

const { Client } = require('pg');

const STALE_AFTER_DAYS = 365;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const URL_ARG = arg('url') || process.env.DATABASE_URL || process.env.RLS_TEST_DATABASE_URL;
const JSON_OUT = arg('json');
const ORG_FILTER = arg('org');

if (!URL_ARG && require.main === module) {
  console.error('No database. Set DATABASE_URL or pass --url.');
  process.exit(2);
}

/** Newest owner row per client. Content date first, insertion time second. */
const LATEST = {
  assessment: `SELECT DISTINCT ON (client_id) *
                 FROM pt_assessments
                ORDER BY client_id, assessment_date DESC NULLS LAST, created_at DESC`,
  goal: `SELECT DISTINCT ON (client_id) *
           FROM pt_goals WHERE is_active = TRUE
          ORDER BY client_id, created_at DESC`,
  lifestyle: `SELECT DISTINCT ON (client_id) *
                FROM pt_lifestyle_assessments
               ORDER BY client_id, assessment_date DESC NULLS LAST, created_at DESC`,
  nutrition: `SELECT DISTINCT ON (client_id) *
                FROM pt_nutrition_assessments
               ORDER BY client_id, assessment_date DESC NULLS LAST, created_at DESC`,
  parq: `SELECT DISTINCT ON (client_id) *
           FROM pt_parq_forms WHERE deleted_at IS NULL
          ORDER BY client_id, assessment_date DESC NULLS LAST, created_at DESC`,
  parqMedical: `SELECT DISTINCT ON (client_id) *
                  FROM pt_parq_forms
                 WHERE deleted_at IS NULL AND status IN ('submitted','reviewed')
                 ORDER BY client_id, assessment_date DESC NULLS LAST, created_at DESC`,
  interview: `SELECT DISTINCT ON (client_id) *
                FROM pt_client_interviews WHERE status = 'completed'
               ORDER BY client_id, created_at DESC`,
  mobility: `SELECT DISTINCT ON (client_id) *
               FROM pt_mobility_performance_assessments
              ORDER BY client_id, assessment_date DESC NULLS LAST, created_at DESC`,
};

/**
 * Every check is one row. `legacy` is always a column on a non-owner table or
 * a text[]/jsonb copy; `owner` is the module the field matrix names.
 *
 * Checks that compare vocabularies (meal regularity, food preferences) do the
 * mapping in SQL so the count means "the two records say different things",
 * not "the two strings differ".
 */
const CHECKS = [
  {
    id: 'D1', field: 'Client identity at signing', owner: 'Consent / PAR-Q snapshot',
    copies: 'pt_clients',
    note: 'Drift is expected: a snapshot is the identity on the signing date, not today.',
    sql: `WITH s AS (SELECT id, client_id, full_name, dob, mobile FROM pt_parq_forms WHERE deleted_at IS NULL
                   UNION ALL
                   SELECT id, client_id, full_name, dob, mobile FROM pt_informed_consents)
          SELECT count(*)::int AS owner_present,
                 0 AS legacy_only,
                 count(*) FILTER (WHERE s.full_name IS DISTINCT FROM c.name
                                    OR (s.mobile IS NOT NULL AND s.mobile <> c.mobile)
                                    OR (s.dob IS NOT NULL AND s.dob::text <> c.dob::text))::int AS conflict,
                 0 AS stale
            FROM s JOIN pt_clients c ON c.id = s.client_id
           WHERE c.organization_id = ANY($1::uuid[])`,
  },
  {
    id: 'D2', field: 'Emergency contact / phone', owner: 'Consent / PAR-Q snapshot',
    copies: 'pt_clients',
    note: 'Same snapshot rule as D1.',
    sql: `WITH s AS (SELECT client_id, emergency_contact, emergency_phone FROM pt_parq_forms WHERE deleted_at IS NULL
                   UNION ALL
                   SELECT client_id, emergency_contact, emergency_phone FROM pt_informed_consents)
          SELECT count(*)::int AS owner_present,
                 0 AS legacy_only,
                 count(*) FILTER (WHERE (s.emergency_contact IS NOT NULL AND s.emergency_contact <> c.emergency_contact)
                                    OR (s.emergency_phone IS NOT NULL AND s.emergency_phone <> c.emergency_phone))::int AS conflict,
                 0 AS stale
            FROM s JOIN pt_clients c ON c.id = s.client_id
           WHERE c.organization_id = ANY($1::uuid[])`,
  },
  {
    id: 'D3', field: 'Height / weight / BMI', owner: 'Fitness Testing',
    copies: 'pt_clients cache, PAR-Q, Goal starting_*',
    note: 'Cache divergence on an active client is the Phase 0 cache bug; snapshot divergence is expected.',
    sql: `WITH l AS (${LATEST.assessment})
          SELECT count(*) FILTER (WHERE l.weight IS NOT NULL OR l.height_cm IS NOT NULL)::int AS owner_present,
                 count(*) FILTER (WHERE l.id IS NULL AND (c.weight IS NOT NULL OR c.height IS NOT NULL))::int AS legacy_only,
                 count(*) FILTER (WHERE (l.height_cm IS NOT NULL AND c.height IS NOT NULL AND c.height <> l.height_cm)
                                    OR (l.weight IS NOT NULL AND c.weight IS NOT NULL AND c.weight <> l.weight))::int AS conflict,
                 count(*) FILTER (WHERE l.assessment_date < CURRENT_DATE - ${STALE_AFTER_DAYS})::int AS stale
            FROM pt_clients c LEFT JOIN l ON l.client_id = c.id
           WHERE c.organization_id = ANY($1::uuid[]) AND c.deleted_at IS NULL`,
  },
  {
    id: 'D4', field: 'Goal', owner: 'Goal Assessment',
    copies: 'pt_clients.goal, client_fitness_profiles.goal',
    note: 'Legacy vocabulary differs in a few rows (weight_loss vs fat_loss); see the conflict sample.',
    sql: `WITH g AS (${LATEST.goal})
          SELECT count(*) FILTER (WHERE g.goal_type IS NOT NULL)::int AS owner_present,
                 count(*) FILTER (WHERE g.goal_type IS NULL AND (c.goal IS NOT NULL OR p.goal IS NOT NULL))::int AS legacy_only,
                 count(*) FILTER (WHERE g.goal_type IS NOT NULL AND (
                        (c.goal IS NOT NULL AND c.goal <> g.goal_type)
                     OR (p.goal IS NOT NULL AND p.goal <> g.goal_type)))::int AS conflict,
                 0 AS stale
            FROM pt_clients c
            LEFT JOIN g ON g.client_id = c.id
            LEFT JOIN client_fitness_profiles p ON p.client_id = c.id
           WHERE c.organization_id = ANY($1::uuid[]) AND c.deleted_at IS NULL`,
  },
  {
    id: 'D5', field: 'Health conditions', owner: 'PAR-Q',
    copies: 'pt_clients.health_conditions, pt_nutrition_assessments.medical_conditions, profile',
    note: 'Structured PAR-Q checklist vs free text; counted as a conflict when both hold any answer.',
    sql: `WITH q AS (${LATEST.parq}), n AS (${LATEST.nutrition})
          SELECT count(*) FILTER (WHERE q.current_health <> '{}'::jsonb OR q.past_history <> '{}'::jsonb)::int AS owner_present,
                 count(*) FILTER (WHERE (q.id IS NULL OR (q.current_health = '{}'::jsonb AND q.past_history = '{}'::jsonb))
                                    AND (c.health_conditions IS NOT NULL
                                      OR coalesce(array_length(n.medical_conditions, 1), 0) > 0
                                      OR coalesce(array_length(p.health_conditions, 1), 0) > 0))::int AS legacy_only,
                 count(*) FILTER (WHERE (q.current_health <> '{}'::jsonb OR q.past_history <> '{}'::jsonb)
                                    AND (c.health_conditions IS NOT NULL
                                      OR coalesce(array_length(n.medical_conditions, 1), 0) > 0))::int AS conflict,
                 count(*) FILTER (WHERE q.assessment_date < CURRENT_DATE - ${STALE_AFTER_DAYS})::int AS stale
            FROM pt_clients c
            LEFT JOIN q ON q.client_id = c.id
            LEFT JOIN n ON n.client_id = c.id
            LEFT JOIN client_fitness_profiles p ON p.client_id = c.id
           WHERE c.organization_id = ANY($1::uuid[]) AND c.deleted_at IS NULL`,
  },
  {
    id: 'D6', field: 'Injuries', owner: 'PAR-Q (history) / Interview (current)',
    copies: 'pt_clients.injuries',
    note: 'Interview narrative is a different fact from PAR-Q history; both are legitimate.',
    sql: `WITH q AS (${LATEST.parq}), i AS (${LATEST.interview})
          SELECT count(*) FILTER (WHERE q.past_history->>'previous_injuries' IS NOT NULL
                                     OR i.pain_and_injuries IS NOT NULL)::int AS owner_present,
                 count(*) FILTER (WHERE q.past_history->>'previous_injuries' IS NULL
                                    AND i.pain_and_injuries IS NULL
                                    AND c.injuries IS NOT NULL)::int AS legacy_only,
                 count(*) FILTER (WHERE c.injuries IS NOT NULL
                                    AND (q.past_history->>'previous_injuries' IS NOT NULL
                                      OR i.pain_and_injuries IS NOT NULL))::int AS conflict,
                 0 AS stale
            FROM pt_clients c
            LEFT JOIN q ON q.client_id = c.id
            LEFT JOIN i ON i.client_id = c.id
           WHERE c.organization_id = ANY($1::uuid[]) AND c.deleted_at IS NULL`,
  },
  {
    id: 'D7', field: 'Workout experience', owner: 'Add Client / enrolment',
    copies: 'pt_lifestyle_assessments, client_fitness_profiles',
    note: 'Lifestyle displays the owner value; its own column predates the move.',
    sql: `WITH l AS (${LATEST.lifestyle})
          SELECT count(*) FILTER (WHERE c.workout_experience_level IS NOT NULL)::int AS owner_present,
                 count(*) FILTER (WHERE c.workout_experience_level IS NULL
                                    AND (l.workout_experience_level IS NOT NULL OR p.fitness_level IS NOT NULL))::int AS legacy_only,
                 count(*) FILTER (WHERE c.workout_experience_level IS NOT NULL AND (
                        (l.workout_experience_level IS NOT NULL AND l.workout_experience_level <> c.workout_experience_level)
                     OR (p.fitness_level IS NOT NULL AND p.fitness_level <> c.workout_experience_level)))::int AS conflict,
                 0 AS stale
            FROM pt_clients c
            LEFT JOIN l ON l.client_id = c.id
            LEFT JOIN client_fitness_profiles p ON p.client_id = c.id
           WHERE c.organization_id = ANY($1::uuid[]) AND c.deleted_at IS NULL`,
  },
  {
    id: 'D8', field: 'Occupation', owner: 'Lifestyle',
    copies: 'pt_clients, Interview, PAR-Q, consent snapshot',
    note: 'old value readable in three places; only the Lifestyle row should be written now.',
    sql: `WITH l AS (${LATEST.lifestyle}), i AS (${LATEST.interview})
          SELECT count(*) FILTER (WHERE l.occupation_type IS NOT NULL)::int AS owner_present,
                 count(*) FILTER (WHERE l.occupation_type IS NULL
                                    AND (c.occupation IS NOT NULL OR i.lifestyle_occupation IS NOT NULL))::int AS legacy_only,
                 count(*) FILTER (WHERE l.occupation_type IS NOT NULL AND (
                        (c.occupation IS NOT NULL AND c.occupation <> l.occupation_type)
                     OR (i.lifestyle_occupation IS NOT NULL AND i.lifestyle_occupation <> l.occupation_type)))::int AS conflict,
                 count(*) FILTER (WHERE l.assessment_date < CURRENT_DATE - ${STALE_AFTER_DAYS})::int AS stale
            FROM pt_clients c
            LEFT JOIN l ON l.client_id = c.id
            LEFT JOIN i ON i.client_id = c.id
           WHERE c.organization_id = ANY($1::uuid[]) AND c.deleted_at IS NULL`,
  },
  {
    id: 'D9', field: 'Screen time', owner: 'Lifestyle',
    copies: 'Interview',
    note: 'Same bracket vocabulary, no mapping needed.',
    sql: `WITH l AS (${LATEST.lifestyle}), i AS (${LATEST.interview})
          SELECT count(*) FILTER (WHERE l.screen_time_bracket IS NOT NULL)::int AS owner_present,
                 count(*) FILTER (WHERE l.screen_time_bracket IS NULL AND i.lifestyle_screen_time IS NOT NULL)::int AS legacy_only,
                 count(*) FILTER (WHERE l.screen_time_bracket IS NOT NULL AND i.lifestyle_screen_time IS NOT NULL
                                    AND l.screen_time_bracket <> i.lifestyle_screen_time)::int AS conflict,
                 count(*) FILTER (WHERE l.assessment_date < CURRENT_DATE - ${STALE_AFTER_DAYS})::int AS stale
            FROM pt_clients c
            LEFT JOIN l ON l.client_id = c.id
            LEFT JOIN i ON i.client_id = c.id
           WHERE c.organization_id = ANY($1::uuid[]) AND c.deleted_at IS NULL`,
  },
  {
    id: 'D10', field: 'Sleep hours', owner: 'Lifestyle',
    copies: 'Interview, PAR-Q',
    note: 'Numeric comparison with a 0.25h tolerance.',
    sql: `WITH l AS (${LATEST.lifestyle}), i AS (${LATEST.interview})
          SELECT count(*) FILTER (WHERE l.sleep_duration_hours IS NOT NULL)::int AS owner_present,
                 count(*) FILTER (WHERE l.sleep_duration_hours IS NULL AND i.lifestyle_sleep_hours IS NOT NULL)::int AS legacy_only,
                 count(*) FILTER (WHERE l.sleep_duration_hours IS NOT NULL AND i.lifestyle_sleep_hours IS NOT NULL
                                    AND abs(l.sleep_duration_hours - i.lifestyle_sleep_hours) > 0.25)::int AS conflict,
                 count(*) FILTER (WHERE l.assessment_date < CURRENT_DATE - ${STALE_AFTER_DAYS})::int AS stale
            FROM pt_clients c
            LEFT JOIN l ON l.client_id = c.id
            LEFT JOIN i ON i.client_id = c.id
           WHERE c.organization_id = ANY($1::uuid[]) AND c.deleted_at IS NULL`,
  },
  {
    id: 'D11', field: 'Smoking', owner: 'Lifestyle',
    copies: 'Interview, PAR-Q',
    note: 'Same vocabulary.',
    sql: `WITH l AS (${LATEST.lifestyle}), i AS (${LATEST.interview})
          SELECT count(*) FILTER (WHERE l.smoking_status IS NOT NULL)::int AS owner_present,
                 count(*) FILTER (WHERE l.smoking_status IS NULL AND i.lifestyle_smoking IS NOT NULL)::int AS legacy_only,
                 count(*) FILTER (WHERE l.smoking_status IS NOT NULL AND i.lifestyle_smoking IS NOT NULL
                                    AND l.smoking_status <> i.lifestyle_smoking)::int AS conflict,
                 count(*) FILTER (WHERE l.assessment_date < CURRENT_DATE - ${STALE_AFTER_DAYS})::int AS stale
            FROM pt_clients c
            LEFT JOIN l ON l.client_id = c.id
            LEFT JOIN i ON i.client_id = c.id
           WHERE c.organization_id = ANY($1::uuid[]) AND c.deleted_at IS NULL`,
  },
  {
    id: 'D12', field: 'Alcohol', owner: 'Lifestyle',
    copies: 'Interview, PAR-Q, Nutrition',
    note: 'Nutrition weekly quantity is a different shape; counted only as a copy when it contradicts "never".',
    sql: `WITH l AS (${LATEST.lifestyle}), i AS (${LATEST.interview}), n AS (${LATEST.nutrition})
          SELECT count(*) FILTER (WHERE l.alcohol_status IS NOT NULL)::int AS owner_present,
                 count(*) FILTER (WHERE l.alcohol_status IS NULL
                                    AND (i.lifestyle_alcohol IS NOT NULL OR n.alcoholic_drinks_per_week IS NOT NULL))::int AS legacy_only,
                 count(*) FILTER (WHERE l.alcohol_status IS NOT NULL AND (
                        (i.lifestyle_alcohol IS NOT NULL AND i.lifestyle_alcohol <> l.alcohol_status)
                     OR (l.alcohol_status = 'never' AND n.alcoholic_drinks_per_week > 0)))::int AS conflict,
                 count(*) FILTER (WHERE l.assessment_date < CURRENT_DATE - ${STALE_AFTER_DAYS})::int AS stale
            FROM pt_clients c
            LEFT JOIN l ON l.client_id = c.id
            LEFT JOIN i ON i.client_id = c.id
            LEFT JOIN n ON n.client_id = c.id
           WHERE c.organization_id = ANY($1::uuid[]) AND c.deleted_at IS NULL`,
  },
  {
    id: 'D13', field: 'Water intake', owner: 'Nutrition',
    copies: 'Lifestyle, PAR-Q',
    note: '0.25L tolerance.',
    sql: `WITH n AS (${LATEST.nutrition}), l AS (${LATEST.lifestyle})
          SELECT count(*) FILTER (WHERE n.water_intake_liters IS NOT NULL)::int AS owner_present,
                 count(*) FILTER (WHERE n.water_intake_liters IS NULL AND l.water_intake_liters IS NOT NULL)::int AS legacy_only,
                 count(*) FILTER (WHERE n.water_intake_liters IS NOT NULL AND l.water_intake_liters IS NOT NULL
                                    AND abs(n.water_intake_liters - l.water_intake_liters) > 0.25)::int AS conflict,
                 count(*) FILTER (WHERE n.assessment_date < CURRENT_DATE - ${STALE_AFTER_DAYS})::int AS stale
            FROM pt_clients c
            LEFT JOIN n ON n.client_id = c.id
            LEFT JOIN l ON l.client_id = c.id
           WHERE c.organization_id = ANY($1::uuid[]) AND c.deleted_at IS NULL`,
  },
  {
    id: 'D14', field: 'Meal frequency', owner: 'Nutrition',
    copies: 'Lifestyle',
    note: 'Meals per day vs the Lifestyle frequency bucket.',
    sql: `WITH n AS (${LATEST.nutrition}), l AS (${LATEST.lifestyle})
          SELECT count(*) FILTER (WHERE n.meals_per_day IS NOT NULL)::int AS owner_present,
                 count(*) FILTER (WHERE n.meals_per_day IS NULL AND l.meal_frequency IS NOT NULL)::int AS legacy_only,
                 count(*) FILTER (WHERE n.meals_per_day IS NOT NULL AND l.meal_frequency IS NOT NULL
                                    AND n.meals_per_day <> l.meal_frequency)::int AS conflict,
                 count(*) FILTER (WHERE n.assessment_date < CURRENT_DATE - ${STALE_AFTER_DAYS})::int AS stale
            FROM pt_clients c
            LEFT JOIN n ON n.client_id = c.id
            LEFT JOIN l ON l.client_id = c.id
           WHERE c.organization_id = ANY($1::uuid[]) AND c.deleted_at IS NULL`,
  },
  {
    id: 'D15', field: 'Meal regularity', owner: 'Interview',
    copies: 'Nutrition meal_timing_consistency',
    note: 'Vocabulary mapped before comparing: regular≈consistent, irregular≈inconsistent, inconsistent≈somewhat_consistent.',
    sql: `WITH i AS (${LATEST.interview}), n AS (${LATEST.nutrition})
          SELECT count(*) FILTER (WHERE i.lifestyle_meal_regularity IS NOT NULL)::int AS owner_present,
                 count(*) FILTER (WHERE i.lifestyle_meal_regularity IS NULL AND n.meal_timing_consistency IS NOT NULL)::int AS legacy_only,
                 count(*) FILTER (WHERE i.lifestyle_meal_regularity IS NOT NULL AND n.meal_timing_consistency IS NOT NULL
                   AND (CASE i.lifestyle_meal_regularity WHEN 'regular' THEN 'consistent'
                                                        WHEN 'irregular' THEN 'inconsistent'
                                                        WHEN 'inconsistent' THEN 'somewhat_consistent' END)
                       <> n.meal_timing_consistency)::int AS conflict,
                 0 AS stale
            FROM pt_clients c
            LEFT JOIN i ON i.client_id = c.id
            LEFT JOIN n ON n.client_id = c.id
           WHERE c.organization_id = ANY($1::uuid[]) AND c.deleted_at IS NULL`,
  },
  {
    id: 'D16', field: 'Food preferences', owner: 'Nutrition',
    copies: 'Lifestyle',
    note: 'Order-insensitive array comparison.',
    sql: `WITH n AS (${LATEST.nutrition}), l AS (${LATEST.lifestyle})
          SELECT count(*) FILTER (WHERE coalesce(array_length(n.diet_preferences, 1), 0) > 0)::int AS owner_present,
                 count(*) FILTER (WHERE coalesce(array_length(n.diet_preferences, 1), 0) = 0
                                    AND coalesce(array_length(l.food_preferences, 1), 0) > 0)::int AS legacy_only,
                 count(*) FILTER (WHERE coalesce(array_length(n.diet_preferences, 1), 0) > 0
                                    AND coalesce(array_length(l.food_preferences, 1), 0) > 0
                                    AND (SELECT array_agg(x ORDER BY x) FROM unnest(n.diet_preferences) x)
                                     IS DISTINCT FROM
                                        (SELECT array_agg(x ORDER BY x) FROM unnest(l.food_preferences) x))::int AS conflict,
                 count(*) FILTER (WHERE n.assessment_date < CURRENT_DATE - ${STALE_AFTER_DAYS})::int AS stale
            FROM pt_clients c
            LEFT JOIN n ON n.client_id = c.id
            LEFT JOIN l ON l.client_id = c.id
           WHERE c.organization_id = ANY($1::uuid[]) AND c.deleted_at IS NULL`,
  },
  {
    id: 'D17', field: 'Training days', owner: 'Interview (availability) / Goal (prescription)',
    copies: 'pt_clients.sessions_per_week (enrolment fallback)',
    note: 'Three different facts by design. A difference is not a defect; the count is how often they diverge.',
    sql: `WITH i AS (${LATEST.interview}), g AS (${LATEST.goal})
          SELECT count(*) FILTER (WHERE i.lifestyle_training_days IS NOT NULL
                                     OR g.training_days_per_week IS NOT NULL)::int AS owner_present,
                 count(*) FILTER (WHERE i.lifestyle_training_days IS NULL
                                    AND g.training_days_per_week IS NULL
                                    AND c.sessions_per_week IS NOT NULL)::int AS legacy_only,
                 count(*) FILTER (WHERE c.sessions_per_week IS NOT NULL AND (
                        (i.lifestyle_training_days IS NOT NULL AND i.lifestyle_training_days <> c.sessions_per_week)
                     OR (g.training_days_per_week IS NOT NULL AND g.training_days_per_week <> c.sessions_per_week)))::int AS conflict,
                 0 AS stale
            FROM pt_clients c
            LEFT JOIN i ON i.client_id = c.id
            LEFT JOIN g ON g.client_id = c.id
           WHERE c.organization_id = ANY($1::uuid[]) AND c.deleted_at IS NULL`,
  },
  {
    id: 'D18', field: 'Sit-and-reach', owner: 'Fitness Testing',
    copies: 'Mobility sit_reach_cm',
    note: 'Inches (scored) vs cm (unscored); not mechanically comparable, so conflict is not counted.',
    sql: `WITH m AS (${LATEST.mobility})
          SELECT count(*) FILTER (WHERE a.flexibility_test_data IS NOT NULL)::int AS owner_present,
                 count(*) FILTER (WHERE m.sit_reach_cm IS NOT NULL)::int AS legacy_only,
                 0 AS conflict,
                 count(*) FILTER (WHERE m.assessment_date < CURRENT_DATE - ${STALE_AFTER_DAYS})::int AS stale
            FROM pt_clients c
            LEFT JOIN m ON m.client_id = c.id
            LEFT JOIN LATERAL (
              SELECT flexibility_test_data FROM pt_assessments
               WHERE client_id = c.id ORDER BY assessment_date DESC NULLS LAST, created_at DESC LIMIT 1
            ) a ON TRUE
           WHERE c.organization_id = ANY($1::uuid[]) AND c.deleted_at IS NULL`,
  },
  {
    id: 'D19', field: '1RM', owner: 'Fitness Testing / Strength Tracking',
    copies: 'strength_logs (assessment-linked and free-standing)',
    note: 'One formula, row ownership by assessment_id. Conflict = same client, exercise and day with a different estimate.',
    sql: `WITH g AS (
            SELECT client_id, exercise_name, log_date, count(DISTINCT one_rm_estimate) AS n
              FROM strength_logs WHERE organization_id = ANY($1::uuid[])
             GROUP BY 1, 2, 3
          )
          SELECT (SELECT count(*) FROM strength_logs
                   WHERE organization_id = ANY($1::uuid[]) AND assessment_id IS NOT NULL)::int AS owner_present,
                 (SELECT count(*) FROM strength_logs
                   WHERE organization_id = ANY($1::uuid[]) AND assessment_id IS NULL)::int AS legacy_only,
                 (SELECT count(*) FROM g WHERE n > 1)::int AS conflict,
                 0 AS stale`,
  },
  {
    id: 'D20', field: 'Consent attestations', owner: 'Informed Consent',
    copies: 'pt_consent_records (PAR-Q, 7 historical keys)',
    note: 'Seven old keys vs ten new keys coexist as history; both are readable.',
    sql: `SELECT (SELECT count(*) FROM pt_informed_consents WHERE organization_id = ANY($1::uuid[]))::int AS owner_present,
                 (SELECT count(*) FROM pt_consent_records WHERE organization_id = ANY($1::uuid[])
                   AND (SELECT count(*) FROM jsonb_object_keys(coalesce(consent_checkboxes, '{}'::jsonb))) <= 7)::int AS legacy_only,
                 (SELECT count(DISTINCT c.id) FROM pt_clients c
                    JOIN pt_informed_consents ic ON ic.client_id = c.id
                    JOIN pt_consent_records cr ON cr.client_id = c.id
                   WHERE c.organization_id = ANY($1::uuid[]))::int AS conflict,
                 0 AS stale`,
  },
  {
    id: 'D21', field: 'Medical clearance', owner: 'PAR-Q gate + Consent physician block',
    copies: 'Two distinct gates, both shown in the snapshot',
    note: 'A client can be PAR-Q cleared and still have a physician objection. Both-present is the safety case, not a duplicate.',
    sql: `WITH q AS (${LATEST.parq})
          SELECT count(*) FILTER (WHERE q.workout_gate_status = 'blocked')::int AS owner_present,
                 count(*) FILTER (WHERE ic.physician_advised_against)::int AS legacy_only,
                 count(*) FILTER (WHERE q.workout_gate_status = 'blocked' AND ic.physician_advised_against)::int AS conflict,
                 0 AS stale
            FROM pt_clients c
            LEFT JOIN q ON q.client_id = c.id
            LEFT JOIN LATERAL (
              SELECT physician_advised_against FROM pt_informed_consents
               WHERE client_id = c.id ORDER BY created_at DESC LIMIT 1
            ) ic ON TRUE
           WHERE c.organization_id = ANY($1::uuid[]) AND c.deleted_at IS NULL`,
  },
  {
    id: 'D22', field: 'Workout experience in programming', owner: 'client-facts precedence',
    copies: 'pt_clients, client_fitness_profiles, Lifestyle',
    note: 'Same rows as D7; listed separately because the generator resolves all three.',
    sql: `WITH l AS (${LATEST.lifestyle})
          SELECT count(*) FILTER (WHERE c.workout_experience_level IS NOT NULL
                                     OR p.fitness_level IS NOT NULL
                                     OR l.workout_experience_level IS NOT NULL)::int AS owner_present,
                 0 AS legacy_only,
                 count(*) FILTER (WHERE c.workout_experience_level IS NOT NULL
                                    AND p.fitness_level IS NOT NULL
                                    AND c.workout_experience_level <> p.fitness_level)::int AS conflict,
                 0 AS stale
            FROM pt_clients c
            LEFT JOIN l ON l.client_id = c.id
            LEFT JOIN client_fitness_profiles p ON p.client_id = c.id
           WHERE c.organization_id = ANY($1::uuid[]) AND c.deleted_at IS NULL`,
  },
  {
    id: 'D23', field: 'Medical conditions in Nutrition', owner: 'PAR-Q',
    copies: 'pt_nutrition_assessments.medical_conditions',
    note: 'Owner is submitted/reviewed only; a draft falls through to the legacy list (Phase 3 fix).',
    sql: `WITH q AS (${LATEST.parqMedical}), n AS (${LATEST.nutrition})
          SELECT count(*) FILTER (WHERE q.current_health <> '{}'::jsonb)::int AS owner_present,
                 count(*) FILTER (WHERE (q.id IS NULL OR q.current_health = '{}'::jsonb)
                                    AND coalesce(array_length(n.medical_conditions, 1), 0) > 0)::int AS legacy_only,
                 count(*) FILTER (WHERE q.current_health <> '{}'::jsonb
                                    AND coalesce(array_length(n.medical_conditions, 1), 0) > 0)::int AS conflict,
                 count(*) FILTER (WHERE q.assessment_date < CURRENT_DATE - ${STALE_AFTER_DAYS})::int AS stale
            FROM pt_clients c
            LEFT JOIN q ON q.client_id = c.id
            LEFT JOIN n ON n.client_id = c.id
           WHERE c.organization_id = ANY($1::uuid[]) AND c.deleted_at IS NULL`,
  },
  {
    id: 'D24', field: 'pt_clients.occupation', owner: 'Lifestyle',
    copies: 'Add Client, Interview, PAR-Q, consent snapshot',
    note: 'Same rows as D8, client leg only: the column still readable, no new writes.',
    sql: `WITH l AS (${LATEST.lifestyle})
          SELECT count(*) FILTER (WHERE l.occupation_type IS NOT NULL)::int AS owner_present,
                 count(*) FILTER (WHERE l.occupation_type IS NULL AND c.occupation IS NOT NULL)::int AS legacy_only,
                 count(*) FILTER (WHERE l.occupation_type IS NOT NULL AND c.occupation IS NOT NULL
                                    AND l.occupation_type <> c.occupation)::int AS conflict,
                 0 AS stale
            FROM pt_clients c
            LEFT JOIN l ON l.client_id = c.id
           WHERE c.organization_id = ANY($1::uuid[]) AND c.deleted_at IS NULL`,
  },
  {
    id: 'D25', field: 'Motivation to exercise', owner: 'Goal',
    copies: 'Lifestyle motivation_to_exercise',
    note: '1–10 score; difference of 2 or more is treated as a conflict (rounding is not disagreement).',
    sql: `WITH g AS (${LATEST.goal}), l AS (${LATEST.lifestyle})
          SELECT count(*) FILTER (WHERE g.motivation_level IS NOT NULL)::int AS owner_present,
                 count(*) FILTER (WHERE g.motivation_level IS NULL AND l.motivation_to_exercise IS NOT NULL)::int AS legacy_only,
                 count(*) FILTER (WHERE g.motivation_level IS NOT NULL AND l.motivation_to_exercise IS NOT NULL
                                    AND abs(g.motivation_level - l.motivation_to_exercise) >= 2)::int AS conflict,
                 0 AS stale
            FROM pt_clients c
            LEFT JOIN g ON g.client_id = c.id
            LEFT JOIN l ON l.client_id = c.id
           WHERE c.organization_id = ANY($1::uuid[]) AND c.deleted_at IS NULL`,
  },
];

async function main() {
  const db = new Client({ connectionString: URL_ARG });
  await db.connect();
  // The hard guarantee that this script cannot mutate anything.
  await db.query('BEGIN TRANSACTION READ ONLY');
  // A read-only audit must not pin a production replica while a query plans
  // badly. One minute per check is generous for an index-backed count.
  await db.query("SET LOCAL statement_timeout = '60s'");

  let orgs = null;
  if (ORG_FILTER) {
    orgs = [ORG_FILTER];
  } else {
    const { rows } = await db.query(
      'SELECT DISTINCT organization_id AS id FROM pt_clients WHERE organization_id IS NOT NULL ORDER BY 1',
    );
    orgs = rows.map((r) => r.id);
  }

  const results = [];
  for (const check of CHECKS) {
    if (process.env.PHASE4_AUDIT_VERBOSE) console.error(`check ${check.id}...`);
    // One broken check must not abort the other 24. A savepoint keeps the
    // read-only transaction alive so the table is always complete.
    await db.query('SAVEPOINT audit_check');
    try {
      const { rows } = await db.query(check.sql, [orgs]);
      await db.query('RELEASE SAVEPOINT audit_check');
      results.push({ ...check, sql: undefined, ...rows[0] });
    } catch (err) {
      await db.query('ROLLBACK TO SAVEPOINT audit_check');
      results.push({ ...check, sql: undefined, error: err.message });
    }
  }

  await db.query('ROLLBACK');

  const lines = [];
  lines.push('# D1–D25 ownership audit');
  lines.push('');
  lines.push(`Database: \`${new URL(URL_ARG).host}${new URL(URL_ARG).pathname}\``);
  lines.push(`Organizations: ${orgs.length} (${orgs.join(', ')})`);
  lines.push(`Staleness threshold: ${STALE_AFTER_DAYS} days`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('| # | Data point | Owner | Owner present | Legacy-only | Conflict | Stale | Note |');
  lines.push('|---|---|---|---:|---:|---:|---:|---|');
  const totals = { owner_present: 0, legacy_only: 0, conflict: 0, stale: 0 };
  for (const r of results) {
    if (r.error) {
      lines.push(`| ${r.id} | ${r.field} | ${r.owner} | — | — | — | — | **QUERY FAILED: ${r.error}** |`);
      continue;
    }
    totals.owner_present += r.owner_present || 0;
    totals.legacy_only += r.legacy_only || 0;
    totals.conflict += r.conflict || 0;
    totals.stale += r.stale || 0;
    lines.push(`| ${r.id} | ${r.field} | ${r.owner} | ${r.owner_present ?? 0} | ${r.legacy_only ?? 0} | ${r.conflict ?? 0} | ${r.stale ?? 0} | ${r.note} |`);
  }
  lines.push('');
  lines.push(`**Totals across ${results.length} duplicate registers:** owner present ${totals.owner_present}, legacy-only ${totals.legacy_only}, conflicting ${totals.conflict}, stale ${totals.stale}.`);
  lines.push('');
  lines.push('`conflict` means both records hold a value and they disagree. Old rows written before the ownership move are expected to appear here; it measures cleanup size, not a live defect.');

  const markdown = lines.join('\n');
  console.log(markdown);

  await db.end();

  if (JSON_OUT) {
    require('fs').writeFileSync(JSON_OUT, JSON.stringify({
      database: new URL(URL_ARG).host + new URL(URL_ARG).pathname,
      organizations: orgs,
      stale_after_days: STALE_AFTER_DAYS,
      generated_at: new Date().toISOString(),
      totals,
      results,
    }, null, 2));
    console.error(`\nJSON written to ${JSON_OUT}`);
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err.stack || err.message);
      process.exit(1);
    });
}

module.exports = { CHECKS, LATEST, STALE_AFTER_DAYS };
