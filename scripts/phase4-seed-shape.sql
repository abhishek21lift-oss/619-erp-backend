-- Phase 4 — a production-shaped dataset for the client-facts ownership audit.
--
-- This is SYNTHETIC. It is not a copy of production: no production dump was
-- supplied for this phase. What it reproduces is the SHAPE the ownership rules
-- have to survive — many concurrent studios, years of history, rows entered
-- late, owners that never got a value, owners that disagree with a legacy
-- column, and records older than the staleness threshold.
--
-- Deterministic: bucket = i % 10, so the same i always gets the same shape.
-- Safe to delete: only rows under the two Phase 4 organizations are touched.
--
--   psql "$URL" -v ON_ERROR_STOP=1 -f scripts/phase4-seed-shape.sql

\set ON_ERROR_STOP on

DO $$
DECLARE
  org_a CONSTANT uuid := 'a4a4a4a4-a4a4-4a4a-a4a4-a4a4a4a4a4a4';
  org_b CONSTANT uuid := 'b4b4b4b4-b4b4-4b4b-8b4b-b4b4b4b4b4b4';
  user_a CONSTANT text := 'phase4-audit-trainer-a';
  user_b CONSTANT text := 'phase4-audit-trainer-b';
  i int;
  cid uuid;
  org uuid;
  bucket int;
  deleted timestamptz;
  goal_cycle text[] := ARRAY['fat_loss','muscle_gain','general_fitness','endurance','strength_gain'];
  goal_text text;
  weight_cache numeric;
  height_cache numeric;
  base_date date;
  d1 date;
  d2 date;
  d3 date;
