'use strict';
// Phase 5 — reconciliation report and reviewed apply workflow, against a real
// migrated database.
//
// The fixture is the Phase 4 production-shaped database. The full report run
// proves every D1–D25 register produces field-level rows and that its counts
// agree with the Phase 4 aggregate in the same snapshot. The apply half runs
// against a temporary studio created by this suite, so it can prove the write,
// the audit row, the dry-run default and the conflict refusal without touching
// the fixture population.
//
// Gated on PHASE4_SHAPE_DATABASE_URL, like the Phase 4 suite. CI builds that
// database in scripts/phase4-shape-setup.sh.

const DB_URL = process.env.PHASE4_SHAPE_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('Phase 5 reconciliation, against a real database', () => {
    it('has a database to run against', () => {
      throw new Error('PHASE4_SHAPE_DATABASE_URL is not set in CI — the Phase 5 reconciliation proof would skip.');
    });
  });
}

const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Pool } = require('pg');

const ANALYZE = path.join(__dirname, '../../scripts/phase5-reconcile-ownership.js');
const APPLY = path.join(__dirname, '../../scripts/phase5-apply-reconciliation.js');

const ORG = 'c5c50000-0000-4000-8000-000000000501';
const CLIENT = 'p5-recon-client';
const GOAL = 'p5-recon-goal';
const LIFE = 'p5-recon-life';
const CLIENT_2 = 'p5-recon-client-2';
const GOAL_2 = 'p5-recon-goal-2';
const LIFE_2 = 'p5-recon-life-2';

const run = (script, args) => spawnSync(process.execPath, [script, ...args], {
  encoding: 'utf8',
  env: process.env,
});

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

