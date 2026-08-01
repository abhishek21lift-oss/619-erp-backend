-- ============================================================
-- 141_exercise_library_premium.sql
--
-- Turns the imported reference list into a library a trainer can own.
--
-- What exists today is the free-exercise-db import: name, a coarse
-- muscle_group, body_part/target_muscle/equipment, instructions, a gif_url,
-- and force/mechanic. Everything a coach actually needs to hand an exercise
-- to another human — cues, common mistakes, contraindications, what to
-- regress or progress to — has had nowhere to live.
--
-- ── Extended, not replaced ──────────────────────────────────────────────
--
-- workout_exercises.exercise_id and workout_session_exercises.exercise_id
-- are live foreign keys into this table, holding every plan and every logged
-- session in the system. A new table plus a data migration would mean
-- repointing both under a rename, and any row that failed to map would take
-- a client's programme history with it. Adding columns cannot do that: every
-- existing row stays exactly where it is and keeps its id.
--
-- Every column here is nullable (or defaulted). A deploy mid-rollout, an
-- older client, and the existing GET/POST/PUT payloads all keep working
-- untouched — the API widens, it does not change shape.
--
-- ── The muscle_group CHECK bug ──────────────────────────────────────────
--
-- scripts/import-exercises.js maps a primary muscle of `neck` to 'Neck',
-- which was never in the CHECK constraint from migration 006. Those INSERTs
-- have been failing the constraint and landing in the importer's silent
-- per-row error counter since the import shipped. 'Neck' and 'Olympic' are
-- added to the allowed set rather than remapped, because a neck exercise is
-- not honestly any of Chest/Back/Legs/Shoulders/Arms/Core.
--
-- Idempotent throughout, and safe to re-run.
-- ============================================================

-- ── 1. Fix the CHECK constraint that has been silently dropping rows ────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'exercises_muscle_group_check'
       AND conrelid = 'public.exercises'::regclass
  ) THEN
    ALTER TABLE public.exercises DROP CONSTRAINT exercises_muscle_group_check;
  END IF;

  ALTER TABLE public.exercises
    ADD CONSTRAINT exercises_muscle_group_check
    CHECK (muscle_group IN (
      'Chest','Back','Legs','Shoulders','Arms','Core','Cardio','Full Body','Neck','Olympic'
    ));
END $$;

