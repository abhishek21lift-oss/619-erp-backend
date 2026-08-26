'use strict';
/**
 * Cross-tenant isolation across the business surfaces, against a real database.
 *
 * rls.isolation.integration.test.js proves the MECHANISM on one table: that a
 * connection whose current_user is app_tenant, scoped with app.org_id, commits
 * none of the four crimes against pt_clients. That is the right shape for the
 * mechanism and says nothing about coverage — a table that never received a
 * tenant_isolation policy leaks (or, worse and more quietly, goes blank) while
 * every assertion in that file still passes.
 *
 * This file walks the surfaces the product actually sells — clients, bookings,
 * attendance, trainers, PT sessions, payments, invoices, progress photos and
 * private uploads — and asks both halves of the question of each one:
 *
 *   can studio A reach studio B's row?        (isolation)
 *   can studio A still reach its OWN row?     (the cutover not breaking the app)
 *
 * The second half is not padding. RLS denies by filtering, not by erroring: a
 * table that grants app_tenant SELECT but permits nothing returns zero rows,
 * with no exception and no log line. The module using it renders empty and
 * looks like a quiet week. The census at the bottom of this file exists because
 * that is not hypothetical either — see BLIND_SPOTS.
 *
 * Skipped unless RLS_TEST_DATABASE_URL points at a throwaway database. Stand
 * one up with scripts/rls-proof-setup.sh.
 */

const { Pool } = require('pg');

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

// Same reasoning as the sibling suite: on a laptop a missing URL means "no
// database here", in CI it means the wiring broke and the proof silently
// stopped running.
if (process.env.CI && !DB_URL) {
  describe('cross-tenant isolation across business surfaces', () => {
    it('has a database to run against', () => {
      throw new Error(
        'RLS_TEST_DATABASE_URL is not set in CI, so the business-surface isolation '
        + 'proof would silently skip. Restore the "Stand up the RLS isolation database" '
        + 'step and the env var in .github/workflows/ci.yml.'
      );
    });
  });
}

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SUFFIX = { [ORG_A]: 'a', [ORG_B]: 'b' };

/**
 * One business surface: how to build a row for a studio, and what to change
 * when testing UPDATE. `pk` is the primary key column because not every table
 * calls it `id` — storage_objects keys uploads by their object key.
 */
const SURFACES = [
  {
    table: 'bookings',
    what: 'a class booking',
    pk: 'id',
    mutable: 'cancellation_reason',
    // UNIQUE (session_id, client_id): one member, one seat. A second booking
    // for the same member has to be for a different class in the same studio.
    vary: (r) => ({ ...r, session_id: `${r.session_id}-2` }),
    row: (org, s) => ({ id: `bk-${s}`, session_id: `sess-${s}`, client_id: `client-${s}`, organization_id: org }),
  },
  {
    table: 'attendance',
    what: 'a gym check-in',
    pk: 'id',
    mutable: 'check_in_method',
    // UNIQUE (type, ref_id, date): a second row for the same member on the same
    // day needs a different ref_id, not a different id.
    vary: (r, n) => ({ ...r, ref_id: `${r.ref_id}-${n}` }),
    row: (org, s) => ({ id: `att-${s}`, ref_id: `client-${s}`, organization_id: org }),
  },
  {
    table: 'attendance_logs',
    what: 'a class attendance record',
    pk: 'id',
    mutable: 'notes',
    // UNIQUE (ref_id, ref_type, date) — same reason as attendance.
    vary: (r, n) => ({ ...r, ref_id: `${r.ref_id}-${n}` }),
    row: (org, s) => ({ id: `atl-${s}`, ref_id: `client-${s}`, organization_id: org }),
  },
  {
    table: 'trainers',
    what: 'a trainer, and with them their commission rate',
    pk: 'id',
    mutable: 'name',
    // status='inactive' for the same class of reason attendance_logs needs
    // `vary`: a constraint that has nothing to do with isolation would
    // otherwise stop the probe inserting at all. Migration 184 added
    // trainers_one_active_per_org — UNIQUE (organization_id) WHERE
    // status='active' — and the fixture above already put an active trainer in
    // each org, so an active probe row is refused before RLS is ever consulted.
    // The policy filters on organization_id and never reads status, so an
    // archived trainer proves exactly the same property.
    row: (org, s) => ({ id: `tr-probe-${s}`, name: `Trainer ${s}`, status: 'inactive', organization_id: org }),
  },
  {
    table: 'pt_sessions',
    what: 'a delivered PT session — the unit commission is paid on',
    pk: 'id',
    mutable: 'notes',
    row: (org, s) => ({ id: `pts-${s}`, client_id: `client-${s}`, session_date: '2026-01-01', organization_id: org }),
  },
  {
    table: 'pt_payments',
    what: 'money taken for PT',
    pk: 'id',
    mutable: 'notes',
    row: (org, s) => ({ id: `ptp-${s}`, client_id: `client-${s}`, amount: 5000, organization_id: org }),
  },
  {
    table: 'invoices',
    what: 'an invoice',
    pk: 'id',
    mutable: 'notes',
    vary: (r, n) => ({ ...r, invoice_no: `${r.invoice_no}-${n}` }),
    row: (org, s) => ({ id: `inv-${s}`, invoice_no: `INV-${s}`, organization_id: org }),
  },
  {
    table: 'progress_photos',
    what: "a member's progress photo",
    pk: 'id',
    mutable: 'photo_url',
    row: (org, s) => ({ id: `ph-${s}`, client_id: `client-${s}`, photo_url: `https://example.invalid/${s}.jpg`, organization_id: org }),
  },
  {
    table: 'storage_objects',
    what: 'a private upload',
    pk: 'key',
    mutable: 'category',
    row: (org, s) => ({ key: `uploads/${s}/private.pdf`, category: 'private', bytes: 1024, organization_id: org }),
  },
];

