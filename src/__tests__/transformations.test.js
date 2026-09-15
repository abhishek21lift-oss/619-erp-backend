'use strict';
// A transformation is a series. A single weight never was one.
//
// ── What was there ─────────────────────────────────────────────────────────
//
// The Transformations screen derived everything from the client list alone,
// comparing pt_clients.weight against `initial_weight` / `start_weight`.
// Neither column exists — not on pt_clients, not in any migration — so every
// comparison was 0 against 0:
//
//   · "Goal Completion Rate" read 0% permanently.
//   · The Start Weight column read "—" for every row, forever.
//   · "Top Performer" reduced over a difference that was always zero, so it
//     returned the FIRST element of the array and printed an arbitrary
//     member's name under a trophy.
//
// It reads pt_os_measurements now. What is pinned here is the distinction the
// old page could not make and the new one must: "not measured twice yet" is
// not "held their weight". Reporting the first as a change of 0 puts a client
// nobody has re-measured in the same bucket as one who held steady for six
// months, which is the kind of quiet wrongness a coach acts on.

jest.mock('../db/pool', () => ({ query: jest.fn() }));
const pool = require('../db/pool');
const { getTransformations } = require('../modules/pt-os/pt-os.service');

const ORG = 'org-a';
const row = (over = {}) => ({
  id: 'c1', client_id: 'PT001', name: 'A', photo_url: null, trainer_name: 'T',
  created_at: '2026-01-01', start_weight: '80.00', start_measured_at: '2026-01-01T00:00:00Z',
  current_weight: '75.00', current_measured_at: '2026-06-01T00:00:00Z',
  measurement_count: 4, ...over,
});

const answer = (rows) => { pool.query.mockReset(); pool.query.mockResolvedValue({ rows }); };

describe('a series, or nothing', () => {
  it('reports the change between first and latest measurement', async () => {
    answer([row()]);
    const [out] = await getTransformations({ applyFilter: true, orgId: ORG });
    expect(out.start_weight).toBe(80);
    expect(out.current_weight).toBe(75);
    expect(out.weight_change).toBe(-5);
  });

  it('a single measurement has no change — null, not zero', async () => {
    // One measuring session: start and latest are the same row.
    answer([row({
      measurement_count: 1,
      start_measured_at: '2026-01-01T00:00:00Z',
      current_measured_at: '2026-01-01T00:00:00Z',
      start_weight: '80.00', current_weight: '80.00',
    })]);
    const [out] = await getTransformations({ applyFilter: true, orgId: ORG });
    expect(out.weight_change).toBeNull();
    expect(out.start_weight).toBeNull();
    // The current weight is still a fact and still shown.
    expect(out.current_weight).toBe(80);
  });

  it('two readings at the same instant are one reading', async () => {
    answer([row({
      measurement_count: 2,
      start_measured_at: '2026-01-01T00:00:00Z',
      current_measured_at: '2026-01-01T00:00:00Z',
    })]);
    const [out] = await getTransformations({ applyFilter: true, orgId: ORG });
    expect(out.weight_change).toBeNull();
  });

  it('a client who genuinely held their weight reports 0, not null', async () => {
    // The other side of the same boundary. Without this the two cases above
    // would pass on an implementation that simply never returns 0.
    answer([row({ start_weight: '80.00', current_weight: '80.00' })]);
    const [out] = await getTransformations({ applyFilter: true, orgId: ORG });
    expect(out.weight_change).toBe(0);
  });

  it('a client with no measurements at all carries nulls, not zeros', async () => {
    answer([row({
      measurement_count: 0, start_weight: null, current_weight: null,
      start_measured_at: null, current_measured_at: null,
    })]);
    const [out] = await getTransformations({ applyFilter: true, orgId: ORG });
    expect(out.current_weight).toBeNull();
    expect(out.weight_change).toBeNull();
  });

  it('rounds to two places rather than carrying float noise into the UI', async () => {
    answer([row({ start_weight: '80.10', current_weight: '79.35' })]);
    const [out] = await getTransformations({ applyFilter: true, orgId: ORG });
    expect(out.weight_change).toBe(-0.75);
  });
});

describe('tenancy', () => {
  it('filters on the client, because the measurement row has no org of its own', async () => {
    // pt_os_measurements deliberately carries no organization_id (migration
    // 177: a child row reached only through its parent), so the predicate has
    // to sit on the JOIN. If it ever moves off, this fails.
    answer([]);
    await getTransformations({ applyFilter: true, orgId: ORG });
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/JOIN pt_clients c ON c\.id = m\.client_id/);
    expect(sql).toMatch(/c\.organization_id = \$1/);
    expect(params).toContain(ORG);
  });

  it('scopes BOTH the measurement series and the outer client list', async () => {
    answer([]);
    await getTransformations({ applyFilter: true, orgId: ORG });
    const [sql] = pool.query.mock.calls[0];
    // Once inside the CTE, once on the outer read. A filter on only the CTE
    // would still list every studio's clients with empty columns — which
    // leaks the roster, not the weights.
    expect(sql.match(/c\.organization_id = \$1/g)).toHaveLength(2);
  });

  it('a platform operator with no studio selected gets no filter and no stray param', async () => {
    answer([]);
    await getTransformations({ applyFilter: false, orgId: null });
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).not.toMatch(/organization_id/);
    expect(params).toEqual([]);
  });
});
