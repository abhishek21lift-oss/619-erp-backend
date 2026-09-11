'use strict';
// Diet templates, against a real database.
//
// ── What this is actually testing ───────────────────────────────────────────
//
// There is no `diet_plans` table and there never was one in this schema —
// `diet_plans` is a search-provider group key and a UI route name, not a data
// source. diet_templates is already the only canonical one. So the thing worth
// pinning here is not a consolidation; it is the tenancy of that single table,
// which was left open on purpose and then not closed.
//
// Migration 106 gave diet_templates an organization_id and said in its own
// header that narrowing the GET routes "belongs in its own change". Until that
// change, GET /api/diet/templates read the table with no org predicate at all
// — not the shared shape that /meals uses, no predicate. Every studio was
// served every other studio's templates, with the full meal composition
// attached by the json_agg subquery.
//
// It leaked nothing in production only because all 8 rows happen to carry
// organization_id IS NULL. The safety was in the data, not the code: the very
// next row created through POST /templates carries orgIdOf(req).
//
// The predicate is the SHARED shape, not the strict one, and that distinction
// is load-bearing — a strict `organization_id = $org` would empty the diet
// template picker for all six studios at once, since every row is currently
// product-seeded. Half the tests below exist to hold that line.
//
// Gated on RLS_TEST_DATABASE_URL and loud in CI if that is missing, so it
// cannot quietly skip in the one place it matters.

const { Pool } = require('pg');

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('diet template tenancy, against a real database', () => {
    it('has a database to run against', () => {
      throw new Error('RLS_TEST_DATABASE_URL is not set in CI — the diet tenancy proof would skip.');
    });
  });
}

const ORG_A = '77777777-7777-4777-8777-777777777777';
const ORG_B = '88888888-8888-4888-8888-888888888888';

// The predicate the route builds when scope.applyFilter is true. Kept as one
// string so a test cannot accidentally assert against a looser version of it
// than the route uses.
const SHARED = '(dt.organization_id IS NULL OR dt.organization_id = $1)';

