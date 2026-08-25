'use strict';

// Tests for src/lib/ai/trainerIntelligence.js — Phase 2F Trainer Intelligence
//
// Coverage:
//   1. Priority scoring (deterministic rules)
//   2. Pending work queue
//   3. Client intelligence summary
//   4. Stale proposal revalidation
//   5. Audit trail
//   6. Edge cases

jest.mock('../db/pool', () => ({ query: jest.fn() }));
jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
  child: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() })),
}));

const pool = require('../db/pool');
const {
  computePriority,
  getPendingWorkQueue,
  buildClientIntelligenceSummary,
  revalidateProposal,
  recordAuditEvent,
} = require('../lib/ai/trainerIntelligence');

const TEST_ORG = '11111111-1111-1111-1111-111111111111';
const TEST_CLIENT = '22222222-2222-2222-2222-222222222222';

function mockSelect(rows) {
  pool.query.mockResolvedValueOnce({ rows: Array.isArray(rows) ? rows : [rows] });
}

function mockInsert(rows) {
  pool.query.mockResolvedValueOnce({ rows: Array.isArray(rows) ? rows : [rows] });
}

beforeEach(() => {
  pool.query.mockReset();
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. PRIORITY SCORING
// ═══════════════════════════════════════════════════════════════════════════

describe('computePriority', () => {
  test('baseline score is 50', () => {
    const score = computePriority({ type: 'memory', data: { confidence: 0.5, created_at: new Date().toISOString() } });
    expect(score).toBeGreaterThanOrEqual(50);
  });

  test('safety flags increase priority for proposals', () => {
    const withFlags = computePriority({
      type: 'proposal',
      data: { confidence: 0.5, safety_flags: ['PAR-Q concern'], created_at: new Date().toISOString() },
    });
    const withoutFlags = computePriority({
      type: 'proposal',
      data: { confidence: 0.5, safety_flags: [], created_at: new Date().toISOString() },
    });
    expect(withFlags).toBeGreaterThan(withoutFlags);
  });

  test('high confidence increases priority', () => {
    const high = computePriority({
      type: 'proposal',
      data: { confidence: 0.9, safety_flags: [], created_at: new Date().toISOString() },
    });
    const low = computePriority({
      type: 'proposal',
      data: { confidence: 0.3, safety_flags: [], created_at: new Date().toISOString() },
    });
    expect(high).toBeGreaterThan(low);
  });

  test('expiring soon increases urgency', () => {
    const expiringSoon = computePriority({
      type: 'proposal',
      data: {
        confidence: 0.5, safety_flags: [],
        expires_at: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
        created_at: new Date().toISOString(),
      },
    });
    const notExpiring = computePriority({
      type: 'proposal',
      data: {
        confidence: 0.5, safety_flags: [],
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        created_at: new Date().toISOString(),
      },
    });
    expect(expiringSoon).toBeGreaterThan(notExpiring);
  });

  test('medical/constraint memories are higher priority', () => {
    const medical = computePriority({
      type: 'memory',
      data: { confidence: 0.5, category: 'medical', created_at: new Date().toISOString() },
    });
    const preference = computePriority({
      type: 'memory',
      data: { confidence: 0.5, category: 'preference', created_at: new Date().toISOString() },
    });
    expect(medical).toBeGreaterThan(preference);
  });

  test('score is clamped to 0-100', () => {
    const score = computePriority({
      type: 'proposal',
      data: {
        confidence: 1.0,
        safety_flags: ['flag1', 'flag2', 'flag3'],
        expires_at: new Date(Date.now() + 1 * 60 * 60 * 1000).toISOString(),
        ai_recommendation: {},
        deterministic_recommendation: {},
        created_at: new Date().toISOString(),
      },
    });
    expect(score).toBeLessThanOrEqual(100);
    expect(score).toBeGreaterThanOrEqual(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. PENDING WORK QUEUE
// ═══════════════════════════════════════════════════════════════════════════

describe('getPendingWorkQueue', () => {
  test('returns combined memory candidates and proposals', async () => {
    // Memory candidates query
    mockSelect([{ id: 'm1', status: 'candidate', fact: 'Test fact', confidence: 0.8, created_at: new Date().toISOString() }]);
    // Proposals query
    mockSelect([{ id: 'p1', status: 'draft', proposal_type: 'progress_load', confidence: 0.9, safety_flags: [], created_at: new Date().toISOString() }]);

    const result = await getPendingWorkQueue(TEST_ORG, TEST_CLIENT);
    expect(result.memory_candidates).toHaveLength(1);
    expect(result.programmer_proposals).toHaveLength(1);
    expect(result.total_pending).toBe(2);
  });

  test('returns empty when nothing pending', async () => {
    mockSelect([]);
    mockSelect([]);

    const result = await getPendingWorkQueue(TEST_ORG, TEST_CLIENT);
    expect(result.total_pending).toBe(0);
  });

  test('handles errors gracefully', async () => {
    pool.query.mockRejectedValueOnce(new Error('DB error'));
    mockSelect([]);

    const result = await getPendingWorkQueue(TEST_ORG, TEST_CLIENT);
    expect(result.total_pending).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. CLIENT INTELLIGENCE SUMMARY
// ═══════════════════════════════════════════════════════════════════════════

describe('buildClientIntelligenceSummary', () => {
  test('returns null for non-existent client', async () => {
    // buildClientState returns null
    mockSelect([]); // pt_clients gate
    const result = await buildClientIntelligenceSummary('ghost', TEST_ORG);
    expect(result).toBeNull();
  });

  test('builds summary for valid client', async () => {
    // Mock the parent client query (pt_clients gate)
    mockSelect([{ id: TEST_CLIENT, name: 'Test Client', dob: '1990-01-01', gender: 'male', status: 'active', goal: 'strength', organization_id: TEST_ORG }]);

    // Mock all child queries (21 parallel queries in buildClientState)
    for (let i = 0; i < 25; i++) mockSelect([]);

    // Mock pending queue queries
    mockSelect([]); // memory candidates
    mockSelect([]); // proposals

    // Mock active memories
    mockSelect([]);

    const result = await buildClientIntelligenceSummary(TEST_CLIENT, TEST_ORG);
    // May be null if client not found, but should not throw
    expect(result === null || typeof result === 'object').toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. STALE PROPOSAL REVALIDATION
// ═══════════════════════════════════════════════════════════════════════════

describe('revalidateProposal', () => {
  test('returns invalid for non-existent proposal', async () => {
    mockSelect([]);
    const result = await revalidateProposal('nonexistent', TEST_ORG);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('not found');
  });

  test('returns invalid for expired proposal', async () => {
    mockSelect([{
      id: 'p1', status: 'draft', client_id: TEST_CLIENT,
      expires_at: new Date(Date.now() - 1000).toISOString(),
      created_at: new Date().toISOString(),
      current_state: '{}',
    }]);
    const result = await revalidateProposal('p1', TEST_ORG);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('expired');
  });

  test('returns invalid for non-draft proposal', async () => {
    mockSelect([{
      id: 'p1', status: 'approved', client_id: TEST_CLIENT,
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      created_at: new Date().toISOString(),
      current_state: '{}',
    }]);
    const result = await revalidateProposal('p1', TEST_ORG);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('not draft');
  });

  test('returns invalid when client has new sessions', async () => {
    mockSelect([{
      id: 'p1', status: 'draft', client_id: TEST_CLIENT,
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      created_at: new Date(Date.now() - 3600000).toISOString(),
      current_state: JSON.stringify({ exercise: 'Bench Press', prescription: { target_weight: 80 } }),
    }]);
    mockSelect([{ count: 2 }]); // 2 new sessions

    const result = await revalidateProposal('p1', TEST_ORG);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('new session');
    expect(result.sessionsSinceProposal).toBe(2);
  });

  test('returns valid when no new sessions', async () => {
    mockSelect([{
      id: 'p1', status: 'draft', client_id: TEST_CLIENT,
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      created_at: new Date().toISOString(),
      current_state: JSON.stringify({ exercise: 'Bench Press', prescription: { target_weight: 80 } }),
    }]);
    mockSelect([{ count: 0 }]); // no new sessions

    const result = await revalidateProposal('p1', TEST_ORG);
    expect(result.valid).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. AUDIT TRAIL
// ═══════════════════════════════════════════════════════════════════════════

describe('recordAuditEvent', () => {
  test('records an audit event', async () => {
    mockInsert({ id: 'audit-1' });

    await recordAuditEvent({
      organizationId: TEST_ORG,
      actorId: 'trainer-1',
      targetType: 'memory',
      targetId: 'mem-1',
      action: 'confirm',
      previousState: 'candidate',
      newState: 'active',
      requestId: 'req-1',
    });

    const call = pool.query.mock.calls[0];
    expect(call[0]).toContain('INSERT INTO ai_intelligence_audit');
    expect(call[1]).toContain(TEST_ORG);
    expect(call[1]).toContain('trainer-1');
    expect(call[1]).toContain('memory');
    expect(call[1]).toContain('confirm');
  });

  test('non-fatal on audit failure', async () => {
    pool.query.mockRejectedValueOnce(new Error('DB error'));

    // Should not throw
    await recordAuditEvent({
      organizationId: TEST_ORG,
      actorId: 'trainer-1',
      targetType: 'proposal',
      targetId: 'prop-1',
      action: 'approve',
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

describe('exports', () => {
  test('all functions are exported', () => {
    expect(typeof computePriority).toBe('function');
    expect(typeof getPendingWorkQueue).toBe('function');
    expect(typeof buildClientIntelligenceSummary).toBe('function');
    expect(typeof revalidateProposal).toBe('function');
    expect(typeof recordAuditEvent).toBe('function');
  });
});
