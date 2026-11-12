'use strict';
// The assembled context object is the one thing every Copilot capability will
// receive. Three rules are asserted here:
//
//   * it carries provenance and freshness, not just values
//   * a missing fact is null (or absent from `sections`), never a plausible
//     default
//   * by default it contains no phone number, email, address or free-text
//     clinical note — those live behind task-specific tools, not a context
//     blob handed to every prompt

jest.mock('../modules/pt-os/client-read.service', () => ({
  findVisibleClient: jest.fn(),
  getClientProfile: jest.fn(),
  getClientTrainingBrief: jest.fn(),
  getClientAttendance: jest.fn(),
}));
jest.mock('../db/pool', () => ({ query: jest.fn() }));

const pool = require('../db/pool');
const {
  findVisibleClient,
  getClientProfile,
  getClientTrainingBrief,
  getClientAttendance,
} = require('../modules/pt-os/client-read.service');
const {
  assembleContext,
  assessFreshness,
  ATTENDANCE_WINDOW_DAYS,
} = require('../modules/copilot/context/assemble');

const NOW = new Date('2026-11-11T00:00:00.000Z');

const CTX = {
  identity: { userId: 'user-1', name: 'Trainer One', role: 'trainer', trainerId: 'tr-1' },
  tenant: { organizationId: 'org-a', organizationName: 'Studio A' },
  permissions: { levels: ['READ', 'ANALYZE', 'DRAFT', 'EXECUTE'], executeRequiresApproval: true },
  clientAccess: { policy: 'organization_wide' },
};

const PROFILE = {
  id: 'c1',
  name: 'Asha',
  gender: 'female',
  dob: '1990-05-05',
  goal: 'fat loss',
  height: 165,
  weight: 70,
  body_fat: 28,
  workout_experience_level: 'beginner',
  status: 'active',
  pt_start_date: '2026-01-01',
  pt_end_date: '2026-12-31',
  updated_at: '2026-11-10T08:00:00.000Z',
  screening: { complete: false, block: null, missing: ['parq'] },
  // None of the following may survive into the context object.
  mobile: '+919999999999',
  email: 'asha@example.com',
  address: '12 Private Street',
  notes: 'Private clinical note',
  health_conditions: 'Private condition',
  injuries: 'Private injury',
  emergency_contact: 'Private contact',
  emergency_phone: '+918888888888',
  whatsapp: '+917777777777',
};

const BRIEF = {
  client: { id: 'c1', name: 'Asha', gender: 'female', age: 36, goal: 'fat loss', notes: 'Private clinical note' },
  sections: {
    readiness: { present: true, as_of: '2026-10-01' },
    body: { present: true, as_of: '2026-08-01' },
    limitations: { present: false },
    goal: { present: true, as_of: '2026-01-01' },
  },
  missing: ['limitations', 'lifestyle'],
  stale: [
    { section: 'body', as_of: '2026-08-01', age_days: 102, stale_after_days: 90 },
    { section: 'goal', as_of: '2026-01-01', age_days: 314, stale_after_days: 180 },
  ],
  completeness_pct: 57,
};

const ATTENDANCE = [
  { date: '2026-11-10', status: 'present' },
  { date: '2026-11-08', status: 'present' },
  { date: '2026-10-30', status: 'late' },
  { date: '2026-10-01', status: 'absent' }, // outside the 28-day window
];

beforeEach(() => {
  pool.query.mockReset();
  findVisibleClient.mockReset();
  getClientProfile.mockReset();
  getClientTrainingBrief.mockReset();
  getClientAttendance.mockReset();
});

describe('assessFreshness', () => {
  test('an unknown date is unknown, not fresh and not stale', () => {
    expect(assessFreshness(null, 30, NOW)).toEqual({ as_of: null, age_days: null, stale: null });
  });

  test('a date inside the threshold is fresh', () => {
    expect(assessFreshness('2026-11-01', 30, NOW)).toEqual({
      as_of: '2026-11-01', age_days: 10, stale: false,
    });
  });

  test('a date outside the threshold is stale', () => {
    expect(assessFreshness('2026-09-01', 30, NOW).stale).toBe(true);
  });
});

describe('assembleContext without a selected client', () => {
  test('returns the identity and a bounded picker list, no client data', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 'c1', name: 'Asha' }] });

    const out = await assembleContext(CTX, null, { now: NOW });

    expect(out.client).toBeNull();
    expect(out.client_scope).toEqual({
      policy: 'organization_wide',
      selected_client_id: null,
      available_clients: [{ id: 'c1', name: 'Asha' }],
    });
    expect(getClientProfile).not.toHaveBeenCalled();
    expect(getClientTrainingBrief).not.toHaveBeenCalled();
    expect(getClientAttendance).not.toHaveBeenCalled();
  });
});