-- ── 2. The premium columns ──────────────────────────────────────────────
-- Grouped by what a trainer is doing when they need them: identifying the
-- movement, coaching it, keeping it safe, and programming around it.
ALTER TABLE public.exercises
  -- Identity / taxonomy
  ADD COLUMN IF NOT EXISTS slug                  TEXT,
  ADD COLUMN IF NOT EXISTS category              TEXT,
  ADD COLUMN IF NOT EXISTS movement_pattern      TEXT,
  ADD COLUMN IF NOT EXISTS plane_of_motion       TEXT,
  -- Coaching
  ADD COLUMN IF NOT EXISTS coaching_cues         TEXT,
  ADD COLUMN IF NOT EXISTS common_mistakes       TEXT,
  ADD COLUMN IF NOT EXISTS breathing_tips        TEXT,
  ADD COLUMN IF NOT EXISTS beginner_notes        TEXT,
  ADD COLUMN IF NOT EXISTS advanced_notes        TEXT,
  ADD COLUMN IF NOT EXISTS trainer_notes         TEXT,
  -- Safety
  ADD COLUMN IF NOT EXISTS safety_tips           TEXT,
  ADD COLUMN IF NOT EXISTS contraindications     TEXT,
  -- Prescription defaults (sets_default/reps_default/rest_seconds already exist)
  ADD COLUMN IF NOT EXISTS tempo_recommendation  TEXT,
  -- Discovery. tags and search_keywords are arrays rather than delimited text
  -- so they can be GIN-indexed and queried with && / @> instead of LIKE.
  ADD COLUMN IF NOT EXISTS tags                  TEXT[],
  ADD COLUMN IF NOT EXISTS search_keywords       TEXT[],
  -- Lifecycle. is_active already exists and is what the current DELETE route
  -- flips; archived_at is separate on purpose — "archived" is a curator
  -- hiding a movement they still want, deleted_at is a removal. Collapsing
  -- them would make an archive irreversible.
  ADD COLUMN IF NOT EXISTS visibility            TEXT NOT NULL DEFAULT 'public',
  ADD COLUMN IF NOT EXISTS archived_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_at            TIMESTAMPTZ,
  -- Attribution. created_by exists; who last touched it did not.
  ADD COLUMN IF NOT EXISTS updated_by            TEXT,
  -- Ownership. NULL = a platform/library exercise every studio sees (which is
  -- what all ~890 imported rows are). Non-NULL = a studio's own custom
  -- movement, visible only to them. Matches how workout_plans scopes its
  -- shared template library, so the visibility rule is one a reader knows.
  ADD COLUMN IF NOT EXISTS organization_id       UUID REFERENCES organizations (id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS version               INTEGER NOT NULL DEFAULT 1;

-- ── 2b. Normalise column TYPES, not just their presence ─────────────────
--
-- ADD COLUMN IF NOT EXISTS skips a column that already exists whatever its
-- type, so a pre-existing column of the wrong type survives the block above
-- and breaks something later that assumed otherwise. The deploy failed on
-- exactly that:
--
--   ✗ 141_exercise_library_premium.sql FAILED:
--     function array_to_string(text, unknown) does not exist
--
-- tags and search_keywords already existed on the production database as
-- plain TEXT — added out of band, like exercise_relations, gym_settings and
-- attendance before them — so the search-vector trigger's array_to_string()
-- was handed a scalar.
--
-- These two must genuinely be arrays: the service reads and writes them as
-- arrays, and the GIN index queries them with && / @>. So they are converted
-- rather than worked around, splitting on comma because that is how a
-- delimited text column of this kind is written. An empty or NULL value
-- becomes NULL rather than a one-element array containing ''.
-- ── 2a. Clear generated columns that pin the types below ────────────────
--
-- A GENERATED column freezes the type of every column its expression reads:
-- Postgres refuses to ALTER them while it exists. The deploy failed on that:
--
--   ✗ 141_exercise_library_premium.sql FAILED:
--     cannot alter type of a column used by a generated column
--
-- The production database already has search_vector as a GENERATED column,
-- built over the very fields being converted below.
--
-- Dropping it is not a loss, and not a workaround. Section 5 rebuilds
-- search_vector as a trigger-maintained column precisely BECAUSE it cannot
-- be generated: array_to_string() is STABLE rather than IMMUTABLE, so a
-- generated expression may not call it, which means any generated
-- search_vector necessarily omits tags and search_keywords — the two fields
-- a trainer most wants to search by. The column is rebuilt and repopulated a
-- few hundred lines down, wider than the one being removed here.
--
-- Any OTHER generated column is a deliberate refusal rather than a silent
-- drop: this migration knows what search_vector is for and can replace it,
-- but it has no idea what an unknown generated column means to whoever added
-- it, and destroying that unattended is not a call a migration should make.
-- The error names the column so it is actionable rather than opaque.
DO $gen$
DECLARE
  gen_col TEXT;
BEGIN
  FOR gen_col IN
    SELECT a.attname
      FROM pg_attribute a
     WHERE a.attrelid = 'public.exercises'::regclass
       AND a.attgenerated <> ''
       AND NOT a.attisdropped
  LOOP
    IF gen_col = 'search_vector' THEN
      RAISE NOTICE 'exercise_library: dropping GENERATED search_vector; section 5 rebuilds it by trigger, including tags and search_keywords';
      ALTER TABLE public.exercises DROP COLUMN search_vector;
    ELSE
      RAISE EXCEPTION
        'exercises.% is a GENERATED column and blocks the type changes this migration needs. Drop or redefine it, then re-run.', gen_col;
    END IF;
  END LOOP;
END $gen$;

-- Postgres has no non-throwing cast to timestamptz, and a single unparseable
-- string in a text column would otherwise abort the conversion — and the
-- deploy with it. Created for the conversion below and dropped straight
-- after, so it leaves nothing behind in the schema.
CREATE OR REPLACE FUNCTION exercises_try_timestamptz(v TEXT) RETURNS TIMESTAMPTZ AS $try$
BEGIN
  RETURN v::timestamptz;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$try$ LANGUAGE plpgsql IMMUTABLE;

-- Every conversion below is written so no existing value can abort it: a
-- value that does not fit the target type becomes NULL rather than raising.
-- Losing an unparseable stray beats refusing to deploy.
DO $types$
DECLARE
  col  TEXT;
  kind TEXT;
BEGIN
  -- tags / search_keywords → text[]. The service reads and writes these as
  -- arrays and the GIN index queries them with && / @>, so they cannot stay
  -- scalar. Split on comma, the way a delimited text column of this kind is
  -- written; empty or NULL becomes NULL, not a one-element array of ''.
  FOREACH col IN ARRAY ARRAY['tags', 'search_keywords'] LOOP
    SELECT data_type INTO kind
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'exercises' AND column_name = col;

    IF kind IS NOT NULL AND kind <> 'ARRAY' THEN
      RAISE NOTICE 'exercise_library: converting exercises.% from % to text[]', col, kind;
      EXECUTE format(
        'ALTER TABLE public.exercises ALTER COLUMN %I TYPE TEXT[] USING (
           CASE WHEN %I IS NULL OR btrim(%I::text) = '''' THEN NULL
                ELSE string_to_array(btrim(%I::text), '','')
           END)', col, col, col, col);
    END IF;
  END LOOP;

  -- organization_id → uuid. The per-studio unique index below collapses NULL
  -- to a sentinel with COALESCE(organization_id, '0000…'::uuid), which will
  -- not type-check against a text column.
  SELECT data_type INTO kind
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'exercises' AND column_name = 'organization_id';
  IF kind IS NOT NULL AND kind <> 'uuid' THEN
    RAISE NOTICE 'exercise_library: converting exercises.organization_id from % to uuid', kind;
    ALTER TABLE public.exercises ALTER COLUMN organization_id TYPE UUID USING (
      CASE WHEN organization_id::text ~*
             '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           THEN organization_id::text::uuid END);
  END IF;

  -- version → integer, and NOT NULL DEFAULT 1: it is incremented on every
  -- edit, so a text column would concatenate instead of counting.
  SELECT data_type INTO kind
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'exercises' AND column_name = 'version';
  IF kind IS NOT NULL AND kind NOT IN ('integer', 'bigint', 'smallint') THEN
    RAISE NOTICE 'exercise_library: converting exercises.version from % to integer', kind;
    ALTER TABLE public.exercises ALTER COLUMN version TYPE INTEGER USING (
      CASE WHEN version::text ~ '^[0-9]+$' THEN version::text::integer ELSE 1 END);
    UPDATE public.exercises SET version = 1 WHERE version IS NULL;
    ALTER TABLE public.exercises ALTER COLUMN version SET DEFAULT 1;
    ALTER TABLE public.exercises ALTER COLUMN version SET NOT NULL;
  END IF;

  -- archived_at / deleted_at → timestamptz. Every read filters on
  -- "deleted_at IS NULL" and the partial indexes below are built on it, so a
  -- text column would silently change what those mean.
  FOREACH col IN ARRAY ARRAY['archived_at', 'deleted_at'] LOOP
    SELECT data_type INTO kind
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'exercises' AND column_name = col;

    IF kind IS NOT NULL AND kind NOT LIKE 'timestamp%' THEN
      RAISE NOTICE 'exercise_library: converting exercises.% from % to timestamptz', col, kind;
      EXECUTE format(
        'ALTER TABLE public.exercises ALTER COLUMN %I TYPE TIMESTAMPTZ USING (
           CASE WHEN btrim(coalesce(%I::text, '''')) = '''' THEN NULL
                ELSE exercises_try_timestamptz(%I::text) END)', col, col, col);
    END IF;
  END LOOP;

  -- visibility must be non-null for the CHECK constraint added later.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'exercises'
       AND column_name = 'visibility' AND is_nullable = 'YES'
  ) THEN
    UPDATE public.exercises SET visibility = 'public'
     WHERE visibility IS NULL OR btrim(visibility) = '';
    ALTER TABLE public.exercises ALTER COLUMN visibility SET DEFAULT 'public';
    ALTER TABLE public.exercises ALTER COLUMN visibility SET NOT NULL;
  END IF;
END $types$;

DROP FUNCTION IF EXISTS exercises_try_timestamptz(TEXT);

COMMENT ON COLUMN public.exercises.slug             IS 'URL-safe unique identifier, generated from name.';
COMMENT ON COLUMN public.exercises.organization_id  IS 'NULL = shared platform library; set = a studio''s own custom exercise.';
COMMENT ON COLUMN public.exercises.visibility       IS 'public | private — a private custom exercise is visible only to its own studio.';
COMMENT ON COLUMN public.exercises.archived_at      IS 'Hidden from pickers but kept, and restorable. Distinct from deleted_at.';
COMMENT ON COLUMN public.exercises.deleted_at       IS 'Soft delete. Rows are never hard-deleted: workout history references them.';
COMMENT ON COLUMN public.exercises.version          IS 'Bumped on each edit; see exercise_versions for the prior snapshots.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'exercises_visibility_check'
       AND conrelid = 'public.exercises'::regclass
  ) THEN
    ALTER TABLE public.exercises
      ADD CONSTRAINT exercises_visibility_check
      CHECK (visibility IN ('public','private'));
  END IF;

  -- A private exercise with no owning studio would be visible to nobody at
  -- all — it could never be read back by the org filter that gates it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'exercises_private_needs_org_check'
       AND conrelid = 'public.exercises'::regclass
  ) THEN
    ALTER TABLE public.exercises
      ADD CONSTRAINT exercises_private_needs_org_check
      CHECK (visibility = 'public' OR organization_id IS NOT NULL);
  END IF;
END $$;

-- ── 3. Backfill slugs for the existing library ──────────────────────────
-- Lower-cased, non-alphanumerics collapsed to a single hyphen, trimmed.
-- Collisions get a short suffix from the row id rather than a counter: a
-- counter would need a second pass and would renumber on re-run.
UPDATE public.exercises
   SET slug = trim(both '-' from regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g'))
 WHERE slug IS NULL AND name IS NOT NULL;

-- Looped, not a single pass: suffixing can itself collide. Two rows named
-- "Plank" and one named "Plank (ab12cd)" all reduce to the slug
-- "plank-ab12cd" once the first pair is disambiguated, and a single pass
-- would leave that collision behind for the unique index to trip over.
-- Bounded so a pathological dataset cannot spin here forever.
DO $$
DECLARE
  fixed INT;
  pass  INT := 0;
BEGIN
  LOOP
    pass := pass + 1;

    WITH dupes AS (
      SELECT id, row_number() OVER (PARTITION BY slug ORDER BY created_at, id) AS rn
        FROM public.exercises
       WHERE slug IS NOT NULL AND deleted_at IS NULL
    )
    UPDATE public.exercises e
       SET slug = e.slug || '-' || right(replace(e.id::text, '-', ''), 6)
      FROM dupes d
     WHERE d.id = e.id AND d.rn > 1;

    GET DIAGNOSTICS fixed = ROW_COUNT;
    EXIT WHEN fixed = 0 OR pass >= 5;

    RAISE NOTICE 'exercise_library: disambiguated % duplicate slug(s) on pass %', fixed, pass;
  END LOOP;

  IF pass >= 5 AND fixed > 0 THEN
    RAISE EXCEPTION 'exercise_library: duplicate slugs still present after % passes', pass;
  END IF;
END $$;

-- Empty-name edge case: a row whose name was all punctuation slugs to ''.
UPDATE public.exercises
   SET slug = 'exercise-' || right(replace(id::text, '-', ''), 8)
 WHERE slug IS NULL OR slug = '';

-- One slug per row, enforced from here on. Partial on deleted_at so a
-- deleted exercise's slug returns to the pool for reuse.
CREATE UNIQUE INDEX IF NOT EXISTS exercises_slug_unique_idx
  ON public.exercises (slug) WHERE deleted_at IS NULL;

-- ── 4. Duplicate-name protection ────────────────────────────────────────
--
-- Existing duplicates have to be resolved BEFORE the unique index below, for
-- the same reason migration 140 deduplicates before its constraint: Postgres
-- will not build a unique index over data that already violates it. The
-- seeded library was imported from free-exercise-db, whose dedup pass ran in
-- application code against source_id and exact name — so rows differing only
-- by case, or re-imported under a new source_id, are already present.
--
-- Duplicates are RENAMED, never deleted and never merged:
--
--   * workout_exercises.exercise_id and workout_session_exercises.exercise_id
--     point at these rows. Deleting one would cascade into a client's saved
--     programme; soft-deleting it would blank the exercise inside a plan that
--     still references it, because every read filters on deleted_at.
--   * Merging means choosing which row's metadata survives and repointing
--     history. That is a judgement call about a studio's data, not something
--     a migration should decide unattended.
--
-- Renaming keeps every row, every id and every reference intact, makes the
-- collision visible in the UI, and leaves a human free to merge later. The
-- earliest row (by created_at, then id) keeps the original name.
--
-- The suffix is drawn from the row id rather than a counter so the result is
-- stable on re-run and needs no second pass to renumber. The loop covers the
-- rare case where a suffixed name collides with something already present;
-- it is bounded so a pathological dataset cannot spin here forever.
DO $$
DECLARE
  renamed INT;
  pass    INT := 0;
BEGIN
  LOOP
    pass := pass + 1;

    WITH dupes AS (
      SELECT id,
             row_number() OVER (
               PARTITION BY COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
                            lower(name)
               ORDER BY created_at, id
             ) AS rn
        FROM public.exercises
       WHERE deleted_at IS NULL AND name IS NOT NULL
    )
    UPDATE public.exercises e
       SET name = e.name || ' (' || right(replace(e.id::text, '-', ''), 6) || ')'
      FROM dupes d
     WHERE d.id = e.id AND d.rn > 1;

    GET DIAGNOSTICS renamed = ROW_COUNT;
    EXIT WHEN renamed = 0 OR pass >= 5;

    RAISE NOTICE 'exercise_library: renamed % duplicate exercise name(s) on pass %', renamed, pass;
  END LOOP;

  IF pass >= 5 AND renamed > 0 THEN
    RAISE EXCEPTION 'exercise_library: duplicate names still present after % passes', pass;
  END IF;
END $$;

-- Case-insensitive, scoped per owning studio (two different studios may each
-- have their own "619 Deadlift"; one studio may not have two). NULLs — the
-- shared platform library — are collapsed to a sentinel so the same rule
-- applies there.
CREATE UNIQUE INDEX IF NOT EXISTS exercises_name_per_org_unique_idx
  ON public.exercises (
    COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(name)
  )
  WHERE deleted_at IS NULL;

-- ── 5. Full-text search ─────────────────────────────────────────────────
-- The trigram indexes from migration 106 stay: they serve fuzzy/substring
-- matching ("bicp" finding "bicep"), which tsvector cannot do. This adds the
-- other half — real ranked term search across the fields a trainer would
-- search by, including the free-text coaching content the trigram facet
-- string never covered.
--
-- Trigger-maintained rather than GENERATED ALWAYS, for one hard reason:
-- array_to_string() is STABLE, not IMMUTABLE, and Postgres rejects any
-- non-immutable function in a generated expression. tags and
-- search_keywords are exactly the fields a trainer searches by, so dropping
-- them to keep a generated column would defeat the point. The trigger fires
-- on INSERT and on UPDATE of the contributing columns only, so an unrelated
-- write does not pay to rebuild it.
ALTER TABLE public.exercises
  ADD COLUMN IF NOT EXISTS search_vector tsvector;

CREATE OR REPLACE FUNCTION exercises_search_vector_refresh() RETURNS trigger AS $fn$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(array_to_string(NEW.search_keywords, ' '), '')), 'A') ||
    setweight(to_tsvector('english', coalesce(array_to_string(NEW.tags, ' '), '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.target_muscle, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.muscle_group, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.equipment, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.category, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(NEW.movement_pattern, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(NEW.description, '')), 'D') ||
    setweight(to_tsvector('english', coalesce(NEW.coaching_cues, '')), 'D');
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS exercises_search_vector_trg ON public.exercises;
CREATE TRIGGER exercises_search_vector_trg
  BEFORE INSERT OR UPDATE OF
    name, search_keywords, tags, target_muscle, muscle_group,
    equipment, category, movement_pattern, description, coaching_cues
  ON public.exercises
  FOR EACH ROW EXECUTE FUNCTION exercises_search_vector_refresh();

CREATE INDEX IF NOT EXISTS exercises_search_vector_idx
  ON public.exercises USING gin (search_vector);

-- ── 6. Indexes for the filter facets the library UI actually offers ─────
-- Partial on deleted_at: every read path excludes deleted rows, so the index
-- should not carry them either.
CREATE INDEX IF NOT EXISTS exercises_category_idx
  ON public.exercises (category) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS exercises_difficulty_idx
  ON public.exercises (difficulty) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS exercises_equipment_idx
  ON public.exercises (equipment) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS exercises_mechanic_idx
  ON public.exercises (mechanic) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS exercises_force_idx
  ON public.exercises (force) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS exercises_tags_idx
  ON public.exercises USING gin (tags);
-- The library list is "this studio's customs + the shared library", ordered
-- by name. This is the index that query sorts and filters on.
CREATE INDEX IF NOT EXISTS exercises_org_active_name_idx
  ON public.exercises (organization_id, name)
  WHERE deleted_at IS NULL AND archived_at IS NULL;

-- ── 7. Version history ──────────────────────────────────────────────────
-- A snapshot of the row as it was BEFORE each edit, so "what did this look
-- like when I programmed it in March" has an answer. Written by the API on
-- update, not by a trigger: the API knows who made the change and a trigger
-- would only ever see the database user.
CREATE TABLE IF NOT EXISTS exercise_versions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exercise_id   TEXT NOT NULL REFERENCES exercises (id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  -- The whole prior row. JSONB rather than a mirrored column set: this table
  -- must not need a migration every time exercises gains a field, and it is
  -- read for display/diffing, never filtered on individual keys.
  snapshot      JSONB NOT NULL,
  changed_by    TEXT,
  changed_by_name TEXT,
  -- What the editor said they changed. Free text, optional.
  change_note   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Reconciled for the same reason as exercise_relations below: a pre-existing
-- table of another shape would make the CREATE above a no-op and the index
-- fail on a missing column.
ALTER TABLE exercise_versions ADD COLUMN IF NOT EXISTS exercise_id     TEXT;
ALTER TABLE exercise_versions ADD COLUMN IF NOT EXISTS version         INTEGER;
ALTER TABLE exercise_versions ADD COLUMN IF NOT EXISTS snapshot        JSONB;
ALTER TABLE exercise_versions ADD COLUMN IF NOT EXISTS changed_by      TEXT;
ALTER TABLE exercise_versions ADD COLUMN IF NOT EXISTS changed_by_name TEXT;
ALTER TABLE exercise_versions ADD COLUMN IF NOT EXISTS change_note     TEXT;
ALTER TABLE exercise_versions ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS exercise_versions_exercise_version_idx
  ON exercise_versions (exercise_id, version);
CREATE INDEX IF NOT EXISTS exercise_versions_exercise_idx
  ON exercise_versions (exercise_id, created_at DESC);

ALTER TABLE exercise_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON exercise_versions FROM anon, authenticated;
DO $rls$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'exercise_versions'
       AND policyname = 'deny_all_direct_access'
  ) THEN
    CREATE POLICY deny_all_direct_access ON exercise_versions
      FOR ALL USING (false) WITH CHECK (false);
  END IF;
END $rls$;

-- ── 8. Favorites ────────────────────────────────────────────────────────
-- Per USER, not per studio: a favourite is one trainer's shortlist, and two
-- trainers in the same studio have different ones.
CREATE TABLE IF NOT EXISTS exercise_favorites (
  user_id     TEXT NOT NULL,
  exercise_id TEXT NOT NULL REFERENCES exercises (id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, exercise_id)
);

ALTER TABLE exercise_favorites ADD COLUMN IF NOT EXISTS user_id     TEXT;
ALTER TABLE exercise_favorites ADD COLUMN IF NOT EXISTS exercise_id TEXT;
ALTER TABLE exercise_favorites ADD COLUMN IF NOT EXISTS created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- The composite primary key comes from the CREATE above, but a reconciled
-- table may not have one — and toggling a favourite upserts with
-- ON CONFLICT (user_id, exercise_id), which needs a unique index to arbitrate
-- against. A unique index satisfies that just as a primary key does.
CREATE UNIQUE INDEX IF NOT EXISTS exercise_favorites_user_exercise_idx
  ON exercise_favorites (user_id, exercise_id);

CREATE INDEX IF NOT EXISTS exercise_favorites_user_idx
  ON exercise_favorites (user_id, created_at DESC);

ALTER TABLE exercise_favorites ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON exercise_favorites FROM anon, authenticated;
DO $rls$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'exercise_favorites'
       AND policyname = 'deny_all_direct_access'
  ) THEN
    CREATE POLICY deny_all_direct_access ON exercise_favorites
      FOR ALL USING (false) WITH CHECK (false);
  END IF;
END $rls$;

-- ── 9. Recently used ────────────────────────────────────────────────────
-- One row per user per exercise, last_used_at bumped on write. Not an
-- append-only event log: the only question asked of it is "the last N
-- distinct exercises this trainer used", and a log would need a DISTINCT ON
-- over an ever-growing table to answer it.
CREATE TABLE IF NOT EXISTS exercise_recent_uses (
  user_id      TEXT NOT NULL,
  exercise_id  TEXT NOT NULL REFERENCES exercises (id) ON DELETE CASCADE,
  use_count    INTEGER NOT NULL DEFAULT 1,
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, exercise_id)
);

ALTER TABLE exercise_recent_uses ADD COLUMN IF NOT EXISTS user_id      TEXT;
ALTER TABLE exercise_recent_uses ADD COLUMN IF NOT EXISTS exercise_id  TEXT;
ALTER TABLE exercise_recent_uses ADD COLUMN IF NOT EXISTS use_count    INTEGER NOT NULL DEFAULT 1;
ALTER TABLE exercise_recent_uses ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Recording a use upserts with ON CONFLICT (user_id, exercise_id); see the
-- note on exercise_favorites above for why a unique index is asserted here.
CREATE UNIQUE INDEX IF NOT EXISTS exercise_recent_uses_user_exercise_idx
  ON exercise_recent_uses (user_id, exercise_id);

CREATE INDEX IF NOT EXISTS exercise_recent_uses_user_idx
  ON exercise_recent_uses (user_id, last_used_at DESC);

ALTER TABLE exercise_recent_uses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON exercise_recent_uses FROM anon, authenticated;
DO $rls$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'exercise_recent_uses'
       AND policyname = 'deny_all_direct_access'
  ) THEN
    CREATE POLICY deny_all_direct_access ON exercise_recent_uses
      FOR ALL USING (false) WITH CHECK (false);
  END IF;
END $rls$;

-- ── 10. Exercise-to-exercise relations ──────────────────────────────────
-- Regressions, progressions and alternatives are all "this exercise relates
-- to that one, in this direction". One table with a kind column rather than
-- three: the queries are identical, and three tables would mean three joins
-- to render one detail page.
CREATE TABLE IF NOT EXISTS exercise_relations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exercise_id    TEXT NOT NULL REFERENCES exercises (id) ON DELETE CASCADE,
  related_id     TEXT NOT NULL REFERENCES exercises (id) ON DELETE CASCADE,
  kind           TEXT NOT NULL,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT exercise_relations_kind_check
    CHECK (kind IN ('regression','progression','alternative')),
  -- An exercise is not a regression of itself; the UI would render a loop.
  CONSTRAINT exercise_relations_no_self_check
    CHECK (exercise_id <> related_id)
);

-- ── Reconcile a pre-existing table ──────────────────────────────────────
--
-- CREATE TABLE IF NOT EXISTS is a no-op when the table already exists, even
-- if its columns are nothing like the ones declared above — and the indexes
-- below then fail on a column that was never created. This is not
-- hypothetical: the deploy of this migration failed with
--
--   ✗ 141_exercise_library_premium.sql FAILED: column "related_id" does not exist
--
-- because the production database already carried an exercise_relations
-- table of a different shape, created out of band rather than by any file in
-- this directory. The same is true elsewhere in this schema — gym_settings,
-- attendance and clients.branch_id all exist there and in no migration.
--
-- So every column is asserted individually. On a database where the CREATE
-- above did the work, all of these are no-ops. On one carrying a divergent
-- table, they add what is missing so the indexes can be built.
--
-- Added WITHOUT the NOT NULL and REFERENCES that the CREATE declares: a
-- table that already holds rows cannot take a NOT NULL column with no
-- default, and a foreign key would fail against pre-existing data that does
-- not satisfy it. A fresh database gets the full constraints from the CREATE;
-- a reconciled one gets a working table, which is the point.
ALTER TABLE exercise_relations ADD COLUMN IF NOT EXISTS exercise_id TEXT;
ALTER TABLE exercise_relations ADD COLUMN IF NOT EXISTS related_id  TEXT;
ALTER TABLE exercise_relations ADD COLUMN IF NOT EXISTS kind        TEXT;
ALTER TABLE exercise_relations ADD COLUMN IF NOT EXISTS sort_order  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE exercise_relations ADD COLUMN IF NOT EXISTS created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS exercise_relations_unique_idx
  ON exercise_relations (exercise_id, related_id, kind);
CREATE INDEX IF NOT EXISTS exercise_relations_exercise_idx
  ON exercise_relations (exercise_id, kind, sort_order);
-- The reverse lookup ("what progresses INTO this exercise") is a real query
-- on the detail page and would otherwise scan.
CREATE INDEX IF NOT EXISTS exercise_relations_related_idx
  ON exercise_relations (related_id, kind);

ALTER TABLE exercise_relations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON exercise_relations FROM anon, authenticated;
DO $rls$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'exercise_relations'
       AND policyname = 'deny_all_direct_access'
  ) THEN
    CREATE POLICY deny_all_direct_access ON exercise_relations
      FOR ALL USING (false) WITH CHECK (false);
  END IF;
END $rls$;

-- ── 11. Seed category / movement pattern for the imported library ───────
-- Derived from the columns the import already populated, so the new filters
-- are useful on day one instead of empty until someone edits 890 rows by
-- hand. Only fills NULLs — never overwrites a curated value, so re-running
-- after an edit is safe.
UPDATE public.exercises
   SET category = CASE
     WHEN lower(coalesce(exercise_type, '')) LIKE '%stretch%'      THEN 'Flexibility'
     WHEN lower(coalesce(exercise_type, '')) LIKE '%cardio%'       THEN 'Cardio'
     WHEN lower(coalesce(exercise_type, '')) LIKE '%plyo%'         THEN 'Plyometric'
     WHEN lower(coalesce(exercise_type, '')) LIKE '%olympic%'      THEN 'Olympic'
     WHEN lower(coalesce(exercise_type, '')) LIKE '%powerlifting%' THEN 'Powerlifting'
     WHEN lower(coalesce(exercise_type, '')) LIKE '%strongman%'    THEN 'Strongman'
     WHEN muscle_group = 'Cardio'                                  THEN 'Cardio'
     ELSE 'Strength'
   END
 WHERE category IS NULL;

UPDATE public.exercises
   SET movement_pattern = CASE
     WHEN lower(name) ~ '(squat|lunge|step.?up|leg press)'      THEN 'Squat'
     WHEN lower(name) ~ '(deadlift|good.?morning|hip thrust|rdl)' THEN 'Hinge'
     WHEN lower(name) ~ '(bench|push.?up|chest press|overhead press|shoulder press|dip)' THEN 'Push'
     WHEN lower(name) ~ '(row|pull.?up|chin.?up|pulldown|pull.?down|curl)' THEN 'Pull'
     WHEN lower(name) ~ '(carry|farmer|walk)'                   THEN 'Carry'
     WHEN lower(name) ~ '(plank|crunch|sit.?up|twist|rotation|woodchop)' THEN 'Core'
     ELSE NULL
   END
 WHERE movement_pattern IS NULL;

-- Search keywords: the terms a trainer would actually type that are not
-- already the name. Built from the facet columns, de-duplicated, blanks
-- dropped. Only for rows that have none, so curated keywords survive.
UPDATE public.exercises
   SET search_keywords = ARRAY(
     SELECT DISTINCT lower(trim(kw))
       FROM unnest(ARRAY[
         target_muscle, muscle_group, body_part, equipment,
         exercise_type, force, mechanic, category, movement_pattern
       ]) AS kw
      WHERE kw IS NOT NULL AND trim(kw) <> ''
   )
 WHERE search_keywords IS NULL;

-- ── 12. Backfill the search vector ──────────────────────────────────────
-- The trigger only fires on write, so the ~890 rows that predate it still
-- have a NULL vector and would be invisible to full-text search. A no-op
-- UPDATE touching a contributing column fires the trigger for each.
UPDATE public.exercises SET name = name WHERE search_vector IS NULL;

ANALYZE public.exercises;
