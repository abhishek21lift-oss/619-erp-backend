'use strict';
// The client list's server-side page, count and KPI summary.
//
// The page used to fetch the whole roster and filter it in the browser. It now
// sends search/status/term to the database and receives one page, so three
// properties stop being visible to a reader and have to be asserted here:
//
//   1. every query is scoped to the caller's organization, including the
//      payment aggregate that used to rely only on its join to pt_clients;
//   2. the page is sliced with a stable ORDER BY (name, id) — equal names must
//      not shuffle between pages;
//   3. the count and the summary use the same filters/scoping as the page,
//      otherwise the header disagrees with the rows or leaks another studio.
//
// CI has no database here (same constraint as the other pt-os suites), so the
// mocked pool records the SQL and binds it would have sent.

const ORG = '0a000000-0000-4000-8000-000000000001';

jest.mock('../db/pool', () => ({
  query: jest.fn(),
}));

const pool = require('../db/pool');
const svc = require('../modules/pt-os/pt-os.service');

let calls;

/** Answer with `rows` and record what the service asked. */
function respond(rows) {
  pool.query.mockImplementationOnce(async (sql, params) => {
    calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
    return { rows };
  });
}

beforeEach(() => {
  calls = [];
  pool.query.mockReset();
});

describe('payment aggregates are org-scoped', () => {
  it('filters the incentive subquery by organization, not just by client id', async () => {
    respond([{ id: 'ptc-1', total_earned_commission: '0' }]);
    await svc.getActiveClients({ orgId: ORG }, {});

    const [{ sql, params }] = calls;
    const incentive = /LEFT JOIN \(\s*SELECT client_id, SUM\(incentive_amt\).*?\) pp/i.exec(sql);
    expect(incentive).not.toBeNull();
    expect(incentive[0]).toMatch(/organization_id = \$1/i);
    expect(params[0]).toBe(ORG);
  });

  it('does the same in the balance sheet', async () => {
    respond([]);
    await svc.getBalanceSheet({ orgId: ORG });

    const [{ sql }] = calls;
    expect(sql).toMatch(/FROM pt_payments\s+WHERE deleted_at IS NULL\s+AND organization_id = \$1/i);
  });
});

describe('the list can tell pending from not enrolled', () => {
  it('returns has_pt_term', async () => {
    respond([{ id: 'ptc-1', has_pt_term: true }]);
    await svc.getActiveClients({ orgId: ORG }, {});

    const [{ sql }] = calls;
    expect(sql).toMatch(/AS has_pt_term/);
    expect(sql).toMatch(/pt_client_subscriptions/);
  });
});

describe('paging', () => {
  it('orders by name with id as the tiebreaker so pages cannot overlap', async () => {
    respond([]);
    await svc.getActiveClients({ orgId: ORG }, { limit: 50, offset: 100 });

    const [{ sql, params }] = calls;
    expect(sql).toMatch(/ORDER BY c\.name, c\.id/i);
    // LIMIT/OFFSET follow the filter binds, so the slice is the last pair.
    expect(params.slice(-2)).toEqual([50, 100]);
  });

  it('caps and clamps limit/offset like the rest of the module', async () => {
    respond([]);
    await svc.getActiveClients({ orgId: ORG }, { limit: 99999, offset: -5 });

    const [{ params }] = calls;
    expect(params.slice(-2)).toEqual([2000, 0]);
  });

  it('counts with the same filters as the page, without a LIMIT', async () => {
    respond([{ total: 7 }]);
    const total = await svc.countActiveClients(
      { orgId: ORG },
      { search: 'ann', status: 'active', limit: 50, offset: 100 },
    );

    const [{ sql, params }] = calls;
    expect(total).toBe(7);
    expect(sql).toMatch(/^SELECT COUNT\(\*\)::INT AS total FROM pt_clients c WHERE /);
    expect(sql).not.toMatch(/LIMIT/i);
    expect(sql).toMatch(/c\.organization_id = \$1/);
    expect(sql).toMatch(/c\.status = \$3/);
    expect(params).toEqual([ORG, '%ann%', 'active']);
  });

  it('searches every field the old browser filter covered', async () => {
    respond([{ total: 0 }]);
    await svc.countActiveClients({ orgId: ORG }, { search: 'maya' });

    const [{ sql }] = calls;
    // name was obvious; trainer name, unique id, phone and email are the ones
    // a handoff from global search actually carries.
    for (const col of ['c.name', 'c.trainer_name', 'c.unique_id', 'c.mobile', 'c.client_id', 'c.email']) {
      expect(sql).toContain(`${col} ILIKE $2`);
    }
  });

  it('expresses the derived Expired pill as status OR a past end date', async () => {
    respond([{ total: 0 }]);
    await svc.countActiveClients({ orgId: ORG }, { expired: true });

    const [{ sql }] = calls;
    expect(sql).toMatch(/c\.status = 'expired'/);
    expect(sql).toMatch(/pt_end_date::DATE/);
    expect(sql).toMatch(/< CURRENT_DATE/);
  });
});

describe('summary', () => {
  it('reports whole-studio KPIs scoped to the caller', async () => {
    respond([{
      total: 12, revenue: '12000', paid: '9000', balance: '3000', active_count: 9,
    }]);
    const summary = await svc.getClientSummary({ orgId: ORG });

    const [{ sql, params }] = calls;
    expect(params).toEqual([ORG]);
    expect(sql).toMatch(/c\.organization_id = \$1/);
    // Term-aware balance: lifetime paid offsets an earlier term first.
    expect(sql).toMatch(/prior\.paid/);
    expect(summary).toEqual({
      total: 12, revenue: 12000, paid: 9000, balance: 3000, active_count: 9,
    });
  });

  it('normalises an empty aggregate row to zeros', async () => {
    respond([{ total: null, revenue: null, paid: null, balance: null, active_count: null }]);
    await expect(svc.getClientSummary({ orgId: ORG })).resolves.toEqual({
      total: 0, revenue: 0, paid: 0, balance: 0, active_count: 0,
    });
  });
});
