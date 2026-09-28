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
const completed = { status: 'completed', physician_advised_against: null, medical_clearance_file_url: null };

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
  mockParq = { risk_level: 'low', workout_gate_status: 'cleared', has_valid_clearance: false };
  mockConsent = { ...completed, physician_advised_against: true };
  expect((await checkScreeningGate(req, 'c1')).blocked.body.code).toBe('PHYSICIAN_ADVISED_AGAINST');
  mockConsent = { ...mockConsent, medical_clearance_file_url: '/uploads/x.pdf' };
  expect((await checkScreeningGate(req, 'c1')).blocked).toBeNull();
});

test('missing paperwork only warns', async () => {
  mockConsent = null;
  const { blocked, warnings } = await checkScreeningGate(req, 'c1');
  expect(blocked).toBeNull();
  expect(warnings).toHaveLength(2);
  expect(await isTrainingBlocked('c1')).toBe(false);
});
