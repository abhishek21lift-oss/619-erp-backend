'use strict';

// No-show and check-in collectors. Both are pure mappers over rows plus a thin
// collect() that runs one tenant-scoped query, so the thresholds can be tested
// without a database.

const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({ query: mockQuery }));

const activity = require('../modules/ai-ops/signals/activity');
const checkins = require('../modules/ai-ops/signals/checkins');

const ORG = 'org-1';
const TODAY = '2026-11-25';

beforeEach(() => { mockQuery.mockReset(); });

describe('no-show mapper', () => {
  const row = (over = {}) => ({
    session_id: 's1',
    session_date: '2026-11-22',
    client_id: 'c1',
    name: 'Ravi',
    photo_url: null,
    ...over,
  });

  it('emits a recent no-show with a dated label', () => {
    const emitted = activity.reasonsFromNoShows([row()], TODAY);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].subject).toEqual({ type: 'client', id: 'c1', name: 'Ravi', photo_url: null });
    expect(emitted[0].reason).toEqual({
      code: 'no_show_recent',
      label: 'No-show on 22 Nov',
      evidence: { session_id: 's1', session_date: '2026-11-22' },
      due_at: null,
    });
  });

  it('ignores a no-show older than fourteen days', () => {
    expect(activity.reasonsFromNoShows([row({ session_date: '2026-11-05' })], TODAY)).toEqual([]);
  });

  it('keeps only the latest no-show per client as a second guard', () => {
    const emitted = activity.reasonsFromNoShows([
      row({ session_id: 'old', session_date: '2026-11-20' }),
      row({ session_id: 'new', session_date: '2026-11-23' }),
    ], TODAY);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].reason.evidence.session_id).toBe('new');
  });
});

describe('no-show collect', () => {
  it('runs a tenant-scoped query and maps the rows', async () => {
    mockQuery.mockResolvedValue({ rows: [{ session_id: 's1', session_date: '2026-11-22', client_id: 'c1', name: 'Ravi', photo_url: null }] });

    const emitted = await activity.collect({ orgId: ORG, today: TODAY });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('organization_id = $1');
    expect(params[0]).toBe(ORG);
    expect(emitted[0].reason.code).toBe('no_show_recent');
  });
});

describe('check-in mapper', () => {
  const row = (over = {}) => ({
    client_id: 'c1',
    name: 'Ravi',
    photo_url: null,
    created_at: '2026-10-01T09:00:00.000Z',
    last_checkin: '2026-11-17',
    ...over,
  });

  it('flags an eight-day gap as checkin_missing_7', () => {
    const emitted = checkins.reasonsFromCheckins([row()], TODAY);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].reason).toEqual({
      code: 'checkin_missing_7',
      label: 'No check-in for 8 days',
      evidence: { last_checkin: '2026-11-17' },
      due_at: null,
    });
  });

  it('flags a fifteen-day gap as checkin_missing_14', () => {
    const emitted = checkins.reasonsFromCheckins([row({ last_checkin: '2026-11-10' })], TODAY);
    expect(emitted[0].reason.code).toBe('checkin_missing_14');
  });

  it('does nothing for a recent check-in', () => {
    expect(checkins.reasonsFromCheckins([row({ last_checkin: '2026-11-24' })], TODAY)).toEqual([]);
  });

  it('waits a week before flagging a client who has never checked in', () => {
    expect(checkins.reasonsFromCheckins([row({
      last_checkin: null, created_at: '2026-11-20T09:00:00.000Z',
    })], TODAY)).toEqual([]);
  });

  it('flags a long-standing client with no check-in ever', () => {
    const emitted = checkins.reasonsFromCheckins([row({ last_checkin: null })], TODAY);

    expect(emitted[0].reason.code).toBe('checkin_missing_14');
    expect(emitted[0].reason.label).toBe('No check-in yet');
    expect(emitted[0].reason.evidence).toEqual({ last_checkin: null });
  });

  it('treats exactly seven and exactly fourteen days as missing', () => {
    expect(checkins.reasonsFromCheckins([row({ last_checkin: '2026-11-18' })], TODAY)[0].reason.code)
      .toBe('checkin_missing_7');
    expect(checkins.reasonsFromCheckins([row({ last_checkin: '2026-11-11' })], TODAY)[0].reason.code)
      .toBe('checkin_missing_14');
  });
});

describe('check-in collect', () => {
  it('runs a tenant-scoped query', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await checkins.collect({ orgId: ORG, today: TODAY });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('organization_id = $1');
    expect(params[0]).toBe(ORG);
  });
});
