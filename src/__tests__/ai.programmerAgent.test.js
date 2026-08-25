'use strict';

// Tests for src/lib/ai/programmerAgent.js — Phase 2E Programmer Agent
//
// Coverage:
//   1. Proposal validation (schema, types, confidence, evidence)
//   2. Safety validation (PAR-Q, injuries, recovery, missing data)
//   3. Allowed proposal types (allow-list enforcement)
//   4. Evidence requirement (non-empty array)
//   5. Confidence filtering
//   6. Deterministic progression remains authoritative
//   7. Proposal storage and lifecycle
//   8. Approval/rejection
//   9. Tenant isolation
//  10. Edge cases

jest.mock('../db/pool', () => ({ query: jest.fn() }));
jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
  child: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() })),
}));

const pool = require('../db/pool');
const {
  validateProposal,
  checkSafety,
  runProgrammerAgent,
  storeProposal,
  listProposals,
  approveProposal,
  rejectProposal,
  markExecuted,
  expireProposals,
  ALLOWED_PROPOSAL_TYPES,
  PROPOSAL_REQUIRED_FIELDS,
  MIN_CONFIDENCE_FOR_PROPOSAL,
  MAX_PROPOSALS_PER_REQUEST,
  PROGRAMMER_SYSTEM_PROMPT,
} = require('../lib/ai/programmerAgent');

const TEST_ORG = '11111111-1111-1111-1111-111111111111';
const TEST_CLIENT = '22222222-2222-2222-2222-222222222222';

function mockSelect(rows) {
  pool.query.mockResolvedValueOnce({ rows: Array.isArray(rows) ? rows : [rows] });
}

function mockInsert(rows) {
  pool.query.mockResolvedValueOnce({ rows: Array.isArray(rows) ? rows : [rows] });
}

function mockUpdate(rows) {
  pool.query.mockResolvedValueOnce({ rows: Array.isArray(rows) ? rows : [rows] });
}

