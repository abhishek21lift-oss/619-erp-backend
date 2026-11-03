#!/usr/bin/env node
'use strict';
// Phase 5 — field-level reconciliation report for the D1–D25 duplicate registers.
//
// Read-only by construction: the whole run is one `BEGIN TRANSACTION READ ONLY`.
// It answers the question Phase 4 only counted: for every legacy-only row and
// every conflict, what are the two values, which record and date does each come
// from, and what should a reviewer do next?
//
// It never writes an owner record. The only output that can lead to a write is
// a separate plan file consumed by phase5-apply-reconciliation.js, and only
// for the narrow case where the owner row already exists, the owner field is
// still NULL, and exactly one legacy source supplies a value. Conflicts are
// always review-only.
//
//   node scripts/phase5-reconcile-ownership.js --url ... --json report.json \
//        --md report.md --plan plan.json --csv review.csv
//
// Exit codes: 0 report written, 1 query/runtime failure, 2 bad arguments.

const { Client } = require('pg');
const fs = require('fs');
const { CHECKS: AGGREGATE_CHECKS } = require('./phase4-audit-ownership');

const STALE_AFTER_DAYS = 365;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const URL_ARG = arg('url') || process.env.DATABASE_URL || process.env.PHASE4_SHAPE_DATABASE_URL;
const JSON_OUT = arg('json');
const MD_OUT = arg('md');
const PLAN_OUT = arg('plan');
const CSV_OUT = arg('csv');
const ORG_FILTER = arg('org');

