'use strict';
// 167_migrate_workout_log_to_training.sql, run against a real PostgreSQL.
//
// Every other migration test in this repo asserts on SQL *text*. That is the
// right tool for "does this migration drop a table something else needs", and
// the wrong one here: 167 moves a client's training history from one shape to
// another, and the only question worth answering is whether the rows come out
// the other side saying the same thing. A regex over the file cannot tell a
// correct join from one that silently produces no rows.
//
// So this connects to the same throwaway database the isolation proof uses —
// schema.sql, every migration, real constraints — inserts a legacy workout,
// executes the migration file itself, and reads the result back.
//
// ── Nothing is left behind ─────────────────────────────────────────────────
//
// The whole test runs inside one transaction that is always rolled back. The
// database is shared with the isolation suite, and a data-migration test that
// leaves 47 sessions lying around would corrupt whatever runs next. Rollback
// also means the fixtures need no cleanup code to get wrong.

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

// Same reasoning as rls.isolation.integration.test.js: skipping is right on a
// laptop without a database and wrong in CI, where a missing URL means the
// wiring broke and this proof quietly stopped running.
if (process.env.CI && !DB_URL) {
  describe('167 data migration, against a real database', () => {
    it('has a database to run against', () => {
      throw new Error(
        'RLS_TEST_DATABASE_URL is not set in CI, so the workout-log migration '
        + 'proof never ran. Repair .github/workflows/ci.yml.'
      );
    });
  });
}

const MIGRATION_SQL = fs.readFileSync(
  path.join(__dirname, '..', 'db', 'migrations', '167_migrate_workout_log_to_training.sql'),
  'utf8'
);

