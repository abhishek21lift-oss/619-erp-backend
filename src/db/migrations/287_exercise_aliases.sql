-- 287_exercise_aliases.sql
-- A second name for an exercise the library already holds.
--
-- ── Why names alone were not enough ───────────────────────────────────────
--
-- The AI workout path resolves every free-text name against the library by
-- NORMALISED EXACT NAME (client-context.js), and that rule stays: trigram
-- similarity resolved "Overhead Press" to "Overhead Lat" at 0.474, which would
-- clear a shoulder-loading press through a lat row for a client with shoulder
-- pain. But exact matching cannot know that trainers write the same movement
-- under a different name. Production's historical misses were exactly that:
--
--   Barbell Bench Press   → the library's row is "Bench Press" (Barbell)
--   Barbell Back Squat    → "Barbell Squat" (Barbell)
--   Seated Cable Row      → "Seated Cable Rows" (plural)
--   Dumbbell Lateral Raise→ "Lateral Raise" (Dumbbell)
--   Overhead Press        → "Barbell Shoulder Press" (the library's plain
--                           "Shoulder Press" row is explicitly Dumbbell)
--
-- Those are synonyms, not typos and not missing exercises. An alias row is the
-- narrow fix: the resolver still resolves to exactly one library row, and an
-- alias is only honoured when somebody wrote it down.
--
-- "Bulgarian Split Squat" is deliberately NOT seeded. The library has no
-- rear-foot-elevated split squat; its nearest rows are "Split Squats" and
-- "Split Squat with Dumbbells", which are different movements. Filing it under
-- either would silently prescribe an exercise the trainer did not name. It
-- stays unverified until a trainer creates it — the same visible failure the
-- audit already reports.
--
-- ── Scope ─────────────────────────────────────────────────────────────────
--
-- organization_id NULL means a built-in alias, visible to every studio, in the
-- same way exercises.organization_id NULL is the shared library. A studio may
-- add its own alias for the same words pointing at its own custom exercise; the
-- resolver prefers the studio's row over the global one (see
-- lookupExercisesByName). Two aliases in the SAME scope may not normalise onto
-- the same text — that would make resolution arbitrary — which the partial
-- unique indexes below enforce.
--
-- No API writes this table yet: aliases ship seeded, and a trainer-facing
-- authoring surface is a later change. The tenant policy is therefore
-- read-mostly in practice, but the write policies are scoped rather than
-- absent so that adding the surface does not require another migration.
--
-- Idempotent: CREATE/INDEX IF NOT EXISTS, DROP POLICY IF EXISTS, and the seed
-- inserts skip aliases that already exist. No rows are read, updated or
-- deleted. migrate.js owns the transaction.

CREATE TABLE IF NOT EXISTS exercise_aliases (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  exercise_id     TEXT NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
  -- NULL = built-in alias shared by every studio.
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  alias           TEXT NOT NULL,
  -- The same fold the resolver applies in SQL and JS. Generated, not written
  -- by callers, so an app-side typo cannot make an alias unreachable.
  normalized      TEXT GENERATED ALWAYS AS (
                    btrim(regexp_replace(lower(btrim(alias)), '[^a-z0-9]+', ' ', 'g'))
                  ) STORED,
  created_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT exercise_aliases_alias_length
    CHECK (char_length(btrim(alias)) BETWEEN 1 AND 120)
);

-- Listing/cleanup by exercise.
CREATE INDEX IF NOT EXISTS exercise_aliases_exercise_idx
  ON exercise_aliases (exercise_id);

-- One mapping per spelling in each scope. Partial indexes, because Postgres
-- treats NULLs as distinct in a plain unique index: without the WHERE clauses
-- two global aliases could share a normalised name.
CREATE UNIQUE INDEX IF NOT EXISTS exercise_aliases_global_key
  ON exercise_aliases (normalized)
  WHERE organization_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS exercise_aliases_org_key
  ON exercise_aliases (organization_id, normalized)
  WHERE organization_id IS NOT NULL;

-- ── RLS ────────────────────────────────────────────────────────────────────
--
-- The same shape as 286: read the shared (NULL-org) aliases, but only while a
-- tenant is identified, and never write them. A tenant that could insert a
-- NULL-org alias would change exercise resolution for every studio.
ALTER TABLE exercise_aliases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS exercise_aliases_tenant_select ON public.exercise_aliases;
DROP POLICY IF EXISTS exercise_aliases_tenant_insert ON public.exercise_aliases;
DROP POLICY IF EXISTS exercise_aliases_tenant_update ON public.exercise_aliases;
DROP POLICY IF EXISTS exercise_aliases_tenant_delete ON public.exercise_aliases;
DROP POLICY IF EXISTS deny_all_direct_access ON public.exercise_aliases;

CREATE POLICY exercise_aliases_tenant_select ON public.exercise_aliases
    AS PERMISSIVE FOR SELECT TO app_tenant
    USING (
        organization_id::text = current_setting('app.org_id', true)
        OR (
            organization_id IS NULL
            AND NULLIF(current_setting('app.org_id', true), '') IS NOT NULL
        )
    );

CREATE POLICY exercise_aliases_tenant_insert ON public.exercise_aliases
    AS PERMISSIVE FOR INSERT TO app_tenant
    WITH CHECK (organization_id::text = current_setting('app.org_id', true));

CREATE POLICY exercise_aliases_tenant_update ON public.exercise_aliases
    AS PERMISSIVE FOR UPDATE TO app_tenant
    USING (organization_id::text = current_setting('app.org_id', true))
    WITH CHECK (organization_id::text = current_setting('app.org_id', true));

CREATE POLICY exercise_aliases_tenant_delete ON public.exercise_aliases
    AS PERMISSIVE FOR DELETE TO app_tenant
    USING (organization_id::text = current_setting('app.org_id', true));

-- Defence in depth for the PostgREST roles, per the convention in
-- rls.convention.test.js.
REVOKE ALL ON public.exercise_aliases FROM anon, authenticated;
CREATE POLICY deny_all_direct_access ON public.exercise_aliases
    FOR ALL USING (false) WITH CHECK (false);

-- 157 granted these on every table that existed then; restating them keeps the
-- app_tenant cutover working if a future default-privilege change removes them.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.exercise_aliases TO app_tenant;

-- ── Seed: the synonyms production actually used ───────────────────────────
--
-- Joined by slug rather than by name: slug is unique among live rows (140),
-- so a duplicated display name cannot seed the alias onto the wrong exercise.
-- A database missing one of these built-ins simply inserts nothing.
INSERT INTO exercise_aliases (exercise_id, organization_id, alias)
SELECT e.id, NULL, v.alias
FROM (VALUES
  ('bench-press',            'Barbell Bench Press'),
  ('barbell-squat',          'Barbell Back Squat'),
  ('seated-cable-rows',      'Seated Cable Row'),
  ('lateral-raise',          'Dumbbell Lateral Raise'),
  ('barbell-shoulder-press', 'Overhead Press')
) AS v(slug, alias)
JOIN exercises e
  ON e.slug = v.slug
 AND e.organization_id IS NULL
 AND e.deleted_at IS NULL
 AND e.archived_at IS NULL
ON CONFLICT DO NOTHING;
