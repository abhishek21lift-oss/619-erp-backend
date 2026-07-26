-- ============================================================
-- 111_whiteboards.sql
--
-- Whiteboard / annotation canvases, phase 1.
--
-- ── Storage model ───────────────────────────────────────────
-- The document is stored as ONE opaque JSONB snapshot per board,
-- not as a row per shape. That is deliberate:
--
--   * The canvas engine (Excalidraw) owns the document format and
--     its own undo/redo and reconciliation. Shredding that into
--     SQL rows means re-implementing it, badly.
--   * A board of 3,000 shapes is one row to read, not 3,000. Every
--     drag would otherwise be a write amplification event.
--   * The format is versioned by the engine; a normalised schema
--     would need a migration every time the engine adds a shape
--     property.
--
-- What we DO extract relationally is the part the application
-- needs to query: which entity the board belongs to, who touched
-- it, and the text inside it (so global search can find a board by
-- what is written on it). `search_text` is maintained by the
-- application on save — see whiteboard.service.js extractText().
--
-- ── Concurrency ─────────────────────────────────────────────
-- `document_version` is a monotonically increasing counter used
-- for optimistic concurrency. A save must present the version it
-- read; a mismatch means someone else saved first and the client
-- is told to reconcile rather than silently clobbering. Real-time
-- multi-cursor collaboration is a later phase — this is what keeps
-- two tabs from destroying each other in the meantime.
--
-- ── Scope ───────────────────────────────────────────────────
-- Boards attach to any entity via (entity_type, entity_id) rather
-- than a hard FK per module, so attaching boards to sessions,
-- exercises or staff later needs no schema change. entity_id is
-- TEXT to match this schema's mixed id types (users.id is TEXT,
-- pt_clients.id is UUID) and is deliberately NOT a foreign key —
-- a polymorphic FK is not expressible in Postgres. Referential
-- integrity for the one type in use today (pt_client) is enforced
-- in the service layer, which checks tenant ownership anyway.
-- ============================================================

-- ── Boards ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS whiteboards (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  title            TEXT NOT NULL,
  -- Polymorphic owner. NULL entity = a standalone board that lives
  -- only in the boards dashboard.
  entity_type      TEXT CHECK (entity_type IS NULL OR entity_type IN (
                     'pt_client', 'session', 'exercise', 'staff', 'course', 'consultation'
                   )),
  entity_id        TEXT,

  -- Engine document snapshot. Shape of the payload belongs to the
  -- canvas engine; the server never interprets it beyond size limits.
  document         JSONB NOT NULL DEFAULT '{"elements":[],"appState":{}}'::jsonb,
  document_version INTEGER NOT NULL DEFAULT 0,

  -- Flattened text of every text/label element, for search.
  search_text      TEXT NOT NULL DEFAULT '',
  thumbnail_key    TEXT,

  status           TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'archived')),

  created_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by       TEXT REFERENCES users(id) ON DELETE SET NULL,

  deleted_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Present because the shared set_updated_at() trigger below writes
  -- it. A table that gets the trigger without this column breaks on
  -- every UPDATE — that exact bug shipped once already (migration 108).
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The list query: "boards for this client, newest first".
CREATE INDEX IF NOT EXISTS idx_whiteboards_entity
  ON whiteboards (organization_id, entity_type, entity_id, updated_at DESC)
  WHERE deleted_at IS NULL;

-- The dashboard query: "recent boards in this studio".
CREATE INDEX IF NOT EXISTS idx_whiteboards_org_recent
  ON whiteboards (organization_id, updated_at DESC)
  WHERE deleted_at IS NULL;

-- Search by title / canvas text. Trigram, matching the approach
-- migration 105 took for client search (substring matches, not just
-- whole words — a trainer types "squa" and expects "Squat").
CREATE INDEX IF NOT EXISTS idx_whiteboards_title_trgm
  ON whiteboards USING GIN (title gin_trgm_ops)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_whiteboards_search_text_trgm
  ON whiteboards USING GIN (search_text gin_trgm_ops)
  WHERE deleted_at IS NULL;

-- ── Version history ─────────────────────────────────────────
-- Append-only snapshots. Written on an explicit "save version"
-- and by the autosave throttle (at most one per interval), never
-- on every keystroke — otherwise this table grows without bound.
CREATE TABLE IF NOT EXISTS whiteboard_versions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  whiteboard_id    UUID NOT NULL REFERENCES whiteboards(id) ON DELETE CASCADE,
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  document         JSONB NOT NULL,
  document_version INTEGER NOT NULL,
  label            TEXT,

  created_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whiteboard_versions_board
  ON whiteboard_versions (whiteboard_id, created_at DESC);

-- ── Attachments ─────────────────────────────────────────────
-- Images/PDFs dropped onto a board. The bytes live in R2 (or the
-- local-disk fallback); this table is the ownership record that
-- makes authorising a download possible.
CREATE TABLE IF NOT EXISTS whiteboard_attachments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  whiteboard_id    UUID NOT NULL REFERENCES whiteboards(id) ON DELETE CASCADE,
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  file_key         TEXT NOT NULL,
  file_name        TEXT NOT NULL,
  mime_type        TEXT NOT NULL,
  size_bytes       INTEGER NOT NULL CHECK (size_bytes > 0),

  created_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whiteboard_attachments_board
  ON whiteboard_attachments (whiteboard_id, created_at DESC);

-- ── updated_at trigger ──────────────────────────────────────
DROP TRIGGER IF EXISTS trg_whiteboards_updated_at ON whiteboards;
CREATE TRIGGER trg_whiteboards_updated_at
  BEFORE UPDATE ON whiteboards
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── RLS: deny all direct PostgREST access ───────────────────
-- Same rule as every other tenant table in this schema (059, 090,
-- 100, 104): these are reachable only through the Express API,
-- which connects as a BYPASSRLS role and does its own tenant
-- scoping. Boards can hold clinical annotations, so they are not
-- becoming the next gap in that policy.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['whiteboards', 'whiteboard_versions', 'whiteboard_attachments'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS deny_all_direct_access ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY deny_all_direct_access ON public.%I '
      'AS PERMISSIVE FOR ALL TO anon, authenticated '
      'USING (false) WITH CHECK (false)', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
  END LOOP;
END $$;
