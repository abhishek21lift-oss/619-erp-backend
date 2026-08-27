-- ai_action_plans grows one column: the exact drafted text an operator
-- approved, frozen at plan time, for actions whose message is now
-- LLM-drafted rather than a fixed template (renewal_reminders, from this
-- migration on — see modules/ai-actions/registry.js).
--
-- Why this can't just be re-derived at execute the way the rest of the plan
-- already is: 152's design re-runs resolve() at execute and refuses on a
-- fingerprint mismatch, specifically so a stale plan can't be run against a
-- client list that moved. That works because a fixed template is the same
-- string every time it's computed. An LLM draft is not — asking the model
-- again would almost certainly return different wording than what the
-- operator read and approved, which would make the fingerprint check refuse
-- a perfectly good plan on every single execute, or force a fuzzy compare
-- that stops meaning "this is exactly what was approved". So the drafted
-- text is generated once, at plan time, stored here, and execute freezes it
-- — it still re-resolves *eligibility* fresh (who currently qualifies), just
-- never re-drafts the words.
--
-- NULL for every plan that isn't model-backed (dues_reminders, and every
-- renewal_reminders plan created before this migration) — those keep working
-- exactly as before, computing body straight from resolve()'s templateBody.

DO $$
BEGIN
  IF to_regclass('public.ai_action_plans') IS NOT NULL THEN
    ALTER TABLE ai_action_plans
      ADD COLUMN IF NOT EXISTS resolved_recipients JSONB;
  END IF;
END $$;
