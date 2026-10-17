-- 228 — Lifestyle & Training Readiness section for Client Interview
-- 8 structured fields consolidated from Lifestyle Assessment, PAR-Q, Goal,
-- and Intake forms. Existing columns on pt_lifestyle_assessments, pt_parq_forms,
-- pt_goals, pt_nutrition_assessments, pt_clients are preserved untouched.

ALTER TABLE pt_client_interviews
  ADD COLUMN IF NOT EXISTS lifestyle_occupation TEXT,
  ADD COLUMN IF NOT EXISTS lifestyle_sitting_hours NUMERIC(4,1),
  ADD COLUMN IF NOT EXISTS lifestyle_screen_time TEXT CHECK (lifestyle_screen_time IS NULL OR lifestyle_screen_time IN ('<2','2_4','4_6','6_8','8_plus')),
  ADD COLUMN IF NOT EXISTS lifestyle_sleep_hours NUMERIC(3,1),
  ADD COLUMN IF NOT EXISTS lifestyle_meal_regularity TEXT CHECK (lifestyle_meal_regularity IS NULL OR lifestyle_meal_regularity IN ('regular','irregular','inconsistent')),
  ADD COLUMN IF NOT EXISTS lifestyle_smoking TEXT CHECK (lifestyle_smoking IS NULL OR lifestyle_smoking IN ('never','occasionally','daily','former')),
  ADD COLUMN IF NOT EXISTS lifestyle_alcohol TEXT CHECK (lifestyle_alcohol IS NULL OR lifestyle_alcohol IN ('never','occasionally','weekly','frequently')),
  ADD COLUMN IF NOT EXISTS lifestyle_training_days SMALLINT CHECK (lifestyle_training_days IS NULL OR lifestyle_training_days BETWEEN 3 AND 6);

COMMENT ON COLUMN pt_client_interviews.lifestyle_occupation IS 'Consolidated: desk_job/active_job/physical_labor/student/homemaker/driver/healthcare/police/fitness_professional/retired/other';
COMMENT ON COLUMN pt_client_interviews.lifestyle_sitting_hours IS 'Consolidated from PAR-Q past_history.daily_sitting_hours';
COMMENT ON COLUMN pt_client_interviews.lifestyle_screen_time IS 'Consolidated from lifestyle_assessment.screen_time_bracket';
COMMENT ON COLUMN pt_client_interviews.lifestyle_sleep_hours IS 'Consolidated from lifestyle_assessment.sleep_duration_hours';
COMMENT ON COLUMN pt_client_interviews.lifestyle_meal_regularity IS 'Consolidated from nutrition.assessment.meal_frequency / breakfast_regularity';
COMMENT ON COLUMN pt_client_interviews.lifestyle_smoking IS 'Consolidated from lifestyle_assessment.smoking_status';
COMMENT ON COLUMN pt_client_interviews.lifestyle_alcohol IS 'Consolidated from lifestyle_assessment.alcohol_status';
COMMENT ON COLUMN pt_client_interviews.lifestyle_training_days IS 'Consolidated from plans/goal frequency (3-6 days/week)';
