'use strict';

// src/__tests__/ai.proposalExecutor.test.js
//
// Phase 2I — Controlled Training Execution tests.

jest.mock('../lib/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../db/pool', () => {
  const mockBegin = jest.fn();
  const mockCommit = jest.fn();
  const mockRollback = jest.fn();
  const mockRelease = jest.fn();
  const clientQuery = jest.fn();
  const mockClient = { query: clientQuery, release: () => mockRelease() };

  global.__mockPool = {
    query: jest.fn(),
    begin: mockBegin,
    commit: mockCommit,
    rollback: mockRollback,
    release: mockRelease,
    client: mockClient,
  };

  return {
    query: (...args) => global.__mockPool.query(...args),
    connect: () => {
      clientQuery.mockReset();
      mockBegin.mockReset();
      mockCommit.mockReset();
      mockRollback.mockReset();
      mockRelease.mockReset();
      clientQuery.mockImplementation(async (sql) => {
        if (sql === 'BEGIN') { mockBegin(); return {}; }
        if (sql === 'COMMIT') { mockCommit(); return {}; }
        if (sql === 'ROLLBACK') { mockRollback(); return {}; }
        return global.__mockPool.query(sql);
      });
      return mockClient;
    },
  };
});

const {
  revalidateForExecution,
  executeProposal,
  computeFingerprint,
  EXECUTABLE_PROPOSAL_TYPES,
} = require('../lib/ai/proposalExecutor');

const pool = require('../db/pool');

// ── Helpers ────────────────────────────────────────────────────────────────

function makeProposal(overrides = {}) {
  return {
    id: 'prop-1',
    organization_id: 'org-1',
    client_id: 'client-1',
    proposal_type: 'progress_load',
    summary: 'Increase bench press load',
    reason: 'All reps completed consistently',
    evidence: [{ type: 'performance', description: '8/8 reps at 80kg', source: 'sessions', value: '80kg' }],
    current_state: { exercise: 'Bench Press', exercise_id: 'ex-1', prescription: { target_weight: 80, target_reps_min: 10 } },
    deterministic_recommendation: { target_weight: 82.5 },
    ai_recommendation: null,
    confidence: 0.85,
    safety_flags: [],
    status: 'approved',
    created_at: new Date(Date.now() - 3600000),
    expires_at: new Date(Date.now() + 7 * 86400000),
    ...overrides,
  };
}

function setupValidRevalidation(proposal) {
  global.__mockPool.query
    .mockResolvedValueOnce({ rows: [proposal] }) // load proposal
    .mockResolvedValueOnce({ rows: [{ id: proposal.client_id, deleted_at: null }] }) // client
    .mockResolvedValueOnce({ rows: [{ id: proposal.client_id }] }) // tenant
    .mockResolvedValueOnce({ rows: [{ workout_gate_status: 'cleared' }] }) // PAR-Q
    .mockResolvedValueOnce({ rows: [{ count: 0 }] }) // sessions
    .mockResolvedValueOnce({ // exercise find for fingerprint
      rows: [{ id: 'we-1', target_weight: 80, sets: 3, reps: 10, exercise_id: 'ex-1', exercise_name: 'Bench Press' }],
    });
}

