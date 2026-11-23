'use strict';
// The dashboard's first-run setup block.
//
// The card used to be three static instructions. These pin the two things
// that make it a checklist instead: the counts come from the same definitions
// the client journey uses, and an established studio does not pay for the
// extra query at all.

jest.mock('../db/pool', () => ({ query: jest.fn() }));

const pool = require('../db/pool');
const { getDashboardStats, getSetupProgress } = require('../modules/pt-os/pt-os.service');

const ORG = '11111111-1111-4111-8111-111111111111';

const totals = {
  active_pt_clients: 0,
  expired_clients: 0,
  clients_with_balance: 0,
  overdue_clients: 0,
  total_monthly_commission: 0,
  total_outstanding: 0,
  total_monthly_pt_revenue: 0,
  today_collected: 0,
  today_payments: 0,
};

function dashboardQueries(setupRow) {
  pool.query
    .mockResolvedValueOnce({ rows: [totals] })                  // totals
    .mockResolvedValueOnce({ rows: [{ total_monthly_pt_revenue: 0 }] }) // month revenue
    .mockResolvedValueOnce({ rows: [{ collected: 0, payments: 0 }] })   // today
    .mockResolvedValueOnce({ rows: [] });                        // revenue trend
  if (setupRow) pool.query.mockResolvedValueOnce({ rows: [setupRow] });
}

describe('getSetupProgress', () => {
  beforeEach(() => pool.query.mockReset());

  it('counts the studio, scoped to the org and excluding soft-deleted clients', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ clients_added: 2, intake_complete: 1, plan_assigned: 1 }],
    });

    const setup = await getSetupProgress({ orgId: ORG });

    expect(setup).toEqual({ clients_added: 2, intake_complete: 1, plan_assigned: 1 });
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query.mock.calls[0][1]).toEqual([ORG]);

    const sql = pool.query.mock.calls[0][0];
    // A draft consent or a draft PAR-Q is not finished intake.
    expect(sql).toContain("ic.status = 'completed'");
    expect(sql).toContain("COALESCE(f.status, 'submitted') <> 'draft'");
    // A paused or completed programme is not a plan the client is on.
    expect(sql).toContain("wa.status = 'active'");
    expect(sql).toContain('c.deleted_at IS NULL');
  });
});

describe('getDashboardStats — setup is first-run only', () => {
  beforeEach(() => pool.query.mockReset());

  it('omits setup for a studio with clients and does not run the extra query', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ ...totals, active_pt_clients: 12, expired_clients: 3 }] })
      .mockResolvedValueOnce({ rows: [{ total_monthly_pt_revenue: 90000 }] })
      .mockResolvedValueOnce({ rows: [{ collected: 0, payments: 0 }] })
      .mockResolvedValueOnce({ rows: [] });

    const stats = await getDashboardStats({ orgId: ORG });

    expect(stats.setup).toBeNull();
    expect(pool.query).toHaveBeenCalledTimes(4);
  });

  it('returns setup counts when there are no active or expired terms', async () => {
    dashboardQueries({ clients_added: 1, intake_complete: 0, plan_assigned: 0 });

    const stats = await getDashboardStats({ orgId: ORG });

    expect(stats.setup).toEqual({ clients_added: 1, intake_complete: 0, plan_assigned: 0 });
    expect(pool.query).toHaveBeenCalledTimes(5);
  });
});
