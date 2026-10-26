'use strict';
// The intake journey's read model, without a database.
//
// The real-DB journey test walks a whole client through every step; these pin
// the one state that walk could not cover cheaply: a plan still marked active
// on a client whose PT term has ended. That client was shown as having
// completed Program Design, and every "next step" button disappeared, while
// the assign gate would refuse them.

jest.mock('../db/pool', () => ({ query: jest.fn() }));
jest.mock('../lib/screeningGate', () => ({ screeningSummary: jest.fn() }));
jest.mock('../lib/ptTerm', () => ({ hasPtTermSql: () => 'true' }));

const pool = require('../db/pool');
const { screeningSummary } = require('../lib/screeningGate');
const { journey } = require('../modules/pt-os/client-journey.service');

const ORG = '11111111-1111-1111-1111-111111111111';
const CLIENT = 'client-1';

function row(over = {}) {
  return {
    id: CLIENT,
    status: 'active',
    welcome_tour_completed_at: '2026-01-01',
    has_pt_term: true,
    ended: false,
    interview_status: 'completed',
    has_assessment: true,
    has_goal: true,
    has_active_plan: true,
    ...over,
  };
}

const step = (j, key) => j.steps.find((s) => s.key === key);

beforeEach(() => {
  pool.query.mockReset();
  screeningSummary.mockReset();
  screeningSummary.mockResolvedValue({
    consent: { status: 'completed' },
    parq: { status: 'complete', complete: true },
    block: null,
  });
});

describe('program_design follows the same eligibility as assign', () => {
  it('is done only for a client who can actually train', async () => {
    pool.query.mockResolvedValueOnce({ rows: [row()] });
    const j = await journey(ORG, CLIENT);
    expect(step(j, 'program_design').state).toBe('done');
    expect(j.next).toBeNull();
  });

  it('is not done for a client whose term has ended, even with a live plan', async () => {
    pool.query.mockResolvedValueOnce({ rows: [row({ status: 'expired', ended: true })] });
    const j = await journey(ORG, CLIENT);
    expect(step(j, 'program_design')).toMatchObject({
      state: 'blocked',
      detail: "Renew the client's PT before assigning a plan.",
    });
    expect(j.next).toBe('enrolment');
  });

  it('is not done for a frozen client, and says what to do', async () => {
    pool.query.mockResolvedValueOnce({ rows: [row({ status: 'frozen' })] });
    const j = await journey(ORG, CLIENT);
    expect(step(j, 'program_design')).toMatchObject({
      state: 'blocked',
      detail: 'This client\'s membership is frozen. Unfreeze it before assigning a plan.',
    });
  });
});
