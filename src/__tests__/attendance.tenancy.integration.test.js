'use strict';
// The attendance register, against a real database.
//
// Four things the consolidation has to be true of, and none of them can be
// proved with a mocked pool — a mock returns what the fixture said no matter
// what the WHERE clause does, which is how a dropped tenant predicate has
// survived a full mocked suite in this repo before:
//
//   1. the legacy `attendance` table is actually gone;
//   2. every attendance row lives in attendance_logs, with an organization_id;
//   3. one studio cannot read, update or delete another studio's attendance;
//   4. marking, history and the summary aggregates still return the right
//      numbers.
//
// Gated on RLS_TEST_DATABASE_URL and loud in CI if that is missing, so it
// cannot quietly skip in the one place it matters.

const { Pool } = require('pg');

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('attendance tenancy, against a real database', () => {
    it('has a database to run against', () => {
      throw new Error('RLS_TEST_DATABASE_URL is not set in CI — the attendance tenancy proof would skip.');
    });
  });
}

const ORG_A = '77777777-7777-4777-8777-777777777777';
const ORG_B = '88888888-8888-4888-8888-888888888888';
const TODAY = new Date().toISOString().slice(0, 10);

// Cleanup predicate for every row this suite creates.
//
// Keyed on ref_id, not on an id prefix: the mirror statement in section 4 lets
// the id default, so an `id LIKE 'att-log-%'` sweep left those rows behind —
// they then collided with the next fixture insert on (ref_id, ref_type, date),
// AND blocked the afterAll organization delete outright. That second failure
// is worth a note: attendance_logs.organization_id is NOT NULL while its
// foreign key is ON DELETE SET NULL, so deleting a studio that has attendance
// raises instead of cleaning up. 087 added the key while the column was still
// nullable and 155 made it NOT NULL; neither revisited the other. 38 tables
// share the shape, so it is reported rather than fixed here.
const CLEAN = `DELETE FROM attendance_logs WHERE ref_id LIKE 'att-cl-%'`;