BEGIN
  -- ── Cleanup, so the file can be re-run ──────────────────────────────────
  DELETE FROM activity_log WHERE organization_id IN (org_a, org_b);
  DELETE FROM pt_os_measurements WHERE client_id IN
    (SELECT id FROM pt_clients WHERE organization_id IN (org_a, org_b));
  DELETE FROM weekly_checkins WHERE organization_id IN (org_a, org_b);
  DELETE FROM client_fitness_profiles WHERE organization_id IN (org_a, org_b);
  DELETE FROM pt_goals WHERE organization_id IN (org_a, org_b);
  DELETE FROM pt_assessments WHERE organization_id IN (org_a, org_b);
  DELETE FROM pt_parq_forms WHERE organization_id IN (org_a, org_b);
  DELETE FROM pt_client_interviews WHERE organization_id IN (org_a, org_b);
  DELETE FROM pt_lifestyle_assessments WHERE organization_id IN (org_a, org_b);
  DELETE FROM pt_nutrition_assessments WHERE organization_id IN (org_a, org_b);
  DELETE FROM pt_mobility_performance_assessments WHERE organization_id IN (org_a, org_b);
  DELETE FROM pt_posture_assessments WHERE organization_id IN (org_a, org_b);
  DELETE FROM pt_clients WHERE organization_id IN (org_a, org_b);
  DELETE FROM users WHERE id IN (user_a, user_b);
  DELETE FROM organizations WHERE id IN (org_a, org_b);

  INSERT INTO organizations (id, name, slug) VALUES
    (org_a, 'Phase 4 Production Shape', 'phase4-production-shape'),
    (org_b, 'Phase 4 Other Studio', 'phase4-other-studio');

  INSERT INTO users (id, name, email, password, role, organization_id, is_active) VALUES
    (user_a, 'Phase 4 Auditor A', 'phase4-a@test.invalid', '!x', 'trainer', org_a, TRUE),
    (user_b, 'Phase 4 Auditor B', 'phase4-b@test.invalid', '!x', 'trainer', org_b, TRUE);

  -- 500 clients in the main studio, 40 in the other. Real studios are not
  -- this uniform, but the mix of shapes below is what the rules must hold for.
  FOR i IN 1..540 LOOP
    org := CASE WHEN i <= 500 THEN org_a ELSE org_b END;
    bucket := i % 10;
    cid := gen_random_uuid();
    deleted := CASE WHEN i % 37 = 0 THEN NOW() - INTERVAL '5 days' ELSE NULL END;
    goal_text := goal_cycle[1 + (i % 5)];
    base_date := CURRENT_DATE - 400;

    -- Caches. Bucket 3 is "legacy only": the cache is the only record.
    -- Bucket 4 deliberately disagrees with its owner.
    height_cache := CASE WHEN bucket IN (3, 4) THEN 160 + (i % 20) ELSE NULL END;
    weight_cache := CASE
      WHEN bucket = 3 THEN 70 + (i % 30)
      WHEN bucket = 4 THEN 90
      ELSE NULL
    END;

    INSERT INTO pt_clients (
      id, name, gender, dob, mobile, weight, height, body_fat, goal,
      injuries, health_conditions, occupation, workout_experience_level,
      sessions_per_week, status, deleted_at, organization_id, created_at)
    VALUES (
      cid, 'P4-' || lpad(i::text, 3, '0'),
      CASE i % 3 WHEN 0 THEN 'male' WHEN 1 THEN 'female' ELSE 'other' END,
      (DATE '1985-01-01' + i),
      '9' || lpad(i::text, 9, '0'),
      weight_cache, height_cache,
      CASE WHEN bucket = 3 THEN 22 + (i % 8) ELSE NULL END,
      CASE WHEN bucket IN (3, 4) THEN goal_text ELSE NULL END,
      CASE WHEN bucket IN (3, 4) THEN 'legacy knee note' ELSE NULL END,
      CASE WHEN bucket = 3 THEN 'legacy asthma note' WHEN bucket = 8 THEN 'legacy condition' ELSE NULL END,
      CASE WHEN bucket IN (3, 4) THEN 'desk_job' ELSE NULL END,
      CASE WHEN bucket = 3 THEN 'intermediate'
           WHEN bucket = 4 THEN 'advanced'
           WHEN bucket BETWEEN 0 AND 2 THEN 'intermediate' ELSE NULL END,
      CASE WHEN bucket = 3 OR bucket = 4 THEN 3
           WHEN bucket BETWEEN 0 AND 2 THEN 4 ELSE NULL END,
      CASE WHEN deleted IS NULL THEN 'active' ELSE 'inactive' END,
      deleted, org, NOW() - INTERVAL '2 years' - (i || ' days')::interval
    );

    -- ── Buckets 0–2: canonical-rich, everything has an owner ────────────
    IF bucket BETWEEN 0 AND 2 THEN
      d1 := base_date;
      d2 := base_date + 200;
      d3 := CURRENT_DATE - (i % 60);
      INSERT INTO pt_assessments
        (client_id, organization_id, assessment_date, assessment_type,
         weight, height_cm, body_fat_pct, bmi, created_at)
      VALUES
        (cid, org, d1, 'initial', 82 - (i % 5), 172, 26, 27.7, (d1 + 1)::timestamptz),
        (cid, org, d2, 'monthly', 79 - (i % 5), 172, 24, 26.7, (d2 + 1)::timestamptz),
        (cid, org, d3, 'follow_up', 76 - (i % 5), 172, 22, 25.7, (d3 + 1)::timestamptz);

      INSERT INTO pt_goals
        (client_id, organization_id, goal_type, is_active, status,
         motivation_level, motivation_reason, created_at)
      VALUES
        (cid, org, goal_text, TRUE, 'active', 8, 'Health and confidence',
         NOW() - INTERVAL '300 days');

      INSERT INTO pt_lifestyle_assessments
        (client_id, organization_id, assessment_date, assessment_number,
         sleep_duration_hours, sleep_category, occupation_type, screen_time_bracket,
         smoking_status, alcohol_status, drinks_per_week, workout_experience_level,
         food_preferences, meal_frequency, motivation_to_exercise, created_at)
      VALUES
        (cid, org, CURRENT_DATE - 10, 2, 7.5, 'good', 'desk_job', '4_6',
         'never', 'occasionally', 2, 'intermediate', ARRAY['vegetarian'], 4, 7,
         NOW() - INTERVAL '10 days');

      INSERT INTO pt_nutrition_assessments
        (client_id, organization_id, assessment_date, assessment_number,
         diet_preferences, meals_per_day, water_intake_liters,
         medical_conditions, meal_timing_consistency, created_at)
      VALUES
        (cid, org, CURRENT_DATE - 9, 2, ARRAY['vegetarian'], 4, 2.5,
         ARRAY['Asthma'], 'consistent', NOW() - INTERVAL '9 days');

      INSERT INTO pt_parq_forms
        (client_id, organization_id, assessment_date, assessment_number,
         full_name, status, risk_level, workout_gate_status, parq_yes_count,
         current_health, past_history, parq_answers, created_at)
      VALUES
        (cid, org, CURRENT_DATE - 300, 1, 'P4-' || lpad(i::text, 3, '0'),
         'reviewed', 'low', 'cleared', 0, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
         NOW() - INTERVAL '300 days');

      INSERT INTO pt_client_interviews
        (client_id, organization_id, status, completed_at, lifestyle_occupation,
         lifestyle_screen_time, lifestyle_smoking, lifestyle_alcohol,
         lifestyle_meal_regularity, lifestyle_training_days, created_at)
      VALUES
        (cid, org, 'completed', NOW() - INTERVAL '250 days', 'desk_job',
         '4_6', 'never', 'occasionally', 'regular', 4, NOW() - INTERVAL '250 days');

      INSERT INTO client_fitness_profiles
        (client_id, organization_id, goal, height_cm, diet_preference,
         fitness_level, health_conditions, created_at)
      VALUES
        (cid, org, NULL, 172, 'vegetarian', 'intermediate',
         ARRAY['stale profile condition'], NOW() - INTERVAL '400 days');

      INSERT INTO weekly_checkins
        (client_id, organization_id, week_start_date, weight, mood,
         sleep_hours, water_glasses, created_at)
      SELECT cid, org, CURRENT_DATE - (w * 7), 76 - (i % 5) + (w * 0.2), 'good', 7.5, 8,
             (CURRENT_DATE - (w * 7) + 1)::timestamptz
      FROM generate_series(1, 8) AS w;
    END IF;

    -- ── Bucket 3: legacy only. No owner row anywhere. ───────────────────
    IF bucket = 3 THEN
      INSERT INTO client_fitness_profiles
        (client_id, organization_id, goal, height_cm, fitness_level,
         health_conditions, injuries, diet_preference, created_at)
      VALUES
        (cid, org, goal_text, height_cache, 'intermediate',
         ARRAY['profile asthma'], 'profile knee', 'vegetarian',
         NOW() - INTERVAL '500 days');
    END IF;

    -- ── Bucket 4: owners and copies disagree on purpose ─────────────────
    IF bucket = 4 THEN
      INSERT INTO pt_assessments
        (client_id, organization_id, assessment_date, assessment_type,
         weight, height_cm, body_fat_pct, created_at)
      VALUES
        (cid, org, CURRENT_DATE - 30, 'follow_up', 80, 175, 20,
         NOW() - INTERVAL '30 days');

      INSERT INTO pt_goals
        (client_id, organization_id, goal_type, is_active, status, created_at)
      VALUES
        (cid, org, 'muscle_gain', TRUE, 'active', NOW() - INTERVAL '60 days');

      INSERT INTO client_fitness_profiles
        (client_id, organization_id, goal, height_cm, fitness_level,
         health_conditions, created_at)
      VALUES
        (cid, org, 'endurance', 160, 'beginner', ARRAY['profile condition'],
         NOW() - INTERVAL '90 days');

      INSERT INTO weekly_checkins
        (client_id, organization_id, week_start_date, weight, mood, created_at)
      VALUES
        (cid, org, CURRENT_DATE - 7, 75, 'okay', NOW() - INTERVAL '6 days');

      INSERT INTO pt_lifestyle_assessments
        (client_id, organization_id, assessment_date, assessment_number,
         smoking_status, alcohol_status, occupation_type, screen_time_bracket,
         workout_experience_level, food_preferences, meal_frequency, created_at)
      VALUES
        (cid, org, CURRENT_DATE - 20, 1, 'daily', 'weekly', 'active_job', '2_4',
         'advanced', ARRAY['vegetarian'], 3, NOW() - INTERVAL '20 days');

      INSERT INTO pt_client_interviews
        (client_id, organization_id, status, completed_at, lifestyle_occupation,
         lifestyle_screen_time, lifestyle_smoking, lifestyle_alcohol,
         lifestyle_meal_regularity, lifestyle_training_days, created_at)
      VALUES
        (cid, org, 'completed', NOW() - INTERVAL '40 days', 'desk_job',
         '8_plus', 'never', 'never', 'irregular', 2, NOW() - INTERVAL '40 days');

      INSERT INTO pt_parq_forms
        (client_id, organization_id, assessment_date, assessment_number,
         full_name, status, risk_level, workout_gate_status, parq_yes_count,
         current_health, past_history, parq_answers, created_at)
      VALUES
        (cid, org, CURRENT_DATE - 50, 1, 'P4-' || lpad(i::text, 3, '0'),
         'reviewed', 'medium', 'cleared', 1,
         '{"asthma":true}'::jsonb, '{"previous_injuries":"shoulder"}'::jsonb,
         '{"q1":true}'::jsonb, NOW() - INTERVAL '50 days');
    END IF;

    -- ── Bucket 5: the only measurement is over a year old ───────────────
    IF bucket = 5 THEN
      INSERT INTO pt_assessments
        (client_id, organization_id, assessment_date, assessment_type,
         weight, height_cm, created_at)
      VALUES
        (cid, org, CURRENT_DATE - 730, 'initial', 90, 170,
         NOW() - INTERVAL '730 days');
    END IF;

    -- ── Bucket 6: entered late about an older test ──────────────────────
    -- The June test was typed in September; the July test was typed the day
    -- after it was taken. created_at ordering picks the WRONG one.
    IF bucket = 6 THEN
      INSERT INTO pt_assessments
        (client_id, organization_id, assessment_date, assessment_type,
         weight, height_cm, created_at)
      VALUES
        -- Typed 20 days ago, about a test from five months ago. Under
        -- `ORDER BY created_at DESC` this row is the latest body.
        (cid, org, CURRENT_DATE - 150, 'follow_up', 80, 171,
         NOW() - INTERVAL '20 days'),
        (cid, org, CURRENT_DATE - 60, 'follow_up', 76, 172,
         NOW() - INTERVAL '59 days');
    END IF;

    -- ── Bucket 7: a check-in entered late about an older week ───────────
    IF bucket = 7 THEN
      INSERT INTO weekly_checkins
        (client_id, organization_id, week_start_date, weight, mood, created_at)
      VALUES
        -- The older week was typed ten days ago; the newer week was typed the
        -- day after it happened. Insertion order would pick the older week.
        (cid, org, CURRENT_DATE - 150, 73, 'good', NOW() - INTERVAL '10 days'),
        (cid, org, CURRENT_DATE - 20, 71, 'great', NOW() - INTERVAL '19 days');
    END IF;

    -- ── Bucket 8: only a DRAFT PAR-Q, plus a legacy medical list ────────
    IF bucket = 8 THEN
      INSERT INTO pt_parq_forms
        (client_id, organization_id, assessment_date, assessment_number,
         full_name, status, risk_level, workout_gate_status, parq_yes_count,
         current_health, past_history, parq_answers, created_at)
      VALUES
        (cid, org, CURRENT_DATE - 5, 1, 'P4-' || lpad(i::text, 3, '0'),
         'draft', 'medium', 'cleared', 1,
         '{"asthma":true}'::jsonb, '{}'::jsonb, '{}'::jsonb,
         NOW() - INTERVAL '5 days');

      INSERT INTO pt_nutrition_assessments
        (client_id, organization_id, assessment_date, assessment_number,
         diet_preferences, meals_per_day, medical_conditions, created_at)
      VALUES
        (cid, org, CURRENT_DATE - 4, 1, ARRAY['non_vegetarian'], 3,
         ARRAY['Migraine'], NOW() - INTERVAL '4 days');
    END IF;

    -- ── Bucket 9: identity only. Nothing else recorded. ─────────────────
    -- (No rows to insert; the client row above is the whole record.)

    -- Same-date tie: insertion time decides. Applies across buckets.
    IF i % 50 = 0 THEN
      INSERT INTO pt_assessments
        (client_id, organization_id, assessment_date, assessment_type,
         weight, height_cm, created_at)
      VALUES
        (cid, org, CURRENT_DATE - 3, 'follow_up', 70, 170,
         NOW() - INTERVAL '2 days'),
        (cid, org, CURRENT_DATE - 3, 'follow_up', 72, 170,
         NOW() - INTERVAL '1 day');
    END IF;

    -- Two active goals: the newest created_at is the current goal.
    IF i % 20 = 0 THEN
      INSERT INTO pt_goals
        (client_id, organization_id, goal_type, is_active, status, created_at)
      VALUES
        (cid, org, 'endurance', TRUE, 'active', NOW() - INTERVAL '10 days');
    END IF;

    -- Legacy measurement series. Read-only, no writer in production.
    IF bucket IN (0, 2, 5) THEN
      INSERT INTO pt_os_measurements (client_id, weight_kg, measured_at, created_at)
      VALUES
        (cid, 77, NOW() - INTERVAL '120 days', NOW() - INTERVAL '120 days');
    END IF;

    -- Mobility / posture: D18 and the clinical screens.
    IF bucket IN (0, 1) THEN
      INSERT INTO pt_mobility_performance_assessments
        (client_id, organization_id, assessment_date, assessment_number,
         sit_reach_cm, mobility_score, mobility_category, created_at)
      VALUES
        (cid, org, CURRENT_DATE - 200, 1, 24, 62, 'fair', NOW() - INTERVAL '200 days');

      INSERT INTO pt_posture_assessments
        (client_id, organization_id, assessment_date, assessment_number,
         posture_risk_score, posture_risk_level, created_at)
      VALUES
        (cid, org, CURRENT_DATE - 200, 1, 3, 'low', NOW() - INTERVAL '200 days');
    END IF;
  END LOOP;

  -- Fitness owns sit-and-reach; the mobility copy is the legacy leg of D18.
  UPDATE pt_assessments a
     SET flexibility_test_data = '{"sit_reach_in": 9.5, "protocol": "standard"}'::jsonb
    FROM pt_clients c
   WHERE c.id = a.client_id AND c.organization_id = org_a
     AND c.name IN ('P4-001', 'P4-002', 'P4-011', 'P4-012');

  -- D19: one assessment-linked 1RM, one free-standing, and one genuine
  -- duplicate that disagrees with itself on the same day.
  INSERT INTO strength_logs
    (client_id, organization_id, exercise_name, weight_kg, reps_done,
     one_rm_estimate, one_rm_formula, is_direct_1rm, log_date, assessment_id, created_at)
  SELECT c.id, org_a, 'Back Squat', 100, 5, 112.5, 'epley', FALSE,
         CURRENT_DATE - 30, a.id, NOW() - INTERVAL '30 days'
  FROM pt_clients c
  JOIN pt_assessments a ON a.client_id = c.id
  WHERE c.organization_id = org_a AND c.name = 'P4-001'
  LIMIT 1;

  INSERT INTO strength_logs
    (client_id, organization_id, exercise_name, weight_kg, reps_done,
     one_rm_estimate, one_rm_formula, is_direct_1rm, log_date, created_at)
  SELECT c.id, org_a, 'Deadlift', 120, 3, 130, 'epley', FALSE,
         CURRENT_DATE - 20, NOW() - INTERVAL '20 days'
  FROM pt_clients c WHERE c.organization_id = org_a AND c.name = 'P4-002';

  INSERT INTO strength_logs
    (client_id, organization_id, exercise_name, weight_kg, reps_done,
     one_rm_estimate, one_rm_formula, is_direct_1rm, log_date, created_at)
  SELECT c.id, org_a, 'Bench Press', 80, 5, 90, 'epley', FALSE,
         CURRENT_DATE - 10, NOW() - INTERVAL '10 days'
  FROM pt_clients c WHERE c.organization_id = org_a AND c.name = 'P4-002';
  INSERT INTO strength_logs
    (client_id, organization_id, exercise_name, weight_kg, reps_done,
     one_rm_estimate, one_rm_formula, is_direct_1rm, log_date, created_at)
  SELECT c.id, org_a, 'Bench Press', 82.5, 5, 92.5, 'epley', FALSE,
         CURRENT_DATE - 10, NOW() - INTERVAL '10 days'
  FROM pt_clients c WHERE c.organization_id = org_a AND c.name = 'P4-002';

  -- D20/D21: one 7-key historical PAR-Q attestation and one 10-key informed
  -- consent per selected client. P4-001's PAR-Q gate is blocked and its
  -- physician objected: the two independent gates must both be visible.
  INSERT INTO pt_consent_records
    (parq_form_id, client_id, organization_id, consent_checkboxes,
     client_signature, trainer_signature, client_signed_at, trainer_signed_at, created_at)
  SELECT q.id, q.client_id, q.organization_id,
         '{"understands_risk":true,"accurate_medical_history":true,"will_inform_pain":true,
           "will_stop_if_dizzy":true,"will_stop_if_chest_pain":true,
           "will_communicate_changes":true,"will_follow_instructions":true}'::jsonb,
         'data:image/png;base64,legacy', 'data:image/png;base64,legacy',
         NOW() - INTERVAL '300 days', NOW() - INTERVAL '300 days', NOW() - INTERVAL '300 days'
  FROM pt_parq_forms q
  JOIN pt_clients c ON c.id = q.client_id
  WHERE c.organization_id = org_a AND c.name IN ('P4-001', 'P4-002');

  INSERT INTO pt_informed_consents
    (client_id, organization_id, full_name, gender, dob, mobile, status,
     acknowledgements, physician_advised_against, physician_name, hospital,
     medical_condition, client_signature, trainer_signature,
     client_signed_at, trainer_signed_at, completed_at, created_at)
  SELECT c.id, org_a, c.name, c.gender, c.dob, c.mobile, 'completed',
         '{"understands_risk":true,"accurate_medical_history":true,"will_inform_pain":true,
           "will_stop_if_dizzy":true,"will_stop_if_chest_pain":true,
           "will_communicate_changes":true,"will_follow_instructions":true,
           "understands_confidentiality":true,"voluntary_participation":true,
           "final_declaration":true}'::jsonb,
         (c.name = 'P4-001'), CASE WHEN c.name = 'P4-001' THEN 'Dr Rao' END,
         CASE WHEN c.name = 'P4-001' THEN 'City Hospital' END,
         CASE WHEN c.name = 'P4-001' THEN 'Hypertension' END,
         'data:image/png;base64,client', 'data:image/png;base64,trainer',
         NOW() - INTERVAL '299 days', NOW() - INTERVAL '299 days',
         NOW() - INTERVAL '299 days', NOW() - INTERVAL '299 days'
  FROM pt_clients c
  WHERE c.organization_id = org_a AND c.name IN ('P4-001', 'P4-002');

  UPDATE pt_parq_forms q
     SET workout_gate_status = 'blocked', risk_level = 'high', parq_yes_count = 2
    FROM pt_clients c
   WHERE c.id = q.client_id AND c.organization_id = org_a AND c.name = 'P4-001';

  -- Audit trail for the soft-deleted clients and one hard-deleted test, so
  -- deletion is provably traceable in the audit.
  INSERT INTO activity_log
    (user_id, user_name, action, entity_type, entity_id, new_data, organization_id, created_at)
  SELECT user_a, 'Phase 4 Auditor A', 'client.delete', 'pt_client', c.id,
         jsonb_build_object('reason', 'phase4 fixture'), org_a,
         COALESCE(c.deleted_at, NOW())
  FROM pt_clients c
  WHERE c.organization_id = org_a AND c.deleted_at IS NOT NULL;

  INSERT INTO activity_log
    (user_id, user_name, action, entity_type, entity_id, new_data, organization_id, created_at)
  SELECT user_a, 'Phase 4 Auditor A', 'assessment.delete', 'pt_assessment',
         gen_random_uuid()::text,
         jsonb_build_object('client_id', c.id, 'assessment_date', CURRENT_DATE - 400),
         org_a, NOW() - INTERVAL '1 day'
  FROM pt_clients c
  WHERE c.organization_id = org_a AND c.name = 'P4-001';
END $$;