describeIf('167_migrate_workout_log_to_training.sql', () => {
  let pool;
  let db;

  beforeAll(() => { pool = new Pool({ connectionString: DB_URL }); });
  afterAll(async () => { await pool.end(); });

  beforeEach(async () => {
    db = await pool.connect();
    await db.query('BEGIN');
  });

  afterEach(async () => {
    await db.query('ROLLBACK').catch(() => {});
    db.release();
  });

  /** A legacy workout: one session, one exercise, three sets. */
  async function seedLegacy(overrides = {}) {
    const {
      status = 'completed',
      durationMinutes = 45,
      programName = 'Push Pull Legs',
      workoutDay = 'Day 2',
      notes = 'Felt strong',
      sets = [
        { set_number: 1, weight_kg: 100, reps: 5, rpe: 8, rir: 2, completed: true },
        { set_number: 2, weight_kg: 102.5, reps: 5, rpe: 9, rir: 1, completed: true },
        { set_number: 3, weight_kg: 105, reps: 3, rpe: 10, rir: 0, completed: false },
      ],
    } = overrides;

    const { rows: [org] } = await db.query(
      `INSERT INTO organizations (name, slug) VALUES ('Mig Test', 'mig-test-167')
       RETURNING id`
    );
    const { rows: [client] } = await db.query(
      `INSERT INTO pt_clients (id, name, organization_id)
       VALUES ('mig167-client', 'Legacy Client', $1) RETURNING id`, [org.id]
    );
    const { rows: [trainer] } = await db.query(
      `INSERT INTO trainers (id, name, organization_id)
       VALUES ('mig167-trainer', 'Legacy Trainer', $1) RETURNING id`, [org.id]
    );
    const { rows: [exercise] } = await db.query(
      `INSERT INTO exercises (id, name, muscle_group)
       VALUES ('mig167-ex', 'Back Squat', 'Legs') RETURNING id`
    );

    const { rows: [session] } = await db.query(
      `INSERT INTO workout_sessions
         (id, client_id, trainer_id, organization_id, session_date,
          program_name, workout_day, notes, duration_minutes, status,
          created_at, updated_at)
       VALUES ('mig167-sess', $1, $2, $3, DATE '2026-03-01', $4, $5, $6, $7, $8,
               TIMESTAMPTZ '2026-03-01 09:00:00+00', TIMESTAMPTZ '2026-03-01 10:05:00+00')
       RETURNING id`,
      [client.id, trainer.id, org.id, programName, workoutDay, notes, durationMinutes, status]
    );

    const { rows: [perf] } = await db.query(
      `INSERT INTO workout_session_exercises
         (id, session_id, exercise_id, exercise_name, sort_order, notes)
       VALUES ('mig167-wse', $1, $2, 'Back Squat', 3, 'depth cue') RETURNING id`,
      [session.id, exercise.id]
    );

    for (const s of sets) {
      await db.query(
        `INSERT INTO workout_sets
           (id, session_exercise_id, set_number, weight_kg, reps, rpe, rir,
            tempo, rest_seconds, completed, notes, is_pr_weight, is_pr_reps, is_pr_volume)
         VALUES ($1, $2, $3, $4, $5, $6, $7, '30X1', 180, $8, NULL, $9, false, false)`,
        [`mig167-set-${s.set_number}`, perf.id, s.set_number, s.weight_kg, s.reps,
          s.rpe, s.rir, s.completed, s.set_number === 2]
      );
    }

    return { org, client, trainer, session, perf };
  }

  const runMigration = () => db.query(MIGRATION_SQL);

  const migratedSession = () => db.query(
    `SELECT * FROM training_sessions WHERE metadata->>'migrated_from' = 'workout_sessions:mig167-sess'`
  );
  const migratedPerf = () => db.query(
    `SELECT * FROM exercise_performances
      WHERE metadata->>'migrated_from' = 'workout_session_exercises:mig167-wse'`
  );
  const migratedSets = () => db.query(
    `SELECT sp.* FROM set_performances sp
       JOIN exercise_performances ep ON ep.id = sp.exercise_performance_id
      WHERE ep.metadata->>'migrated_from' = 'workout_session_exercises:mig167-wse'
      ORDER BY sp.set_number`
  );

  describe('the session', () => {
    it('arrives with its client, trainer, org and date intact', async () => {
      const { org, client, trainer } = await seedLegacy();
      await runMigration();

      const { rows } = await migratedSession();
      expect(rows).toHaveLength(1);
      expect(rows[0].organization_id).toBe(org.id);
      expect(rows[0].client_id).toBe(client.id);
      expect(rows[0].trainer_id).toBe(trainer.id);
      expect(rows[0].session_date.toISOString().slice(0, 10)).toBe('2026-03-01');
    });

    it('converts the duration from minutes to seconds', async () => {
      // Reading 45 as 45 seconds would turn every historical session into a
      // rounding error in the analytics that come next.
      await seedLegacy({ durationMinutes: 45 });
      await runMigration();
      expect((await migratedSession()).rows[0].duration_seconds).toBe(2700);
    });

    it('maps the status to the new vocabulary', async () => {
      await seedLegacy({ status: 'completed' });
      await runMigration();
      expect((await migratedSession()).rows[0].status).toBe('COMPLETED');
    });

    it('leaves an unfinished session in progress, not completed', async () => {
      await seedLegacy({ status: 'in_progress' });
      await runMigration();
      const [row] = (await migratedSession()).rows;
      expect(row.status).toBe('IN_PROGRESS');
      expect(row.completed_at).toBeNull();
    });

    it('gives a completed session a completion time', async () => {
      // A COMPLETED row with no completed_at is dropped by every
      // "sessions this week" query, silently.
      await seedLegacy({ status: 'completed' });
      await runMigration();
      const [row] = (await migratedSession()).rows;
      expect(row.completed_at).not.toBeNull();
      expect(row.completed_at.getTime()).toBeGreaterThanOrEqual(row.started_at.getTime());
    });

    it('says in the row itself that its timestamps are approximate', async () => {
      // The old table stored no clock. Anything downstream that treats these
      // as measured needs to be able to find out that they are not.
      await seedLegacy();
      await runMigration();
      expect((await migratedSession()).rows[0].metadata.approximate_timestamps).toBe(true);
    });

    it('builds a readable name from the programme and the day', async () => {
      await seedLegacy();
      await runMigration();
      expect((await migratedSession()).rows[0].template_name).toBe('Push Pull Legs — Day 2');
    });

    it('uses whichever half of the name exists', async () => {
      await seedLegacy({ programName: null, workoutDay: 'Day 2' });
      await runMigration();
      expect((await migratedSession()).rows[0].template_name).toBe('Day 2');
    });

    it('leaves the name null when the old row had neither', async () => {
      await seedLegacy({ programName: null, workoutDay: null });
      await runMigration();
      expect((await migratedSession()).rows[0].template_name).toBeNull();
    });

    it('files the notes as the trainer\'s, because the trainer wrote them', async () => {
      await seedLegacy({ notes: 'Felt strong' });
      await runMigration();
      const [row] = (await migratedSession()).rows;
      expect(row.trainer_notes).toBe('Felt strong');
      expect(row.client_notes).toBeNull();
    });
  });

  describe('the exercise', () => {
    it('keeps its library link, its name snapshot and its position', async () => {
      await seedLegacy();
      await runMigration();
      const [row] = (await migratedPerf()).rows;
      expect(row.exercise_id).toBe('mig167-ex');
      expect(row.exercise_name).toBe('Back Squat');
      expect(row.order_index).toBe(3);
      expect(row.notes).toBe('depth cue');
    });

    it('counts as performed when any set was completed', async () => {
      await seedLegacy();
      await runMigration();
      expect((await migratedPerf()).rows[0].status).toBe('COMPLETED');
    });

    it('counts as not performed when every set was left unticked', async () => {
      // Written down and not done is a different fact from done.
      await seedLegacy({
        sets: [{ set_number: 1, weight_kg: 60, reps: 10, rpe: null, rir: null, completed: false }],
      });
      await runMigration();
      expect((await migratedPerf()).rows[0].status).toBe('PENDING');
    });

    it('claims no section, because the old schema had none', async () => {
      await seedLegacy();
      await runMigration();
      expect((await migratedPerf()).rows[0].section).toBeNull();
    });
  });

  describe('the sets', () => {
    it('brings every set across, in order', async () => {
      await seedLegacy();
      await runMigration();
      const { rows } = await migratedSets();
      expect(rows.map((r) => r.set_number)).toEqual([1, 2, 3]);
    });

    it('preserves the numbers a trainer would recognise', async () => {
      await seedLegacy();
      await runMigration();
      const [first] = (await migratedSets()).rows;
      expect(Number(first.actual_weight)).toBe(100);
      expect(first.actual_reps).toBe(5);
      expect(Number(first.actual_rpe)).toBe(8);
      expect(first.actual_rir).toBe(2);
      expect(first.tempo).toBe('30X1');
      expect(first.rest_seconds).toBe(180);
      expect(first.weight_unit).toBe('kg');
    });

    it('keeps a set that was not completed marked as not completed', async () => {
      // The PR engine only counts completed sets. Flipping this would award
      // records for work nobody did.
      await seedLegacy();
      await runMigration();
      const rows = (await migratedSets()).rows;
      expect(rows.map((r) => r.completed)).toEqual([true, true, false]);
    });

    it('does not invent a prescription that was never recorded', async () => {
      await seedLegacy();
      await runMigration();
      const [first] = (await migratedSets()).rows;
      expect(first.planned_reps).toBeNull();
      expect(first.planned_weight).toBeNull();
      expect(first.planned_rpe).toBeNull();
    });

    it('keeps what the old system believed about records', async () => {
      await seedLegacy();
      await runMigration();
      const rows = (await migratedSets()).rows;
      expect(rows[1].metadata.legacy_pr).toEqual({ weight: true, reps: false, volume: false });
    });

    it('clamps a set number the new constraint would reject, keeping the original', async () => {
      // sp_set_number_check is 1–99 and the old column was an unconstrained
      // INTEGER. One bad row must not abort the migration for everyone else.
      await seedLegacy({
        sets: [{ set_number: 250, weight_kg: 60, reps: 10, rpe: null, rir: null, completed: true }],
      });
      await runMigration();
      const [row] = (await migratedSets()).rows;
      expect(row.set_number).toBe(99);
      expect(row.metadata.original_set_number).toBe(250);
    });
  });

  describe('running it again', () => {
    it('changes nothing the second time', async () => {
      await seedLegacy();
      await runMigration();
      const before = {
        sessions: (await migratedSession()).rows.length,
        perfs: (await migratedPerf()).rows.length,
        sets: (await migratedSets()).rows.length,
      };

      await runMigration();

      expect((await migratedSession()).rows.length).toBe(before.sessions);
      expect((await migratedPerf()).rows.length).toBe(before.perfs);
      expect((await migratedSets()).rows.length).toBe(before.sets);
      expect(before.sets).toBe(3);
    });

    it('picks up a session logged since the last run', async () => {
      // The realistic deploy: migrate, then someone uses the old screen once
      // more before the cutover lands.
      const { org, client } = await seedLegacy();
      await runMigration();

      await db.query(
        `INSERT INTO workout_sessions (id, client_id, organization_id, session_date, status)
         VALUES ('mig167-sess-2', $1, $2, DATE '2026-03-02', 'completed')`,
        [client.id, org.id]
      );
      await runMigration();

      const { rows } = await db.query(
        `SELECT * FROM training_sessions
          WHERE metadata->>'migrated_from' = 'workout_sessions:mig167-sess-2'`
      );
      expect(rows).toHaveLength(1);
    });
  });

  describe('what it refuses to do', () => {
    it('leaves the old tables exactly as they were', async () => {
      // The whole point of migrate-then-replace: this migration copies. If it
      // ever starts deleting, the rollback path disappears with the data.
      await seedLegacy();
      await runMigration();

      const { rows: [counts] } = await db.query(`
        SELECT (SELECT count(*) FROM workout_sessions WHERE id = 'mig167-sess')          AS sessions,
               (SELECT count(*) FROM workout_session_exercises WHERE id = 'mig167-wse')  AS perfs,
               (SELECT count(*) FROM workout_sets WHERE session_exercise_id = 'mig167-wse') AS sets
      `);
      expect(Number(counts.sessions)).toBe(1);
      expect(Number(counts.perfs)).toBe(1);
      expect(Number(counts.sets)).toBe(3);
    });

    it('writes no personal records, leaving that to the backfill script', async () => {
      // Records depend on what the client's best was at the time, which SQL
      // cannot decide without reimplementing records.js.
      await seedLegacy();
      await runMigration();
      const { rows } = await db.query(
        'SELECT count(*)::int AS n FROM personal_records WHERE client_id = $1', ['mig167-client']
      );
      expect(rows[0].n).toBe(0);
    });

    // The migration also carries `WHERE ws.organization_id IS NOT NULL`, and
    // that branch cannot be exercised: migration 155 made the column NOT NULL,
    // so the row it guards against cannot be inserted to test with. The guard
    // stays as defence if that constraint is ever relaxed; what is pinned here
    // is the reason it is currently unreachable, so a future migration that
    // drops the NOT NULL fails this and has to think about the orphan case.
    it('relies on the database to rule out a session with no organisation', async () => {
      const { rows } = await db.query(`
        SELECT is_nullable FROM information_schema.columns
         WHERE table_name = 'workout_sessions' AND column_name = 'organization_id'
      `);
      expect(rows[0].is_nullable).toBe('NO');
    });
  });
});
