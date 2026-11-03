'use strict';
// Phase 4 — the ownership architecture against a production-shaped database.
//
// ── What this runs against ─────────────────────────────────────────────────
//
// The `phase4_shape` database: a dump of the real schema and migrations,
// restored, then seeded by `scripts/phase4-seed-shape.sql` with 540 clients
// across two studios. That fixture is SYNTHETIC. It reproduces the shapes the
// ownership rules have to survive — years of history, rows typed in months
// after the event, owners that never got a value, owners that disagree with a
// legacy copy, records older than the staleness threshold, soft-deleted
// clients — but it is not production data, and this suite does not claim it
// is. Criterion 1 stays BLOCKED until a production dump is supplied.
//
// Gated on its own variable rather than RLS_TEST_DATABASE_URL: running these
// assertions against the ordinary test database would fail for the right
// reason but the wrong cause, and a CI that only sets the ordinary variable
// should skip this suite rather than half-run it.
//
// ── What it proves ─────────────────────────────────────────────────────────
//
//   * the canonical loader picks the same body the database says is latest,
//     for every canonical-rich fixture client, not one hand-built example;
//   * content date beats typing date, including for late-entered assessments
//     and check-ins, and insertion time breaks a same-date tie;
//   * a foreign or soft-deleted client is unreachable through every consumer;
//   * RLS is enabled and policied on every table this architecture reads;
//   * deleting the newest assessment falls back to the previous one and the
//     client cache follows it; a backdated insert cannot move the cache
//     backwards;
//   * stale, disputed and draft-only records reach the AI prompt labelled,
//     rather than being silently promoted or silently dropped.

const DB_URL = process.env.PHASE4_SHAPE_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('Phase 4 production-shape ownership, against a real database', () => {
    it('has a database to run against', () => {
      throw new Error('PHASE4_SHAPE_DATABASE_URL is not set in CI — the Phase 4 shape proof would skip.');
    });
  });
}

const mockDbUrl = DB_URL;
jest.mock('../db/pool', () => {
  if (!mockDbUrl) return { query: jest.fn(), connect: jest.fn() };
  const { Pool } = jest.requireActual('pg');
  return new Pool({ connectionString: mockDbUrl, max: 8 });
});
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../modules/automation/automation.triggers', () => new Proxy({}, {
  get: () => async () => {},
}));

const ORG_A = 'a4a4a4a4-a4a4-4a4a-a4a4-a4a4a4a4a4a4';
const ORG_B = 'b4b4b4b4-b4b4-4b4b-8b4b-b4b4b4b4b4b4';

jest.setTimeout(180000);

const CLIENTS_READ = [
  'pt_clients', 'pt_assessments', 'pt_goals', 'pt_lifestyle_assessments',
  'pt_nutrition_assessments', 'pt_parq_forms', 'pt_client_interviews',
  'pt_mobility_performance_assessments', 'pt_posture_assessments',
  'client_fitness_profiles', 'weekly_checkins', 'pt_os_measurements',
  'pt_consent_records', 'pt_informed_consents', 'strength_logs',
];

