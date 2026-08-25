-- ============================================================
-- 181_ai_client_memory.sql
--
-- Phase 2B — Durable client memory for AI coaching.
--
-- Two tables:
--   ai_client_memory    — semantic (durable facts: preferences,
--                          constraints, observations, goals)
--   ai_client_episodes  — episodic (notable events: PRs achieved,
--                          programme changes, injury reports, milestones)
--
-- Working memory (ai_conversations / ai_messages) is untouched.
--
-- LIFECYCLE for semantic memory:
--   candidate → confirmed → active → stale/superseded → deleted
--
-- SAFETY:
--   - Every row is organization_id + client_id scoped.
--   - source_type + source_id required for provenance.
--   - The LLM never directly creates CONFIRMED/ACTIVE memory.
--     AI-generated memory enters as 'candidate' only.
--   - Authoritative DB facts and explicitly confirmed trainer/client
--     information may enter as 'active' directly.
--
-- PRIVACY:
--   - Medical/sensitive data uses category='medical' and is only
--     surfaced to routes that already have authorization for it.
--   - No prompt/response text stored.
-- ============================================================

-- ── SEMANTIC MEMORY ─────────────────────────────────────────────
-- Durable facts about a client confirmed by trainer or derived from DB.

CREATE TABLE IF NOT EXISTS ai_client_memory (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id       UUID NOT NULL REFERENCES pt_clients(id) ON DELETE CASCADE,

  -- Classification
  category        TEXT NOT NULL CHECK (category IN (
                    'preference', 'constraint', 'observation',
                    'goal', 'medical', 'schedule', 'equipment'
                  )),
  subcategory     TEXT,          -- 'exercise' | 'nutrition' | 'scheduling' | 'recovery' | NULL

  -- The fact
  fact            TEXT NOT NULL, -- human-readable, e.g. "Prefers morning workouts"
  confidence      REAL NOT NULL DEFAULT 1.0 CHECK (confidence >= 0.0 AND confidence <= 1.0),

  -- Source tracking (provenance)
  source_type     TEXT NOT NULL CHECK (source_type IN (
                    'trainer_confirmed', 'client_reported',
                    'db_derived', 'assessment', 'system_observed'
                  )),
  source_id       TEXT,          -- row id or reference for audit trail
  source_text     TEXT,          -- original text if derived from conversation

  -- Lifecycle
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN (
                    'candidate', 'active', 'stale', 'superseded', 'deleted'
                  )),
  verified_at     TIMESTAMPTZ,   -- last time confirmed true
  superseded_by   UUID REFERENCES ai_client_memory(id), -- which memory replaced this one
  expires_at      TIMESTAMPTZ,   -- optional TTL

  -- Audit
  created_by      TEXT,          -- user_id or 'system'
  as_of           DATE,          -- date the fact pertains to

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fast lookup: active memories for a specific client in a specific org.
-- Partial index — only active rows consume index space.
CREATE INDEX IF NOT EXISTS idx_ai_client_memory_lookup
  ON ai_client_memory (client_id, organization_id, category)
  WHERE status = 'active';

-- Conflict detection: find other active memories for same client + category
-- to surface potential duplicates during creation.
CREATE INDEX IF NOT EXISTS idx_ai_client_memory_conflict
  ON ai_client_memory (client_id, organization_id, category, subcategory)
  WHERE status = 'active';

-- Expiration sweep: find memories that have passed their TTL.
CREATE INDEX IF NOT EXISTS idx_ai_client_memory_expiring
  ON ai_client_memory (expires_at)
  WHERE status = 'active' AND expires_at IS NOT NULL;

COMMENT ON TABLE  public.ai_client_memory IS
  'Phase 2B — Durable semantic memory for AI coaching. Facts about clients confirmed by trainers or derived from authoritative DB data. The LLM never directly writes active memory.';
COMMENT ON COLUMN public.ai_client_memory.category IS
  'Fact classification: preference, constraint, observation, goal, medical, schedule, equipment.';
COMMENT ON COLUMN public.ai_client_memory.source_type IS
  'Provenance: trainer_confirmed, client_reported, db_derived, assessment, system_observed.';
COMMENT ON COLUMN public.ai_client_memory.status IS
  'Lifecycle: candidate → active → stale/superseded → deleted. AI-generated entries start as candidate.';
COMMENT ON COLUMN public.ai_client_memory.superseded_by IS
  'If this memory was replaced by a newer one, points to the replacing record. NULL if current.';

-- ── EPISODIC MEMORY ─────────────────────────────────────────────
-- Notable events in the coaching relationship. Immutable once written;
-- lifecycle managed via status field.

CREATE TABLE IF NOT EXISTS ai_client_episodes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id       UUID NOT NULL REFERENCES pt_clients(id) ON DELETE CASCADE,

  -- The event
  episode_type    TEXT NOT NULL CHECK (episode_type IN (
                    'programme_change', 'pr_achieved', 'injury_reported',
                    'deload', 'assessment', 'milestone', 'observation',
                    'session_completed', 'coach_decision', 'client_feedback'
                  )),
  title           TEXT NOT NULL, -- short summary
  detail          TEXT,          -- full description

  -- Context
  week_number     INTEGER,       -- programme week when this happened
  session_date    DATE,          -- date if session-specific

  -- Source
  source_type     TEXT NOT NULL CHECK (source_type IN (
                    'workout_log', 'trainer_note', 'assessment',
                    'checkin', 'system_detected', 'ai_detected'
                  )),
  source_id       TEXT,          -- row id for audit trail

  -- Classification
  severity        TEXT DEFAULT 'info' CHECK (severity IN (
                    'info', 'warning', 'significant'
                  )),

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Episode history for a specific client.
CREATE INDEX IF NOT EXISTS idx_ai_client_episodes_lookup
  ON ai_client_episodes (client_id, organization_id, created_at DESC);

-- Fast lookup by episode type (for "show me all PRs" or "show me all deloads").
CREATE INDEX IF NOT EXISTS idx_ai_client_episodes_type
  ON ai_client_episodes (client_id, organization_id, episode_type, created_at DESC);

COMMENT ON TABLE  public.ai_client_episodes IS
  'Phase 2B — Episodic memory for AI coaching. Notable events in the coaching relationship (PRs, programme changes, injuries, milestones). Immutable once written.';
COMMENT ON COLUMN public.ai_client_episodes.episode_type IS
  'Event classification: programme_change, pr_achieved, injury_reported, deload, assessment, milestone, observation, session_completed, coach_decision, client_feedback.';
COMMENT ON COLUMN public.ai_client_episodes.source_type IS
  'Provenance: workout_log, trainer_note, assessment, checkin, system_detected, ai_detected.';
