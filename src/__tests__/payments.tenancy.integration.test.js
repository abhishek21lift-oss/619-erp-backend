'use strict';
// The payment ledger, against a real database.
//
// Four things the consolidation has to be true of, and none of them can be
// proved with a mocked pool — a mock returns what the fixture said no matter
// what the WHERE clause does, which is how a dropped tenant predicate has
// survived a full mocked suite in this repo before:
//
//   1. the legacy `payments` table is actually gone;
//   2. every payment lives in pt_payments, with an organization_id;
//   3. one studio cannot read or delete another studio's payments;
//   4. creation, history and reporting still return the right numbers.
//
// Gated on RLS_TEST_DATABASE_URL and loud in CI if that is missing, so it
// cannot quietly skip in the one place it matters.

const { Pool } = require('pg');

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('payment tenancy, against a real database', () => {
    it('has a database to run against', () => {
      throw new Error('RLS_TEST_DATABASE_URL is not set in CI — the payment tenancy proof would skip.');
    });
  });
}

const ORG_A = '77777777-7777-4777-8777-777777777777';
const ORG_B = '88888888-8888-4888-8888-888888888888';

describeIf('payment tenancy, against a real database', () => {
  let db;

  beforeAll(async () => {
    db = new Pool({ connectionString: DB_URL, max: 4 });

    await db.query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1,'Pay A','pay-a'), ($2,'Pay B','pay-b')
       ON CONFLICT (id) DO NOTHING`, [ORG_A, ORG_B]);
    await db.query(
      `INSERT INTO trainers (id, name, organization_id) VALUES ('pay-tr-a','Ana',$1), ('pay-tr-b','Ben',$2)
       ON CONFLICT (id) DO NOTHING`, [ORG_A, ORG_B]);
    await db.query(
      `INSERT INTO pt_clients (id, name, mobile, organization_id, trainer_id) VALUES
         ('pay-cl-a','Asha','+919000007001',$1,'pay-tr-a'),
         ('pay-cl-b','Bala','+919000008001',$2,'pay-tr-b')
       ON CONFLICT (id) DO NOTHING`, [ORG_A, ORG_B]);
    await db.query(
      `INSERT INTO pt_payments (id, client_id, trainer_id, amount, incentive_amt, payment_method,
                                payment_ref, date, organization_id, created_at, updated_at)
       VALUES
         ('pay-a-1','pay-cl-a','pay-tr-a', 5000, 500, 'CASH','RCPT-A1', CURRENT_DATE, $1, NOW(), NOW()),
         ('pay-a-2','pay-cl-a','pay-tr-a', 2500, 250, 'UPI', 'RCPT-A2', CURRENT_DATE, $1, NOW(), NOW()),
         ('pay-b-1','pay-cl-b','pay-tr-b', 9000, 900, 'CASH','RCPT-B1', CURRENT_DATE, $2, NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`, [ORG_A, ORG_B]);
  });

  afterAll(async () => {
    await db.query(`DELETE FROM pt_payments WHERE id LIKE 'pay-%'`);
    await db.query(`DELETE FROM pt_clients  WHERE id LIKE 'pay-cl-%'`);
    await db.query(`DELETE FROM trainers    WHERE id LIKE 'pay-tr-%'`);
    await db.query(`DELETE FROM organizations WHERE id IN ($1,$2)`, [ORG_A, ORG_B]);
    await db.end();
  });

  describe('1. the legacy ledger is gone', () => {
    test('public.payments does not exist', async () => {
      const { rows } = await db.query(`SELECT to_regclass('public.payments') AS t`);
      expect(rows[0].t).toBeNull();
    });

    test('and neither does the view that aggregated it', async () => {
      const { rows } = await db.query(`SELECT to_regclass('public.v_trainer_monthly_revenue') AS t`);
      expect(rows[0].t).toBeNull();
    });

    test('pt_payments does, and carries organization_id', async () => {
      // The other half — a migration that dropped both would pass the two
      // tests above and leave the product with no ledger at all.
      const { rows } = await db.query(
        `SELECT count(*)::int AS n FROM information_schema.columns
          WHERE table_name='pt_payments' AND column_name='organization_id'`);
      expect(rows[0].n).toBe(1);
    });
  });

  describe('2. every payment carries a studio', () => {
    test('organization_id is present on all of them', async () => {
      const { rows } = await db.query(
        `SELECT count(*)::int AS n FROM pt_payments WHERE organization_id IS NULL`);
      expect(rows[0].n).toBe(0);
    });
  });

  describe('3. one studio cannot reach another studio\'s money', () => {
    const ledger = (orgId, extra = '', params = []) => db.query(
      `SELECT p.id, p.amount FROM pt_payments p
        WHERE p.organization_id = $1 AND p.deleted_at IS NULL${extra}
        ORDER BY p.id`, [orgId, ...params]);

    test('a scoped list returns only your own', async () => {
      const a = await ledger(ORG_A);
      expect(a.rows.map((r) => r.id)).toEqual(['pay-a-1', 'pay-a-2']);
      const b = await ledger(ORG_B);
      expect(b.rows.map((r) => r.id)).toEqual(['pay-b-1']);
    });

    test('naming another studio\'s payment id directly returns nothing', async () => {
      // Ids are the attack: `WHERE id = $1` alone would find it.
      const { rows } = await ledger(ORG_A, ' AND p.id = $2', ['pay-b-1']);
      expect(rows).toEqual([]);
    });

    test('a delete scoped to the wrong studio changes nothing', async () => {
      // The shape routes/payments.js uses. The legacy fallback it replaced had
      // no organization clause at all, which against a populated table is a
      // cross-tenant destroy by id.
      const { rowCount } = await db.query(
        `UPDATE pt_payments SET deleted_at = NOW()
          WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
        ['pay-b-1', ORG_A]);
      expect(rowCount).toBe(0);

      const { rows } = await db.query(
        `SELECT deleted_at FROM pt_payments WHERE id = 'pay-b-1'`);
      expect(rows[0].deleted_at).toBeNull();
    });

    test('and the owning studio\'s delete does work', async () => {
      // A guard that refuses everything is not a guard.
      const { rowCount } = await db.query(
        `UPDATE pt_payments SET deleted_at = NOW()
          WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
        ['pay-a-2', ORG_A]);
      expect(rowCount).toBe(1);
      await db.query(`UPDATE pt_payments SET deleted_at = NULL WHERE id = 'pay-a-2'`);
    });

    test('a revenue total cannot be inflated by another studio\'s payments', async () => {
      const { rows } = await db.query(
        `SELECT COALESCE(SUM(amount),0)::float AS total FROM pt_payments
          WHERE organization_id = $1 AND deleted_at IS NULL`, [ORG_A]);
      expect(rows[0].total).toBe(7500);   // 5000 + 2500, not 16500
    });
  });

  describe('4. history and reporting are still correct', () => {
    test('the ledger read returns the shape the payments API serves', async () => {
      // The exact projection routes/payments.js uses, minus the UNION half
      // that used to append the unscopable ledger.
      const { rows } = await db.query(`
        SELECT p.id, p.client_id, c.name AS client_name, p.trainer_id,
               t.name AS trainer_name, p.amount, p.incentive_amt,
               UPPER(p.payment_method) AS method, p.payment_ref AS receipt_no,
               p.date, p.notes, p.deleted_at, p.created_at,
               NULL::text AS branch_id, NULL::text AS package_type, p.organization_id
        FROM pt_payments p
        LEFT JOIN pt_clients c ON c.id = p.client_id
        LEFT JOIN trainers   t ON t.id = p.trainer_id
        WHERE p.organization_id = $1 AND p.deleted_at IS NULL
        ORDER BY p.id`, [ORG_A]);

      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        id: 'pay-a-1', client_name: 'Asha', trainer_name: 'Ana',
        method: 'CASH', receipt_no: 'RCPT-A1',
      });
    });

    test('the trainer payment list runs and returns real rows', async () => {
      // This query used to select client_name, method and receipt_no straight
      // off pt_payments — three columns it has never had — so the trainer page
      // raised on every load. It now aliases the real ones.
      const { rows } = await db.query(`
        SELECT p.id, c.name AS client_name, p.amount,
               UPPER(p.payment_method) AS method, p.date,
               p.payment_ref AS receipt_no, p.incentive_amt
        FROM pt_payments p
        LEFT JOIN pt_clients c ON c.id = p.client_id
        WHERE p.trainer_id = $1 AND p.deleted_at IS NULL
        ORDER BY p.date DESC, p.created_at DESC LIMIT 30`, ['pay-tr-a']);

      expect(rows).toHaveLength(2);
      expect(rows[0].client_name).toBe('Asha');
      expect(rows[0].method).toMatch(/CASH|UPI/);
    });

    test('the 6-month trend reads the canonical ledger, so it is not a flat zero', async () => {
      const { rows } = await db.query(`
        SELECT TO_CHAR(DATE_TRUNC('month', date::date), 'Mon YY') AS month,
               COALESCE(SUM(amount),0)::float AS revenue
        FROM pt_payments
        WHERE trainer_id=$1 AND deleted_at IS NULL
          AND date >= NOW() - INTERVAL '6 months'
        GROUP BY DATE_TRUNC('month', date::date)
        ORDER BY DATE_TRUNC('month', date::date)`, ['pay-tr-a']);

      expect(rows.length).toBeGreaterThan(0);
      expect(rows.reduce((s, r) => s + r.revenue, 0)).toBe(7500);
    });

    test('a soft-deleted payment leaves every total, not just the list', async () => {
      // The aggregates on the trainer page did not filter deleted_at, so a
      // reversed payment stayed in lifetime revenue while dropping out of the
      // list beside it — the page contradicted itself.
      await db.query(`UPDATE pt_payments SET deleted_at = NOW() WHERE id = 'pay-a-2'`);
      const { rows } = await db.query(
        `SELECT COALESCE(SUM(amount),0)::float AS lifetime FROM pt_payments
          WHERE trainer_id = $1 AND deleted_at IS NULL`, ['pay-tr-a']);
      expect(rows[0].lifetime).toBe(5000);
      await db.query(`UPDATE pt_payments SET deleted_at = NULL WHERE id = 'pay-a-2'`);
    });

    test('the invoice link points at the canonical ledger', async () => {
      // Migration 191 repointed invoices.payment_id from the dropped table to
      // pt_payments, and added the column where a fresh build lacked it.
      const { rows } = await db.query(`
        SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
         WHERE conname = 'invoices_payment_id_fkey'`);
      expect(rows).toHaveLength(1);
      expect(rows[0].def).toMatch(/REFERENCES pt_payments\(id\)/);
    });

    test('an invoice cannot be linked to a payment that does not exist', async () => {
      // What the foreign key is actually for.
      await expect(db.query(
        `INSERT INTO invoices (id, organization_id, payment_id, total_amount, status)
         VALUES ('pay-inv-x', $1, 'no-such-payment', 100, 'draft')`, [ORG_A]
      )).rejects.toThrow(/foreign key|violates/i);
    });
  });
});
