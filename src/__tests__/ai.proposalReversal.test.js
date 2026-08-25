'use strict';

// src/__tests__/ai.proposalReversal.test.js

jest.mock('../lib/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

// Simple pool mock — all queries go through one mock
const mockPoolQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockClientRelease = jest.fn();
const mockClient = {
  query: (...args) => mockClientQuery(...args),
  release: () => mockClientRelease(),
};
jest.mock('../db/pool', () => ({
  query: (...args) => mockPoolQuery(...args),
  connect: jest.fn().mockResolvedValue(mockClient),
}));

const pool = require('../db/pool');
const {
  revalidateForReversal,
  reverseProposal,
} = require('../lib/ai/proposalReversal');

// ── Helpers ────────────────────────────────────────────────────────────────

function makeExecutedProposal(overrides = {}) {
  return {
    id: 'prop-1',
    organization_id: 'org-1',
    client_id: 'client-1',
    proposal_type: 'progress_load',
    summary: 'Increase bench press',
    reason: 'All reps completed',
    evidence: [],
    current_state: { exercise: 'Bench Press', exercise_id: 'ex-1', prescription: { target_weight: 80 } },
    status: 'executed',
    executed_at: new Date().toISOString(),
    execution_history: {
      exercise: 'Bench Press',
      field: 'target_weight',
      from: 80,
      to: 82.5,
    },
    created_at: new Date(Date.now() - 3600000),
    expires_at: new Date(Date.now() + 7 * 86400000),
    ...overrides,
  };
}

function setupValidReversal(proposal) {
  mockPoolQuery
    .mockResolvedValueOnce({ rows: [proposal] }) // load proposal
    .mockResolvedValueOnce({ rows: [{ id: proposal.client_id, deleted_at: null }] }) // client
    .mockResolvedValueOnce({ rows: [{ id: proposal.client_id }] }) // tenant
    .mockResolvedValueOnce({ // exercise find
      rows: [{ id: 'we-1', target_weight: 82.5, sets: 3, reps: 10, exercise_id: 'ex-1', exercise_name: 'Bench Press' }],
    });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('revalidateForReversal', () => {
  beforeEach(() => mockPoolQuery.mockReset());

  it('returns invalid for non-existent proposal', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const result = await revalidateForReversal('prop-1', 'org-1');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('Proposal not found');
  });

  it('returns ALREADY_REVERSED for reversed proposal', async () => {
    const p = makeExecutedProposal({ status: 'reversed' });
    mockPoolQuery.mockResolvedValueOnce({ rows: [p] });
    const result = await revalidateForReversal('prop-1', 'org-1');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('ALREADY_REVERSED');
  });

  it('returns invalid for non-executed proposal', async () => {
    const p = makeExecutedProposal({ status: 'draft' });
    mockPoolQuery.mockResolvedValueOnce({ rows: [p] });
    const result = await revalidateForReversal('prop-1', 'org-1');
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/draft, not executed/);
  });

  it('returns invalid when execution_history is missing', async () => {
    const p = makeExecutedProposal({ execution_history: null });
    mockPoolQuery.mockResolvedValueOnce({ rows: [p] });
    const result = await revalidateForReversal('prop-1', 'org-1');
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/No execution history/);
  });

  it('returns invalid when client is deleted', async () => {
    const p = makeExecutedProposal();
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [p] })
      .mockResolvedValueOnce({ rows: [{ id: 'client-1', deleted_at: new Date() }] });
    const result = await revalidateForReversal('prop-1', 'org-1');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('Client no longer exists');
  });

  it('returns EXECUTION_STATE_CHANGED when current value differs', async () => {
    const p = makeExecutedProposal();
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [p] })
      .mockResolvedValueOnce({ rows: [{ id: 'client-1', deleted_at: null }] })
      .mockResolvedValueOnce({ rows: [{ id: 'client-1' }] })
      .mockResolvedValueOnce({
        rows: [{ id: 'we-1', target_weight: 90, sets: 3, reps: 10, exercise_id: 'ex-1', exercise_name: 'Bench Press' }],
      });
    const result = await revalidateForReversal('prop-1', 'org-1');
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/EXECUTION_STATE_CHANGED/);
  });

  it('returns valid for a clean executed proposal', async () => {
    const p = makeExecutedProposal();
    setupValidReversal(p);
    const result = await revalidateForReversal('prop-1', 'org-1');
    expect(result.valid).toBe(true);
    expect(result.exercise).toBeDefined();
    expect(result.history).toBeDefined();
  });
});

