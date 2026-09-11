'use strict';
// The canonical metric layer, and the properties that make it canonical.
//
// ── What is worth pinning here ─────────────────────────────────────────────
//
// Not the wording of any query. Three properties that were each violated
// somewhere in the reporting surface this module replaces:
//
//   1. A rate with an empty denominator is NULL, not 0. "Nobody was due to
//      renew" and "everybody left" are different facts and must not render
//      alike.
//   2. Every read carries its own organization predicate. Scoping by
//      derivation — "the parent lookup was scoped, so the children are too" —
//      is what left four aggregates cross-tenant.
//   3. The renewal cohort is built from BOTH sources. A renewed term's end
//      date survives only in pt_client_renewals; a lapsed term's is still on
//      the client row. Drop either and the rate is wrong in a direction that
//      flatters the studio.

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'https://example.com';

const mockQueries = [];
let mockRows = [];

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    mockQueries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params: params || [] });
    return { rows: mockRows.length ? mockRows.shift() : [{}] };
  }),
}));

const repo = require('../modules/insights/insights.repository');
const D = require('../modules/insights/definitions');

beforeEach(() => { mockQueries.length = 0; mockRows = []; });

describe('pct: an empty denominator is null, never zero', () => {
  it('returns null when nothing was due', () => {
    expect(repo.pct(0, 0)).toBeNull();
  });

  it('returns 0 only when there genuinely were none out of some', () => {
    // The distinction the whole helper exists for.
    expect(repo.pct(0, 10)).toBe(0);
  });

  it('returns 100 when every one converted', () => {
    expect(repo.pct(7, 7)).toBe(100);
  });

  it('keeps one decimal place rather than rounding a rate to an integer', () => {
    // 1 of 6 is 16.666…; reporting "17%" of a six-term cohort overstates by
    // a third of a term. subscriptions.js settled on one decimal for churn
    // for the same reason.
    expect(repo.pct(1, 6)).toBe(16.7);
  });

  it('treats a null denominator as empty rather than throwing', () => {
    expect(repo.pct(3, null)).toBeNull();
    expect(repo.pct(null, null)).toBeNull();
  });
});

describe('every query scopes to an organization', () => {
  const ORG = '11111111-1111-4111-8111-111111111111';

  it.each([
    ['clientStock', () => repo.clientStock(ORG)],
    ['renewalConversion', () => repo.renewalConversion(ORG, '2026-01-01', '2026-12-31')],
    ['revenue', () => repo.revenue(ORG, '2026-01-01', '2026-12-31')],
    ['attendance', () => repo.attendance(ORG, '2026-01-01', '2026-12-31')],
    ['sessions', () => repo.sessions(ORG, '2026-01-01', '2026-12-31')],
  ])('%s binds the org and filters on it', async (_name, run) => {
    await run();
    expect(mockQueries).toHaveLength(1);
    const q = mockQueries[0];
    // Bound, never interpolated — an org id spliced into SQL is the shape
    // that turns a tenant filter into an injection point.
    expect(q.params[0]).toBe(ORG);
    expect(q.sql).not.toContain(ORG);
    expect(q.sql).toMatch(/\$1::uuid IS NULL OR/);
  });

  it('scopes EVERY table it touches, not just the driving one', async () => {
    // sessions() reads two unrelated tables in one statement. One predicate
    // would leave the other table unscoped, which is exactly the fault found
    // in reports.js and trainers.js.
    await repo.sessions(ORG, '2026-01-01', '2026-12-31');
    const sql = mockQueries[0].sql;
    expect(sql).toMatch(/ws\.organization_id = \$1/);
    expect(sql).toMatch(/s\.organization_id = \$1/);
  });

  it('renewalConversion scopes through pt_clients, which is where the org lives', async () => {
    // pt_client_renewals had no organization_id until migration 196, and rows
    // written before it still have none — so the join is the scope, and it is
    // also what drops the orphaned rows whose client no longer exists.
    await repo.renewalConversion(ORG, '2026-01-01', '2026-12-31');
    const sql = mockQueries[0].sql;
    expect(sql).toMatch(/JOIN pt_clients c ON c\.id = r\.client_id/);
    expect(sql).toMatch(/c\.organization_id = \$1/);
  });
});

