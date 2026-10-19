# Proposal — Goal Setting coaching fields as first-class columns

**Status: NOT APPLIED.** Awaiting explicit approval. The K11 goal-setting wizard
(`feat/k11-goal-setting-redesign`) ships **today with zero backend changes** — see
§1. This migration is an optional first-classing follow-up, proposed separately as
ordered by the delivery boundary.

Follows the repo migration conventions: additive only, `ADD COLUMN IF NOT EXISTS`,
numbered `src/db/migrations/232_goal_coaching_fields.sql`. migrate.js wraps each
migration, so the SQL carries no explicit BEGIN/COMMIT.

---

## 1. Zero-migration baseline (what K11 does today)

The wizard maps every new field onto columns that already exist:

| Wizard field | Existing column | Why it fits |
|---|---|---|
| SMART statement (all goal types) | `pt_goals.goal_description` | TEXT, always the SMART sentence now |
| Nominated weekdays | `pt_goals.preferred_training_days` | TEXT[] (230), weekday names |
| Milestones (type/label/date/description) | `pt_goals.milestones` | JSONB array (230) |
| Short/medium term (weeks) | `pt_goals.short_term_weeks` / `medium_term_weeks` | SMALLINT (230), wizard clamps 1–52 |
| Success metric, confidence (1–10), session length, time of day, barrier plans | `pt_goals.routine_blueprint -> 'coaching'` | block inside the existing JSONB (230) |
| 4 new daily-routine booleans (`consistent_schedule`, `regular_training_time`, `stress_managed`, `willing_to_track`) | keys inside `pt_goals.lifestyle_readiness` | JSONB record tolerates extra keys; `calcLifestyleReadinessScore` iterates a fixed 6-key list, so the read score is unchanged |

No data is invented; no schema is touched; the zod contract
(`src/modules/progress/progress.routes.js`) already accepts all of this
(`routine_blueprint`/`milestones` are `z.any()`, booleans list, `textList(20, 7)`).

## 2. Motivation for first-classing (later, optional)

Promotes the five coaching values out of the JSONB into typed columns so they can
be queried, constrained and validated at the DB layer instead of only by zod:

- `success_metric` TEXT
- `confidence_level` SMALLINT (1–10)
- `session_minutes` SMALLINT (20–180)
- `time_of_day` TEXT (enum-like CHECK)
- `barrier_plans` JSONB (`[{ "challenge": ..., "plan": ... }]`)

## 3. Exact SQL — `src/db/migrations/232_goal_coaching_fields.sql`

```sql
-- ============================================================
-- 232_goal_coaching_fields.sql
-- Goal setting — promote K11 coaching fields to first-class columns.
--
-- Additive only. Values currently live in pt_goals.routine_blueprint
-- -> 'coaching' (written by the K11 wizard); this keeps them there as
-- the source of truth during the transition (write-through) and adds
-- typed columns filled from the JSONB for querying and validation.
-- ============================================================

DO $$ BEGIN
  ALTER TABLE pt_goals ADD COLUMN IF NOT EXISTS success_metric TEXT;
ALTER  TABLE pt_goals ADD COLUMN IF NOT EXISTS confidence_level SMALLINT
    CHECK (confidence_level IS NULL OR confidence_level BETWEEN 1 AND 10);
ALTER TABLE pt_goals ADD COLUMN IF NOT EXISTS session_minutes SMALLINT
    CHECK (session_minutes IS NULL OR session_minutes BETWEEN 20 AND 180);
ALTER TABLE pt_goals ADD COLUMN IF NOT EXISTS time_of_day TEXT
    CHECK (time_of_day IS NULL OR time_of_day IN ('morning','afternoon','evening','flexible'));
ALTER TABLE pt_goals ADD COLUMN IF NOT EXISTS barrier_plans JSONB
    DEFAULT '[]'::jsonb;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'pt_goals coaching columns: %', SQLERRM; END $$;

-- One-time backfill from the coaching block the wizard writes today.
-- Numeric casts are guarded so a stray string cannot abort the migration:
DO $$ BEGIN
  UPDATE pt_goals
     SET success_metric    = routine_blueprint->'coaching'->>'success_metric',
         confidence_level  = CASE
           WHEN routine_blueprint->'coaching'->>'confidence_level' ~ '^[0-9]+$'
             THEN (routine_blueprint->'coaching'->>'confidence_level')::SMALLINT END,
         session_minutes   = CASE
           WHEN routine_blueprint->'coaching'->>'session_minutes' ~ '^[0-9]+$'
             THEN (routine_blueprint->'coaching'->>'session_minutes')::SMALLINT END,
         time_of_day       = routine_blueprint->'coaching'->>'time_of_day',
         barrier_plans     = COALESCE(routine_blueprint->'coaching'->'barrier_plans', '[]'::jsonb)
   WHERE routine_blueprint ? 'coaching';
RAISE NOTICE 'pt_goals coaching backfill: %', SQLERRM; END $$;
```

No index is added deliberately: `pt_goals` is small and per-client, and no
coaching-column query pattern exists yet.

## 4. Compatibility

| Deployment state | Behaviour |
|---|---|
| Old BE + old DB, new FE (today) | Works — wizard writes JSONB only. |
| Migration applied + old BE | Works — BE keeps reading/writing `routine_blueprint.coaching`; new columns simply idle (backfilled). |
| Migration applied + updated BE | First-class columns become read targets; FE continues the write-through to both places until the FE fallback is removed. |

- `lifestyle_readiness` extra keys: nothing to migrate (JSONB); scoring unchanged.
- `organizations_id`/tenant columns untouched; `pt_goals` rows cascade on client
  delete as today.
- CHECK constraints allow NULL, so legacy rows never violate them.

## 5. Rollback

```sql
-- Optional first: preserve column values back into the JSONB before dropping.
DO $$ BEGIN
  UPDATE pt_goals g SET routine_blueprint = jsonb_set(
      COALESCE(g.routine_blueprint, '{}'::jsonb),
      '{coaching}',
      jsonb_build_object(
        'success_metric',     g.success_metric,
        'confidence_level',   g.confidence_level,
        'session_minutes',    g.session_minutes,
        'time_of_day',        g.time_of_day,
        'barrier_plans',      COALESCE(g.barrier_plans, '[]'::jsonb)))
   WHERE g.success_metric IS NOT NULL OR g.confidence_level IS NOT NULL
      OR g.session_minutes IS NOT NULL OR g.time_of_day IS NOT NULL;
RAISE NOTICE 'pt_goals coaching un-backfill: %', SQLERRM; END $$;

ALTER TABLE pt_goals DROP COLUMN IF EXISTS success_metric,
                      DROP COLUMN IF EXISTS confidence_level,
                      DROP COLUMN IF EXISTS session_minutes,
                      DROP COLUMN IF EXISTS time_of_day,
                      DROP COLUMN IF EXISTS barrier_plans;
```

After rollback the wizard still works because the JSONB was kept in sync via
write-through. Dropping the columns without the un-backfill loses nothing the
JSONB does not already have.

## 6. Transition sequencing (if approved)

1. Apply 232.
2. Add BE read/write of the new columns in the goals routes.
3. Wizard keeps writing both (write-through) for one release.
4. Remove the JSONB `coaching` write from the wizard; backfill already moved old rows.