describeIf('attendance tenancy, against a real database', () => {
  let db;

  beforeAll(async () => {
    db = new Pool({ connectionString: DB_URL, max: 4 });

    await db.query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1,'Att A','att-a'), ($2,'Att B','att-b')
       ON CONFLICT (id) DO NOTHING`, [ORG_A, ORG_B]);
    await db.query(
      `INSERT INTO trainers (id, name, organization_id) VALUES ('att-tr-a','Ana',$1), ('att-tr-b','Ben',$2)
       ON CONFLICT (id) DO NOTHING`, [ORG_A, ORG_B]);
    await db.query(
      `INSERT INTO pt_clients (id, name, mobile, organization_id, trainer_id) VALUES
         ('att-cl-a','Asha','+919000017001',$1,'att-tr-a'),
         ('att-cl-b','Bala','+919000018001',$2,'att-tr-b')
       ON CONFLICT (id) DO NOTHING`, [ORG_A, ORG_B]);
  });

  beforeEach(async () => {
    // Rebuilt per test: several cases below delete rows, and a shared fixture
    // would make them order-dependent.
    await db.query(CLEAN);
    await db.query(
      `INSERT INTO attendance_logs
         (id, ref_id, ref_type, ref_name, date, check_in_time, method, status, organization_id)
       VALUES
         ('att-log-a1','att-cl-a','client','Asha', $3::date,        NOW(), 'manual','present',$1),
         ('att-log-a2','att-cl-a','client','Asha', $3::date - 1,    NOW(), 'qr',    'late',   $1),
         ('att-log-b1','att-cl-b','client','Bala', $3::date,        NOW(), 'manual','present',$2)`,
      [ORG_A, ORG_B, TODAY]);
  });

  afterAll(async () => {
    await db.query(CLEAN);
    await db.query(`DELETE FROM pt_clients      WHERE id LIKE 'att-cl-%'`);
    await db.query(`DELETE FROM trainers        WHERE id LIKE 'att-tr-%'`);
    await db.query(`DELETE FROM organizations   WHERE id IN ($1,$2)`, [ORG_A, ORG_B]);
    await db.end();
  });

  // ── 1. one table ──────────────────────────────────────────────────────────

  describe('1. the legacy table is gone', () => {
    test('public.attendance does not exist', async () => {
      const { rows } = await db.query(`SELECT to_regclass('public.attendance') AS t`);
      expect(rows[0].t).toBeNull();
    });

    test('attendance_logs does, and carries a NOT NULL organization_id', async () => {
      // The other half. A migration that dropped both would satisfy the test
      // above and destroy the register.
      const { rows } = await db.query(
        `SELECT is_nullable, data_type FROM information_schema.columns
          WHERE table_schema='public' AND table_name='attendance_logs'
            AND column_name='organization_id'`);
      expect(rows).toHaveLength(1);
      expect(rows[0].data_type).toBe('uuid');
      expect(rows[0].is_nullable).toBe('NO');
    });

    test('an attendance row cannot be written without a studio', async () => {
      // NOT NULL is the property that makes every predicate below meaningful:
      // a nullable org would let a row exist that no scoped read can see and
      // no scoped delete can remove.
      await expect(db.query(
        `INSERT INTO attendance_logs (id, ref_id, ref_type, date, status, organization_id)
         VALUES ('att-log-orphan','att-cl-a','client',$1::date,'present',NULL)`, [TODAY]
      )).rejects.toThrow(/null value|not-null/i);
    });

    test('the tenant isolation policy is on the canonical table', async () => {
      const { rows } = await db.query(
        `SELECT policyname FROM pg_policies
          WHERE tablename='attendance_logs' AND policyname='tenant_isolation'`);
      expect(rows).toHaveLength(1);
    });
  });

  // ── 2. reads ──────────────────────────────────────────────────────────────

  describe('2. a studio reads only its own register', () => {
    test('the scoped list returns only the caller studio rows', async () => {
      const { rows } = await db.query(
        `SELECT id FROM attendance_logs WHERE organization_id = $1 ORDER BY id`, [ORG_A]);
      expect(rows.map((r) => r.id)).toEqual(['att-log-a1', 'att-log-a2']);
    });

    test('fetching another studio row by id returns nothing', async () => {
      // The shape every :id handler uses — id alone would find it.
      const { rows } = await db.query(
        `SELECT id FROM attendance_logs WHERE id = $1 AND organization_id = $2`,
        ['att-log-b1', ORG_A]);
      expect(rows).toHaveLength(0);

      const unscoped = await db.query(`SELECT id FROM attendance_logs WHERE id = $1`, ['att-log-b1']);
      expect(unscoped.rows).toHaveLength(1); // it exists — the predicate is what hides it
    });

    test('the today-summary aggregate counts one studio, not both', async () => {
      // Three rows exist for today across two studios. A missing predicate
      // here inflates a studio dashboard with a competitor's footfall rather
      // than erroring, which is why it is asserted on the number.
      const { rows } = await db.query(
        `SELECT COUNT(*)::int AS total FROM attendance_logs
          WHERE date = $1::date AND ref_type='client' AND organization_id = $2`, [TODAY, ORG_A]);
      expect(rows[0].total).toBe(1);

      const both = await db.query(
        `SELECT COUNT(*)::int AS total FROM attendance_logs
          WHERE date = $1::date AND ref_type='client'`, [TODAY]);
      expect(both.rows[0].total).toBe(2);
    });
  });

  // ── 3. writes ─────────────────────────────────────────────────────────────

  describe('3. a studio cannot write another studio register', () => {
    test('a scoped update of another studio row changes nothing', async () => {
      const r = await db.query(
        `UPDATE attendance_logs SET status='absent'
          WHERE id = $1 AND organization_id = $2`, ['att-log-b1', ORG_A]);
      expect(r.rowCount).toBe(0);

      const { rows } = await db.query(`SELECT status FROM attendance_logs WHERE id = 'att-log-b1'`);
      expect(rows[0].status).toBe('present');
    });

    test('a scoped delete of another studio row changes nothing', async () => {
      const r = await db.query(
        `DELETE FROM attendance_logs WHERE id = $1 AND organization_id = $2`, ['att-log-b1', ORG_A]);
      expect(r.rowCount).toBe(0);

      const { rows } = await db.query(`SELECT id FROM attendance_logs WHERE id = 'att-log-b1'`);
      expect(rows).toHaveLength(1);
    });

    test('deleting a row the studio does own works', async () => {
      // The negative cases above are also satisfied by a predicate that
      // matches nothing at all. This is what separates "scoped" from "broken".
      const r = await db.query(
        `DELETE FROM attendance_logs WHERE id = $1 AND organization_id = $2`, ['att-log-a1', ORG_A]);
      expect(r.rowCount).toBe(1);
    });
  });

  // ── 4. the class check-in mirror ──────────────────────────────────────────

  describe('4. the class check-in mirror lands in the register', () => {
    const mirror = (refId, method, orgId) => db.query(
      // The statement from bookings.service.js checkIn(), minus the members
      // subselect (that table is empty; ref_name is nullable).
      `INSERT INTO attendance_logs
         (ref_id, ref_type, date, check_in_time, method, status, notes, organization_id)
       VALUES ($1, 'client', CURRENT_DATE, NOW(), $2, 'present', $3, $4)
       ON CONFLICT (ref_id, ref_type, date) DO UPDATE
         SET check_in_time = COALESCE(attendance_logs.check_in_time, EXCLUDED.check_in_time),
             status        = 'present',
             method        = CASE WHEN attendance_logs.method = 'manual' THEN EXCLUDED.method
                                  ELSE attendance_logs.method END
       RETURNING id, organization_id, method, check_in_time`,
      [refId, method, 'Class booking bk-1', orgId]);

    test('a mirrored check-in is visible to the scoped register read', async () => {
      // The whole point of the move. Against the old table this row existed
      // and this query returned nothing.
      await db.query(CLEAN);
      await mirror('att-cl-a', 'manual', ORG_A);

      const { rows } = await db.query(
        `SELECT ref_id, notes FROM attendance_logs
          WHERE organization_id = $1 AND date = CURRENT_DATE`, [ORG_A]);
      expect(rows).toHaveLength(1);
      expect(rows[0].ref_id).toBe('att-cl-a');
      expect(rows[0].notes).toMatch(/Class booking/);
    });

    test('it keeps the earliest check-in rather than rewriting arrival time', async () => {
      await db.query(CLEAN);
      const first = await mirror('att-cl-a', 'qr', ORG_A);
      const again = await mirror('att-cl-a', 'manual', ORG_A);

      expect(again.rows[0].id).toBe(first.rows[0].id);
      expect(again.rows[0].check_in_time).toEqual(first.rows[0].check_in_time);
      // …and a specific method is not downgraded to 'manual' by a later pass.
      expect(again.rows[0].method).toBe('qr');
    });

    test('the method the service clamps to is one the table accepts', async () => {
      // attendance_logs.method carries a CHECK the legacy column did not. This
      // is the constraint the clamp in bookings.service.js exists for: proved
      // here against the real constraint rather than against a mock that would
      // accept any string.
      await db.query(CLEAN);
      await expect(mirror('att-cl-a', 'turnstile', ORG_A)).rejects.toThrow(/method_check|violates check/i);
      await expect(mirror('att-cl-b', 'manual', ORG_B)).resolves.toBeDefined();
    });
  });

  // ── 5. a hazard this change does not introduce, and does not fix ──────────

  describe('5. the uniqueness key is not studio-scoped', () => {
    test('UNIQUE is (ref_id, ref_type, date) with no organization_id', async () => {
      // Documented rather than fixed, deliberately.
      //
      // Two studios cannot hold a row for the same ref_id on the same day.
      // Because all three writers use `ON CONFLICT (ref_id, ref_type, date)
      // DO UPDATE`, a collision would not error — studio B's check-in would
      // quietly UPDATE studio A's row, which is a cross-tenant write.
      //
      // It is unreachable today: ref_id is a pt_clients / trainers / users id,
      // and those are globally unique, so no two studios can present the same
      // one. The legacy `attendance` table had the identical key, so nothing
      // here is new or made worse by the consolidation.
      //
      // Scoping the key properly means changing this constraint AND the
      // ON CONFLICT target in routes/attendance.js, routes/qr-checkin.js and
      // bookings.service.js in lockstep — a change with its own blast radius,
      // which is why it is not smuggled into a de-duplication commit. This
      // test is here so the next person finds the fact rather than the bug.
      const { rows } = await db.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'public.attendance_logs'::regclass AND contype = 'u'`);
      expect(rows).toHaveLength(1);
      expect(rows[0].def).toBe('UNIQUE (ref_id, ref_type, date)');
      expect(rows[0].def).not.toMatch(/organization_id/);
    });
  });
});
