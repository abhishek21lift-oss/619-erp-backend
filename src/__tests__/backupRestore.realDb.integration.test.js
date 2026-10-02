'use strict';
// Backup → restore, end to end, against a real Postgres (Phase 4).
//
// Runs the production backup script (scripts/backup-database.js) against a
// fully migrated database with data in it, restores the dump it wrote into a
// new empty database with scripts/restore-drill.js, and requires every table
// in `public` to come back with exactly the source's row count — the payments,
// clients and consents included. Then the ways a restore must refuse: a
// truncated dump, a target that already has data, a production host.
//
// Nothing here reaches a real customer database. The source is a private copy
// of the test schema, built here with the same script CI uses
// (scripts/rls-proof-setup.sh) — not the shared test database, which other
// suites write to in parallel and whose row counts would move under the
// comparison. The targets are scratch databases created and dropped here.

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('Backup and restore, against a real database', () => {
    it('has a database to run against', () => {
      throw new Error('RLS_TEST_DATABASE_URL is not set in CI — the backup/restore proof would skip.');
    });
  });
}

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const ORG = 'b4c70000-0000-4000-8000-000000000701';
const SCRATCH = `restore_drill_${process.pid}`;
const SOURCE = `backup_source_${process.pid}`;

describeIf('Backup and restore, against a real database', () => {
  const { Client } = require('pg');
  const { restoreAndVerify } = require('../../scripts/restore-drill');
  let admin;
  let dir;
  let dumpFile;
  const scratchUrl = (name = SCRATCH) => { const u = new URL(DB_URL); u.pathname = `/${name}`; return u.toString(); };
  const sourceUrl = () => scratchUrl(SOURCE);
  const freshDb = async (name) => {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${name}`);
  };

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    const u = new URL(DB_URL);
    execFileSync('bash', [path.join(REPO, 'scripts', 'rls-proof-setup.sh')], {
      cwd: REPO, stdio: 'ignore',
      env: {
        ...process.env, RLS_PG_DATABASE: SOURCE, RLS_PG_HOST: u.hostname, RLS_PG_PORT: u.port || '5432',
        RLS_PG_SUPERUSER: decodeURIComponent(u.username || 'postgres'),
        ...(u.password ? { PGPASSWORD: decodeURIComponent(u.password) } : {}),
      },
    });
    // Real rows in the tables a recovery is for: a studio, a client, money.
    const src = new Client({ connectionString: sourceUrl() });
    await src.connect();
    await src.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Restore Studio', 'restore-studio')`, [ORG]);
    const { rows: [c] } = await src.query(
      `INSERT INTO pt_clients (name, mobile, organization_id, status) VALUES ('Restore Client', '9811100000', $1, 'active') RETURNING id`, [ORG]);
    await src.query(
      `INSERT INTO pt_payments (client_id, amount, payment_method, date, organization_id) VALUES ($1, 4321, 'CASH', CURRENT_DATE, $2)`, [c.id, ORG]);
    await src.end();

    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-drill-'));
    const out = execFileSync(process.execPath, [path.join(REPO, 'scripts', 'backup-database.js')], {
      env: { ...process.env, BACKUP_DATABASE_URL: sourceUrl(), BACKUP_DIR: dir, BACKUP_UPLOAD: '' },
      encoding: 'utf8',
    });
    expect(out).toMatch(/Verified: .* tables with data/);
    dumpFile = path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith('.dump')));
  }, 300000);

  afterAll(async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH}_b WITH (FORCE)`);
    await admin.query(`DROP DATABASE IF EXISTS ${SOURCE} WITH (FORCE)`);
    await admin.end();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the nightly backup restores into an empty database with every public table\'s row count intact', async () => {
    await freshDb(SCRATCH);
    const rep = await restoreAndVerify({ file: dumpFile, targetUrl: scratchUrl(), sourceUrl: sourceUrl() });
    expect(rep.compared).toBeGreaterThan(150);
    expect(rep.core.pt_payments).toBeGreaterThan(0);

    // And the specific money row is there, to the rupee, in its own studio.
    const c = new Client({ connectionString: scratchUrl() });
    await c.connect();
    const { rows } = await c.query('SELECT amount FROM pt_payments WHERE organization_id = $1', [ORG]);
    await c.end();
    expect(rows.map((r) => Number(r.amount))).toEqual([4321]);
  }, 180000);

  it('the drill CLI says so, and exits 0', async () => {
    await freshDb(`${SCRATCH}_b`);
    const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'restore-drill.js'), dumpFile, scratchUrl(`${SCRATCH}_b`), '--compare', sourceUrl()], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Every one of \d+ source tables matched/);
  }, 180000);

  it('refuses to restore over a database that already has tables', async () => {
    await expect(restoreAndVerify({ file: dumpFile, targetUrl: scratchUrl(), sourceUrl: sourceUrl() }))
      .rejects.toThrow(/already has \d+ table/);
  });

  it('refuses a production host outright', async () => {
    await expect(restoreAndVerify({
      file: dumpFile, targetUrl: 'postgresql://u:p@aws-1-ap-south-1.pooler.supabase.com:5432/postgres',
    })).rejects.toThrow(/never a managed production host/);
  });

  it('a truncated dump fails the drill instead of passing as a restore', async () => {
    const broken = path.join(dir, 'truncated.dump');
    const buf = fs.readFileSync(dumpFile);
    fs.writeFileSync(broken, buf.subarray(0, Math.floor(buf.length / 3)));
    await freshDb(SCRATCH);
    await expect(restoreAndVerify({ file: broken, targetUrl: scratchUrl(), sourceUrl: sourceUrl() }))
      .rejects.toThrow(/missing core table|does not match the source/);
  }, 180000);
});