describe('the renewal cohort is both halves or it is wrong', () => {
  it('unions renewed terms with lapsed ones', async () => {
    await repo.renewalConversion(null, '2026-01-01', '2026-12-31');
    const sql = mockQueries[0].sql;
    // Renewed: the old end date, which only the renewals table still holds.
    expect(sql).toMatch(/r\.old_end_date AS term_end/);
    // Lapsed: the client's current end date, nothing having moved it on.
    expect(sql).toMatch(/c\.pt_end_date AS term_end/);
    // UNION, not UNION ALL — one client, one decision, one row.
    expect(sql).toMatch(/UNION SELECT client_id, term_end FROM lapsed/);
    expect(sql).not.toMatch(/UNION ALL/);
  });

  it('windows on the term end date, not on when the renewal was keyed in', async () => {
    // A renewal entered three weeks late belongs to the month the term ran
    // out. Windowing on renewed_at would move it, and would let a studio
    // improve last quarter by doing its data entry now.
    await repo.renewalConversion(null, '2026-01-01', '2026-12-31');
    const sql = mockQueries[0].sql;
    expect(sql).toMatch(/r\.old_end_date BETWEEN \$2::date AND \$3::date/);
    expect(sql).not.toMatch(/renewed_at BETWEEN/);
  });

  it('reports the rate with the cohort it was computed from', async () => {
    mockRows = [[{ terms_due: 6, terms_renewed: 1 }]];
    const out = await repo.renewalConversion(null, '2026-01-01', '2026-12-31');
    // The denominator travels with the rate. A bare "16.7%" cannot be
    // sanity-checked by the person reading it.
    expect(out).toEqual({ terms_due: 6, terms_renewed: 1, renewal_rate_pct: 16.7 });
  });

  it('returns a null rate, with the zero cohort, when nothing was due', async () => {
    mockRows = [[{ terms_due: 0, terms_renewed: 0 }]];
    const out = await repo.renewalConversion(null, '2026-01-01', '2026-12-31');
    expect(out.renewal_rate_pct).toBeNull();
    expect(out.terms_due).toBe(0);
  });
});

describe('the definitions are the ones the queries are built from', () => {
  it('active means dates, not the status column', async () => {
    // The defect this replaces: pt_clients.status is hand-maintained, has no
    // CHECK constraint, and disagreed with pt_end_date for 12 of production's
    // 34 live clients. Three studios' active counts changed when this landed.
    expect(D.CLIENT_ACTIVE).toMatch(/pt_end_date/);
    expect(D.CLIENT_ACTIVE).not.toMatch(/status/);
    expect(D.CLIENT_LAPSED).not.toMatch(/status/);

    await repo.clientStock(null);
    expect(mockQueries[0].sql).not.toMatch(/c\.status/);
  });

  it('a late arrival counts as attendance', () => {
    // attendance.js counted status='present' alone; qr-checkin.js counted
    // present OR late. One studio, two footfall numbers.
    expect(D.ATTENDED).toMatch(/'present'/);
    expect(D.ATTENDED).toMatch(/'late'/);
  });

  it('attendance means clients, not staff rows in the same table', () => {
    expect(D.ATTENDANCE_CLIENT_ROWS).toMatch(/ref_type = 'client'/);
  });

  it('delivered sessions read the training log, not the appointment diary', () => {
    // Nothing in the product ever writes 'completed' to pt_sessions, so six
    // surfaces counting it as delivery were reporting zero work done.
    expect(D.SESSION_DELIVERED).toMatch(/ws\.status = 'completed'/);
  });

  it('outstanding excludes credit balances rather than netting them off', () => {
    expect(D.BALANCE_OUTSTANDING).toMatch(/balance_amount > 0/);
  });

  it('the incentive is the ledger value, not revenue times today\'s rate', () => {
    // trainers.js:60 recomputes it from the CURRENT rate, which silently
    // rewrites history whenever a trainer's rate changes; the ledger column
    // is the rate that was actually applied at the time.
    expect(D.INCENTIVE_LEDGER).toMatch(/incentive_amt/);
  });

  it('publishes a one-line definition for every metric it serves', () => {
    const missing = Object.entries(D.CATALOGUE)
      .filter(([, s]) => !s.unit || typeof s.definition !== 'string' || s.definition.length < 30)
      .map(([name]) => name);
    // Named rather than counted, so the failure says which metric is
    // undocumented instead of only that one is.
    expect(missing).toEqual([]);
  });

  it('says what null means for every metric that can be null', () => {
    // A percentage that can be null and does not explain it is a percentage
    // somebody will render as 0.
    for (const key of ['renewal_rate_pct', 'attendance_rate_pct']) {
      expect(D.CATALOGUE[key].nullWhen).toBeTruthy();
    }
  });
});
