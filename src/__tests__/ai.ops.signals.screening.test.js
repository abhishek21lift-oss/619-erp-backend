'use strict';

// Screening and form-check signals. Screening reads the LATEST PAR-Q, consent
// and clearance per client through LATERAL joins: a cross join would multiply
// rows and pick arbitrary versions, which for a medical record is not a bug you
// want to discover later.

const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({ query: mockQuery }));

const screening = require('../modules/ai-ops/signals/screening');
const formChecks = require('../modules/ai-ops/signals/formChecks');

const ORG = 'org-1';
const TODAY = '2026-11-25';

beforeEach(() => { mockQuery.mockReset(); });

const screeningRow = (over = {}) => ({
  client_id: 'c1',
  name: 'Ravi',
  photo_url: null,
  client_status: 'active',
  parq_id: null,
  parq_status: null,
  consent_id: null,
  consent_status: null,
  clearance_id: null,
  approval_status: null,
  expiry_date: null,
  ...over,
});

const codes = (emitted) => emitted.map((e) => e.reason.code);

describe('screening mapper', () => {
  it('flags a client with no PAR-Q', () => {
    const emitted = screening.reasonsFromScreening([screeningRow()], TODAY);
    const parq = emitted.find((e) => e.reason.code === 'parq_missing');

    expect(parq.reason.evidence).toEqual({ parq_id: null });
  });

  it('flags a draft PAR-Q even when an older form exists', () => {
    const emitted = screening.reasonsFromScreening([
      screeningRow({ parq_id: 'p1', parq_status: 'draft' }),
    ], TODAY);

    expect(codes(emitted)).toContain('parq_missing');
    expect(emitted.find((e) => e.reason.code === 'parq_missing').reason.evidence)
      .toEqual({ parq_id: 'p1' });
  });

  it('clears a submitted or reviewed PAR-Q', () => {
    for (const parq_status of ['submitted', 'reviewed']) {
      const emitted = screening.reasonsFromScreening([
        screeningRow({ parq_id: 'p1', parq_status }),
      ], TODAY);
      expect(codes(emitted)).not.toContain('parq_missing');
    }
  });

  it('flags missing or draft consent', () => {
    const none = screening.reasonsFromScreening([screeningRow()], TODAY);
    expect(none.find((e) => e.reason.code === 'consent_missing').reason.evidence)
      .toEqual({ consent_id: null, consent_status: null });

    const draft = screening.reasonsFromScreening([
      screeningRow({ consent_id: 'ic1', consent_status: 'draft' }),
    ], TODAY);
    expect(draft.find((e) => e.reason.code === 'consent_missing').reason.evidence)
      .toEqual({ consent_id: 'ic1', consent_status: 'draft' });
  });

  it('clears completed consent', () => {
    const emitted = screening.reasonsFromScreening([
      screeningRow({ consent_id: 'ic1', consent_status: 'completed' }),
    ], TODAY);
    expect(codes(emitted)).not.toContain('consent_missing');
  });

  it('flags an approved clearance that has expired', () => {
    const emitted = screening.reasonsFromScreening([
      screeningRow({
        clearance_id: 'mc1', approval_status: 'approved', expiry_date: '2026-11-04',
      }),
    ], TODAY);
    const expired = emitted.find((e) => e.reason.code === 'clearance_expired');

    expect(expired.reason.evidence).toEqual({ clearance_id: 'mc1', expiry_date: '2026-11-04' });
    expect(expired.reason.label).toBe('Medical clearance expired 4 Nov');
  });

  it('does not flag a clearance that expires today or later', () => {
    for (const expiry_date of [TODAY, '2027-01-01']) {
      const emitted = screening.reasonsFromScreening([
        screeningRow({ clearance_id: 'mc1', approval_status: 'approved', expiry_date }),
      ], TODAY);
      expect(codes(emitted)).not.toContain('clearance_expired');
    }
  });

  it('does not flag a pending or rejected clearance', () => {
    for (const approval_status of ['pending', 'rejected']) {
      const emitted = screening.reasonsFromScreening([
        screeningRow({ clearance_id: 'mc1', approval_status, expiry_date: '2026-01-01' }),
      ], TODAY);
      expect(codes(emitted)).not.toContain('clearance_expired');
    }
  });

  it('emits nothing for an inactive client', () => {
    const emitted = screening.reasonsFromScreening([
      screeningRow({ client_status: 'inactive' }),
    ], TODAY);
    expect(emitted).toEqual([]);
  });
});

describe('screening collect', () => {
  it('runs one tenant-scoped query over active and frozen clients', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await screening.collect({ orgId: ORG, today: TODAY });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('organization_id = $1');
    expect(sql).toContain("c.status IN ('active','frozen')");
    expect(params[0]).toBe(ORG);
  });
});

describe('form-check mapper', () => {
  const NOW = new Date('2026-11-25T12:00:00.000Z');
  const row = (over = {}) => ({
    form_check_id: 'fc1',
    created_at: '2026-11-24T06:00:00.000Z',
    form_check_status: 'pending',
    client_id: 'c1',
    name: 'Ravi',
    photo_url: null,
    ...over,
  });

  it('flags a check pending for thirty hours with its due time', () => {
    const emitted = formChecks.reasonsFromFormChecks([row()], TODAY, NOW);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].reason).toEqual({
      code: 'form_check_pending',
      label: 'Form check waiting 30 hours',
      evidence: { form_check_id: 'fc1', created_at: '2026-11-24T06:00:00.000Z' },
      due_at: '2026-11-25T06:00:00.000Z',
    });
  });

  it('does not flag a check that is twelve hours old', () => {
    const emitted = formChecks.reasonsFromFormChecks([
      row({ created_at: '2026-11-25T00:00:00.000Z' }),
    ], TODAY, NOW);
    expect(emitted).toEqual([]);
  });

  it('keeps only the oldest pending check per client', () => {
    const emitted = formChecks.reasonsFromFormChecks([
      row({ form_check_id: 'newer', created_at: '2026-11-24T00:00:00.000Z' }),
      row({ form_check_id: 'older', created_at: '2026-11-22T00:00:00.000Z' }),
    ], TODAY, NOW);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].reason.evidence.form_check_id).toBe('older');
  });

  it('never emits for a reviewed check', () => {
    expect(formChecks.reasonsFromFormChecks([
      row({ form_check_status: 'reviewed' }),
    ], TODAY, NOW)).toEqual([]);
  });
});

describe('form-check collect', () => {
  it('runs one tenant-scoped pending query', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await formChecks.collect({ orgId: ORG, today: TODAY });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('organization_id = $1');
    expect(sql).toContain("fc.status = 'pending'");
    expect(sql).toContain("INTERVAL '24 hours'");
    expect(params[0]).toBe(ORG);
  });
});
