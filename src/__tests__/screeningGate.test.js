// The screening gate's hard stops (assessment modules audit 2026-09-28,
// A-2, A-3, A-5). The SQL itself — the org join, the draft exclusion, the
// clearance-expiry predicate — is proved against a real database by the
// member-app integration test; this pins the decision made from its rows.
'use strict';

let mockParq = null;
let mockConsent = null;
const mockQueries = [];
jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    mockQueries.push({ sql: String(sql), params });
    if (/FROM pt_parq_forms/i.test(sql)) return { rows: mockParq ? [mockParq] : [] };
    if (/FROM pt_informed_consents/i.test(sql)) return { rows: mockConsent ? [mockConsent] : [] };
    return { rows: [] };
  }),
}));
jest.mock('../lib/activityLog', () => ({ logActivity: jest.fn() }));

const { checkScreeningGate, isTrainingBlocked } = require('../lib/screeningGate');

const req = { user: { id: 'u1' } };
const completed = { status: 'completed', physician_block: false };
const cleanParq = { risk_level: 'low', workout_gate_status: 'cleared', status: 'submitted', has_valid_clearance: false, answered_count: 10, is_stale: false };

beforeEach(() => { mockParq = null; mockConsent = completed; mockQueries.length = 0; });

test('high risk with no valid clearance blocks', async () => {
  mockParq = { risk_level: 'high', workout_gate_status: 'cleared', has_valid_clearance: false };
  const { blocked } = await checkScreeningGate(req, 'c1');
  expect(blocked.status).toBe(403);
  expect(blocked.body.code).toBe('PARQ_BLOCKED');
  expect(await isTrainingBlocked('c1')).toBe(true);
});

test('high risk with a valid clearance passes — and an expired one does not', async () => {
  // has_valid_clearance is computed in SQL with the expiry predicate, at read
  // time: a stored workout_gate_status of 'cleared' no longer decides.
  mockParq = { risk_level: 'high', workout_gate_status: 'cleared', has_valid_clearance: true };
  expect((await checkScreeningGate(req, 'c1')).blocked).toBeNull();
  mockParq = { ...mockParq, has_valid_clearance: false };
  expect((await checkScreeningGate(req, 'c1')).blocked).not.toBeNull();
  expect(mockQueries.some((q) => /expiry_date >= CURRENT_DATE/.test(q.sql))).toBe(true);
});

test('reads are pinned to the client\'s own studio and skip drafts', async () => {
  await checkScreeningGate(req, 'c1');
  const parqSql = mockQueries.find((q) => /FROM pt_parq_forms/.test(q.sql)).sql;
  const consentSql = mockQueries.find((q) => /FROM pt_informed_consents/.test(q.sql)).sql;
  expect(parqSql).toMatch(/c\.organization_id = f\.organization_id/);
  expect(parqSql).toMatch(/<> 'draft'/);
  expect(parqSql).toMatch(/created_at DESC/);
  expect(consentSql).toMatch(/c\.organization_id = ic\.organization_id/);
});

test('a revoked consent blocks', async () => {
  mockParq = { risk_level: 'low', workout_gate_status: 'cleared', has_valid_clearance: false };
  mockConsent = { ...completed, status: 'revoked' };
  const { blocked } = await checkScreeningGate(req, 'c1');
  expect(blocked.body.code).toBe('CONSENT_REVOKED');
  expect(await isTrainingBlocked('c1')).toBe(true);
});

test('physician advised against exercise blocks until a clearance is uploaded', async () => {
  mockParq = cleanParq;
  mockConsent = { ...completed, physician_block: true };
  expect((await checkScreeningGate(req, 'c1')).blocked.body.code).toBe('PHYSICIAN_ADVISED_AGAINST');
  mockConsent = { ...mockConsent, physician_block: false };
  expect((await checkScreeningGate(req, 'c1')).blocked).toBeNull();
});

test('missing paperwork only warns', async () => {
  // No consent ever completed or revoked: the SQL still returns its one row,
  // with a null status.
  mockConsent = { status: null, physician_block: false };
  const { blocked, warnings } = await checkScreeningGate(req, 'c1');
  expect(blocked).toBeNull();
  expect(warnings).toHaveLength(2);
  expect(await isTrainingBlocked('c1')).toBe(false);
});

