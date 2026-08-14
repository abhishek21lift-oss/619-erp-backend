'use strict';
// scripts/backfill-training-records.js, against a real PostgreSQL.
//
// The script rebuilds personal_records by replaying training history through
// modules/training/records.js. The rules themselves are unit-tested there;
// what is untested until here is the replay — the ordering, the accumulation
// of what a client currently holds, and whether running it twice doubles
// anything.
//
// Same shape as migration167.dataMigration.test.js: one transaction, always
// rolled back, so the shared database is untouched.

const { Pool } = require('pg');

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('training record backfill, against a real database', () => {
    it('has a database to run against', () => {
      throw new Error(
        'RLS_TEST_DATABASE_URL is not set in CI, so the record backfill proof '
        + 'never ran. Repair .github/workflows/ci.yml.'
      );
    });
  });
}

// Required at module load because the script's own module does, via the pool.
// Both suites in CI already have DATABASE_URL set for that reason.
const { backfill } = require('../../scripts/backfill-training-records');

/** Swallows the script's progress output so the test log stays readable. */
const quiet = { write: () => {} };

describeIf('backfill-training-records', () => {
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

  const run = (opts = {}) =>
    backfill({ db, ownTransaction: false, out: quiet, clientId: 'bf-client', ...opts });

  async function seedClient() {
    const { rows: [org] } = await db.query(
      `INSERT INTO organizations (name, slug) VALUES ('BF Test', 'bf-test-records') RETURNING id`
    );
    await db.query(
      `INSERT INTO pt_clients (id, name, organization_id) VALUES ('bf-client', 'BF Client', $1)`,
      [org.id]
    );
    await db.query(
      `INSERT INTO exercises (id, name, muscle_group) VALUES ('bf-ex', 'Back Squat', 'Legs')`
    );
    return org;
  }

  /** One completed session on `date`, with the given sets against bf-ex. */
  async function seedSession(org, date, sets, key = date) {
    const { rows: [session] } = await db.query(
      `INSERT INTO training_sessions
         (organization_id, client_id, session_date, status, started_at, completed_at)
       VALUES ($1, 'bf-client', $2::date, 'COMPLETED', $2::timestamptz, $2::timestamptz)
       RETURNING id`,
      [org.id, date]
    );
    const { rows: [perf] } = await db.query(
      `INSERT INTO exercise_performances (session_id, exercise_id, exercise_name, order_index, status)
       VALUES ($1, 'bf-ex', 'Back Squat', 0, 'COMPLETED') RETURNING id`,
      [session.id]
    );
    let n = 0;
    for (const s of sets) {
      n += 1;
      await db.query(
        `INSERT INTO set_performances
           (exercise_performance_id, set_number, actual_reps, actual_weight, weight_unit,
            completed, client_token)
         VALUES ($1, $2, $3, $4, 'kg', $5, $6)`,
        [perf.id, n, s.reps, s.weight, s.completed !== false, `bf:${key}:${n}`]
      );
    }
    return { session, perf };
  }

  const liveRecords = () => db.query(
    `SELECT record_type, value, reps, achieved_on FROM personal_records
      WHERE client_id = 'bf-client' AND superseded_at IS NULL
      ORDER BY record_type`
  );

  it('writes the client\'s best lift as their record', async () => {
    const org = await seedClient();
    await seedSession(org, '2026-01-10', [{ weight: 100, reps: 5 }]);

    await run();

    const { rows } = await liveRecords();
    const max = rows.find((r) => r.record_type === 'MAX_WEIGHT');
    expect(Number(max.value)).toBe(100);
    expect(max.reps).toBe(5);
  });

  it('leaves one live record per type, not one per session', async () => {
    // The partial unique index would reject two, but the script is what has to
    // supersede — getting this wrong throws rather than corrupting, which is
    // why it is worth pinning.
    const org = await seedClient();
    await seedSession(org, '2026-01-10', [{ weight: 100, reps: 5 }], 'a');
    await seedSession(org, '2026-02-10', [{ weight: 110, reps: 5 }], 'b');

    await run();

    const { rows } = await liveRecords();
    expect(rows.filter((r) => r.record_type === 'MAX_WEIGHT')).toHaveLength(1);
    expect(Number(rows.find((r) => r.record_type === 'MAX_WEIGHT').value)).toBe(110);
  });

  it('does not let a later lighter session beat an earlier heavier one', async () => {
    // The reason sessions replay oldest-first. Out of order, the deload in
    // February would supersede the January PR and the client would be told
    // their best squat is 80kg.
    const org = await seedClient();
    await seedSession(org, '2026-01-10', [{ weight: 140, reps: 3 }], 'a');
    await seedSession(org, '2026-02-10', [{ weight: 80, reps: 3 }], 'b');

    await run();

    const { rows } = await liveRecords();
    expect(Number(rows.find((r) => r.record_type === 'MAX_WEIGHT').value)).toBe(140);
  });

  it('dates the record to the session that set it, not to today', async () => {
    const org = await seedClient();
    await seedSession(org, '2026-01-10', [{ weight: 100, reps: 5 }]);

    await run();

    const { rows } = await liveRecords();
    expect(rows[0].achieved_on.toISOString().slice(0, 10)).toBe('2026-01-10');
  });

  it('ignores sets that were never completed', async () => {
    // Awarding a record for work nobody did makes the whole feature ignorable.
    const org = await seedClient();
    await seedSession(org, '2026-01-10', [
      { weight: 100, reps: 5, completed: true },
      { weight: 200, reps: 1, completed: false },
    ]);

    await run();

    const { rows } = await liveRecords();
    expect(Number(rows.find((r) => r.record_type === 'MAX_WEIGHT').value)).toBe(100);
  });

  it('writes nothing at all on the second run', async () => {
    const org = await seedClient();
    await seedSession(org, '2026-01-10', [{ weight: 100, reps: 5 }], 'a');
    await seedSession(org, '2026-02-10', [{ weight: 110, reps: 5 }], 'b');

    const first = await run();
    const before = (await liveRecords()).rows;

    const second = await run();
    const after = (await liveRecords()).rows;

    expect(first.written).toBeGreaterThan(0);
    expect(second.written).toBe(0);
    expect(after).toEqual(before);
  });

  it('respects records a client already holds from live use', async () => {
    // The realistic case: some clients have been using the new logger while
    // others are being migrated. The backfill must not demote a live record.
    const org = await seedClient();
    await db.query(
      `INSERT INTO personal_records
         (organization_id, client_id, exercise_id, exercise_name, record_type, value, unit, achieved_on)
       VALUES ($1, 'bf-client', 'bf-ex', 'Back Squat', 'MAX_WEIGHT', 160, 'kg', DATE '2026-05-01')`,
      [org.id]
    );
    await seedSession(org, '2026-01-10', [{ weight: 100, reps: 5 }]);

    await run();

    const { rows } = await liveRecords();
    expect(Number(rows.find((r) => r.record_type === 'MAX_WEIGHT').value)).toBe(160);
  });

  it('writes nothing when asked for a dry run', async () => {
    const org = await seedClient();
    await seedSession(org, '2026-01-10', [{ weight: 100, reps: 5 }]);

    const result = await run({ dryRun: true });

    expect(result.written).toBeGreaterThan(0);
    expect((await liveRecords()).rows).toHaveLength(0);
  });

  it('skips a performance whose exercise is gone, rather than crediting nobody', async () => {
    // exercise_id goes NULL when an exercise is deleted. A record is per
    // movement; "some exercise that no longer exists" is not one.
    const org = await seedClient();
    const { session } = await seedSession(org, '2026-01-10', [{ weight: 100, reps: 5 }]);
    await db.query(
      `UPDATE exercise_performances SET exercise_id = NULL WHERE session_id = $1`, [session.id]
    );

    const result = await run();

    expect(result.written).toBe(0);
    expect((await liveRecords()).rows).toHaveLength(0);
  });

  it('ignores sessions that were never finished', async () => {
    const org = await seedClient();
    const { session } = await seedSession(org, '2026-01-10', [{ weight: 100, reps: 5 }]);
    await db.query(
      `UPDATE training_sessions SET status = 'IN_PROGRESS', completed_at = NULL WHERE id = $1`,
      [session.id]
    );

    const result = await run();
    expect(result.sessions).toBe(0);
    expect((await liveRecords()).rows).toHaveLength(0);
  });
});
