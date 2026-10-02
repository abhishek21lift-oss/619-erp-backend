'use strict';
// Migration failure and recovery, against a real Postgres (Phase 4).
//
// The deploy runs `npm run migrate` before it swaps containers. What a release
// depends on is what happens when a migration FAILS half way:
//
//   · its statements roll back completely — no half-created table is left for
//     the next attempt to trip over;
//   · it is not recorded in _migrations, so the next run tries it again;
//   · the migrations before it stay applied and are not re-run;
//   · once the file is fixed, a rerun applies it and nothing else;
//   · two runners started together (two containers booting) apply each file
//     once, serialised by the advisory lock.
//
// Run against a scratch database created and dropped here, with a scratch
// migrations directory, so the real schema is never touched.

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('Migration recovery, against a real database', () => {
    it('has a database to run against', () => {
      throw new Error('RLS_TEST_DATABASE_URL is not set in CI — the migration recovery proof would skip.');
    });
  });
}

const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRATCH_DB = `migrate_recovery_${process.pid}`;
const scratchUrl = () => {
  const u = new URL(DB_URL);
  u.pathname = `/${SCRATCH_DB}`;
  return u.toString();
};

const mockScratch = { url: null };
jest.mock('../db/pool', () => {
  const { Pool } = jest.requireActual('pg');
  let pool = null;
  const get = () => (pool ||= new Pool({ connectionString: mockScratch.url, max: 4 }));
  return {
    connect: (...a) => get().connect(...a),
    query: (...a) => get().query(...a),
    end: () => (pool ? pool.end() : Promise.resolve()),
  };
});

describeIf('Migration recovery, against a real database', () => {
  let admin;
  let dir;
  let runMigrations;
  let pool;

  const write = (name, sql) => fs.writeFileSync(path.join(dir, name), sql);
  const applied = async () => (await pool.query('SELECT filename FROM _migrations ORDER BY filename')).rows.map((r) => r.filename);
  const tableExists = async (t) => (await pool.query('SELECT to_regclass($1) AS t', [`public.${t}`])).rows[0].t !== null;
  const quiet = () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  };

  beforeAll(async () => {
    const { Client } = jest.requireActual('pg');
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
    await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);
    mockScratch.url = scratchUrl();
    pool = require('../db/pool');
    ({ runMigrations } = require('../db/migrate'));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-recovery-'));
  });

  beforeEach(quiet);
  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await admin.end();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a failing migration rolls back completely, is not recorded, and earlier ones stay applied', async () => {
    write('001_ok.sql', 'CREATE TABLE rec_one (id int);');
    write('002_bad.sql', `CREATE TABLE rec_half (id int);
                          INSERT INTO rec_one VALUES (1);
                          SELECT 1/0;`);
    await expect(runMigrations({ dir })).rejects.toThrow(/division by zero/);

    expect(await applied()).toEqual(['001_ok.sql']);
    expect(await tableExists('rec_one')).toBe(true);
    expect(await tableExists('rec_half')).toBe(false);
    expect((await pool.query('SELECT count(*)::int n FROM rec_one')).rows[0].n).toBe(0);
  });

  it('the advisory lock is released after a failure, so the next run is not blocked', async () => {
    const { rows } = await pool.query(
      `SELECT count(*)::int n FROM pg_locks WHERE locktype = 'advisory' AND objid = 619619619`);
    expect(rows[0].n).toBe(0);
  });

  it('once fixed, a rerun applies the failed file and does not re-run the earlier one', async () => {
    write('002_bad.sql', 'CREATE TABLE rec_half (id int); INSERT INTO rec_one VALUES (1);');
    await runMigrations({ dir });
    expect(await applied()).toEqual(['001_ok.sql', '002_bad.sql']);
    expect(await tableExists('rec_half')).toBe(true);
    // 001 was not run a second time: it would have failed on CREATE TABLE.
    expect((await pool.query('SELECT count(*)::int n FROM rec_one')).rows[0].n).toBe(1);
  });

  it('two runners started together apply each new file exactly once', async () => {
    write('003_counted.sql', 'INSERT INTO rec_one VALUES (3);');
    await Promise.all([runMigrations({ dir }), runMigrations({ dir })]);
    expect(await applied()).toEqual(['001_ok.sql', '002_bad.sql', '003_counted.sql']);
    expect((await pool.query('SELECT count(*)::int n FROM rec_one WHERE id = 3')).rows[0].n).toBe(1);
  });
});