describeIf('Phase 5 reconciliation, against a real database', () => {
  let pool;
  let tmp;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL, max: 2 });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase5-recon-'));
    await pool.query(`DELETE FROM audit_log WHERE record_id = ANY($1)`, [[GOAL, GOAL_2]]);
    await pool.query(`DELETE FROM pt_goals WHERE id = ANY($1)`, [[GOAL, GOAL_2]]);
    await pool.query(`DELETE FROM pt_lifestyle_assessments WHERE id = ANY($1)`, [[LIFE, LIFE_2]]);
    await pool.query(`DELETE FROM pt_clients WHERE id = ANY($1)`, [[CLIENT, CLIENT_2]]);
    await pool.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);

    await pool.query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1, 'Phase 5 Recon', 'phase5-recon')`, [ORG]);
    await pool.query(
      `INSERT INTO pt_clients (id, name, organization_id) VALUES ($1, 'Recon One', $2), ($3, 'Recon Two', $2)`,
      [CLIENT, ORG, CLIENT_2]);
    // One owner field is empty and one legacy copy holds the value: a safe
    // backfill candidate. The second client already disagrees: a conflict.
    await pool.query(
      `INSERT INTO pt_goals (id, client_id, goal_type, is_active, organization_id, motivation_level)
       VALUES ($1, $2, 'fat_loss', TRUE, $4, NULL), ($3, $5, 'fat_loss', TRUE, $4, 4)`,
      [GOAL, CLIENT, GOAL_2, ORG, CLIENT_2]);
    await pool.query(
      `INSERT INTO pt_lifestyle_assessments (id, client_id, assessment_date, organization_id, motivation_to_exercise)
       VALUES ($1, $2, CURRENT_DATE, $4, 6), ($3, $5, CURRENT_DATE, $4, 9)`,
      [LIFE, CLIENT, LIFE_2, ORG, CLIENT_2]);
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM audit_log WHERE record_id = ANY($1)`, [[GOAL, GOAL_2]]);
    await pool.query(`DELETE FROM pt_goals WHERE id = ANY($1)`, [[GOAL, GOAL_2]]);
    await pool.query(`DELETE FROM pt_lifestyle_assessments WHERE id = ANY($1)`, [[LIFE, LIFE_2]]);
    await pool.query(`DELETE FROM pt_clients WHERE id = ANY($1)`, [[CLIENT, CLIENT_2]]);
    await pool.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    await pool.end();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('the full fixture report is field-level, complete and self-validating', () => {
    const reportPath = path.join(tmp, 'full-report.json');
    const result = run(ANALYZE, ['--url', DB_URL, '--json', reportPath]);
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });

    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    expect(report.read_only).toBe(true);
    expect(report.validation).toEqual({ ok: true, mismatches: [] });
    expect(report.checks.map((c) => c.id)).toEqual(
      Array.from({ length: 25 }, (_, i) => `D${i + 1}`));
    expect(report.totals.records).toBe(report.totals.legacy_only + report.totals.conflicts);
    expect(report.totals.legacy_only).toBeGreaterThan(0);
    expect(report.totals.conflicts).toBeGreaterThan(0);

    const records = report.checks.flatMap((c) => c.records);
    expect(records.length).toBe(report.totals.records);
    expect(records.filter((r) => !['legacy_only', 'conflict'].includes(r.status))).toEqual([]);
    // A conflict is never proposed for an automatic write.
    expect(records.filter((r) => r.status === 'conflict' && r.backfill)).toEqual([]);
    expect(records.filter((r) => r.backfill).every((r) => r.status === 'legacy_only')).toBe(true);
    // Every row carries both sides' provenance and timestamps where they exist.
    for (const r of records) {
      expect(r).toEqual(expect.objectContaining({
        check_id: expect.any(String),
        client_id: expect.any(String),
        legacy_table: expect.any(String),
        recommended_action: expect.any(String),
      }));
    }
  });

  test('the scoped report proposes exactly the safe candidate and never the conflict', () => {
    const planPath = path.join(tmp, 'scoped-plan.json');
    const result = run(ANALYZE, ['--url', DB_URL, '--org', ORG, '--plan', planPath]);
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });

    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]).toMatchObject({
      check_id: 'D25',
      status: 'legacy_only',
      owner_table: 'pt_goals',
      owner_record_id: GOAL,
      owner_column: 'motivation_level',
      proposed_value: 6,
      decision: '',
    });
  });

  test('dry-run is the default and writes nothing', async () => {
    const planPath = path.join(tmp, 'scoped-plan.json');
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    plan.candidates[0].decision = 'backfill';
    const approved = path.join(tmp, 'approved-plan.json');
    fs.writeFileSync(approved, JSON.stringify(plan, null, 2));

    const result = run(APPLY, ['--url', DB_URL, '--plan', approved]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('DRY RUN (no writes)');
    expect(result.stdout).toContain('Would change / changed: 1');
    expect((await pool.query('SELECT motivation_level FROM pt_goals WHERE id = $1', [GOAL])).rows[0].motivation_level).toBeNull();
  });

  test('apply refuses without the reviewed plan hash', async () => {
    const approved = path.join(tmp, 'approved-plan.json');
    const result = run(APPLY, ['--url', DB_URL, '--plan', approved, '--apply',
      '--confirm', 'not-the-hash', '--reviewer', 'phase5-test']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Refusing to apply');
    expect((await pool.query('SELECT motivation_level FROM pt_goals WHERE id = $1', [GOAL])).rows[0].motivation_level).toBeNull();
  });

  test('apply backfills the reviewed NULL field once and audits it', async () => {
    const approved = path.join(tmp, 'approved-plan.json');
    const result = run(APPLY, ['--url', DB_URL, '--plan', approved, '--apply',
      '--confirm', sha256(approved), '--reviewer', 'phase5-test']);
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    expect(result.stdout).toContain('Would change / changed: 1');

    const goal = (await pool.query('SELECT motivation_level FROM pt_goals WHERE id = $1', [GOAL])).rows[0];
    expect(goal.motivation_level).toBe(6);

    const audit = (await pool.query(
      `SELECT old_data, new_data FROM audit_log
        WHERE record_id = $1 AND action = 'legacy_reconciliation_backfill'`, [GOAL])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].old_data).toEqual({ column: 'motivation_level', before: null });
    expect(audit[0].new_data).toMatchObject({
      column: 'motivation_level', after: 6, check_id: 'D25',
      legacy_table: 'pt_lifestyle_assessments', legacy_record_id: LIFE,
      reviewer: 'phase5-test',
    });
  });

  test('a second apply aborts instead of overwriting the value it just filled', async () => {
    const approved = path.join(tmp, 'approved-plan.json');
    const result = run(APPLY, ['--url', DB_URL, '--plan', approved, '--apply',
      '--confirm', sha256(approved), '--reviewer', 'phase5-test']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no longer NULL');
    expect((await pool.query('SELECT motivation_level FROM pt_goals WHERE id = $1', [GOAL])).rows[0].motivation_level).toBe(6);
  });

  test('a hand-edited conflict plan is refused and changes nothing', async () => {
    const conflictPlan = path.join(tmp, 'conflict-plan.json');
    fs.writeFileSync(conflictPlan, JSON.stringify({
      generated_at: new Date().toISOString(),
      candidates: [{
        plan_id: 'manual-conflict', check_id: 'D25', status: 'conflict',
        owner_table: 'pt_goals', owner_record_id: GOAL_2, owner_column: 'motivation_level',
        proposed_action: 'backfill', proposed_value: 9,
        legacy_table: 'pt_lifestyle_assessments', legacy_record_id: LIFE_2,
        decision: 'backfill',
      }],
    }, null, 2));

    const result = run(APPLY, ['--url', DB_URL, '--plan', conflictPlan, '--apply',
      '--confirm', sha256(conflictPlan), '--reviewer', 'phase5-test']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('conflicts are never written');
    expect((await pool.query('SELECT motivation_level FROM pt_goals WHERE id = $1', [GOAL_2])).rows[0].motivation_level).toBe(4);
  });
});