describeIf('Phase 4 production-shape ownership, against a real database', () => {
  let pool;
  let ai;
  let readService;
  let authoritative;
  let assessmentsRepo;
  let clientFacts;
  let fixture;

  /** The fixture row for a P4-### client, or a failure naming the missing one. */
  const byName = (name) => {
    const row = fixture.get(name);
    if (!row) throw new Error(`fixture client ${name} is missing — re-run scripts/phase4-seed-shape.sql`);
    return row;
  };

  /** What the canonical SQL says is the newest assessment for a client. */
  const canonicalAssessment = async (clientId) => {
    const { rows } = await pool.query(
      `SELECT * FROM pt_assessments WHERE client_id = $1
        ORDER BY assessment_date DESC, created_at DESC LIMIT 1`,
      [clientId],
    );
    return rows[0] || null;
  };

  beforeAll(async () => {
    pool = require('../db/pool');
    ai = require('../routes/ai');
    readService = require('../modules/pt-os/client-read.service');
    authoritative = require('../modules/pt-os/authoritative-client');
    assessmentsRepo = require('../modules/progress/assessments.repo');
    clientFacts = require('../modules/pt-os/client-facts');

    const { rows } = await pool.query(
      `SELECT id, name, organization_id, deleted_at, weight, height, goal
         FROM pt_clients WHERE name ~ '^P4-[0-9]{3}$' ORDER BY name`,
    );
    fixture = new Map(rows.map((r) => [r.name, r]));
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('the fixture is the shape it claims to be', () => {
    test('540 clients, two studios, history, and soft deletions', async () => {
      const { rows: [totals] } = await pool.query(`
        SELECT count(*)::int AS clients,
               count(DISTINCT organization_id)::int AS orgs,
               count(*) FILTER (WHERE deleted_at IS NOT NULL)::int AS deleted
          FROM pt_clients WHERE name LIKE 'P4-%'`);
      expect(totals).toEqual({ clients: 540, orgs: 2, deleted: 14 });

      const { rows: [volumes] } = await pool.query(`
        SELECT (SELECT count(*) FROM pt_assessments WHERE client_id IN
                  (SELECT id FROM pt_clients WHERE name LIKE 'P4-%'))::int AS assessments,
               (SELECT count(*) FROM weekly_checkins WHERE client_id IN
                  (SELECT id FROM pt_clients WHERE name LIKE 'P4-%'))::int AS checkins,
               (SELECT count(*) FROM pt_goals WHERE client_id IN
                  (SELECT id FROM pt_clients WHERE name LIKE 'P4-%'))::int AS goals`);
      expect(volumes.assessments).toBeGreaterThan(700);
      expect(volumes.checkins).toBeGreaterThan(1400);
      expect(volumes.goals).toBeGreaterThan(200);
    });

    test('every child row belongs to the same studio as its client', async () => {
      for (const table of [
        'pt_assessments', 'pt_goals', 'pt_lifestyle_assessments',
        'pt_nutrition_assessments', 'pt_parq_forms', 'pt_client_interviews',
        'pt_mobility_performance_assessments', 'pt_posture_assessments',
        'client_fitness_profiles', 'weekly_checkins',
      ]) {
        const { rows: [{ mismatches }] } = await pool.query(
          `SELECT count(*)::int AS mismatches FROM ${table} x
             JOIN pt_clients c ON c.id = x.client_id
            WHERE x.organization_id <> c.organization_id`,
        );
        expect({ table, mismatches }).toEqual({ table, mismatches: 0 });
      }
    });
  });

  describe('canonical agreement at production shape', () => {
    test('every canonical-rich client reads the same body the database calls latest', async () => {
      // Buckets 0–2 are the clients whose owner tables are populated. They are
      // the population a real studio would mostly have, and they are checked
      // wholesale rather than sampled: an ordering bug that only loses ties
      // survives a sample.
      const { rows: clients } = await pool.query(
        `SELECT c.id, c.organization_id,
                substring(c.name from 4)::int % 10 AS bucket,
                l.weight, l.height_cm, l.assessment_date::text AS as_of
           FROM pt_clients c
           JOIN LATERAL (
             SELECT weight, height_cm, assessment_date FROM pt_assessments a
              WHERE a.client_id = c.id
              ORDER BY assessment_date DESC, created_at DESC LIMIT 1
           ) l ON TRUE
          WHERE c.name ~ '^P4-[0-9]{3}$' AND c.deleted_at IS NULL
            AND substring(c.name from 4)::int % 10 BETWEEN 0 AND 2
          ORDER BY c.name`,
      );
      expect(clients.length).toBeGreaterThanOrEqual(140);

      let checked = 0;
      for (const c of clients) {
        const brief = await readService.getClientTrainingBrief(c.organization_id, c.id);
        expect({ client: c.id, present: brief.sections.body.present })
          .toEqual({ client: c.id, present: true });
        expect({ client: c.id, weight: brief.sections.body.weight_kg })
          .toEqual({ client: c.id, weight: Number(c.weight) });
        expect({ client: c.id, as_of: brief.sections.body.as_of })
          .toEqual({ client: c.id, as_of: c.as_of });
        checked += 1;
      }
      expect(checked).toBe(clients.length);

      // The snapshot consumes the same owner through a different code path.
      // Check a deterministic tenth of the set to prove the two surfaces do
      // not diverge without paying for 140 duplicate loads.
      for (const c of clients.filter((_, i) => i % 10 === 0)) {
        const snapshot = await readService.getClientSnapshot(c.organization_id, c.id);
        expect({ client: c.id, current_kg: snapshot.goal.current_kg })
          .toEqual({ client: c.id, current_kg: Number(c.weight) });
      }
    });

    test('the generator and the digital twin resolve the same weight', async () => {
      const c = byName('P4-001');
      const expected = await canonicalAssessment(c.id);

      const ctx = await ai.loadAuthoritativeClient(c.id, ORG_A);
      const { facts } = ai.resolveClientFacts(ctx);
      expect(Number(ai.resolveDietInputs(ctx, {}).weight_kg)).toBe(Number(expected.weight));
      expect(facts.weight_kg.value).toBe(Number(expected.weight));
      expect(facts.weight_kg.source).toBe('pt_assessments.weight');
    });
  });

  describe('content date beats typing date', () => {
    test('an assessment entered two months late does not become the latest body', async () => {
      const c = byName('P4-006');
      const { rows: [typing] } = await pool.query(
        `SELECT weight FROM pt_assessments WHERE client_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [c.id],
      );
      // The fixture contains the trap: the newest *typed* row is the older test.
      expect(Number(typing.weight)).toBe(80);

      const brief = await readService.getClientTrainingBrief(ORG_A, c.id);
      expect(brief.sections.body.weight_kg).toBe(76);
      expect(brief.sections.body.as_of).toBe(
        (await canonicalAssessment(c.id)).assessment_date.toISOString().slice(0, 10),
      );

      const ctx = await ai.loadAuthoritativeClient(c.id, ORG_A);
      expect(Number(ctx.latestAssessment.weight)).toBe(76);
    });

    test('a check-in entered months late does not out-rank the newer week', async () => {
      const c = byName('P4-007');
      const { rows: [typing] } = await pool.query(
        `SELECT weight FROM weekly_checkins WHERE client_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [c.id],
      );
      expect(Number(typing.weight)).toBe(73);

      const ctx = await authoritative.loadClientSources(c.id, ORG_A, { checkin: true });
      const { rows: [canonical] } = await pool.query(
        `SELECT weight, week_start_date FROM weekly_checkins WHERE client_id = $1
          ORDER BY week_start_date DESC, created_at DESC LIMIT 1`,
        [c.id],
      );
      expect(Number(ctx.latestCheckin.weight)).toBe(Number(canonical.weight));
      expect(ctx.latestCheckin.week_start_date.toISOString().slice(0, 10))
        .toBe(canonical.week_start_date.toISOString().slice(0, 10));
    });

    test('a same-date tie is broken by insertion time, newest first', async () => {
      const c = byName('P4-050');
      const expected = await canonicalAssessment(c.id);
      const ctx = await ai.loadAuthoritativeClient(c.id, ORG_A);
      // Two rows share a date; the later insertion carries 72.
      expect(Number(expected.weight)).toBe(72);
      expect(Number(ctx.latestAssessment.weight)).toBe(Number(expected.weight));
      expect(ctx.latestAssessment.assessment_date.toISOString().slice(0, 10))
        .toBe(expected.assessment_date.toISOString().slice(0, 10));
    });

    test('two active goals resolve to the newest one, consistently', async () => {
      const c = byName('P4-020');
      const ctx = await authoritative.loadClientSources(c.id, ORG_A);
      expect(ctx.goals).toHaveLength(2);
      expect(ctx.goal.goal_type).toBe('endurance');
      const { facts } = clientFacts.resolveClientFacts(ctx);
      expect(facts.goal.value).toBe('endurance');
    });
  });

  describe('tenant isolation', () => {
    test('a client of another studio is unreachable through every consumer', async () => {
      const a = byName('P4-001');
      const b = byName('P4-501');

      await expect(authoritative.loadClientRow(a.id, ORG_B)).resolves.toBeNull();
      await expect(authoritative.loadClientSources(a.id, ORG_B)).resolves.toBeNull();
      await expect(readService.getClientTrainingBrief(ORG_B, a.id)).resolves.toBeNull();
      await expect(readService.getClientSnapshot(ORG_B, a.id)).resolves.toBeNull();
      await expect(ai.loadAuthoritativeClient(a.id, ORG_B)).resolves.toBeNull();

      // And the reverse is not a one-way accident.
      await expect(readService.getClientTrainingBrief(ORG_A, b.id)).resolves.toBeNull();
      await expect(ai.loadAuthoritativeClient(b.id, ORG_A)).resolves.toBeNull();
    });

    test('RLS is enabled and policied on every table the architecture reads', async () => {
      const { rows } = await pool.query(
        `SELECT c.relname, c.relrowsecurity, count(p.polname)::int AS policies
           FROM pg_class c
           LEFT JOIN pg_policy p ON p.polrelid = c.oid
          WHERE c.relname = ANY($1)
          GROUP BY 1, 2 ORDER BY 1`,
        [CLIENTS_READ],
      );
      expect(rows).toHaveLength(CLIENTS_READ.length);
      for (const row of rows) {
        expect({ table: row.relname, rls: row.relrowsecurity })
          .toEqual({ table: row.relname, rls: true });
        expect({ table: row.relname, policied: row.policies > 0 })
          .toEqual({ table: row.relname, policied: true });
      }
    });

    test('the application role cannot bypass RLS', async () => {
      const { rows } = await pool.query(
        `SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'app_tenant'`,
      );
      if (rows.length === 0) return; // role is created by scripts/rls-proof-setup.sh
      expect(rows[0]).toMatchObject({ rolname: 'app_tenant', rolbypassrls: false, rolsuper: false });
    });
  });

  describe('deletion, recovery and audit trail', () => {
    test('a soft-deleted client is invisible but its history is retained', async () => {
      const c = byName('P4-111');
      expect(c.deleted_at).not.toBeNull();

      await expect(authoritative.loadClientSources(c.id, ORG_A)).resolves.toBeNull();
      await expect(readService.getClientTrainingBrief(ORG_A, c.id)).resolves.toBeNull();
      await expect(readService.getClientSnapshot(ORG_A, c.id)).resolves.toBeNull();

      const { rows: [{ n }] } = await pool.query(
        'SELECT count(*)::int AS n FROM pt_assessments WHERE client_id = $1', [c.id],
      );
      expect(n).toBe(3); // children were never cascaded away

      const { rows: [audit] } = await pool.query(
        `SELECT action, entity_type FROM activity_log
          WHERE entity_id = $1 AND action = 'client.delete' ORDER BY created_at DESC LIMIT 1`,
        [c.id],
      );
      expect(audit).toEqual({ action: 'client.delete', entity_type: 'pt_client' });
    });

    test('restoring the client makes the retained history readable again', async () => {
      const c = byName('P4-037');
      const original = c.deleted_at;
      expect(original).not.toBeNull();

      try {
        await pool.query('UPDATE pt_clients SET deleted_at = NULL WHERE id = $1', [c.id]);
        const sources = await authoritative.loadClientSources(c.id, ORG_A, { checkin: true });
        expect(sources).not.toBeNull();
        // P4-037 is a late check-in client: both check-ins survived the delete.
        expect(Number(sources.latestCheckin.weight)).toBe(71);
        const brief = await readService.getClientTrainingBrief(ORG_A, c.id);
        expect(brief).not.toBeNull();
        expect(brief.sections.readiness.present).toBe(false);
      } finally {
        await pool.query('UPDATE pt_clients SET deleted_at = $2 WHERE id = $1', [c.id, original]);
      }
    });

    test('deleting the newest assessment falls back to the previous one, and the cache follows', async () => {
      const c = byName('P4-006');
      const newest = await canonicalAssessment(c.id);
      expect(Number(newest.weight)).toBe(76);
      const req = { user: { organization_id: ORG_A } };
      const tx = await pool.connect();
      try {
        await tx.query('BEGIN');
        const deleted = await assessmentsRepo.deleteAssessment(req, newest.id, tx);
        expect(deleted).not.toBeNull();
        await assessmentsRepo.syncClientBodyFromLatest(c.id, ORG_A, tx);
        const { rows: [after] } = await tx.query(
          `SELECT weight, height FROM pt_clients WHERE id = $1`, [c.id],
        );
        expect(Number(after.weight)).toBe(80);
        expect(Number(after.height)).toBe(171);
        const { rows: [fallback] } = await tx.query(
          `SELECT weight FROM pt_assessments WHERE client_id = $1
            ORDER BY assessment_date DESC, created_at DESC LIMIT 1`, [c.id],
        );
        expect(Number(fallback.weight)).toBe(80);
      } finally {
        await tx.query('ROLLBACK');
        tx.release();
      }
    });

    test('the client cache is a cache of the latest test, not of the last edit', async () => {
      const c = byName('P4-004');
      // Fixture shape: cache holds 90/160, owner says 80/175.
      const { rows: [before] } = await pool.query(
        'SELECT weight, height FROM pt_clients WHERE id = $1', [c.id],
      );
      expect(Number(before.weight)).toBe(90);

      const tx = await pool.connect();
      try {
        await tx.query('BEGIN');
        // An old test typed today must not move the cache backwards…
        await tx.query(
          `INSERT INTO pt_assessments
             (client_id, organization_id, assessment_date, assessment_type, weight, height_cm, created_at)
           VALUES ($1, $2, CURRENT_DATE - 200, 'follow_up', 95, 160, NOW())`,
          [c.id, ORG_A],
        );
        await assessmentsRepo.syncClientBodyFromLatest(c.id, ORG_A, tx);
        let { rows: [row] } = await tx.query(
          'SELECT weight, height FROM pt_clients WHERE id = $1', [c.id],
        );
        expect({ weight: Number(row.weight), height: Number(row.height) })
          .toEqual({ weight: 80, height: 175 });

        // …and no assessment at all leaves the last known body untouched.
        await tx.query('DELETE FROM pt_assessments WHERE client_id = $1', [c.id]);
        await assessmentsRepo.syncClientBodyFromLatest(c.id, ORG_A, tx);
        ({ rows: [row] } = await tx.query(
          'SELECT weight, height FROM pt_clients WHERE id = $1', [c.id],
        ));
        expect({ weight: Number(row.weight), height: Number(row.height) })
          .toEqual({ weight: 80, height: 175 });
      } finally {
        await tx.query('ROLLBACK');
        tx.release();
      }

      const { rows: [after] } = await pool.query(
        'SELECT weight, height FROM pt_clients WHERE id = $1', [c.id],
      );
      expect(Number(after.weight)).toBe(90); // rollback left the fixture alone
    });
  });

  describe('provenance, stale data and disputed values', () => {
    test('a record older than a year reaches the prompt marked stale', async () => {
      const c = byName('P4-005');
      const ctx = await ai.loadAuthoritativeClient(c.id, ORG_A);
      const { facts, data_quality: quality } = ai.resolveClientFacts(ctx);

      expect(facts.weight_kg).toMatchObject({
        value: 90, source: 'pt_assessments.weight', stale: true,
      });
      expect(facts.weight_kg.age_days).toBeGreaterThan(365);
      expect(quality.stale).toContainEqual(expect.objectContaining({
        field: 'weight_kg', source: 'pt_assessments.weight',
      }));

      const prompt = clientFacts.describeFacts(facts);
      expect(prompt).toContain('STALE; confirm with the client');
      expect(prompt).toContain('STALE means the record is more than a year old');
    });

    test('two owners disagreeing is reported with both values, and the precedence winner is used', async () => {
      const c = byName('P4-004');
      const ctx = await ai.loadAuthoritativeClient(c.id, ORG_A);
      const { facts, data_quality: quality } = ai.resolveClientFacts(ctx);

      // Goal Assessment wins: pt_goals = muscle_gain; profile = endurance;
      // enrolment cache = strength_gain.
      expect(facts.goal.value).toBe('muscle_gain');
      expect(facts.goal.conflicts).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: 'client_fitness_profiles.goal', value: 'endurance' }),
        expect.objectContaining({ source: 'pt_clients.goal', value: 'strength_gain' }),
      ]));
      expect(quality.conflicting).toContainEqual(expect.objectContaining({ field: 'goal' }));

      const prompt = clientFacts.describeFacts(facts);
      expect(prompt).toContain('DISPUTED');
      expect(prompt).toContain('endurance in client_fitness_profiles.goal');
      expect(prompt).toContain('do not average them');
    });

    test('a draft PAR-Q does not answer the medical question; the legacy list still does', async () => {
      const c = byName('P4-008');
      const ctx = await ai.loadAuthoritativeClient(c.id, ORG_A);

      expect(ctx.parq).toMatchObject({ status: 'draft' });
      expect(ctx.parqMedical).toBeNull();
      await expect(assessmentsRepo.latestParqMedical(c.id)).resolves.toBeNull();

      const { resolveMedicalConditions } = require('../modules/progress/assessment-facts');
      expect(resolveMedicalConditions(ctx.parqMedical, ctx.nutrition)).toEqual(['Migraine']);
    });

    test('both safety gates are visible: PAR-Q blocked and physician objected', async () => {
      const c = byName('P4-001');
      const ctx = await ai.loadAuthoritativeClient(c.id, ORG_A);
      expect(ctx.parq.workout_gate_status).toBe('blocked');

      const { rows: [consent] } = await pool.query(
        `SELECT physician_advised_against FROM pt_informed_consents
          WHERE client_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [c.id],
      );
      expect(consent.physician_advised_against).toBe(true);
    });

    test('a thin identity-only record reports missing facts instead of inventing them', async () => {
      const c = byName('P4-009');
      const ctx = await ai.loadAuthoritativeClient(c.id, ORG_A);
      const { facts, data_quality: quality } = ai.resolveClientFacts(ctx);

      expect(facts.weight_kg).toMatchObject({ value: null, origin: 'missing' });
      expect(facts.goal).toMatchObject({ value: null, origin: 'missing' });
      expect(quality.missing.length).toBeGreaterThan(0);
      expect(clientFacts.describeFacts(facts)).toContain('Weight (kg): NOT RECORDED');
      expect(clientFacts.describeFacts(facts)).toContain('Do not infer it');
    });
  });

  describe('consumer surfaces read the canonical owner', () => {
    test('a member weight goal sees fitness tests when the legacy log is empty', async () => {
      const { weightSeries } = require('../modules/client-portal/member-goals.service');
      const c = byName('P4-006');
      const { rows: [{ measurements }] } = await pool.query(
        `SELECT count(*)::int AS measurements FROM pt_os_measurements WHERE client_id = $1`,
        [c.id],
      );
      expect(measurements).toBe(0); // the bug being fixed: this used to return no series

      const { rows: expected } = await pool.query(
        `SELECT assessment_date::text AS d, weight::float AS kg
           FROM pt_assessments
          WHERE client_id = $1 AND weight IS NOT NULL
          ORDER BY assessment_date, created_at`,
        [c.id],
      );
      expect(expected.length).toBeGreaterThanOrEqual(2);

      const series = await weightSeries(c.id, ORG_A);
      expect(series).toEqual(expected.map((r) => ({ date: r.d, value: r.kg })));

      // Content date, not typing date: the trap row typed last is the older test.
      const latest = await canonicalAssessment(c.id);
      expect(series.at(-1)).toEqual({
        date: latest.assessment_date.toISOString().slice(0, 10),
        value: Number(latest.weight),
      });
    });

    test('the transformations screen sees an assessment-only client', async () => {
      const { getTransformations } = require('../modules/pt-os/pt-os.service');
      const rows = await getTransformations({ applyFilter: true, orgId: ORG_A });
      const c = byName('P4-006');

      const { rows: [counts] } = await pool.query(
        `SELECT (SELECT count(*)::int FROM pt_assessments
                  WHERE client_id = $1 AND weight IS NOT NULL)
              + (SELECT count(*)::int FROM pt_os_measurements
                  WHERE client_id = $1 AND weight_kg IS NOT NULL) AS readings`,
        [c.id],
      );
      const { rows: [first] } = await pool.query(
        `SELECT weight::float AS kg FROM pt_assessments
          WHERE client_id = $1 AND weight IS NOT NULL
          ORDER BY assessment_date ASC, created_at ASC LIMIT 1`, [c.id],
      );
      const latest = await canonicalAssessment(c.id);

      const out = rows.find((r) => r.id === c.id);
      expect(out).toMatchObject({
        measurement_count: counts.readings,
        start_weight: first.kg,
        current_weight: Number(latest.weight),
        weight_change: Number((Number(latest.weight) - first.kg).toFixed(2)),
      });
      expect(out.current_weight).not.toBeNull();
    });
  });
});
