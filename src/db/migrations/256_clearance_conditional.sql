-- Conditional medical clearance.
--
-- `workout_gate_status` was binary: a client was either cleared or blocked.
-- That forced every "yes" answer a trainer had not yet reviewed into one of
-- two wrong answers — blocked (which stops a client who may train with
-- restrictions) or cleared (which hides the open question).
--
-- `conditional` is the third state: training may proceed, but only while the
-- restrictions recorded on the PAR-Q are carried into the programme. The
-- stored value is recomputed by parq.routes.js on every form/clearance write.
--
-- Additive only: no row is rewritten here. Existing `cleared`/`blocked` rows
-- keep their value until their form is next written, at which point a medium
-- risk form that has not been reviewed becomes `conditional`.

ALTER TABLE pt_parq_forms
  DROP CONSTRAINT IF EXISTS pt_parq_forms_gate_status_check;

ALTER TABLE pt_parq_forms
  ADD CONSTRAINT pt_parq_forms_gate_status_check
  CHECK (workout_gate_status IN ('blocked', 'cleared', 'conditional'));