describe('screening that is on file but cannot be relied on (safety audit 2026-09-29)', () => {
  test('a "submitted" PAR-Q with unanswered questions warns instead of reading as clean', async () => {
    mockParq = { ...cleanParq, answered_count: 0 };
    const { blocked, warnings } = await checkScreeningGate(req, 'c1');
    expect(blocked).toBeNull();
    expect(warnings).toEqual([expect.stringMatching(/incomplete \(0 of 10/)]);
  });

  test('a PAR-Q over a year old asks for a re-screen', async () => {
    mockParq = { ...cleanParq, is_stale: true };
    expect((await checkScreeningGate(req, 'c1')).warnings).toEqual([expect.stringMatching(/over 12 months/)]);
  });

  test('medium risk warns until a trainer marks it reviewed', async () => {
    mockParq = { ...cleanParq, risk_level: 'medium' };
    expect((await checkScreeningGate(req, 'c1')).warnings).toEqual([expect.stringMatching(/trainer review/)]);
    mockParq = { ...mockParq, status: 'reviewed' };
    expect((await checkScreeningGate(req, 'c1')).warnings).toEqual([]);
  });

  test('a complete, current, low-risk PAR-Q and a completed consent pass silently', async () => {
    mockParq = cleanParq;
    expect(await checkScreeningGate(req, 'c1')).toEqual({ blocked: null, warnings: [] });
  });

  test('the consent read decides on the newest given or withdrawn consent, not the newest row', async () => {
    await checkScreeningGate(req, 'c1');
    const sql = mockQueries.find((q) => /FROM pt_informed_consents/.test(q.sql)).sql;
    expect(sql).toMatch(/status IN \('completed', 'revoked', 'expired'\)/);
  });

  test('the clearance read takes the latest decision, not any approval', async () => {
    await checkScreeningGate(req, 'c1');
    const sql = mockQueries.find((q) => /FROM pt_parq_forms/.test(q.sql)).sql;
    expect(sql).toMatch(/approval_status IN \('approved', 'rejected'\)/);
    expect(sql).toMatch(/ORDER BY COALESCE\(mc\.reviewed_at/);
  });
});

describe('screeningGaps — the dashboard list of clients not cleared to train', () => {
  const row = (extra) => ({
    client_id: 'c1', client_name: 'Mina Rao', client_photo: null,
    risk_level: 'low', workout_gate_status: 'cleared', has_valid_clearance: false, answered_count: 10,
    consent_status: 'completed', physician_block: false, ...extra,
  });
  const { screeningGaps } = require('../lib/screeningGate');
  const pool = require('../db/pool');
  const gapsFor = async (rows) => {
    pool.query.mockResolvedValueOnce({ rows });
    return screeningGaps('org-a');
  };

  test('is scoped to the studio and to active, live clients', async () => {
    await gapsFor([]);
    const [sql, params] = pool.query.mock.calls.at(-1);
    expect(params).toEqual(['org-a']);
    expect(sql).toMatch(/c\.organization_id = \$1 AND c\.deleted_at IS NULL AND c\.status = 'active'/);
  });

  test('a fully screened client is not listed', async () => {
    expect(await gapsFor([row()])).toEqual([]);
  });

  test('names what is missing', async () => {
    const out = await gapsFor([
      row({ client_id: 'none', consent_status: null, answered_count: null, risk_level: null }),
      row({ client_id: 'partial', answered_count: 6 }),
    ]);
    expect(out).toEqual([
      expect.objectContaining({ client_id: 'none', missing: ['informed_consent', 'parq'], block: null }),
      expect.objectContaining({ client_id: 'partial', missing: ['parq'], block: null }),
    ]);
  });

  test('names the hard stop, most serious first', async () => {
    const out = await gapsFor([
      row({ client_id: 'risk', risk_level: 'high' }),
      row({ client_id: 'cleared', risk_level: 'high', has_valid_clearance: true }),
      row({ client_id: 'revoked', consent_status: 'revoked' }),
      row({ client_id: 'doctor', physician_block: true }),
    ]);
    expect(out.map((g) => [g.client_id, g.block])).toEqual([
      ['risk', 'PARQ_BLOCKED'], ['revoked', 'CONSENT_REVOKED'], ['doctor', 'PHYSICIAN_ADVISED_AGAINST'],
    ]);
  });
});
