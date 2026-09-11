# Rolling back 195

195 moved five tables from `public` to `archive`. It deleted nothing, so the
rollback is the same catalog operation in reverse and no data has to be
restored from anywhere.

```sql
BEGIN;

ALTER TABLE archive.training_programs           SET SCHEMA public;
ALTER TABLE archive.training_program_phases     SET SCHEMA public;
ALTER TABLE archive.training_program_weeks      SET SCHEMA public;
ALTER TABLE archive.workout_templates           SET SCHEMA public;
ALTER TABLE archive.workout_template_exercises  SET SCHEMA public;

DELETE FROM _migrations WHERE filename = '195_archive_training_program_tables.sql';

COMMIT;
```

Parents before children on the way back, which is the reverse of the order 195
moves them in. The foreign keys between the five followed their tables and are
still intact, so nothing needs re-creating.

Deleting the `_migrations` row is what lets the next deploy re-apply 195. Leave
it in place if you are rolling back to keep the tables.

## What this does not restore

The rows come back, the API does not. The same change removed
`/api/training` from `server.js`, deleted `src/modules/training/`'s routes,
repository and schemas, and deleted the frontend's `/pt-os/training/templates`
pages, `WorkoutTemplateBuilder` and `endpoints/trainingOs.ts`. A rollback that
needs the builder back needs those reverted too — `git revert` of the
consolidation commit, then this SQL.

## Checking it worked

```sql
SELECT (SELECT count(*) FROM public.workout_templates)           AS templates,
       (SELECT count(*) FROM public.workout_template_exercises)  AS prescriptions,
       (SELECT count(*) FROM public.training_programs)           AS programs;
```

Expected at the time 195 was written: 1 template, 4 prescriptions, 0 programmes.

## Why you would not

195's own argument, restated so a future reader does not have to re-derive it:
after 193 archived `training_assignments`, nothing downstream could assign or
log a workout template. Restoring these tables restores an authoring surface
whose output still has nowhere to go. The thing to restore instead is whatever
`workout_plans` cannot express — as a change to `workout_plans`.