function setupValidExerciseFind() {
  global.__mockPool.query.mockResolvedValueOnce({
    rows: [{ id: 'we-1', target_weight: 80, sets: 3, reps: 10, exercise_id: 'ex-1', exercise_name: 'Bench Press' }],
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('EXECUTABLE_PROPOSAL_TYPES', () => {
  it('contains all executable types', () => {
    expect(EXECUTABLE_PROPOSAL_TYPES).toContain('progress_load');
    expect(EXECUTABLE_PROPOSAL_TYPES).toContain('regress_load');
    expect(EXECUTABLE_PROPOSAL_TYPES).toContain('change_rep_range');
    expect(EXECUTABLE_PROPOSAL_TYPES).toContain('adjust_sets');
    expect(EXECUTABLE_PROPOSAL_TYPES).toContain('exercise_substitution');
    expect(EXECUTABLE_PROPOSAL_TYPES).toContain('volume_adjustment');
    expect(EXECUTABLE_PROPOSAL_TYPES).toContain('intensity_adjustment');
    expect(EXECUTABLE_PROPOSAL_TYPES).toContain('deload_proposal');
    expect(EXECUTABLE_PROPOSAL_TYPES).toContain('recovery_modification');
  });

  it('does NOT include explain_progression', () => {
    expect(EXECUTABLE_PROPOSAL_TYPES).not.toContain('explain_progression');
  });
});

describe('computeFingerprint', () => {
  it('generates a 16-char hex string', () => {
    const fp = computeFingerprint({ exercise: 'Bench Press', prescription: { target_weight: 80 } });
    expect(fp).toMatch(/^[a-f0-9]{16}$/);
  });

  it('produces different fingerprints for different weights', () => {
    const fp1 = computeFingerprint({ exercise: 'Bench Press', prescription: { target_weight: 80 } });
    const fp2 = computeFingerprint({ exercise: 'Bench Press', prescription: { target_weight: 85 } });
    expect(fp1).not.toBe(fp2);
  });
});

describe('revalidateForExecution', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns invalid for non-existent proposal', async () => {
    global.__mockPool.query.mockResolvedValueOnce({ rows: [] });
    const result = await revalidateForExecution('prop-1', 'org-1');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('Proposal not found');
  });

  it('returns ALREADY_EXECUTED for executed proposal', async () => {
    const p = makeProposal({ status: 'executed' });
    global.__mockPool.query.mockResolvedValueOnce({ rows: [p] });
    const result = await revalidateForExecution('prop-1', 'org-1');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('ALREADY_EXECUTED');
  });

  it('returns invalid for expired proposal', async () => {
    const p = makeProposal({ expires_at: new Date(Date.now() - 1000) });
    global.__mockPool.query.mockResolvedValueOnce({ rows: [p] });
    const result = await revalidateForExecution('prop-1', 'org-1');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('Proposal has expired');
  });

  it('returns invalid when client is deleted', async () => {
    const p = makeProposal();
    global.__mockPool.query
      .mockResolvedValueOnce({ rows: [p] })
      .mockResolvedValueOnce({ rows: [{ id: 'client-1', deleted_at: new Date() }] });
    const result = await revalidateForExecution('prop-1', 'org-1');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('Client no longer exists');
  });

  it('returns invalid when PAR-Q blocks', async () => {
    const p = makeProposal();
    global.__mockPool.query
      .mockResolvedValueOnce({ rows: [p] })
      .mockResolvedValueOnce({ rows: [{ id: 'client-1', deleted_at: null }] })
      .mockResolvedValueOnce({ rows: [{ id: 'client-1' }] })
      .mockResolvedValueOnce({ rows: [{ workout_gate_status: 'blocked' }] });
    const result = await revalidateForExecution('prop-1', 'org-1');
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/PAR-Q/);
  });

  it('returns invalid when client has new sessions', async () => {
    const p = makeProposal();
    global.__mockPool.query
      .mockResolvedValueOnce({ rows: [p] })
      .mockResolvedValueOnce({ rows: [{ id: 'client-1', deleted_at: null }] })
      .mockResolvedValueOnce({ rows: [{ id: 'client-1' }] })
      .mockResolvedValueOnce({ rows: [{ workout_gate_status: 'cleared' }] })
      .mockResolvedValueOnce({ rows: [{ count: 3 }] });
    const result = await revalidateForExecution('prop-1', 'org-1');
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/3 new session/);
  });

  it('returns valid for a clean approved proposal', async () => {
    const p = makeProposal();
    setupValidRevalidation(p);
    const result = await revalidateForExecution('prop-1', 'org-1');
    expect(result.valid).toBe(true);
  });
});

describe('executeProposal', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns error for non-executable type', async () => {
    const p = makeProposal({ proposal_type: 'explain_progression' });
    global.__mockPool.query
      .mockResolvedValueOnce({ rows: [p] })
      .mockResolvedValueOnce({ rows: [{ id: 'client-1', deleted_at: null }] })
      .mockResolvedValueOnce({ rows: [{ id: 'client-1' }] })
      .mockResolvedValueOnce({ rows: [{ workout_gate_status: 'cleared' }] })
      .mockResolvedValueOnce({ rows: [{ count: 0 }] });

    const result = await executeProposal({ proposalId: 'prop-1', organizationId: 'org-1', actorId: 'trainer-1' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not executable/);
  });

  it('returns already_executed for double execution', async () => {
    const p = makeProposal({ status: 'executed' });
    global.__mockPool.query.mockResolvedValueOnce({ rows: [p] });

    const result = await executeProposal({ proposalId: 'prop-1', organizationId: 'org-1', actorId: 'trainer-1' });
    expect(result.success).toBe(true);
    expect(result.execution.status).toBe('already_executed');
  });

  it('executes a progress_load proposal', async () => {
    const p = makeProposal();
    // revalidation: 5 queries
    setupValidRevalidation(p);
    // After revalidation succeeds, executeProposal runs the transaction.
    // The transaction client queries route through pool.query for non-BEGIN/COMMIT/ROLLBACK.
    // So we need mocks for: claim, exercise_find, update_exercise, update_proposal, audit
    global.__mockPool.query
      .mockResolvedValueOnce({ rows: [p] }) // claim (status → executing)
      .mockResolvedValueOnce({ // exercise find
        rows: [{ id: 'we-1', target_weight: 80, sets: 3, reps: 10, exercise_id: 'ex-1', exercise_name: 'Bench Press' }],
      })
      .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE exercise
      .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE proposal → executed
      .mockResolvedValueOnce({ rowCount: 1 }); // audit INSERT

    const result = await executeProposal({ proposalId: 'prop-1', organizationId: 'org-1', actorId: 'trainer-1' });
    expect(result.success).toBe(true);
    expect(result.execution.status).toBe('executed');
    expect(result.execution.changes.exercise).toBe('Bench Press');
    expect(result.execution.changes.field).toBe('target_weight');
  });

  it('rolls back when exercise not found', async () => {
    const p = makeProposal();
    setupValidRevalidation(p);
    global.__mockPool.query
      .mockResolvedValueOnce({ rows: [p] }) // claim
      .mockResolvedValueOnce({ rows: [] }); // exercise NOT found

    const result = await executeProposal({ proposalId: 'prop-1', organizationId: 'org-1', actorId: 'trainer-1' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/);
  });
});

describe('exports', () => {
  it('all expected functions are exported', () => {
    expect(typeof revalidateForExecution).toBe('function');
    expect(typeof executeProposal).toBe('function');
    expect(typeof computeFingerprint).toBe('function');
    expect(Array.isArray(EXECUTABLE_PROPOSAL_TYPES)).toBe(true);
  });
});