describe('reverseProposal', () => {
  beforeEach(() => {
    mockPoolQuery.mockReset();
    mockClientQuery.mockReset();
    mockClientRelease.mockReset();
  });

  it('returns already_reversed for double reversal', async () => {
    const p = makeExecutedProposal({ status: 'reversed' });
    mockPoolQuery.mockResolvedValueOnce({ rows: [p] });
    const result = await reverseProposal({ proposalId: 'prop-1', organizationId: 'org-1', actorId: 'trainer-1' });
    expect(result.success).toBe(true);
    expect(result.reversal.status).toBe('already_reversed');
  });

  it('reverses a single-field change (target_weight)', async () => {
    const p = makeExecutedProposal();
    setupValidReversal(p);

    // Transaction client queries: BEGIN, claim, UPDATE, UPDATE, COMMIT
    mockClientQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [p] }) // claim
      .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE exercise
      .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE proposal
      .mockResolvedValueOnce({}); // COMMIT
    // Audit (pool.query after commit)
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 1 });

    const result = await reverseProposal({ proposalId: 'prop-1', organizationId: 'org-1', actorId: 'trainer-1' });
    expect(result.success).toBe(true);
    expect(result.reversal.status).toBe('reversed');
    expect(result.reversal.restored.field).toBe('target_weight');
    expect(result.reversal.restored.restored_from).toBe(82.5);
    expect(result.reversal.restored.restored_to).toBe(80);
  });

  it('reverses a multi-field change', async () => {
    const p = makeExecutedProposal({
      execution_history: {
        exercise: 'Bench Press',
        fields: {
          sets: { from: 3, to: 4 },
          reps: { from: 10, to: 8 },
        },
      },
    });
    // Override the exercise find to return values matching the 'after' state
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [p] }) // load proposal
      .mockResolvedValueOnce({ rows: [{ id: p.client_id, deleted_at: null }] }) // client
      .mockResolvedValueOnce({ rows: [{ id: p.client_id }] }) // tenant
      .mockResolvedValueOnce({ // exercise find — must match 'after' state
        rows: [{ id: 'we-1', target_weight: 80, sets: 4, reps: 8, exercise_id: 'ex-1', exercise_name: 'Bench Press' }],
      });

    // Transaction client queries: BEGIN, claim, UPDATE, UPDATE, COMMIT
    mockClientQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [p] }) // claim
      .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE exercise
      .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE proposal
      .mockResolvedValueOnce({}); // COMMIT
    // Audit (pool.query after commit)
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 1 });

    const result = await reverseProposal({ proposalId: 'prop-1', organizationId: 'org-1', actorId: 'trainer-1' });
    expect(result.success).toBe(true);
    expect(result.reversal.restored.fields.sets.to).toBe(3);
    expect(result.reversal.restored.fields.reps.to).toBe(10);
  });

  it('rolls back on mutation failure', async () => {
    const p = makeExecutedProposal();
    setupValidReversal(p);

    mockClientQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [p] }) // claim
      .mockRejectedValueOnce(new Error('DB error')); // UPDATE fails

    const result = await reverseProposal({ proposalId: 'prop-1', organizationId: 'org-1', actorId: 'trainer-1' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Reversal failed/);
  });

  it('returns error for proposal without execution_history', async () => {
    const p = makeExecutedProposal({ execution_history: null });
    mockPoolQuery.mockResolvedValueOnce({ rows: [p] });
    const result = await reverseProposal({ proposalId: 'prop-1', organizationId: 'org-1', actorId: 'trainer-1' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No execution history/);
  });
});

describe('exports', () => {
  it('all expected functions are exported', () => {
    expect(typeof revalidateForReversal).toBe('function');
    expect(typeof reverseProposal).toBe('function');
  });
});
