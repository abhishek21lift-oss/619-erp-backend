-- ============================================================
-- 180_voice_workout_drafts.sql
-- Siri Phase 5 — the first WRITE on the voice surface.
--
-- "Hey Siri, create a workout for Rahul" must never save anything. It
-- prepares a draft; a second, explicit confirmation saves it. This table is
-- what makes that two-step real rather than cosmetic.
--
-- ── Why the draft is stored SERVER-SIDE and not handed to the caller ──
--
-- The obvious implementation returns the generated plan to the phone and has
-- /confirm accept it back. That is not a confirmation step — it is an
-- unauthenticated plan-creation endpoint with an extra round trip, because
-- whatever comes back is whatever the caller chose to send. Every safety
-- decision made during preparation (the PAR-Q gate, the contraindication
-- filter, the library validation) would be advisory.
--
-- So the draft is written here, and /confirm takes ONE id. The exercises it
-- saves are the ones this server generated and checked; there is no field on
-- the confirm request that can introduce an exercise.
--
-- ── Single use, by construction ──────────────────────────────────────
--
-- `status` starts 'pending' and /confirm claims it with
--   UPDATE … SET status='confirmed' WHERE id=$1 AND status='pending'
-- inside the same transaction that inserts the plan. Two confirmations racing
-- each other produce one plan and one 409: the row can only be claimed once,
-- and the losing transaction never reaches the INSERT.
--
-- ── Why it expires ───────────────────────────────────────────────────
--
-- A draft is a proposal about a person's body made from facts read at one
-- moment — their PAR-Q status, their injuries, their current programme. A
-- confirmation arriving a week later would save a plan built from a week-old
-- reading of all three. The gate is re-run at confirm time as well, but a
-- short TTL means the question Siri asked is still the question being
-- answered.
-- ============================================================

CREATE TABLE IF NOT EXISTS voice_workout_drafts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Tenancy, stamped from the SESSION at prepare time and re-checked at
  -- confirm time. NOT NULL: a draft that cannot say which studio it belongs
  -- to is a draft nobody may confirm.
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id        TEXT NOT NULL REFERENCES pt_clients(id) ON DELETE CASCADE,

  -- Who asked. A draft is confirmable only by the account that prepared it —
  -- a colleague must not be able to complete a write somebody else started,
  -- even inside the same studio.
  created_by       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','confirmed','discarded')),

  -- The generated plan, exactly as it will be saved: plan metadata and the
  -- resolved exercise rows, every exercise_id already checked against the
  -- live library and already filtered for contraindications.
  draft            JSONB NOT NULL,

  -- 'ai' when a model chose the exercises, 'derived' when the deterministic
  -- library selection did. Recorded because "who chose this exercise for this
  -- injured client" is the first question anyone will ask.
  source           TEXT NOT NULL DEFAULT 'derived',

  -- The safety work, kept for audit rather than recomputed later: paperwork
  -- warnings raised at preparation, and every exercise the contraindication
  -- filter removed together with the reason.
  screening_warnings TEXT[] NOT NULL DEFAULT '{}',
  excluded         JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Set when confirmation actually saved something.
  workout_plan_id  TEXT REFERENCES workout_plans(id) ON DELETE SET NULL,
  confirmed_at     TIMESTAMPTZ,

  expires_at       TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The confirm path looks a draft up by id and then filters on org + creator +
-- status, so the id alone is never the whole key.
CREATE INDEX IF NOT EXISTS vwd_org_status_idx
  ON voice_workout_drafts (organization_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS vwd_client_idx
  ON voice_workout_drafts (client_id, created_at DESC);

-- Lets a future cleanup job find lapsed drafts without a full scan. Nothing
-- deletes them today: an unconfirmed draft is a record of a workout somebody
-- was offered and did not save, which is worth keeping.
CREATE INDEX IF NOT EXISTS vwd_expiry_idx
  ON voice_workout_drafts (expires_at)
  WHERE status = 'pending';


-- ─── RLS ─────────────────────────────────────────────────────
-- The repo convention (asserted by src/__tests__/rls.convention.test.js):
-- every new table is unreachable through PostgREST with the publishable key,
-- so the API and its tenant checks are the only way in.
--
-- It matters more here than on most tables. A draft holds a proposed training
-- plan and the exercises the safety filter withheld; direct read access would
-- expose which clients were flagged, and direct WRITE access would let someone
-- author a draft and then confirm it through the API — walking straight past
-- the PAR-Q gate and the contraindication filter, which run on the way IN.
ALTER TABLE voice_workout_drafts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON voice_workout_drafts FROM anon, authenticated;
DROP POLICY IF EXISTS deny_all_direct_access ON voice_workout_drafts;
CREATE POLICY deny_all_direct_access ON voice_workout_drafts
  FOR ALL USING (false) WITH CHECK (false);