describe('assembleContext with a client', () => {
  beforeEach(() => {
    findVisibleClient.mockResolvedValue({ id: 'c1', name: 'Asha' });
    getClientProfile.mockResolvedValue(PROFILE);
    getClientTrainingBrief.mockResolvedValue(BRIEF);
    getClientAttendance.mockResolvedValue(ATTENDANCE);
  });

  test('a foreign client resolves to null before any record read', async () => {
    findVisibleClient.mockResolvedValue(null);

    expect(await assembleContext(CTX, 'foreign', { now: NOW })).toBeNull();
    expect(getClientProfile).not.toHaveBeenCalled();
    expect(getClientTrainingBrief).not.toHaveBeenCalled();
    expect(getClientAttendance).not.toHaveBeenCalled();
  });

  test('whitelists profile facts and derives age', async () => {
    const out = await assembleContext(CTX, 'c1', { now: NOW });

    expect(out.client).toMatchObject({
      id: 'c1',
      name: 'Asha',
      age: 36,
      gender: 'female',
      goal: 'fat loss',
      height_cm: 165,
      weight_kg: 70,
      body_fat_pct: 28,
      experience_level: 'beginner',
      status: 'active',
      pt_start_date: '2026-01-01',
      pt_end_date: '2026-12-31',
    });
    expect(out.client.screening).toEqual(PROFILE.screening);
  });

  test('brief carries presence and dates, not clinical text', async () => {
    const out = await assembleContext(CTX, 'c1', { now: NOW });

    expect(out.client.brief.sections.readiness).toEqual({
      present: true, as_of: '2026-10-01', stale: false,
    });
    expect(out.client.brief.sections.body).toEqual({
      present: true, as_of: '2026-08-01', stale: true,
    });
    expect(out.client.brief.sections.limitations).toEqual({
      present: false, as_of: null, stale: null,
    });
    expect(out.client.brief.missing).toEqual(['limitations', 'lifestyle']);
    expect(out.client.brief.completeness_pct).toBe(57);
  });

  test('attendance is a bounded summary, never raw rows with notes', async () => {
    const out = await assembleContext(CTX, 'c1', { now: NOW });

    expect(out.client.attendance).toEqual({
      window_days: ATTENDANCE_WINDOW_DAYS,
      present: 2,
      absent: 0,
      late: 1,
      half_day: 0,
      last_present_on: '2026-11-10',
      freshness: { as_of: '2026-11-10', age_days: 1, stale: false },
    });
    expect(JSON.stringify(out)).not.toContain('notes');
  });

  test('missing profile facts stay null instead of becoming zero', async () => {
    getClientProfile.mockResolvedValue({ ...PROFILE, weight: null, height: null, body_fat: null });

    const out = await assembleContext(CTX, 'c1', { now: NOW });

    expect(out.client.weight_kg).toBeNull();
    expect(out.client.height_cm).toBeNull();
    expect(out.client.body_fat_pct).toBeNull();
  });

  test('contains no phone, email, address or free-text clinical note', async () => {
    const out = await assembleContext(CTX, 'c1', { now: NOW });
    const json = JSON.stringify(out);

    for (const secret of [
      '+919999999999', 'asha@example.com', '12 Private Street',
      'Private clinical note', 'Private condition', 'Private injury',
      '+918888888888', '+917777777777',
    ]) {
      expect(json).not.toContain(secret);
    }
  });

  test('states provenance for the facts it reports', async () => {
    const out = await assembleContext(CTX, 'c1', { now: NOW });

    expect(out.client.provenance).toEqual(expect.arrayContaining([
      { table: 'pt_clients', as_of: '2026-11-10' },
      { table: 'attendance_logs', as_of: '2026-11-10' },
    ]));
  });

  test('the attendance read it consumes actually selects status', () => {
    // The summary counts present/absent/late/half_day, which only works if the
    // shared read returns `status`; the fixture above would otherwise match a
    // shape production never sends. Read the source rather than the service,
    // which this suite mocks.
    const source = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'modules', 'pt-os', 'pt-os.service.js'),
      'utf8'
    );
    const select = source.match(/SELECT id, date, check_in_time[^`]+/);
    expect(select).not.toBeNull();
    expect(select[0]).toContain('status');
  });
});
