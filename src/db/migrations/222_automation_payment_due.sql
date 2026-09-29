-- ─────────────────────────────────────────────────────────────────────────
-- 222 — A reminder for money a client still owes
-- ─────────────────────────────────────────────────────────────────────────
--
-- From the WhatsApp automation audit: a PT studio's most common chase is an
-- outstanding balance, and none of the twelve trigger events could send one.
-- Production had five clients with balance_amount > 0 and no way to remind
-- them short of typing each message by hand.
--
-- `payment_due` is produced by the daily sweep (automation.sweep.js) for
-- clients whose balance is above zero, at most once a week per client while
-- the balance stays unpaid. The engine's TRIGGER_EVENTS lists the same
-- values, and automation.engine.test.js asserts the two agree.
--
-- Idempotent; safe to re-run.

ALTER TABLE automation_rules DROP CONSTRAINT IF EXISTS automation_rules_trigger_event_check;
ALTER TABLE automation_rules
  ADD CONSTRAINT automation_rules_trigger_event_check
  CHECK (trigger_event IN (
    'member_created', 'lead_created', 'followup_due', 'membership_expiring',
    'membership_expired', 'payment_received', 'session_low', 'birthday',
    'anniversary', 'attendance_missed', 'trial_scheduled', 'trial_completed',
    'payment_due'
  ));
