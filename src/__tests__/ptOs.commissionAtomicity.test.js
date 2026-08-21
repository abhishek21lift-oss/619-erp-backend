// The monthly commission run writes in one statement, not one per client.
//
// ── What this replaces ─────────────────────────────────────────────────────
//
// calculateMonthlyCommissions used to SELECT the eligible clients and then
// loop, issuing an INSERT … ON CONFLICT per client with nothing wrapping the
// loop. Two failures, and the second is the one that bites at month end:
//
//   · A failure partway through left some commissions written and the rest
//     not. Re-running recovers, because the upsert is idempotent — but nothing
//     told anyone it needed re-running, so a studio could pay out against a
//     half-computed month.
//   · N+1 round trips, and with TENANT_RLS_ENFORCE on, db/pool.js turns each
//     one into four (BEGIN → set_config → query → COMMIT) on a dedicated
//     pooled client. A thousand PT clients is four thousand round trips
//     against a 15s query_timeout.
//
// Both are properties of the SHAPE of the write, so that is what this asserts:
// one statement, an INSERT … SELECT, and no per-row loop. A single statement
// is atomic in Postgres, which is where the all-or-nothing guarantee comes
// from — there is deliberately no BEGIN/COMMIT to assert on.
//
// The behaviour this shape produces (correct scoping, idempotent re-runs, and
// zero rows written when the statement fails partway) was verified against a
// real PostgreSQL 16 rather than a mock; this test is the standing guard that
// the shape does not quietly revert to a loop.
'use strict';

const ORG_A = '11111111-1111-4111-8111-111111111111';

const calls = [];
jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params: params || [] });
    return { rows: [{ commission_amt: '500.00' }, { commission_amt: '600.00' }], rowCount: 2 };
  }),
}));
jest.mock('../lib/appTime', () => ({
  today: () => '2026-08-20',
  todayShortDay: () => 'Thu',
}));

const svc = require('../modules/pt-os/pt-os.service');

beforeEach(() => { calls.length = 0; });

describe('calculateMonthlyCommissions writes in a single statement', () => {
  it('issues exactly one query — not one per client', async () => {
    await svc.calculateMonthlyCommissions('2026-08', { applyFilter: true, orgId: ORG_A });
    expect(calls).toHaveLength(1);
  });

  it('that query is an INSERT … SELECT, so the read cannot drift from the write', async () => {
    await svc.calculateMonthlyCommissions('2026-08', { applyFilter: true, orgId: ORG_A });
    const { sql } = calls[0];
    expect(sql).toMatch(/^INSERT INTO pt_commissions/i);
    expect(sql).toMatch(/SELECT c\.trainer_id/i);
    expect(sql).toMatch(/FROM pt_clients c JOIN pt_trainers t/i);
    // The upsert is what makes a re-run idempotent rather than duplicating.
    expect(sql).toMatch(/ON CONFLICT \(trainer_id, client_id, month\) DO UPDATE/i);
    expect(sql).toMatch(/RETURNING \*/i);
  });

  it('carries the caller\'s org when the scope asks for it', async () => {
    await svc.calculateMonthlyCommissions('2026-08', { applyFilter: true, orgId: ORG_A });
    expect(calls[0].sql).toMatch(/c\.organization_id = \$\d/);
    expect(calls[0].params).toContain(ORG_A);
  });

  it('omits the org filter for a platform-wide operator, and only then', async () => {
    await svc.calculateMonthlyCommissions('2026-08', { applyFilter: false });
    expect(calls[0].sql).not.toMatch(/organization_id/);
    expect(calls[0].params).toEqual(['2026-08-01', '2026-09-01']);
  });

  it('defaults a null trainer_commission to 0 rather than failing the NOT NULL', async () => {
    // The loop read the value through Number(), and Number(null) is 0. Passing
    // a SQL NULL straight into commission_amt would now raise instead, so the
    // COALESCE is behaviour preservation, not decoration.
    await svc.calculateMonthlyCommissions('2026-08', { applyFilter: false });
    expect(calls[0].sql).toMatch(/COALESCE\(c\.trainer_commission, 0\)/i);
  });

  it('totals the rows the database actually returned', async () => {
    const result = await svc.calculateMonthlyCommissions('2026-08', { applyFilter: false });
    expect(result).toEqual({ count: 2, total: 1100 });
  });
});