const insert = (client, table, row) => {
  const cols = Object.keys(row);
  const ph = cols.map((_, i) => `$${i + 1}`).join(',');
  return client.query(
    `INSERT INTO ${table} (${cols.join(',')}) VALUES (${ph})`,
    cols.map((c) => row[c]));
};

describeIf('cross-tenant isolation across business surfaces', () => {
  /** Owner connection. Bypasses RLS — sets the world up and checks it after. */
  let owner;
  /** The role the app connects as after the cutover. */
  let tenant;

  beforeAll(async () => {
    owner = new Pool({ connectionString: DB_URL, max: 2 });
    const tenantUrl = new URL(DB_URL);
    tenantUrl.username = 'app_tenant';
    tenantUrl.password = process.env.RLS_TEST_TENANT_PASSWORD || 'localproof';
    tenant = new Pool({ connectionString: tenantUrl.toString(), max: 2 });

    for (const org of [ORG_A, ORG_B]) {
      const s = SUFFIX[org];
      await owner.query(
        `INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
        [org, `Studio ${s.toUpperCase()}`, `surface-${s}`]);
      await owner.query(
        `INSERT INTO pt_clients (id, name, organization_id) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
        [`client-${s}`, `${s.toUpperCase()} Member`, org]);
      await owner.query(
        `INSERT INTO trainers (id, name, organization_id) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
        [`tr-${s}`, `Coach ${s.toUpperCase()}`, org]);
      await owner.query(
        `INSERT INTO class_sessions (id, title, date, start_time, end_time, instructor_id, organization_id)
         VALUES ($1, 'Spin', DATE '2026-01-01', TIME '07:00', TIME '08:00', $2, $3) ON CONFLICT (id) DO NOTHING`,
        [`sess-${s}`, `tr-${s}`, org]);
      // A second class, so a surface with UNIQUE (session_id, client_id) has
      // somewhere legitimate to put its second fixture row.
      await owner.query(
        `INSERT INTO class_sessions (id, title, date, start_time, end_time, instructor_id, organization_id)
         VALUES ($1, 'Yoga', DATE '2026-01-02', TIME '07:00', TIME '08:00', $2, $3) ON CONFLICT (id) DO NOTHING`,
        [`sess-${s}-2`, `tr-${s}`, org]);
    }
  });

  afterAll(async () => {
    // Children before parents; the surfaces reference clients and sessions.
    for (const { table, pk, row } of SURFACES) {
      const keys = [row(ORG_A, 'a')[pk], row(ORG_B, 'b')[pk]];
      await owner.query(
        `DELETE FROM ${table} WHERE ${pk} = ANY($1) OR ${pk} LIKE 'smuggled-%' OR ${pk} LIKE 'fresh-%'`,
        [keys]);
    }
    await owner.query(`DELETE FROM class_sessions WHERE organization_id IN ($1,$2)`, [ORG_A, ORG_B]);
    await owner.query(`DELETE FROM trainers WHERE organization_id IN ($1,$2)`, [ORG_A, ORG_B]);
    await owner.query(`DELETE FROM pt_clients WHERE organization_id IN ($1,$2)`, [ORG_A, ORG_B]);
    await owner.query(`DELETE FROM organizations WHERE id IN ($1,$2)`, [ORG_A, ORG_B]);
    await owner?.end();
    await tenant?.end();
  });

  /** Run `fn` on a connection scoped to `orgId`, exactly as db/pool.js does. */
  async function asOrg(orgId, fn) {
    const client = await tenant.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1,$2,true)', ['app.org_id', orgId]);
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  it('connects as a role that cannot bypass RLS', async () => {
    // If this drifts, every assertion below passes for the wrong reason.
    const { rows } = await tenant.query(
      `SELECT current_user AS who, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user`);
    expect(rows[0].who).toBe('app_tenant');
    expect(rows[0].rolbypassrls).toBe(false);
    expect(rows[0].rolsuper).toBe(false);
  });

  describe.each(SURFACES)('$table — $what', ({ table, pk, mutable, row, vary }) => {
    // Some surfaces carry a UNIQUE constraint that a second fixture row would
    // trip before RLS ever sees it. `vary` moves the row off that constraint
    // so the test still measures the policy rather than the index.
    const distinct = vary || ((r) => r);
    const rowA = row(ORG_A, 'a');
    const rowB = row(ORG_B, 'b');
    const keyA = rowA[pk];
    const keyB = rowB[pk];

    beforeEach(async () => {
      await owner.query(`DELETE FROM ${table} WHERE ${pk} IN ($1,$2)`, [keyA, keyB]);
      await insert(owner, table, rowA);
      await insert(owner, table, rowB);
    });

    it('the owner sees both rows, so the fixture is real', async () => {
      const { rows } = await owner.query(
        `SELECT ${pk} AS k FROM ${table} WHERE ${pk} IN ($1,$2) ORDER BY 1`, [keyA, keyB]);
      expect(rows.map((r) => r.k)).toEqual([keyA, keyB].sort());
    });

    it("SELECT returns the caller's row and not the other studio's", async () => {
      const { rows } = await asOrg(ORG_A, (c) =>
        c.query(`SELECT ${pk} AS k FROM ${table} WHERE ${pk} IN ($1,$2)`, [keyA, keyB]));
      expect(rows.map((r) => r.k)).toEqual([keyA]);
    });

    it('SELECT cannot reach the other studio even when asked for it by primary key', async () => {
      // The shape a guessed or leaked id takes: the caller knows exactly what
      // it wants and the policy must still refuse.
      const { rows } = await asOrg(ORG_A, (c) =>
        c.query(`SELECT ${pk} AS k FROM ${table} WHERE ${pk} = $1`, [keyB]));
      expect(rows).toEqual([]);
    });

    it('COUNT cannot count what it cannot see', async () => {
      // Reports are aggregates. An aggregate that crosses studios leaks the
      // numbers without ever returning a row.
      const { rows } = await asOrg(ORG_A, (c) =>
        c.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${pk} IN ($1,$2)`, [keyA, keyB]));
      expect(rows[0].n).toBe(1);
    });

    it("INSERT of a row belonging to the other studio is refused", async () => {
      const smuggled = { ...distinct(row(ORG_B, 'b'), 'smuggled'), [pk]: `smuggled-${keyB}` };
      await expect(asOrg(ORG_A, (c) => insert(c, table, smuggled)))
        .rejects.toThrow(/row-level security/i);
      const { rows } = await owner.query(
        `SELECT ${pk} FROM ${table} WHERE ${pk} = $1`, [smuggled[pk]]);
      expect(rows).toEqual([]);
    });

    it("UPDATE of the other studio's row changes nothing", async () => {
      const { rowCount } = await asOrg(ORG_A, (c) =>
        c.query(`UPDATE ${table} SET ${mutable} = 'tampered' WHERE ${pk} = $1`, [keyB]));
      expect(rowCount).toBe(0);
      const { rows } = await owner.query(
        `SELECT ${mutable} AS v FROM ${table} WHERE ${pk} = $1`, [keyB]);
      expect(rows[0].v).not.toBe('tampered');
    });

    it("DELETE of the other studio's row removes nothing", async () => {
      const { rowCount } = await asOrg(ORG_A, (c) =>
        c.query(`DELETE FROM ${table} WHERE ${pk} = $1`, [keyB]));
      expect(rowCount).toBe(0);
      const { rows } = await owner.query(
        `SELECT count(*)::int AS n FROM ${table} WHERE ${pk} = $1`, [keyB]);
      expect(rows[0].n).toBe(1);
    });

    it('an unqualified DELETE removes only the caller\'s rows', async () => {
      // The accident, not the attack: a WHERE clause the application forgot.
      await asOrg(ORG_A, (c) => c.query(`DELETE FROM ${table} WHERE ${pk} IN ($1,$2)`, [keyA, keyB]));
      const { rows } = await owner.query(
        `SELECT ${pk} AS k FROM ${table} WHERE ${pk} IN ($1,$2)`, [keyA, keyB]);
      expect(rows.map((r) => r.k)).toEqual([keyB]);
    });

    // ── the other half: the cutover must not break the studio's own work ────
    it("the caller can still read, write and delete its OWN row", async () => {
      await asOrg(ORG_A, async (c) => {
        const read = await c.query(`SELECT ${pk} AS k FROM ${table} WHERE ${pk} = $1`, [keyA]);
        expect(read.rows).toHaveLength(1);
        const upd = await c.query(`UPDATE ${table} SET ${mutable} = 'edited' WHERE ${pk} = $1`, [keyA]);
        expect(upd.rowCount).toBe(1);
        const del = await c.query(`DELETE FROM ${table} WHERE ${pk} = $1`, [keyA]);
        expect(del.rowCount).toBe(1);
      });
    });

    it('an INSERT into the caller\'s own studio still works', async () => {
      const fresh = { ...distinct(row(ORG_A, 'a'), 'fresh'), [pk]: `fresh-${keyA}` };
      await asOrg(ORG_A, (c) => insert(c, table, fresh));
      const { rows } = await owner.query(
        `SELECT ${pk} FROM ${table} WHERE ${pk} = $1`, [fresh[pk]]);
      expect(rows).toHaveLength(1);
      await owner.query(`DELETE FROM ${table} WHERE ${pk} = $1`, [fresh[pk]]);
    });

    it('sees nothing at all when app.org_id is not set', async () => {
      // The unscoped borrow: a query that escapes the wrapper must fail closed,
      // not open. current_setting(..., true) returns NULL, which matches no row.
      const client = await tenant.connect();
      try {
        const { rows } = await client.query(
          `SELECT count(*)::int AS n FROM ${table} WHERE ${pk} IN ($1,$2)`, [keyA, keyB]);
        expect(rows[0].n).toBe(0);
      } finally {
        client.release();
      }
    });
  });

  describe('reporting', () => {
    beforeEach(async () => {
      await owner.query(`DELETE FROM pt_payments WHERE id IN ('rep-a','rep-b')`);
      await owner.query(
        `INSERT INTO pt_payments (id, client_id, amount, organization_id)
         VALUES ('rep-a','client-a',1000,$1), ('rep-b','client-b',9999,$2)`, [ORG_A, ORG_B]);
    });

    afterEach(async () => {
      await owner.query(`DELETE FROM pt_payments WHERE id IN ('rep-a','rep-b')`);
    });

    it('a revenue total is the caller\'s revenue, not the platform\'s', async () => {
      // The leak a report makes is a number, so no row ever crosses and no
      // audit log records anything unusual.
      const { rows } = await asOrg(ORG_A, (c) =>
        c.query(`SELECT coalesce(sum(amount),0)::int AS total FROM pt_payments WHERE id IN ('rep-a','rep-b')`));
      expect(rows[0].total).toBe(1000);
    });

    it('a report run for the other studio returns that studio\'s number to nobody', async () => {
      const { rows } = await asOrg(ORG_B, (c) =>
        c.query(`SELECT coalesce(sum(amount),0)::int AS total FROM pt_payments WHERE id IN ('rep-a','rep-b')`));
      expect(rows[0].total).toBe(9999);
    });
  });

  describe('private uploads', () => {
    afterEach(async () => {
      await owner.query(`DELETE FROM storage_objects WHERE key LIKE 'shared/%'`);
    });

    it('an upload with no studio is visible to EVERY studio', async () => {
      // Not a bug being reported as a pass — the storage_objects policy is
      // written `organization_id = app.org_id OR organization_id IS NULL`, so
      // this is what it does. It is recorded here because the same clause on a
      // table of private files means any row that reaches production with a
      // null organization_id is readable by every tenant, and a column that is
      // nullable eventually holds a null. See STORAGE-OBJECTS-NULL-ORG in the
      // cutover notes.
      await owner.query(
        `INSERT INTO storage_objects (key, category, bytes, organization_id)
         VALUES ('shared/orphan.pdf','private',1,NULL)`);
      for (const org of [ORG_A, ORG_B]) {
        const { rows } = await asOrg(org, (c) =>
          c.query(`SELECT key FROM storage_objects WHERE key = 'shared/orphan.pdf'`));
        expect(rows).toHaveLength(1);
      }
    });

    it('an upload that belongs to a studio is not', async () => {
      await owner.query(
        `INSERT INTO storage_objects (key, category, bytes, organization_id)
         VALUES ('shared/owned.pdf','private',1,$1)`, [ORG_B]);
      const { rows } = await asOrg(ORG_A, (c) =>
        c.query(`SELECT key FROM storage_objects WHERE key = 'shared/owned.pdf'`));
      expect(rows).toEqual([]);
    });
  });
  // ── cutover readiness ──────────────────────────────────────────────────────
  //
  // Everything above proves the policies that EXIST do their job. This section
  // is about the tables that have no policy at all, and it is the reason the
  // cutover is not finished.
  //
  // The failure mode is the quiet one. A table with RLS enabled, a grant to
  // app_tenant, and no permissive policy does not error — it returns zero rows
  // and accepts no writes. Point DATABASE_URL at app_tenant with these
  // outstanding and the payments page renders "no payments", the notification
  // bell empties, and nothing anywhere says why.
  describe('cutover readiness', () => {
    /**
     * Tables that grant app_tenant SELECT, have RLS on, and permit nothing.
     *
     * Recorded from the database on 26 Aug 2026, after migrations 001-183.
     * This list is a ratchet: it must only ever shrink. A test that merely
     * counted them would let one be swapped for another.
     *
     * They are not all the same kind of problem, and the difference decides
     * what each needs:
     *
     *   • platform-only tables (platform_*, ai_platform_settings,
     *     ai_provider_settings, ai_model_rates, _migrations) are CORRECT here.
     *     A studio has no business reading them and every legitimate read goes
     *     over the owner connection. They come off this list by having the
     *     grant to app_tenant revoked, not by gaining a policy.
     *
     *   • child tables with no organization_id of their own (invoice_items,
     *     set_performances, workout_exercises, exercise_*, diet_plan_meals,
     *     training_program_*) need the parent-join policy migration 159
     *     established, not a column.
     *
     *   • tables the tenant path reads directly — payments, members,
     *     notifications, branches, body_metrics, weight_logs, pt_commissions,
     *     pt_client_subscriptions, pt_client_renewals, pt_payouts, pt_plans,
     *     holds_freezes, trials, user_profiles — are the ones that go blank.
     *     These are the cutover blockers.
     */
    const BLIND_SPOTS = [
    '_migrations',
    'admin_reset_intents',
    'agent_audit_log',
    'agent_tasks',
    'ai_conversations',
    'ai_messages',
    'ai_model_rates',
    'ai_platform_settings',
    'ai_provider_settings',
    'ai_usage_log',
    'audit_log',
    'biometric_attendance',
    'body_metrics',
    'branches',
    'cardio_performances',
    'churn_risk_log',
    'diet_plan_meals',
    'equipment_types',
    'exercise_categories',
    'exercise_favorites',
    'exercise_muscles',
    'exercise_performances',
    'exercise_recent_usage',
    'exercise_relations',
    'exercise_versions',
    'face_checkin_logs',
    'face_descriptors',
    'google_calendar_events',
    'google_calendar_tokens',
    'holds_freezes',
    'invoice_items',
    'members',
    'membership_actions',
    'muscles',
    'notifications',
    'payments',
    'plan_features',
    'platform_ai_settings',
    'platform_announcements',
    'platform_billing_settings',
    'platform_features',
    'pt_client_renewals',
    'pt_client_subscriptions',
    'pt_commissions',
    'pt_payouts',
    'pt_plans',
    'qr_tokens',
    'receipt_counter',
    'refresh_tokens',
    'set_performances',
    'storage_accounting_meta',
    'support_ticket_messages',
    'system_alerts',
    'system_logs',
    'training_program_phases',
    'training_program_weeks',
    'trial_sessions',
    'trials',
    'user_profiles',
    'webauthn_challenges',
    'webauthn_credentials',
    'weight_logs',
    'workout_exercises',
    'workout_template_exercises',
    ];

    it('no table has quietly joined the blind spot', async () => {
      const { rows } = await owner.query(`
        WITH t AS (
          SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
        ), g AS (
          SELECT DISTINCT table_name FROM information_schema.role_table_grants
           WHERE table_schema = 'public' AND grantee = 'app_tenant' AND privilege_type = 'SELECT'
        ), permitted AS (
          SELECT DISTINCT p.tablename FROM pg_policies p
           WHERE p.schemaname = 'public' AND p.permissive = 'PERMISSIVE'
             AND ('app_tenant' = ANY(p.roles) OR 'public' = ANY(p.roles))
             AND coalesce(p.qual, '') <> 'false'
        )
        SELECT t.relname FROM t JOIN g ON g.table_name = t.relname
         WHERE t.relname NOT IN (SELECT tablename FROM permitted)
         ORDER BY 1`);
      const found = rows.map((r) => r.relname);

      const added = found.filter((t) => !BLIND_SPOTS.includes(t));
      expect(added).toEqual([]);
      // Removals are the point of the exercise, so they are not a failure —
      // but the list must be edited when one is fixed, or it stops meaning
      // anything. Reported as a message rather than an assertion so a green
      // cutover step does not read as a broken test.
      const fixed = BLIND_SPOTS.filter((t) => !found.includes(t));
      if (fixed.length) {
        // eslint-disable-next-line no-console
        console.log(`BLIND_SPOTS can drop: ${fixed.join(', ')}`);
      }
    });

    it("a payment belonging to the caller's OWN studio is invisible to app_tenant", async () => {
      // The concrete demonstration, because a list of 64 table names does not
      // convey what it costs. This is not a cross-tenant test: the payment is
      // the caller's own, taken by the caller's own studio, and the caller
      // cannot see it. No error is raised. The row simply is not there.
      await owner.query(
        `INSERT INTO payments (id, client_id, amount) VALUES ('blind-pay','client-a',1000)
         ON CONFLICT (id) DO NOTHING`);
      try {
        const asOwner = await owner.query(`SELECT count(*)::int AS n FROM payments WHERE id = 'blind-pay'`);
        expect(asOwner.rows[0].n).toBe(1);

        const asTenant = await asOrg(ORG_A, (c) =>
          c.query(`SELECT count(*)::int AS n FROM payments WHERE id = 'blind-pay'`));
        expect(asTenant.rows[0].n).toBe(0);
      } finally {
        await owner.query(`DELETE FROM payments WHERE id = 'blind-pay'`);
      }
    });

    it('and a payment cannot be recorded either', async () => {
      // The write half. Taking money is the studio's core transaction.
      await expect(asOrg(ORG_A, (c) =>
        c.query(`INSERT INTO payments (id, client_id, amount) VALUES ('blind-pay-2','client-a',1000)`)))
        .rejects.toThrow(/row-level security/i);
    });
  });
});
