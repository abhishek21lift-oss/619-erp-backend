'use strict';
// The restart-verification SQL, against a real migrated database.
//
// commandCenter.restartLadder.test.js drives the rungs through an in-memory
// audit table. That proves the control flow, not the queries — and the two
// guarantees that matter most here ARE queries: "the API restart is refused
// unless a worker restart is recent" and "the new process claims exactly the
// requests it is the result of, once".

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('restart verification, against a real database', () => {
    it('has a database to run against', () => {
      throw new Error('RLS_TEST_DATABASE_URL is not set in CI — the restart verification proof would skip.');
    });
  });
}

const mockDbUrl = DB_URL;
jest.mock('../db/pool', () => {
  if (!mockDbUrl) return { query: jest.fn(), connect: jest.fn() };
  const { Pool } = jest.requireActual('pg');
  return new Pool({ connectionString: mockDbUrl, max: 2 });
});
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const PREFIX = 'rv-test-';

describeIf('restart verification, against a real database', () => {
  let pool;
  let v;

  beforeAll(async () => {
    pool = require('../db/pool');
    v = require('../modules/command-center/restart-verification');
    // activity_log.user_id references users; the operator must exist.
    await pool.query(`INSERT INTO users (id, name, email, password, role, is_active)
      VALUES ('rv-op', 'RV Operator', 'rv-op@test.invalid', '!x', 'super_admin', TRUE) ON CONFLICT (id) DO NOTHING`);
  });
  const clean = () => pool.query(
    `DELETE FROM activity_log WHERE entity_id LIKE $1 OR (action = $2 AND user_id = 'rv-op')`,
    [`${PREFIX}%`, v.ACTION.workerRestart],
  );
  beforeEach(clean);
  afterAll(async () => {
    await clean();
    await pool.query(`DELETE FROM users WHERE id = 'rv-op'`);
    await pool.end();
  });

  const req = (id) => ({ id, user: { id: 'rv-op', name: 'RV Operator' }, ip: '10.1.1.1', headers: {} });

  async function workerRestartAt(msAgo) {
    await pool.query(
      `INSERT INTO activity_log (user_id, user_name, action, entity_type, entity_id, created_at)
       VALUES ('rv-op', 'RV Operator', $1, 'command_center', 'worker.restart', NOW() - ($2::int * INTERVAL '1 millisecond'))`,
      [v.ACTION.workerRestart, msAgo],
    );
  }

  it('refuses the API restart with no worker restart, allows it after one, refuses again once it is stale', async () => {
    // Other rows in the table must not satisfy the ladder; only ours count here.
    await pool.query(`DELETE FROM activity_log WHERE action = $1`, [v.ACTION.workerRestart]);
    expect(await v.apiRestartLadderReason()).toMatch(/Restart the worker first/);

    await workerRestartAt(v.LADDER_WINDOW_MS + 60_000);
    expect(await v.apiRestartLadderReason()).toMatch(/Restart the worker first/);

    await workerRestartAt(60_000);
    expect(await v.apiRestartLadderReason()).toBeNull();
  });

  it('records the request, and the process started after it claims it exactly once', async () => {
    const id = `${PREFIX}a`;
    await v.recordApiRestartRequest(req(id), { healthBefore: { status: 'critical', cards: { database: 'healthy' } } });
    // The request was written by the PREVIOUS process: move it before this one's start.
    await pool.query(
      `UPDATE activity_log SET created_at = $2 WHERE entity_id = $1`,
      [id, new Date(v.PROCESS_STARTED_AT.getTime() - 3000)],
    );
    expect((await v.apiRestartStatus(id)).state).toBe('pending');

    const health = async () => ({ status: 'healthy', cards: { database: 'healthy', redis: 'healthy' } });
    const first = await v.verifyPendingApiRestarts({ health, settleMs: 1 });
    expect(first.map((r) => r.request_id)).toContain(id);
    const second = await v.verifyPendingApiRestarts({ health, settleMs: 1 });
    expect(second.map((r) => r.request_id)).not.toContain(id);

    const status = await v.apiRestartStatus(id);
    expect(status).toMatchObject({ state: 'verified', outcome: 'recovered', request_id: id });
    expect(status.health_before).toMatchObject({ status: 'critical' });

    const { rows } = await pool.query(
      `SELECT user_id, action FROM activity_log WHERE entity_id = $1 ORDER BY created_at`, [id],
    );
    expect(rows).toEqual([
      { user_id: 'rv-op', action: v.ACTION.apiRequested },
      { user_id: 'rv-op', action: v.ACTION.apiVerified },
    ]);
  });

  it('does not claim a request made after this process started', async () => {
    const id = `${PREFIX}b`;
    await v.recordApiRestartRequest(req(id), { healthBefore: null });
    const results = await v.verifyPendingApiRestarts({
      health: async () => ({ status: 'healthy', cards: {} }), settleMs: 1,
    });
    expect(results.map((r) => r.request_id)).not.toContain(id);
    expect((await v.apiRestartStatus(id)).state).toBe('pending');
  });

  it('a refused restart closes the request as not_restarted', async () => {
    const id = `${PREFIX}c`;
    await v.recordApiRestartRequest(req(id), { healthBefore: null });
    await v.recordApiRestartRefused(req(id), 'Docker refused the restart (403)');
    expect(await v.apiRestartStatus(id)).toMatchObject({ state: 'verified', outcome: 'not_restarted' });
  });

  it('an unknown request id is reported as unknown', async () => {
    expect((await v.apiRestartStatus(`${PREFIX}nope`)).state).toBe('unknown');
  });
});