if (!URL_ARG) {
  console.error('No database. Set DATABASE_URL / PHASE4_SHAPE_DATABASE_URL or pass --url.');
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

const DETAILS = [
  {
    id: 'D1', field: 'Client identity at signing', owner: 'Consent / PAR-Q snapshot',
    copies: 'pt_clients', recommendation: 'none',
    note: 'A snapshot is the identity on the signing date. Drift is history, not a duplicate to merge.',
    sql: `WITH s AS (
            SELECT 'pt_parq_forms'::text AS src, id, client_id, full_name, dob, mobile, created_at
              FROM pt_parq_forms WHERE deleted_at IS NULL
            UNION ALL
            SELECT 'pt_informed_consents', id, client_id, full_name, dob, mobile, created_at
              FROM pt_informed_consents)
          SELECT 'conflict'::text AS status, c.id AS client_id, c.name AS client_name, c.organization_id,
                 s.src AS owner_table, s.id AS owner_record_id, s.created_at AS owner_recorded_at,
                 jsonb_build_object('full_name', s.full_name, 'dob', s.dob, 'mobile', s.mobile) AS owner_value,
                 false AS owner_field_null,
                 'pt_clients'::text AS legacy_table, c.id AS legacy_record_id, c.updated_at AS legacy_recorded_at,
                 jsonb_build_object('name', c.name, 'dob', c.dob, 'mobile', c.mobile) AS legacy_value
            FROM s JOIN pt_clients c ON c.id = s.client_id
           WHERE c.organization_id = ANY($1::uuid[])
             AND (s.full_name IS DISTINCT FROM c.name
               OR (s.mobile IS NOT NULL AND s.mobile <> c.mobile)
               OR (s.dob IS NOT NULL AND s.dob::text <> c.dob::text))`,
  },
  {
    id: 'D2', field: 'Emergency contact / phone', owner: 'Consent / PAR-Q snapshot',
    copies: 'pt_clients', recommendation: 'none',
    note: 'Same snapshot rule as D1.',
    sql: `WITH s AS (
            SELECT 'pt_parq_forms'::text AS src, id, client_id, emergency_contact, emergency_phone, created_at
              FROM pt_parq_forms WHERE deleted_at IS NULL
            UNION ALL
            SELECT 'pt_informed_consents', id, client_id, emergency_contact, emergency_phone, created_at
              FROM pt_informed_consents)
          SELECT 'conflict'::text AS status, c.id AS client_id, c.name AS client_name, c.organization_id,
                 s.src AS owner_table, s.id AS owner_record_id, s.created_at AS owner_recorded_at,
                 jsonb_build_object('emergency_contact', s.emergency_contact, 'emergency_phone', s.emergency_phone) AS owner_value,
                 false AS owner_field_null,
                 'pt_clients'::text AS legacy_table, c.id AS legacy_record_id, c.updated_at AS legacy_recorded_at,
                 jsonb_build_object('emergency_contact', c.emergency_contact, 'emergency_phone', c.emergency_phone) AS legacy_value
            FROM s JOIN pt_clients c ON c.id = s.client_id
           WHERE c.organization_id = ANY($1::uuid[])
             AND ((s.emergency_contact IS NOT NULL AND s.emergency_contact <> c.emergency_contact)
               OR (s.emergency_phone IS NOT NULL AND s.emergency_phone <> c.emergency_phone))`,
  },
  {
    id: 'D3', field: 'Height / weight / BMI', owner: 'Fitness Testing',
    copies: 'pt_clients cache', recommendation: 'manual_review',
    note: 'Never overwrite a fitness test from the client cache. A missing test is recorded by the trainer, not fabricated here.',
    sql: `WITH a AS (${LATEST.assessment})
          SELECT CASE WHEN a.id IS NULL THEN 'legacy_only' ELSE 'conflict' END AS status,
                 c.id AS client_id, c.name AS client_name, c.organization_id,
                 'pt_assessments'::text AS owner_table, a.id AS owner_record_id,
                 COALESCE(a.assessment_date::timestamptz, a.created_at) AS owner_recorded_at,
                 jsonb_build_object('weight', a.weight, 'height_cm', a.height_cm) AS owner_value,
                 false AS owner_field_null,
                 'pt_clients'::text AS legacy_table, c.id AS legacy_record_id, c.updated_at AS legacy_recorded_at,
                 jsonb_build_object('weight', c.weight, 'height', c.height) AS legacy_value
            FROM pt_clients c LEFT JOIN a ON a.client_id = c.id
           WHERE c.organization_id = ANY($1::uuid[]) AND c.deleted_at IS NULL
             AND ((a.id IS NULL AND (c.weight IS NOT NULL OR c.height IS NOT NULL))
               OR (a.height_cm IS NOT NULL AND c.height IS NOT NULL AND c.height <> a.height_cm)
               OR (a.weight IS NOT NULL AND c.weight IS NOT NULL AND c.weight <> a.weight))`,
  },
  {
    id: 'D4', field: 'Goal', owner: 'Goal Assessment',
    copies: 'pt_clients.goal, client_fitness_profiles.goal', recommendation: 'manual_review',
    note: 'Vocabulary and active-goal selection are coaching decisions; the old enum is not mechanically expanded.',
    sql: `WITH g AS (${LATEST.goal})
          SELECT CASE WHEN g.id IS NULL THEN 'legacy_only' ELSE 'conflict' END AS status,
                 c.id AS client_id, c.name AS client_name, c.organization_id,
                 'pt_goals'::text AS owner_table, g.id AS owner_record_id, g.created_at AS owner_recorded_at,
                 jsonb_build_object('goal_type', g.goal_type, 'priority_goal', g.priority_goal) AS owner_value,
                 false AS owner_field_null,
                 'pt_clients + client_fitness_profiles'::text AS legacy_table, c.id AS legacy_record_id,
                 GREATEST(c.updated_at, p.updated_at) AS legacy_recorded_at,
                 jsonb_build_object('pt_clients.goal', c.goal, 'fitness_profile.goal', p.goal) AS legacy_value
            FROM pt_clients c
            LEFT JOIN g ON g.client_id = c.id
            LEFT JOIN client_fitness_profiles p ON p.client_id = c.id
           WHERE c.organization_id = ANY($1::uuid[]) AND c.deleted_at IS NULL
             AND ((g.id IS NULL AND (c.goal IS NOT NULL OR p.goal IS NOT NULL))
               OR (g.goal_type IS NOT NULL AND (
                     (c.goal IS NOT NULL AND c.goal <> g.goal_type)
                  OR (p.goal IS NOT NULL AND p.goal <> g.goal_type))))`,
  },
  {
    id: 'D5', field: 'Health conditions', owner: 'PAR-Q',
    copies: 'pt_clients, Nutrition, fitness profile', recommendation: 'manual_review',
    note: 'Free-text conditions cannot be mapped into the structured PAR-Q without a clinician reading them.',
    sql: `WITH q AS (${LATEST.parq}), n AS (${LATEST.nutrition})
          SELECT CASE WHEN q.id IS NULL OR (q.current_health = '{}'::jsonb AND q.past_history = '{}'::jsonb)
                      THEN 'legacy_only' ELSE 'conflict' END AS status,
                 c.id AS client_id, c.name AS client_name, c.organization_id,
                 'pt_parq_forms'::text AS owner_table, q.id AS owner_record_id,
                 COALESCE(q.assessment_date::timestamptz, q.created_at) AS owner_recorded_at,
                 jsonb_build_object('current_health', q.current_health, 'past_history', q.past_history) AS owner_value,
                 (q.id IS NOT NULL AND q.current_health = '{}'::jsonb AND q.past_history = '{}'::jsonb) AS owner_field_null,
                 'pt_clients + pt_nutrition_assessments + client_fitness_profiles'::text AS legacy_table,
                 c.id AS legacy_record_id, GREATEST(c.updated_at, n.updated_at, p.updated_at) AS legacy_recorded_at,
                 jsonb_build_object('pt_clients.health_conditions', c.health_conditions,
                                    'nutrition.medical_conditions', n.medical_conditions,
                                    'fitness_profile.health_conditions', p.health_conditions) AS legacy_value
            FROM pt_clients c
            LEFT JOIN q ON q.client_id = c.id
            LEFT JOIN n ON n.client_id = c.id
            LEFT JOIN client_fitness_profiles p ON p.client_id = c.id
           WHERE c.organization_id = ANY($1::uuid[]) AND c.deleted_at IS NULL
             AND (((q.id IS NULL OR (q.current_health = '{}'::jsonb AND q.past_history = '{}'::jsonb))
                   AND (c.health_conditions IS NOT NULL
                     OR coalesce(array_length(n.medical_conditions, 1), 0) > 0
                     OR coalesce(array_length(p.health_conditions, 1), 0) > 0))
               OR ((q.current_health <> '{}'::jsonb OR q.past_history <> '{}'::jsonb)
                   AND (c.health_conditions IS NOT NULL
                     OR coalesce(array_length(n.medical_conditions, 1), 0) > 0)))`,
  },
  {
    id: 'D6', field: 'Injuries', owner: 'PAR-Q history / Interview current',
    copies: 'pt_clients.injuries', recommendation: 'none',
    note: 'PAR-Q history and the interview narrative are different facts with different dates. Keep both.',
    sql: `WITH q AS (${LATEST.parq}), i AS (${LATEST.interview})
          SELECT CASE WHEN q.past_history->>'previous_injuries' IS NULL AND i.pain_and_injuries IS NULL
                      THEN 'legacy_only' ELSE 'conflict' END AS status,
                 c.id AS client_id, c.name AS client_name, c.organization_id,
                 CASE WHEN q.past_history->>'previous_injuries' IS NOT NULL THEN 'pt_parq_forms'
                      WHEN i.pain_and_injuries IS NOT NULL THEN 'pt_client_interviews'
                      ELSE NULL END::text AS owner_table,
                 CASE WHEN q.past_history->>'previous_injuries' IS NOT NULL THEN q.id
                      WHEN i.pain_and_injuries IS NOT NULL THEN i.id ELSE NULL END AS owner_record_id,
                 CASE WHEN q.past_history->>'previous_injuries' IS NOT NULL
                      THEN COALESCE(q.assessment_date::timestamptz, q.created_at)
                      ELSE COALESCE(i.completed_at, i.created_at) END AS owner_recorded_at,
                 jsonb_build_object('parq_previous_injuries', q.past_history->>'previous_injuries',
                                    'interview_pain_and_injuries', i.pain_and_injuries) AS owner_value,
                 false AS owner_field_null,
                 'pt_clients'::text AS legacy_table, c.id AS legacy_record_id, c.updated_at AS legacy_recorded_at,
                 jsonb_build_object('injuries', c.injuries) AS legacy_value
            FROM pt_clients c
            LEFT JOIN q ON q.client_id = c.id
            LEFT JOIN i ON i.client_id = c.id
           WHERE c.organization_id = ANY($1::uuid[]) AND c.deleted_at IS NULL
             AND ((q.past_history->>'previous_injuries' IS NULL AND i.pain_and_injuries IS NULL AND c.injuries IS NOT NULL)
               OR (c.injuries IS NOT NULL AND (q.past_history->>'previous_injuries' IS NOT NULL
                                            OR i.pain_and_injuries IS NOT NULL)))`,
  },
  {
    id: 'D7', field: 'Workout experience', owner: 'Add Client / enrolment',
    copies: 'pt_lifestyle_assessments, client_fitness_profiles', recommendation: 'manual_review',
    note: 'The three vocabularies are not identical. The trainer confirms the enrolment value.',
    sql: `WITH l AS (${LATEST.lifestyle})
          SELECT CASE WHEN c.workout_experience_level IS NULL THEN 'legacy_only' ELSE 'conflict' END AS status,
                 c.id AS client_id, c.name AS client_name, c.organization_id,
                 'pt_clients'::text AS owner_table, c.id AS owner_record_id, c.updated_at AS owner_recorded_at,
                 jsonb_build_object('workout_experience_level', c.workout_experience_level) AS owner_value,
                 (c.workout_experience_level IS NULL) AS owner_field_null,
                 'pt_lifestyle_assessments + client_fitness_profiles'::text AS legacy_table,
                 COALESCE(l.id, p.id) AS legacy_record_id, GREATEST(l.updated_at, p.updated_at) AS legacy_recorded_at,
                 jsonb_build_object('lifestyle.workout_experience_level', l.workout_experience_level,
                                    'fitness_profile.fitness_level', p.fitness_level) AS legacy_value
            FROM pt_clients c
            LEFT JOIN l ON l.client_id = c.id
            LEFT JOIN client_fitness_profiles p ON p.client_id = c.id
           WHERE c.organization_id = ANY($1::uuid[]) AND c.deleted_at IS NULL
             AND ((c.workout_experience_level IS NULL
                   AND (l.workout_experience_level IS NOT NULL OR p.fitness_level IS NOT NULL))
               OR (c.workout_experience_level IS NOT NULL AND (
                     (l.workout_experience_level IS NOT NULL AND l.workout_experience_level <> c.workout_experience_level)
                  OR (p.fitness_level IS NOT NULL AND p.fitness_level <> c.workout_experience_level))))`,
  },
  {
    id: 'D8', field: 'Occupation', owner: 'Lifestyle',
    copies: 'pt_clients, Interview', recommendation: 'manual_review',
    note: 'Backfill only when an owner row exists, its field is NULL, and exactly one legacy source supplies a value.',
    sql: `WITH l AS (${LATEST.lifestyle}), i AS (${LATEST.interview})
          SELECT CASE WHEN l.occupation_type IS NULL THEN 'legacy_only' ELSE 'conflict' END AS status,
                 c.id AS client_id, c.name AS client_name, c.organization_id,
                 'pt_lifestyle_assessments'::text AS owner_table, l.id AS owner_record_id,
                 COALESCE(l.assessment_date::timestamptz, l.created_at) AS owner_recorded_at,
                 jsonb_build_object('occupation_type', l.occupation_type) AS owner_value,
                 (l.id IS NOT NULL AND l.occupation_type IS NULL) AS owner_field_null,
                 'pt_clients + pt_client_interviews'::text AS legacy_table, c.id AS legacy_record_id,
                 GREATEST(c.updated_at, i.updated_at) AS legacy_recorded_at,
                 jsonb_build_object('client_occupation', c.occupation,
                                    'interview_occupation', i.lifestyle_occupation) AS legacy_value
            FROM pt_clients c
            LEFT JOIN l ON l.client_id = c.id
            LEFT JOIN i ON i.client_id = c.id
           WHERE c.organization_id = ANY($1::uuid[]) AND c.deleted_at IS NULL
             AND ((l.occupation_type IS NULL AND (c.occupation IS NOT NULL OR i.lifestyle_occupation IS NOT NULL))
               OR (l.occupation_type IS NOT NULL AND (
                     (c.occupation IS NOT NULL AND c.occupation <> l.occupation_type)
                  OR (i.lifestyle_occupation IS NOT NULL AND i.lifestyle_occupation <> l.occupation_type))))`,
  },
  {
    id: 'D9', field: 'Screen time', owner: 'Lifestyle',
    copies: 'Interview', recommendation: 'manual_review',
    note: 'Same bracket vocabulary. Backfill only into an existing owner row with a NULL field.',
    sql: `WITH l AS (${LATEST.lifestyle}), i AS (${LATEST.interview})
          SELECT CASE WHEN l.screen_time_bracket IS NULL THEN 'legacy_only' ELSE 'conflict' END AS status,
                 c.id AS client_id, c.name AS client_name, c.organization_id,
                 'pt_lifestyle_assessments'::text AS owner_table, l.id AS owner_record_id,
                 COALESCE(l.assessment_date::timestamptz, l.created_at) AS owner_recorded_at,
                 jsonb_build_object('screen_time_bracket', l.screen_time_bracket) AS owner_value,
                 (l.id IS NOT NULL AND l.screen_time_bracket IS NULL) AS owner_field_null,
                 'pt_client_interviews'::text AS legacy_table, i.id AS legacy_record_id,
                 i.updated_at AS legacy_recorded_at,
                 jsonb_build_object('interview_screen_time', i.lifestyle_screen_time) AS legacy_value
            FROM pt_clients c
            LEFT JOIN l ON l.client_id = c.id
            LEFT JOIN i ON i.client_id = c.id
           WHERE c.organization_id = ANY($1::uuid[]) AND c.deleted_at IS NULL
             AND ((l.screen_time_bracket IS NULL AND i.lifestyle_screen_time IS NOT NULL)
               OR (l.screen_time_bracket IS NOT NULL AND i.lifestyle_screen_time IS NOT NULL
                   AND l.screen_time_bracket <> i.lifestyle_screen_time))`,
  },
  {
    id: 'D10', field: 'Sleep hours', owner: 'Lifestyle',
    copies: 'Interview', recommendation: 'manual_review',
    note: 'Numeric comparison with a 0.25h tolerance. Backfill only into an existing owner row with a NULL field.',
    sql: `WITH l AS (${LATEST.lifestyle}), i AS (${LATEST.interview})
          SELECT CASE WHEN l.sleep_duration_hours IS NULL THEN 'legacy_only' ELSE 'conflict' END AS status,
                 c.id AS client_id, c.name AS client_name, c.organization_id,
                 'pt_lifestyle_assessments'::text AS owner_table, l.id AS owner_record_id,
                 COALESCE(l.assessment_date::timestamptz, l.created_at) AS owner_recorded_at,
                 jsonb_build_object('sleep_duration_hours', l.sleep_duration_hours) AS owner_value,
                 (l.id IS NOT NULL AND l.sleep_duration_hours IS NULL) AS owner_field_null,
                 'pt_client_interviews'::text AS legacy_table, i.id AS legacy_record_id,
                 i.updated_at AS legacy_recorded_at,
                 jsonb_build_object('interview_sleep_hours', i.lifestyle_sleep_hours) AS legacy_value
            FROM pt_clients c
            LEFT JOIN l ON l.client_id = c.id
            LEFT JOIN i ON i.client_id = c.id
           WHERE c.organization_id = ANY($1::uuid[]) AND c.deleted_at IS NULL
             AND ((l.sleep_duration_hours IS NULL AND i.lifestyle_sleep_hours IS NOT NULL)
               OR (l.sleep_duration_hours IS NOT NULL AND i.lifestyle_sleep_hours IS NOT NULL
                   AND abs(l.sleep_duration_hours - i.lifestyle_sleep_hours) > 0.25))`,
  },
  {
    id: 'D11', field: 'Smoking', owner: 'Lifestyle',
    copies: 'Interview', recommendation: 'manual_review',
    note: 'Same vocabulary. Backfill only into an existing owner row with a NULL field.',
    sql: `WITH l AS (${LATEST.lifestyle}), i AS (${LATEST.interview})
          SELECT CASE WHEN l.smoking_status IS NULL THEN 'legacy_only' ELSE 'conflict' END AS status,
                 c.id AS client_id, c.name AS client_name, c.organization_id,
                 'pt_lifestyle_assessments'::text AS owner_table, l.id AS owner_record_id,
                 COALESCE(l.assessment_date::timestamptz, l.created_at) AS owner_recorded_at,
                 jsonb_build_object('smoking_status', l.smoking_status) AS owner_value,
                 (l.id IS NOT NULL AND l.smoking_status IS NULL) AS owner_field_null,
                 'pt_client_interviews'::text AS legacy_table, i.id AS legacy_record_id,
                 i.updated_at AS legacy_recorded_at,
                 jsonb_build_object('interview_smoking', i.lifestyle_smoking) AS legacy_value
            FROM pt_clients c
            LEFT JOIN l ON l.client_id = c.id
            LEFT JOIN i ON i.client_id = c.id
           WHERE c.organization_id = ANY($1::uuid[]) AND c.deleted_at IS NULL
             AND ((l.smoking_status IS NULL AND i.lifestyle_smoking IS NOT NULL)
               OR (l.smoking_status IS NOT NULL AND i.lifestyle_smoking IS NOT NULL
                   AND l.smoking_status <> i.lifestyle_smoking))`,
  },
  {
    id: 'D12', field: 'Alcohol', owner: 'Lifestyle',
    copies: 'Interview, Nutrition', recommendation: 'manual_review',
    note: 'Only the interview copy has the same vocabulary. Weekly drink counts are a different shape and stay review-only.',
    sql: `WITH l AS (${LATEST.lifestyle}), i AS (${LATEST.interview}), n AS (${LATEST.nutrition})
          SELECT CASE WHEN l.alcohol_status IS NULL THEN 'legacy_only' ELSE 'conflict' END AS status,
                 c.id AS client_id, c.name AS client_name, c.organization_id,
                 'pt_lifestyle_assessments'::text AS owner_table, l.id AS owner_record_id,
                 COALESCE(l.assessment_date::timestamptz, l.created_at) AS owner_recorded_at,
                 jsonb_build_object('alcohol_status', l.alcohol_status) AS owner_value,
                 (l.id IS NOT NULL AND l.alcohol_status IS NULL) AS owner_field_null,
                 'pt_client_interviews + pt_nutrition_assessments'::text AS legacy_table, i.id AS legacy_record_id,
                 GREATEST(i.updated_at, n.updated_at) AS legacy_recorded_at,
                 jsonb_build_object('interview_alcohol', i.lifestyle_alcohol,
                                    'nutrition_drinks_per_week', n.alcoholic_drinks_per_week) AS legacy_value
            FROM pt_clients c
            LEFT JOIN l ON l.client_id = c.id
            LEFT JOIN i ON i.client_id = c.id
            LEFT JOIN n ON n.client_id = c.id
           WHERE c.organization_id = ANY($1::uuid[]) AND c.deleted_at IS NULL
             AND ((l.alcohol_status IS NULL
                   AND (i.lifestyle_alcohol IS NOT NULL OR n.alcoholic_drinks_per_week IS NOT NULL))
               OR (l.alcohol_status IS NOT NULL AND (
                     (i.lifestyle_alcohol IS NOT NULL AND i.lifestyle_alcohol <> l.alcohol_status)
                  OR (l.alcohol_status = 'never' AND n.alcoholic_drinks_per_week > 0))))`,
  },
  {
    id: 'D13', field: 'Water intake', owner: 'Nutrition',
    copies: 'Lifestyle', recommendation: 'manual_review',
    note: '0.25L tolerance. Backfill only into an existing owner row with a NULL field.',
    sql: `WITH n AS (${LATEST.nutrition}), l AS (${LATEST.lifestyle})
          SELECT CASE WHEN n.water_intake_liters IS NULL THEN 'legacy_only' ELSE 'conflict' END AS status,
                 c.id AS client_id, c.name AS client_name, c.organization_id,
                 'pt_nutrition_assessments'::text AS owner_table, n.id AS owner_record_id,
                 COALESCE(n.assessment_date::timestamptz, n.created_at) AS owner_recorded_at,
                 jsonb_build_object('water_intake_liters', n.water_intake_liters) AS owner_value,
                 (n.id IS NOT NULL AND n.water_intake_liters IS NULL) AS owner_field_null,
                 'pt_lifestyle_assessments'::text AS legacy_table, l.id AS legacy_record_id,
                 COALESCE(l.assessment_date::timestamptz, l.created_at) AS legacy_recorded_at,
                 jsonb_build_object('lifestyle_water_intake_liters', l.water_intake_liters) AS legacy_value
            FROM pt_clients c
            LEFT JOIN n ON n.client_id = c.id
            LEFT JOIN l ON l.client_id = c.id
           WHERE c.organization_id = ANY($1::uuid[]) AND c.deleted_at IS NULL
             AND ((n.water_intake_liters IS NULL AND l.water_intake_liters IS NOT NULL)
               OR (n.water_intake_liters IS NOT NULL AND l.water_intake_liters IS NOT NULL
                   AND abs(n.water_intake_liters - l.water_intake_liters) > 0.25))`,
  },
  {
    id: 'D14', field: 'Meal frequency', owner: 'Nutrition',
    copies: 'Lifestyle', recommendation: 'manual_review',
    note: 'Meals per day and the lifestyle frequency bucket are not the same unit. Review before moving a value.',
    sql: `WITH n AS (${LATEST.nutrition}), l AS (${LATEST.lifestyle})
          SELECT CASE WHEN n.meals_per_day IS NULL THEN 'legacy_only' ELSE 'conflict' END AS status,
                 c.id AS client_id, c.name AS client_name, c.organization_id,
                 'pt_nutrition_assessments'::text AS owner_table, n.id AS owner_record_id,
                 COALESCE(n.assessment_date::timestamptz, n.created_at) AS owner_recorded_at,
                 jsonb_build_object('meals_per_day', n.meals_per_day) AS owner_value,
                 (n.id IS NOT NULL AND n.meals_per_day IS NULL) AS owner_field_null,
                 'pt_lifestyle_assessments'::text AS legacy_table, l.id AS legacy_record_id,
                 COALESCE(l.assessment_date::timestamptz, l.created_at) AS legacy_recorded_at,
                 jsonb_build_object('lifestyle_meal_frequency', l.meal_frequency) AS legacy_value
            FROM pt_clients c
            LEFT JOIN n ON n.client_id = c.id
            LEFT JOIN l ON l.client_id = c.id
           WHERE c.organization_id = ANY($1::uuid[]) AND c.deleted_at IS NULL
             AND ((n.meals_per_day IS NULL AND l.meal_frequency IS NOT NULL)
               OR (n.meals_per_day IS NOT NULL AND l.meal_frequency IS NOT NULL
                   AND n.meals_per_day <> l.meal_frequency))`,
  },
  {
    id: 'D15', field: 'Meal regularity', owner: 'Interview',
    copies: 'Nutrition meal_timing_consistency', recommendation: 'manual_review',
    note: 'The vocabularies are mapped for counting, but an approximate mapping is not evidence for a write.',
    sql: `WITH i AS (${LATEST.interview}), n AS (${LATEST.nutrition})
          SELECT CASE WHEN i.lifestyle_meal_regularity IS NULL THEN 'legacy_only' ELSE 'conflict' END AS status,
                 c.id AS client_id, c.name AS client_name, c.organization_id,
                 'pt_client_interviews'::text AS owner_table, i.id AS owner_record_id,
                 COALESCE(i.completed_at, i.created_at) AS owner_recorded_at,
                 jsonb_build_object('lifestyle_meal_regularity', i.lifestyle_meal_regularity) AS owner_value,
                 (i.id IS NOT NULL AND i.lifestyle_meal_regularity IS NULL) AS owner_field_null,
                 'pt_nutrition_assessments'::text AS legacy_table, n.id AS legacy_record_id,
                 COALESCE(n.assessment_date::timestamptz, n.created_at) AS legacy_recorded_at,
                 jsonb_build_object('meal_timing_consistency', n.meal_timing_consistency) AS legacy_value
            FROM pt_clients c
            LEFT JOIN i ON i.client_id = c.id
            LEFT JOIN n ON n.client_id = c.id
           WHERE c.organization_id = ANY($1::uuid[]) AND c.deleted_at IS NULL
             AND ((i.lifestyle_meal_regularity IS NULL AND n.meal_timing_consistency IS NOT NULL)
               OR (i.lifestyle_meal_regularity IS NOT NULL AND n.meal_timing_consistency IS NOT NULL
                   AND (CASE i.lifestyle_meal_regularity WHEN 'regular' THEN 'consistent'
                                                        WHEN 'irregular' THEN 'inconsistent'
                                                        WHEN 'inconsistent' THEN 'somewhat_consistent' END)
                       <> n.meal_timing_consistency))`,
  },
  {
    id: 'D16', field: 'Food preferences', owner: 'Nutrition',
    copies: 'Lifestyle', recommendation: 'manual_review',
    note: 'Array vocabulary is not guaranteed identical. Review the two lists before copying.',
    sql: `WITH n AS (${LATEST.nutrition}), l AS (${LATEST.lifestyle})
          SELECT CASE WHEN coalesce(array_length(n.diet_preferences, 1), 0) = 0
                      THEN 'legacy_only' ELSE 'conflict' END AS status,
                 c.id AS client_id, c.name AS client_name, c.organization_id,
                 'pt_nutrition_assessments'::text AS owner_table, n.id AS owner_record_id,
                 COALESCE(n.assessment_date::timestamptz, n.created_at) AS owner_recorded_at,
                 jsonb_build_object('diet_preferences', n.diet_preferences) AS owner_value,
                 (n.id IS NOT NULL AND coalesce(array_length(n.diet_preferences, 1), 0) = 0) AS owner_field_null,
                 'pt_lifestyle_assessments'::text AS legacy_table, l.id AS legacy_record_id,
                 COALESCE(l.assessment_date::timestamptz, l.created_at) AS legacy_recorded_at,
                 jsonb_build_object('food_preferences', l.food_preferences) AS legacy_value
            FROM pt_clients c
            LEFT JOIN n ON n.client_id = c.id
            LEFT JOIN l ON l.client_id = c.id
           WHERE c.organization_id = ANY($1::uuid[]) AND c.deleted_at IS NULL
             AND ((coalesce(array_length(n.diet_preferences, 1), 0) = 0
                   AND coalesce(array_length(l.food_preferences, 1), 0) > 0)
               OR (coalesce(array_length(n.diet_preferences, 1), 0) > 0
                   AND coalesce(array_length(l.food_preferences, 1), 0) > 0
                   AND (SELECT array_agg(x ORDER BY x) FROM unnest(n.diet_preferences) x)
                    IS DISTINCT FROM
                       (SELECT array_agg(x ORDER BY x) FROM unnest(l.food_preferences) x)))`,
  },
  {
    id: 'D17', field: 'Training days', owner: 'Interview availability / Goal prescription',
    copies: 'pt_clients.sessions_per_week', recommendation: 'none',
    note: 'Availability and prescription are different facts by design; divergence is expected.',
    sql: `WITH i AS (${LATEST.interview}), g AS (${LATEST.goal})
          SELECT CASE WHEN i.lifestyle_training_days IS NULL AND g.training_days_per_week IS NULL
                      THEN 'legacy_only' ELSE 'conflict' END AS status,
                 c.id AS client_id, c.name AS client_name, c.organization_id,
                 'pt_client_interviews + pt_goals'::text AS owner_table,
                 COALESCE(i.id, g.id) AS owner_record_id,
                 COALESCE(i.completed_at, i.created_at, g.created_at) AS owner_recorded_at,
                 jsonb_build_object('interview_training_days', i.lifestyle_training_days,
                                    'goal_training_days_per_week', g.training_days_per_week) AS owner_value,
                 false AS owner_field_null,
                 'pt_clients'::text AS legacy_table, c.id AS legacy_record_id, c.updated_at AS legacy_recorded_at,
                 jsonb_build_object('sessions_per_week', c.sessions_per_week) AS legacy_value
            FROM pt_clients c
            LEFT JOIN i ON i.client_id = c.id
            LEFT JOIN g ON g.client_id = c.id
           WHERE c.organization_id = ANY($1::uuid[]) AND c.deleted_at IS NULL
             AND ((i.lifestyle_training_days IS NULL AND g.training_days_per_week IS NULL
                   AND c.sessions_per_week IS NOT NULL)
               OR (c.sessions_per_week IS NOT NULL AND (
                     (i.lifestyle_training_days IS NOT NULL AND i.lifestyle_training_days <> c.sessions_per_week)
                  OR (g.training_days_per_week IS NOT NULL AND g.training_days_per_week <> c.sessions_per_week))))`,
  },
  {
    id: 'D18', field: 'Sit-and-reach', owner: 'Fitness Testing',
    copies: 'Mobility sit_reach_cm', recommendation: 'manual_review',
    note: 'Inches (scored) and centimetres (unscored) are not mechanically comparable. Do not convert silently.',
    sql: `WITH m AS (${LATEST.mobility})
          SELECT 'legacy_only'::text AS status, c.id AS client_id, c.name AS client_name, c.organization_id,
                 'pt_assessments'::text AS owner_table, a.id AS owner_record_id,
                 COALESCE(a.assessment_date::timestamptz, a.created_at) AS owner_recorded_at,
                 jsonb_build_object('flexibility_test_data', a.flexibility_test_data) AS owner_value,
                 false AS owner_field_null,
                 'pt_mobility_performance_assessments'::text AS legacy_table, m.id AS legacy_record_id,
                 COALESCE(m.assessment_date::timestamptz, m.created_at) AS legacy_recorded_at,
                 jsonb_build_object('sit_reach_cm', m.sit_reach_cm) AS legacy_value
            FROM pt_clients c
            JOIN m ON m.client_id = c.id
            LEFT JOIN LATERAL (
              SELECT id, assessment_date, created_at, flexibility_test_data FROM pt_assessments
               WHERE client_id = c.id ORDER BY assessment_date DESC NULLS LAST, created_at DESC LIMIT 1
            ) a ON TRUE
           WHERE c.organization_id = ANY($1::uuid[]) AND c.deleted_at IS NULL
             AND m.sit_reach_cm IS NOT NULL`,
  },
  {
    id: 'D19', field: '1RM', owner: 'Fitness Testing / Strength Tracking',
    copies: 'strength_logs free-standing', recommendation: 'none',
    note: 'A free-standing log is a valid record, not a missing owner. Same-day different estimates stay for a coach to resolve.',
    sql: `WITH conflicts AS (
            SELECT c.id AS client_id, c.name AS client_name, c.organization_id,
                   sl.exercise_name, sl.log_date,
                   array_agg(DISTINCT sl.one_rm_estimate) AS estimates,
                   array_agg(DISTINCT sl.id) AS log_ids,
                   max(sl.created_at) AS recorded_at
              FROM strength_logs sl JOIN pt_clients c ON c.id = sl.client_id
             WHERE sl.organization_id = ANY($1::uuid[]) AND c.deleted_at IS NULL
             GROUP BY c.id, c.name, c.organization_id, sl.exercise_name, sl.log_date
            HAVING count(DISTINCT sl.one_rm_estimate) > 1)
          SELECT 'conflict'::text AS status, client_id, client_name, organization_id,
                 'strength_logs'::text AS owner_table, NULL::text AS owner_record_id,
                 recorded_at AS owner_recorded_at,
                 jsonb_build_object('exercise', exercise_name, 'log_date', log_date,
                                    'estimates', estimates, 'log_ids', log_ids) AS owner_value,
                 false AS owner_field_null,
                 'strength_logs'::text AS legacy_table, NULL::text AS legacy_record_id,
                 recorded_at AS legacy_recorded_at,
                 jsonb_build_object('exercise', exercise_name, 'log_date', log_date) AS legacy_value
            FROM conflicts
          UNION ALL
          SELECT 'legacy_only'::text, c.id, c.name, c.organization_id,
                 'pt_assessments'::text, NULL::text, NULL::timestamptz,
                 NULL::jsonb, false,
                 'strength_logs'::text, sl.id, sl.log_date::timestamptz,
                 jsonb_build_object('exercise', sl.exercise_name, 'one_rm_estimate', sl.one_rm_estimate,
                                    'assessment_id', sl.assessment_id)
            FROM strength_logs sl JOIN pt_clients c ON c.id = sl.client_id
           WHERE sl.organization_id = ANY($1::uuid[]) AND c.deleted_at IS NULL
             AND sl.assessment_id IS NULL`,
  },
  {
    id: 'D20', field: 'Consent attestations', owner: 'Informed Consent',
    copies: 'pt_consent_records', recommendation: 'none',
    note: 'Old and new key sets are separate historical attestations. Both remain readable; neither is merged.',
    sql: `WITH old_records AS (
            SELECT cr.id, cr.client_id, cr.consent_checkboxes, cr.created_at,
                   (SELECT count(*) FROM jsonb_object_keys(coalesce(cr.consent_checkboxes, '{}'::jsonb))) AS key_count
              FROM pt_consent_records cr JOIN pt_clients c ON c.id = cr.client_id
             WHERE cr.organization_id = ANY($1::uuid[]) AND c.deleted_at IS NULL),
          paired AS (
            SELECT DISTINCT ON (c.id) c.id AS client_id, c.name AS client_name, c.organization_id,
                   ic.id AS consent_id, ic.created_at AS consent_at,
                   cr.id AS record_id, cr.created_at AS record_at, cr.consent_checkboxes
              FROM pt_clients c
              JOIN pt_informed_consents ic ON ic.client_id = c.id
              JOIN pt_consent_records cr ON cr.client_id = c.id
             WHERE c.organization_id = ANY($1::uuid[]) AND c.deleted_at IS NULL
             ORDER BY c.id, ic.created_at DESC, cr.created_at DESC)
          SELECT 'legacy_only'::text AS status, c.id AS client_id, c.name AS client_name, c.organization_id,
                 'pt_informed_consents'::text AS owner_table, NULL::text AS owner_record_id,
                 NULL::timestamptz AS owner_recorded_at, NULL::jsonb AS owner_value, false AS owner_field_null,
                 'pt_consent_records'::text AS legacy_table, o.id AS legacy_record_id,
                 o.created_at AS legacy_recorded_at,
                 jsonb_build_object('consent_checkboxes', o.consent_checkboxes, 'key_count', o.key_count) AS legacy_value
            FROM old_records o JOIN pt_clients c ON c.id = o.client_id
           WHERE o.key_count <= 7
          UNION ALL
          SELECT 'conflict'::text, b.client_id, b.client_name, b.organization_id,
                 'pt_informed_consents'::text, b.consent_id, b.consent_at,
                 jsonb_build_object('informed_consent_id', b.consent_id), false,
                 'pt_consent_records'::text, b.record_id, b.record_at,
                 jsonb_build_object('consent_checkboxes', b.consent_checkboxes)
            FROM paired b`,
  },
  {
    id: 'D21', field: 'Medical clearance', owner: 'PAR-Q gate + Consent physician block',
    copies: 'Two distinct gates', recommendation: 'none',
    note: 'PAR-Q clearance and a physician objection are independent safety gates. Both are shown; neither overrides the other.',
    sql: `WITH q AS (${LATEST.parq}),
          cte AS (
            SELECT c.id AS client_id, c.name AS client_name, c.organization_id,
                   q.id AS parq_id, q.workout_gate_status,
                   COALESCE(q.assessment_date::timestamptz, q.created_at) AS parq_at,
                   ic.id AS consent_id, ic.created_at AS consent_at, ic.physician_advised_against
              FROM pt_clients c
              LEFT JOIN q ON q.client_id = c.id
              LEFT JOIN LATERAL (
                SELECT id, physician_advised_against, created_at FROM pt_informed_consents
                 WHERE client_id = c.id ORDER BY created_at DESC LIMIT 1
              ) ic ON TRUE
             WHERE c.organization_id = ANY($1::uuid[]) AND c.deleted_at IS NULL)
          SELECT 'legacy_only'::text AS status, client_id, client_name, organization_id,
                 'pt_parq_forms'::text AS owner_table, NULL::text AS owner_record_id,
                 NULL::timestamptz AS owner_recorded_at, NULL::jsonb AS owner_value,
                 false AS owner_field_null,
                 'pt_informed_consents'::text AS legacy_table, consent_id AS legacy_record_id,
                 consent_at AS legacy_recorded_at,
                 jsonb_build_object('physician_advised_against', physician_advised_against) AS legacy_value
            FROM cte WHERE physician_advised_against
          UNION ALL
          SELECT 'conflict'::text, client_id, client_name, organization_id,
                 'pt_parq_forms'::text, parq_id, parq_at,
                 jsonb_build_object('workout_gate_status', workout_gate_status), false,
                 'pt_informed_consents'::text, consent_id, consent_at,
                 jsonb_build_object('physician_advised_against', physician_advised_against)
            FROM cte WHERE workout_gate_status = 'blocked' AND physician_advised_against`,
  },
  {
    id: 'D22', field: 'Workout experience in programming', owner: 'client-facts precedence',
    copies: 'pt_clients, client_fitness_profiles', recommendation: 'manual_review',
    note: 'The generator already resolves owner before legacy; the disagreement is reported but never rewritten automatically.',
    sql: `SELECT 'conflict'::text AS status, c.id AS client_id, c.name AS client_name, c.organization_id,
                 'pt_clients'::text AS owner_table, c.id AS owner_record_id, c.updated_at AS owner_recorded_at,
                 jsonb_build_object('workout_experience_level', c.workout_experience_level) AS owner_value,
                 false AS owner_field_null,
                 'client_fitness_profiles'::text AS legacy_table, p.id AS legacy_record_id,
                 p.updated_at AS legacy_recorded_at,
                 jsonb_build_object('fitness_level', p.fitness_level) AS legacy_value
            FROM pt_clients c
            JOIN client_fitness_profiles p ON p.client_id = c.id
           WHERE c.organization_id = ANY($1::uuid[]) AND c.deleted_at IS NULL
             AND c.workout_experience_level IS NOT NULL AND p.fitness_level IS NOT NULL
             AND c.workout_experience_level <> p.fitness_level`,
  },
  {
    id: 'D23', field: 'Medical conditions in Nutrition', owner: 'PAR-Q',
    copies: 'pt_nutrition_assessments.medical_conditions', recommendation: 'manual_review',
    note: 'Only submitted/reviewed PAR-Q is an owner. A draft falls through to the legacy list; do not promote free text automatically.',
    sql: `WITH q AS (${LATEST.parqMedical}), n AS (${LATEST.nutrition})
          SELECT CASE WHEN q.id IS NULL OR q.current_health = '{}'::jsonb
                      THEN 'legacy_only' ELSE 'conflict' END AS status,
                 c.id AS client_id, c.name AS client_name, c.organization_id,
                 'pt_parq_forms'::text AS owner_table, q.id AS owner_record_id,
                 COALESCE(q.assessment_date::timestamptz, q.created_at) AS owner_recorded_at,
                 jsonb_build_object('current_health', q.current_health) AS owner_value,
                 (q.id IS NOT NULL AND q.current_health = '{}'::jsonb) AS owner_field_null,
                 'pt_nutrition_assessments'::text AS legacy_table, n.id AS legacy_record_id,
                 COALESCE(n.assessment_date::timestamptz, n.created_at) AS legacy_recorded_at,
                 jsonb_build_object('medical_conditions', n.medical_conditions) AS legacy_value
            FROM pt_clients c
            LEFT JOIN q ON q.client_id = c.id
            LEFT JOIN n ON n.client_id = c.id
           WHERE c.organization_id = ANY($1::uuid[]) AND c.deleted_at IS NULL
             AND coalesce(array_length(n.medical_conditions, 1), 0) > 0`,
  },
  {
    id: 'D24', field: 'pt_clients.occupation', owner: 'Lifestyle',
    copies: 'Add Client / Interview / PAR-Q / consent snapshot', recommendation: 'manual_review',
    note: 'Client leg of D8. Backfill only into an existing Lifestyle row whose field is NULL.',
    sql: `WITH l AS (${LATEST.lifestyle})
          SELECT CASE WHEN l.occupation_type IS NULL THEN 'legacy_only' ELSE 'conflict' END AS status,
                 c.id AS client_id, c.name AS client_name, c.organization_id,
                 'pt_lifestyle_assessments'::text AS owner_table, l.id AS owner_record_id,
                 COALESCE(l.assessment_date::timestamptz, l.created_at) AS owner_recorded_at,
                 jsonb_build_object('occupation_type', l.occupation_type) AS owner_value,
                 (l.id IS NOT NULL AND l.occupation_type IS NULL) AS owner_field_null,
                 'pt_clients'::text AS legacy_table, c.id AS legacy_record_id, c.updated_at AS legacy_recorded_at,
                 jsonb_build_object('client_occupation', c.occupation) AS legacy_value
            FROM pt_clients c
            LEFT JOIN l ON l.client_id = c.id
           WHERE c.organization_id = ANY($1::uuid[]) AND c.deleted_at IS NULL
             AND ((l.occupation_type IS NULL AND c.occupation IS NOT NULL)
               OR (l.occupation_type IS NOT NULL AND c.occupation IS NOT NULL
                   AND l.occupation_type <> c.occupation))`,
  },
  {
    id: 'D25', field: 'Motivation to exercise', owner: 'Goal',
    copies: 'Lifestyle motivation_to_exercise', recommendation: 'manual_review',
    note: 'Same 1–10 score. Backfill only into an existing active goal whose motivation field is NULL.',
    sql: `WITH g AS (${LATEST.goal}), l AS (${LATEST.lifestyle})
          SELECT CASE WHEN g.motivation_level IS NULL THEN 'legacy_only' ELSE 'conflict' END AS status,
                 c.id AS client_id, c.name AS client_name, c.organization_id,
                 'pt_goals'::text AS owner_table, g.id AS owner_record_id, g.created_at AS owner_recorded_at,
                 jsonb_build_object('motivation_level', g.motivation_level) AS owner_value,
                 (g.id IS NOT NULL AND g.motivation_level IS NULL) AS owner_field_null,
                 'pt_lifestyle_assessments'::text AS legacy_table, l.id AS legacy_record_id,
                 COALESCE(l.assessment_date::timestamptz, l.created_at) AS legacy_recorded_at,
                 jsonb_build_object('motivation_to_exercise', l.motivation_to_exercise) AS legacy_value
            FROM pt_clients c
            LEFT JOIN g ON g.client_id = c.id
            LEFT JOIN l ON l.client_id = c.id
           WHERE c.organization_id = ANY($1::uuid[]) AND c.deleted_at IS NULL
             AND ((g.motivation_level IS NULL AND l.motivation_to_exercise IS NOT NULL)
               OR (g.motivation_level IS NOT NULL AND l.motivation_to_exercise IS NOT NULL
                   AND abs(g.motivation_level - l.motivation_to_exercise) >= 2))`,
  },
];

/**
 * The only automated action is a one-column backfill into an owner row that
 * already exists and whose field is NULL. If two legacy sources disagree, the
 * row goes to manual review instead: a human must pick the value.
 */
function autoCandidate(id, row) {
  const { status, owner_record_id: ownerId, owner_field_null: nullField } = row;
  if (status !== 'legacy_only' || !ownerId || !nullField) return null;
  const lv = row.legacy_value || {};
  const pick = (v) => v !== null && v !== undefined;

  if (id === 'D8' || id === 'D24') {
    const sources = [];
    if (pick(lv.client_occupation)) sources.push(lv.client_occupation);
    if (pick(lv.interview_occupation) && !sources.includes(lv.interview_occupation)) sources.push(lv.interview_occupation);
    if (sources.length !== 1) return null;
    return { table: 'pt_lifestyle_assessments', column: 'occupation_type', value: sources[0] };
  }
  if (id === 'D9' && pick(lv.interview_screen_time)) {
    return { table: 'pt_lifestyle_assessments', column: 'screen_time_bracket', value: lv.interview_screen_time };
  }
  if (id === 'D10' && pick(lv.interview_sleep_hours)) {
    return { table: 'pt_lifestyle_assessments', column: 'sleep_duration_hours', value: Number(lv.interview_sleep_hours) };
  }
  if (id === 'D11' && pick(lv.interview_smoking)) {
    return { table: 'pt_lifestyle_assessments', column: 'smoking_status', value: lv.interview_smoking };
  }
  if (id === 'D12' && pick(lv.interview_alcohol)) {
    return { table: 'pt_lifestyle_assessments', column: 'alcohol_status', value: lv.interview_alcohol };
  }
  if (id === 'D13' && pick(lv.lifestyle_water_intake_liters)) {
    return { table: 'pt_nutrition_assessments', column: 'water_intake_liters', value: Number(lv.lifestyle_water_intake_liters) };
  }
  if (id === 'D25' && pick(lv.motivation_to_exercise)) {
    return { table: 'pt_goals', column: 'motivation_level', value: Number(lv.motivation_to_exercise) };
  }
  return null;
}

const RECOMMENDATION_TEXT = {
  none: 'Keep both records. No reconciliation action.',
  manual_review: 'Review the two values with the trainer; no automatic write.',
};

function shapeRecord(check, row) {
  const candidate = autoCandidate(check.id, row);
  const recommended_action = candidate ? 'backfill' : check.recommendation;
  return {
    check_id: check.id,
    field: check.field,
    status: row.status,
    client_id: row.client_id,
    client_name: row.client_name,
    organization_id: row.organization_id,
    owner_table: row.owner_table,
    owner_record_id: row.owner_record_id,
    owner_recorded_at: row.owner_recorded_at,
    owner_value: row.owner_value,
    owner_field_null: row.owner_field_null,
    legacy_table: row.legacy_table,
    legacy_record_id: row.legacy_record_id,
    legacy_recorded_at: row.legacy_recorded_at,
    legacy_value: row.legacy_value,
    recommended_action,
    recommendation: candidate
      ? 'Owner row exists with an empty field and one legacy source. Eligible for reviewed backfill.'
      : RECOMMENDATION_TEXT[recommended_action] || check.note,
    backfill: candidate,
    plan_id: candidate ? `${check.id}:${candidate.table}:${row.owner_record_id}:${candidate.column}` : null,
  };
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeCsv(path, candidates) {
  const header = ['check_id', 'status', 'client_id', 'client_name', 'owner_table', 'owner_record_id',
    'owner_column', 'current_value', 'proposed_value', 'legacy_table', 'legacy_record_id',
    'recommended_action', 'reviewer_decision'];
  const lines = [header.join(',')];
  for (const c of candidates) {
    lines.push([
      c.check_id, c.status, c.client_id, c.client_name, c.owner_table, c.owner_record_id,
      c.owner_column, c.current_value, c.proposed_value, c.legacy_table, c.legacy_record_id,
      c.proposed_action, c.decision,
    ].map(csvCell).join(','));
  }
  fs.writeFileSync(path, lines.join('\n') + '\n');
}

function writeMarkdown(path, report) {
  const lines = [];
  lines.push('# Phase 5 — D1–D25 field-level reconciliation report');
  lines.push('');
  lines.push(`Database: \`${report.database}\``);
  lines.push(`Organizations: ${report.organizations.length} (${report.organizations.join(', ') || 'none'})`);
  lines.push(`Generated: ${report.generated_at}`);
  lines.push('Read-only: yes (`BEGIN TRANSACTION READ ONLY`)');
  lines.push('');
  lines.push('| Metric | Count |');
  lines.push('|---|---:|');
  lines.push(`| Legacy-only records | ${report.totals.legacy_only} |`);
  lines.push(`| Conflicting records | ${report.totals.conflicts} |`);
  lines.push(`| Total records reviewed | ${report.totals.records} |`);
  lines.push(`| Reviewed backfill candidates | ${report.totals.auto_candidates} |`);
  lines.push(`| Conflicts eligible for automatic write | 0 |`);
  lines.push('');
  lines.push('A backfill candidate is an owner row that already exists, whose target field is NULL, and for which exactly one legacy source supplies a value. Conflicts are never eligible.');
  lines.push('');
  for (const check of report.checks) {
    lines.push(`## ${check.id} — ${check.field}`);
    lines.push('');
    lines.push(`Owner: ${check.owner}. Legacy copies: ${check.copies}.`);
    lines.push('');
    lines.push(`Records: ${check.counts.legacy_only} legacy-only, ${check.counts.conflicts} conflicting.`);
    lines.push('');
    if (!check.records.length) {
      lines.push('No records in this register.');
      lines.push('');
      continue;
    }
    lines.push('| Status | Client | Owner source | Owner value | Owner recorded | Legacy source | Legacy value | Legacy recorded | Recommended |');
    lines.push('|---|---|---|---|---|---|---|---|---|');
    for (const r of check.records) {
      lines.push(`| ${r.status} | ${r.client_id} (${r.client_name || ''}) | ${r.owner_table || '—'} ${r.owner_record_id || ''} | ${csvCell(r.owner_value)} | ${r.owner_recorded_at || '—'} | ${r.legacy_table || '—'} ${r.legacy_record_id || ''} | ${csvCell(r.legacy_value)} | ${r.legacy_recorded_at || '—'} | ${r.recommended_action} |`);
    }
    lines.push('');
  }
  fs.writeFileSync(path, lines.join('\n'));
}

async function main() {
  const db = new Client({ connectionString: URL_ARG });
  await db.connect();
  // One snapshot for the whole run: the detail rows and the Phase 4
  // aggregate they are validated against must see the same database.
  await db.query('BEGIN TRANSACTION READ ONLY ISOLATION LEVEL REPEATABLE READ');
  await db.query("SET LOCAL statement_timeout = '120s'");

  let orgs;
  if (ORG_FILTER) {
    orgs = [ORG_FILTER];
  } else {
    const { rows } = await db.query(
      'SELECT DISTINCT organization_id AS id FROM pt_clients WHERE organization_id IS NOT NULL ORDER BY 1',
    );
    orgs = rows.map((r) => r.id);
  }

  const checks = [];
  const candidates = [];
  const totals = { legacy_only: 0, conflicts: 0, records: 0, auto_candidates: 0 };

  for (const check of DETAILS) {
    if (process.env.PHASE5_RECONCILE_VERBOSE) console.error(`detail ${check.id}...`);
    await db.query('SAVEPOINT detail_check');
    try {
      const { rows } = await db.query(check.sql, [orgs]);
      await db.query('RELEASE SAVEPOINT detail_check');
      const records = rows.map((row) => shapeRecord(check, row));
      const counts = {
        legacy_only: records.filter((r) => r.status === 'legacy_only').length,
        conflicts: records.filter((r) => r.status === 'conflict').length,
      };
      totals.legacy_only += counts.legacy_only;
      totals.conflicts += counts.conflicts;
      totals.records += records.length;
      for (const r of records) {
        if (r.backfill) {
          candidates.push({
            plan_id: r.plan_id,
            check_id: r.check_id,
            status: r.status,
            client_id: r.client_id,
            client_name: r.client_name,
            organization_id: r.organization_id,
            owner_table: r.backfill.table,
            owner_record_id: r.owner_record_id,
            owner_column: r.backfill.column,
            current_value: r.owner_value ? r.owner_value[r.backfill.column] ?? null : null,
            proposed_value: r.backfill.value,
            legacy_table: r.legacy_table,
            legacy_record_id: r.legacy_record_id,
            proposed_action: 'backfill',
            decision: '',
          });
        }
      }
      checks.push({ ...check, sql: undefined, counts, records });
    } catch (err) {
      await db.query('ROLLBACK TO SAVEPOINT detail_check');
      checks.push({ ...check, sql: undefined, counts: { legacy_only: 0, conflicts: 0 }, records: [], error: err.message });
    }
  }

  // Validate every register against the Phase 4 aggregate in the same snapshot.
  // A mismatch means the detail SQL and the published totals have drifted.
  const aggregate = new Map();
  for (const check of AGGREGATE_CHECKS) {
    try {
      const { rows } = await db.query(check.sql, [orgs]);
      aggregate.set(check.id, { legacy_only: rows[0].legacy_only || 0, conflict: rows[0].conflict || 0 });
    } catch (err) {
      aggregate.set(check.id, { error: err.message });
    }
  }
  await db.query('ROLLBACK');
  await db.end();

  const mismatches = [];
  for (const check of checks) {
    const expected = aggregate.get(check.id);
    if (!expected || expected.error) {
      mismatches.push(`${check.id}: aggregate query failed: ${expected ? expected.error : 'missing'}`);
    } else if (expected.legacy_only !== check.counts.legacy_only) {
      mismatches.push(`${check.id}: legacy-only detail ${check.counts.legacy_only} != aggregate ${expected.legacy_only}`);
    } else if (expected.conflict !== check.counts.conflicts) {
      mismatches.push(`${check.id}: conflict detail ${check.counts.conflicts} != aggregate ${expected.conflict}`);
    }
  }
  if (mismatches.length) checks.push({ id: 'VALIDATION', counts: { legacy_only: 0, conflicts: 0 }, records: [], error: mismatches.join('; ') });

  // D8 and D24 share a target row. A plan must not contain the same write twice.
  const seen = new Map();
  for (const c of candidates) {
    const key = `${c.owner_table}:${c.owner_record_id}:${c.owner_column}`;
    const prior = seen.get(key);
    if (prior && String(prior.proposed_value) !== String(c.proposed_value)) {
      prior.decision = 'manual_review';
      c.decision = 'manual_review';
    } else if (!prior) {
      seen.set(key, c);
    }
  }
  const plan = [...seen.values()].filter((c) => c.decision !== 'manual_review');
  totals.auto_candidates = plan.length;

  const report = {
    database: new URL(URL_ARG).host + new URL(URL_ARG).pathname,
    organizations: orgs,
    generated_at: new Date().toISOString(),
    read_only: true,
    stale_after_days: STALE_AFTER_DAYS,
    totals,
    validation: { ok: mismatches.length === 0, mismatches },
    checks,
  };

  if (MD_OUT) writeMarkdown(MD_OUT, report);
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
  if (PLAN_OUT) {
    fs.writeFileSync(PLAN_OUT, JSON.stringify({
      generated_at: report.generated_at,
      database: report.database,
      organizations: orgs,
      note: 'Set decision="backfill" only on rows a reviewer has approved. The apply script refuses conflicts and non-allowlisted columns.',
      candidates: plan,
    }, null, 2));
  }
  if (CSV_OUT) writeCsv(CSV_OUT, plan);

  const header = [
    '# Phase 5 reconciliation',
    '',
    `Database: ${report.database}`,
    `Legacy-only: ${totals.legacy_only}`,
    `Conflicting: ${totals.conflicts}`,
    `Total records: ${totals.records}`,
    `Reviewed backfill candidates: ${totals.auto_candidates} (not applied)`,
    `Aggregate validation: ${mismatches.length ? `FAILED (${mismatches.length})` : 'ok'}`,
  ];
  if (checks.some((c) => c.error)) {
    header.push('', 'FAILED CHECKS:');
    for (const c of checks.filter((x) => x.error)) header.push(`  ${c.id}: ${c.error}`);
  }
  console.log(header.join('\n'));
  if (checks.some((c) => c.error)) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