describeIf('diet template tenancy, against a real database', () => {
  let db;

  // The route's own WHERE, bounded to this suite's fixture rows. The bound is
  // on id only — the SHARED predicate under test is applied exactly as the
  // route builds it. Without the bound these assertions would also be counting
  // the product-seeded templates the schema ships, which vary by database.
  const listFor = (orgId) => db.query(
    `SELECT dt.id FROM diet_templates dt
      WHERE is_active = true AND ${SHARED}
        AND dt.id LIKE 'diet-tpl-%' ORDER BY dt.id`, [orgId]);

  beforeAll(async () => {
    db = new Pool({ connectionString: DB_URL, max: 4 });

    await db.query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1,'Diet A','diet-a'), ($2,'Diet B','diet-b')
       ON CONFLICT (id) DO NOTHING`, [ORG_A, ORG_B]);
    await db.query(
      `INSERT INTO trainers (id, name, organization_id) VALUES ('diet-tr-a','Ana',$1), ('diet-tr-b','Ben',$2)
       ON CONFLICT (id) DO NOTHING`, [ORG_A, ORG_B]);
    await db.query(
      `INSERT INTO pt_clients (id, name, mobile, organization_id, trainer_id) VALUES
         ('diet-cl-a','Asha','+919000027001',$1,'diet-tr-a'),
         ('diet-cl-b','Bala','+919000028001',$2,'diet-tr-b')
       ON CONFLICT (id) DO NOTHING`, [ORG_A, ORG_B]);
  });

  beforeEach(async () => {
    await db.query(`DELETE FROM diet_assignments WHERE id LIKE 'diet-as-%'`);
    await db.query(`DELETE FROM diet_templates   WHERE id LIKE 'diet-tpl-%'`);
    await db.query(
      `INSERT INTO diet_templates (id, name, goal, daily_calories, is_active, organization_id) VALUES
         ('diet-tpl-shared','Seeded Cut','weight_loss', 1800, true, NULL),
         ('diet-tpl-a',     'A Private', 'weight_loss', 1900, true, $1),
         ('diet-tpl-b',     'B Private', 'muscle_gain', 2600, true, $2)`,
      [ORG_A, ORG_B]);
  });

  afterAll(async () => {
    await db.query(`DELETE FROM diet_assignments WHERE id LIKE 'diet-as-%'`);
    await db.query(`DELETE FROM diet_templates   WHERE id LIKE 'diet-tpl-%'`);
    await db.query(`DELETE FROM pt_clients       WHERE id LIKE 'diet-cl-%'`);
    await db.query(`DELETE FROM trainers         WHERE id LIKE 'diet-tr-%'`);
    await db.query(`DELETE FROM organizations    WHERE id IN ($1,$2)`, [ORG_A, ORG_B]);
    await db.end();
  });

  // ── 1. one canonical table ────────────────────────────────────────────────

  describe('1. diet_templates is the only diet-template table', () => {
    test('no diet_plans relation exists, under any relkind', async () => {
      // to_regclass alone would miss a view; this catches table, view and
      // materialized view alike.
      const { rows } = await db.query(
        `SELECT relname FROM pg_class
          WHERE relnamespace = 'public'::regnamespace
            AND relkind IN ('r','v','m') AND relname = 'diet_plans'`);
      expect(rows).toHaveLength(0);
    });

    test('diet_templates does, and carries a nullable organization_id', async () => {
      // NULLABLE on purpose — see migration 106. If this ever becomes NOT NULL
      // the shared half of the predicate below is dead and the seeded
      // templates have been orphaned or deleted.
      const { rows } = await db.query(
        `SELECT data_type, is_nullable FROM information_schema.columns
          WHERE table_schema='public' AND table_name='diet_templates'
            AND column_name='organization_id'`);
      expect(rows).toHaveLength(1);
      expect(rows[0].data_type).toBe('uuid');
      expect(rows[0].is_nullable).toBe('YES');
    });

    test('the meal join table hangs off diet_templates', async () => {
      const { rows } = await db.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'public.diet_plan_meals'::regclass AND contype = 'f'`);
      expect(rows.map((r) => r.def).join(' ')).toMatch(/REFERENCES diet_templates\(id\)/);
    });
  });

  // ── 2. the shared shape ───────────────────────────────────────────────────

  describe('2. a studio sees shared templates plus its own', () => {
    test('studio A sees the seeded template and its own, not B\'s', async () => {
      const { rows } = await listFor(ORG_A);
      expect(rows.map((r) => r.id)).toEqual(['diet-tpl-a', 'diet-tpl-shared']);
    });

    test('studio B sees the seeded template and its own, not A\'s', async () => {
      // Both directions, so a predicate that happens to favour one fixture
      // cannot pass.
      const { rows } = await listFor(ORG_B);
      expect(rows.map((r) => r.id)).toEqual(['diet-tpl-b', 'diet-tpl-shared']);
    });

    test('the unscoped read this replaced returned all three', async () => {
      // The defect, stated as a fact rather than described in a comment. If
      // this stops returning three rows the fixture has drifted and the two
      // assertions above prove less than they appear to.
      const { rows } = await db.query(
        `SELECT dt.id FROM diet_templates dt WHERE is_active = true AND dt.id LIKE 'diet-tpl-%'`);
      expect(rows).toHaveLength(3);
    });

    test('a STRICT predicate would hide the seeded templates — which is why it is not used', async () => {
      // The failure mode in the other direction. Every diet template in
      // production today has organization_id IS NULL, so scoping strictly
      // would empty the picker for all six studios at once.
      const { rows } = await db.query(
        `SELECT dt.id FROM diet_templates dt
          WHERE is_active = true AND dt.organization_id = $1 AND dt.id LIKE 'diet-tpl-%'`, [ORG_A]);
      expect(rows.map((r) => r.id)).toEqual(['diet-tpl-a']);
      expect(rows.map((r) => r.id)).not.toContain('diet-tpl-shared');
    });

    test('is_active = false hides a template from its own studio too', async () => {
      await db.query(`UPDATE diet_templates SET is_active = false WHERE id = 'diet-tpl-a'`);
      const { rows } = await listFor(ORG_A);
      expect(rows.map((r) => r.id)).toEqual(['diet-tpl-shared']);
    });
  });

  // ── 3. assignment cannot reach across ─────────────────────────────────────

  describe('3. a studio cannot assign another studio template', () => {
    // The statement from POST /api/diet/assign, with the guard the route now
    // builds when scope.applyFilter is true.
    const assign = (templateId, clientId, orgId) => db.query(
      `INSERT INTO diet_assignments (id, diet_template_id, client_id, trainer_id,
         start_date, end_date, status, notes, organization_id)
       SELECT $1,$2,$3,NULL,CURRENT_DATE,NULL,'active',NULL,$4
        WHERE EXISTS (SELECT 1 FROM diet_templates dt WHERE dt.id = $2
                        AND (dt.organization_id IS NULL OR dt.organization_id = $4))
       ON CONFLICT (diet_template_id, client_id, status)
       DO UPDATE SET status = 'active', updated_at = NOW()
       RETURNING id`,
      [`diet-as-${templateId}-${clientId}`, templateId, clientId, orgId]);

    test('assigning B\'s private template as A writes nothing', async () => {
      const { rows } = await assign('diet-tpl-b', 'diet-cl-a', ORG_A);
      expect(rows).toHaveLength(0);

      const after = await db.query(`SELECT id FROM diet_assignments WHERE id LIKE 'diet-as-%'`);
      expect(after.rows).toHaveLength(0);
    });

    test('assigning the studio own template works', async () => {
      // The negative above is also satisfied by a guard that matches nothing
      // at all. This is what separates "guarded" from "broken".
      const { rows } = await assign('diet-tpl-a', 'diet-cl-a', ORG_A);
      expect(rows).toHaveLength(1);
    });

    test('assigning a seeded template works for either studio', async () => {
      // The shared half of the guard. Losing it would break the product's own
      // starter content for everyone.
      expect((await assign('diet-tpl-shared', 'diet-cl-a', ORG_A)).rows).toHaveLength(1);
      expect((await assign('diet-tpl-shared', 'diet-cl-b', ORG_B)).rows).toHaveLength(1);
    });

    test('assigning a template id that does not exist writes nothing', async () => {
      const { rows } = await assign('diet-tpl-nope', 'diet-cl-a', ORG_A);
      expect(rows).toHaveLength(0);
    });

    test('the assignment read-back cannot surface a foreign template', async () => {
      // Why the assign guard matters even with the list endpoint scoped: this
      // join is scoped by da.organization_id, which is the CALLER's own. A
      // foreign template smuggled in through assign would be read straight
      // back out through it.
      await assign('diet-tpl-a', 'diet-cl-a', ORG_A);
      await assign('diet-tpl-b', 'diet-cl-a', ORG_A);   // refused by the guard

      const { rows } = await db.query(
        `SELECT dt.name FROM diet_assignments da
           JOIN diet_templates dt ON dt.id = da.diet_template_id
          WHERE da.organization_id = $1 AND da.id LIKE 'diet-as-%'`, [ORG_A]);
      expect(rows.map((r) => r.name)).toEqual(['A Private']);
      expect(rows.map((r) => r.name)).not.toContain('B Private');
    });
  });

  // ── 4. CRUD keeps the stamp ───────────────────────────────────────────────

  describe('4. create and update keep the owning studio', () => {
    test('a template created by a studio carries that studio', async () => {
      await db.query(
        `INSERT INTO diet_templates (id, name, goal, daily_calories, is_active, organization_id)
         VALUES ('diet-tpl-new','A New','maintenance',2200,true,$1)`, [ORG_A]);

      const { rows } = await db.query(
        `SELECT organization_id FROM diet_templates WHERE id = 'diet-tpl-new'`);
      expect(rows[0].organization_id).toBe(ORG_A);

      // …and is immediately invisible to the other studio.
      const b = await listFor(ORG_B);
      expect(b.rows.map((r) => r.id)).not.toContain('diet-tpl-new');
    });

    test('a scoped update of another studio template changes nothing', async () => {
      const r = await db.query(
        `UPDATE diet_templates SET name = 'hijacked'
          WHERE id = 'diet-tpl-b' AND organization_id = $1`, [ORG_A]);
      expect(r.rowCount).toBe(0);

      const { rows } = await db.query(`SELECT name FROM diet_templates WHERE id = 'diet-tpl-b'`);
      expect(rows[0].name).toBe('B Private');
    });
  });
});
