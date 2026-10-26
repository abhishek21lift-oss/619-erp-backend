-- 238_diet_assignment_active_unique.sql
-- A client may hold one ACTIVE assignment per template, but history rows for
-- the same template must be allowed to repeat. The old
-- UNIQUE (diet_template_id, client_id, status) made re-assigning a template
-- after ending it collide with the completed row.
ALTER TABLE diet_assignments
  DROP CONSTRAINT IF EXISTS diet_assignments_diet_template_id_client_id_status_key;

CREATE UNIQUE INDEX IF NOT EXISTS diet_assignments_active_unique
  ON diet_assignments (diet_template_id, client_id)
  WHERE status = 'active';