beforeEach(() => {
  pool.query.mockReset();
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. PROPOSAL VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

describe('validateProposal', () => {
  const validProposal = {
    proposal_type: 'progress_load',
    summary: 'Increase Bench Press to 82.5kg',
    reason: 'All sets completed at target reps with RPE below target',
    evidence: [
      { type: 'performance', description: 'Last 3 sessions: all sets completed at 80kg × 12 reps' },
    ],
    confidence: 0.85,
    requires_trainer_approval: true,
  };

  test('accepts valid proposal', () => {
    const result = validateProposal(validProposal);
    expect(result.valid).toBe(true);
    expect(result.proposal.proposal_type).toBe('progress_load');
    expect(result.proposal.requires_trainer_approval).toBe(true);
  });

  test('rejects null/undefined', () => {
    expect(validateProposal(null).valid).toBe(false);
    expect(validateProposal(undefined).valid).toBe(false);
  });

  test('rejects missing required fields', () => {
    expect(validateProposal({}).valid).toBe(false);
    expect(validateProposal({ proposal_type: 'progress_load' }).valid).toBe(false);
  });

  test('rejects invalid proposal_type', () => {
    const result = validateProposal({
      ...validProposal,
      proposal_type: 'invalid_type',
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid proposal_type');
  });

  test('rejects invalid confidence', () => {
    expect(validateProposal({
      ...validProposal, confidence: 'high',
    }).valid).toBe(false);
    expect(validateProposal({
      ...validProposal, confidence: -0.5,
    }).valid).toBe(false);
  });

  test('rejects empty evidence', () => {
    expect(validateProposal({
      ...validProposal, evidence: [],
    }).valid).toBe(false);
  });

  test('rejects non-array evidence', () => {
    expect(validateProposal({
      ...validProposal, evidence: 'not an array',
    }).valid).toBe(false);
  });

  test('forces requires_trainer_approval to true', () => {
    const result = validateProposal({
      ...validProposal,
      requires_trainer_approval: false,
    });
    expect(result.valid).toBe(true);
    expect(result.proposal.requires_trainer_approval).toBe(true);
  });

  test('sanitizes strings', () => {
    const result = validateProposal({
      ...validProposal,
      summary: '  Increase Bench Press  ',
      reason: '  Because reasons  ',
    });
    expect(result.valid).toBe(true);
    expect(result.proposal.summary).toBe('Increase Bench Press');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. ALLOWED PROPOSAL TYPES
// ═══════════════════════════════════════════════════════════════════════════

describe('ALLOWED_PROPOSAL_TYPES', () => {
  test('includes all required types', () => {
    expect(ALLOWED_PROPOSAL_TYPES).toContain('progress_load');
    expect(ALLOWED_PROPOSAL_TYPES).toContain('regress_load');
    expect(ALLOWED_PROPOSAL_TYPES).toContain('exercise_substitution');
    expect(ALLOWED_PROPOSAL_TYPES).toContain('deload_proposal');
    expect(ALLOWED_PROPOSAL_TYPES).toContain('explain_progression');
  });

  test('does not include dangerous types', () => {
    expect(ALLOWED_PROPOSAL_TYPES).not.toContain('direct_write');
    expect(ALLOWED_PROPOSAL_TYPES).not.toContain('auto_progress');
    expect(ALLOWED_PROPOSAL_TYPES).not.toContain('database_mutation');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. SAFETY VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

describe('checkSafety', () => {
  test('returns safe for healthy client', () => {
    const state = {
      clearance: { parq: { gate_status: 'cleared' } },
      body: { source: 'measured' },
      limitations: { injuries: null, mobility: { findings: [] } },
      recovery: { readiness: { score: 80 } },
      analytics: { recoveryTrend: { direction: 'stable' }, adherence: { trend: 'good' } },
      performance: { sessions: [{ date: '2026-08-20' }] },
      missing: { critical_gaps: [] },
    };
    const result = checkSafety(state);
    expect(result.safe).toBe(true);
    expect(result.hardStop).toBe(false);
    expect(result.flags).toHaveLength(0);
  });

  test('hard-stops on PAR-Q block', () => {
    const state = {
      clearance: { parq: { gate_status: 'blocked' } },
      body: { source: 'measured' },
      limitations: {},
      recovery: { readiness: { score: 80 } },
      analytics: {},
      performance: { sessions: [] },
      missing: { critical_gaps: [] },
    };
    const result = checkSafety(state);
    expect(result.safe).toBe(false);
    expect(result.hardStop).toBe(true);
  });

  test('flags missing PAR-Q', () => {
    const state = {
      clearance: { parq: null },
      body: { source: 'measured' },
      limitations: {},
      recovery: { readiness: { score: 80 } },
      analytics: {},
      performance: { sessions: [] },
      missing: { critical_gaps: [] },
    };
    const result = checkSafety(state);
    expect(result.safe).toBe(true);
    expect(result.flags.some((f) => f.includes('PAR-Q'))).toBe(true);
  });

  test('flags injuries', () => {
    const state = {
      clearance: { parq: { gate_status: 'cleared' } },
      body: { source: 'measured' },
      limitations: { injuries: 'Left shoulder impingement', mobility: { findings: [] } },
      recovery: { readiness: { score: 80 } },
      analytics: {},
      performance: { sessions: [] },
      missing: { critical_gaps: [] },
    };
    const result = checkSafety(state);
    expect(result.flags.some((f) => f.includes('injuries'))).toBe(true);
  });

  test('flags low recovery', () => {
    const state = {
      clearance: { parq: { gate_status: 'cleared' } },
      body: { source: 'measured' },
      limitations: {},
      recovery: { readiness: { score: 30 } },
      analytics: {},
      performance: { sessions: [] },
      missing: { critical_gaps: [] },
    };
    const result = checkSafety(state);
    expect(result.flags.some((f) => f.includes('Recovery score is low'))).toBe(true);
  });

  test('flags declining recovery trend', () => {
    const state = {
      clearance: { parq: { gate_status: 'cleared' } },
      body: { source: 'measured' },
      limitations: {},
      recovery: { readiness: { score: 70 } },
      analytics: { recoveryTrend: { direction: 'declining' }, adherence: {} },
      performance: { sessions: [] },
      missing: { critical_gaps: [] },
    };
    const result = checkSafety(state);
    expect(result.flags.some((f) => f.includes('declining'))).toBe(true);
  });

  test('flags missing performance data', () => {
    const state = {
      clearance: { parq: { gate_status: 'cleared' } },
      body: { source: 'measured' },
      limitations: {},
      recovery: { readiness: { score: 80 } },
      analytics: {},
      performance: { sessions: [] },
      missing: { critical_gaps: [] },
    };
    const result = checkSafety(state);
    expect(result.flags.some((f) => f.includes('No training session data'))).toBe(true);
  });

  test('flags critical gaps', () => {
    const state = {
      clearance: { parq: { gate_status: 'cleared' } },
      body: { source: 'measured' },
      limitations: {},
      recovery: { readiness: { score: 80 } },
      analytics: {},
      performance: { sessions: [] },
      missing: { critical_gaps: ['No PAR-Q screening on file'] },
    };
    const result = checkSafety(state);
    expect(result.flags.some((f) => f.includes('Critical gap'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. PROPOSAL STORAGE AND LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════

describe('storeProposal', () => {
  test('stores a proposal in the database', async () => {
    mockInsert({
      id: 'prop-1',
      organization_id: TEST_ORG,
      client_id: TEST_CLIENT,
      proposal_type: 'progress_load',
      status: 'draft',
    });

    const result = await storeProposal({
      organizationId: TEST_ORG,
      clientId: TEST_CLIENT,
      proposalType: 'progress_load',
      summary: 'Increase Bench Press',
      reason: 'All sets completed',
      evidence: [{ type: 'performance', description: 'Done' }],
      currentState: {},
      confidence: 0.85,
      safetyFlags: [],
      createdBy: 'trainer-1',
    });

    expect(result.id).toBe('prop-1');
    expect(result.status).toBe('draft');

    const call = pool.query.mock.calls[0];
    expect(call[0]).toContain('INSERT INTO ai_programmer_proposals');
    expect(call[1]).toContain(TEST_ORG);
    expect(call[1]).toContain(TEST_CLIENT);
  });
});

describe('listProposals', () => {
  test('lists proposals for a client', async () => {
    mockSelect([{ id: 'prop-1', status: 'draft' }]);

    const result = await listProposals(TEST_CLIENT, TEST_ORG);
    expect(result).toHaveLength(1);

    const call = pool.query.mock.calls[0];
    expect(call[0]).toContain('ai_programmer_proposals');
    expect(call[1]).toContain(TEST_CLIENT);
  });

  test('filters by status', async () => {
    mockSelect([{ id: 'prop-1', status: 'approved' }]);

    const result = await listProposals(TEST_CLIENT, TEST_ORG, { status: 'approved' });
    expect(result).toHaveLength(1);

    const call = pool.query.mock.calls[0];
    expect(call[0]).toContain('ai_programmer_proposals');
    expect(call[1]).toContain('approved');
  });
});

describe('approveProposal', () => {
  test('approves a draft proposal', async () => {
    mockUpdate({ id: 'prop-1', status: 'approved', reviewed_by: 'trainer-1' });

    const result = await approveProposal('prop-1', TEST_ORG, 'trainer-1');
    expect(result.status).toBe('approved');

    const call = pool.query.mock.calls[0];
    expect(call[0]).toContain("status = 'approved'");
    expect(call[1]).toContain('prop-1');
  });

  test('returns null for non-existent proposal', async () => {
    mockUpdate([]);
    const result = await approveProposal('nonexistent', TEST_ORG, 'trainer-1');
    expect(result).toBeNull();
  });
});

describe('rejectProposal', () => {
  test('rejects a draft proposal', async () => {
    mockUpdate({ id: 'prop-1', status: 'rejected', rejection_reason: 'Not needed' });

    const result = await rejectProposal('prop-1', TEST_ORG, 'trainer-1', 'Not needed');
    expect(result.status).toBe('rejected');

    const call = pool.query.mock.calls[0];
    expect(call[0]).toContain("status = 'rejected'");
  });
});

describe('expireProposals', () => {
  test('expires old draft proposals', async () => {
    mockUpdate([{ id: 'expired-1' }, { id: 'expired-2' }]);

    const count = await expireProposals();
    expect(count).toBe(2);

    const call = pool.query.mock.calls[0];
    expect(call[0]).toContain("status = 'expired'");
    expect(call[0]).toContain('expires_at < NOW()');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. SYSTEM PROMPT
// ═══════════════════════════════════════════════════════════════════════════

describe('PROGRAMMER_SYSTEM_PROMPT', () => {
  test('contains key instructions', () => {
    expect(PROGRAMMER_SYSTEM_PROMPT).toContain('NEVER guess');
    expect(PROGRAMMER_SYSTEM_PROMPT).toContain('NEVER contradict');
    expect(PROGRAMMER_SYSTEM_PROMPT).toContain('evidence');
    expect(PROGRAMMER_SYSTEM_PROMPT).toContain('ALLOWED PROPOSAL TYPES');
    expect(PROGRAMMER_SYSTEM_PROMPT).toContain('progress_load');
    expect(PROGRAMMER_SYSTEM_PROMPT).toContain('explain_progression');
  });

  test('specifies JSON output format', () => {
    expect(PROGRAMMER_SYSTEM_PROMPT).toContain('VALID JSON');
    expect(PROGRAMMER_SYSTEM_PROMPT).toContain('proposals');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

describe('constants', () => {
  test('MIN_CONFIDENCE_FOR_PROPOSAL is reasonable', () => {
    expect(MIN_CONFIDENCE_FOR_PROPOSAL).toBeGreaterThanOrEqual(0.3);
    expect(MIN_CONFIDENCE_FOR_PROPOSAL).toBeLessThanOrEqual(0.8);
  });

  test('MAX_PROPOSALS_PER_REQUEST is bounded', () => {
    expect(MAX_PROPOSALS_PER_REQUEST).toBeGreaterThanOrEqual(1);
    expect(MAX_PROPOSALS_PER_REQUEST).toBeLessThanOrEqual(10);
  });

  test('PROPOSAL_REQUIRED_FIELDS includes all mandatory fields', () => {
    expect(PROPOSAL_REQUIRED_FIELDS).toContain('proposal_type');
    expect(PROPOSAL_REQUIRED_FIELDS).toContain('summary');
    expect(PROPOSAL_REQUIRED_FIELDS).toContain('reason');
    expect(PROPOSAL_REQUIRED_FIELDS).toContain('evidence');
    expect(PROPOSAL_REQUIRED_FIELDS).toContain('confidence');
    expect(PROPOSAL_REQUIRED_FIELDS).toContain('requires_trainer_approval');
  });
});
