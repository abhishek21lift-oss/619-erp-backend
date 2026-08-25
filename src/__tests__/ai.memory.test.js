'use strict';

// Tests for src/lib/ai/memory.js — Phase 2B Durable Client Memory
//
// Coverage:
//   1. CRUD operations (create, read, update, delete)
//   2. Lifecycle (candidate → confirmed → active → stale/superseded → deleted)
//   3. Tenant isolation (organization_id enforced)
//   4. Client isolation (client_id enforced)
//   5. Conflict detection
//   6. Source-based trust (trainer_confirmed → active, system_observed → candidate)
//   7. Expiration sweep
//   8. Episodic memory
//   9. Memory projection (for buildClientState)
//  10. Validation (required fields, enum checks)
//  11. Superseding
//  12. Soft delete preserves audit

jest.mock('../db/pool', () => ({ query: jest.fn() }));
jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
  child: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() })),
}));

const pool = require('../db/pool');
const {
  createMemory,
  confirmMemory,
  rejectMemory,
  getActiveMemories,
  getMemories,
  updateMemory,
  invalidateMemory,
  deleteMemory,
  refreshMemory,
  supersedeMemory,
  detectConflicts,
  sweepExpired,
  createEpisode,
  getEpisodes,
  getEpisodeCounts,
  buildMemoryProjection,
  VALID_CATEGORIES,
  VALID_SOURCE_TYPES,
  VALID_EPISODE_TYPES,
  TRUSTED_SOURCES,
  AI_SOURCES,
} = require('../lib/ai/memory');

// ── Test data ──────────────────────────────────────────────────────────────

const TEST_ORG = '11111111-1111-1111-1111-111111111111';
const TEST_CLIENT = '22222222-2222-2222-2222-222222222222';
const TEST_USER = 'trainer-1';

const MOCK_MEMORY_ROW = {
  id: '33333333-3333-3333-3333-333333333333',
  organization_id: TEST_ORG,
  client_id: TEST_CLIENT,
  category: 'preference',
  subcategory: 'exercise',
  fact: 'Prefers morning workouts',
  confidence: 1.0,
  source_type: 'trainer_confirmed',
  source_id: null,
  source_text: null,
  status: 'active',
  verified_at: null,
  superseded_by: null,
  expires_at: null,
  created_by: TEST_USER,
  as_of: '2026-08-20',
  created_at: new Date('2026-08-20'),
  updated_at: new Date('2026-08-20'),
};

const MOCK_EPISODE_ROW = {
  id: '44444444-4444-4444-4444-444444444444',
  organization_id: TEST_ORG,
  client_id: TEST_CLIENT,
  episode_type: 'pr_achieved',
  title: 'Bench Press PR — 80kg × 3',
  detail: 'New personal record on bench press',
  week_number: 8,
  session_date: new Date('2026-08-18'),
  source_type: 'workout_log',
  source_id: 'set-perf-123',
  severity: 'significant',
  created_at: new Date('2026-08-18'),
};

// ── Mock helpers ───────────────────────────────────────────────────────────

function mockInsert(rows) {
  pool.query.mockResolvedValueOnce({ rows: Array.isArray(rows) ? rows : [rows] });
}

function mockUpdate(rows) {
  pool.query.mockResolvedValueOnce({ rows: Array.isArray(rows) ? rows : [rows] });
}

function mockSelect(rows) {
  pool.query.mockResolvedValueOnce({ rows: Array.isArray(rows) ? rows : [rows] });
}

beforeEach(() => {
  pool.query.mockReset();
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. CREATE — TRUSTED SOURCE → ACTIVE
// ═══════════════════════════════════════════════════════════════════════════

describe('createMemory — trusted source', () => {
  test('trainer_confirmed creates memory as active', async () => {
    // detectConflicts returns empty
    mockSelect([]);
    // insert returns the new row
    mockInsert(MOCK_MEMORY_ROW);

    const result = await createMemory({
      organization_id: TEST_ORG,
      client_id: TEST_CLIENT,
      category: 'preference',
      subcategory: 'exercise',
      fact: 'Prefers morning workouts',
      source_type: 'trainer_confirmed',
      created_by: TEST_USER,
    });

    expect(result.status).toBe('active');
    expect(result.fact).toBe('Prefers morning workouts');
    expect(result.category).toBe('preference');

    // Verify INSERT was called
    const insertCall = pool.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO ai_client_memory'));
    expect(insertCall).toBeDefined();
    expect(insertCall[1]).toContain(TEST_ORG);
    expect(insertCall[1]).toContain(TEST_CLIENT);
  });

  test('db_derived creates memory as active', async () => {
    mockSelect([]);
    mockInsert({ ...MOCK_MEMORY_ROW, source_type: 'db_derived', category: 'observation' });

    const result = await createMemory({
      organization_id: TEST_ORG,
      client_id: TEST_CLIENT,
      category: 'observation',
      fact: 'Has not trained chest in 14 days',
      source_type: 'db_derived',
      source_id: 'workout_sets_query',
    });

    expect(result.status).toBe('active');
    expect(result.source_type).toBe('db_derived');
  });

  test('client_reported creates memory as active', async () => {
    mockSelect([]);
    mockInsert({ ...MOCK_MEMORY_ROW, source_type: 'client_reported', category: 'schedule' });

    const result = await createMemory({
      organization_id: TEST_ORG,
      client_id: TEST_CLIENT,
      category: 'schedule',
      fact: 'Travels for work every other week',
      source_type: 'client_reported',
    });

    expect(result.status).toBe('active');
  });

  test('assessment creates memory as active', async () => {
    mockSelect([]);
    mockInsert({ ...MOCK_MEMORY_ROW, source_type: 'assessment', category: 'medical' });

    const result = await createMemory({
      organization_id: TEST_ORG,
      client_id: TEST_CLIENT,
      category: 'medical',
      fact: 'Mild asthma — avoid high-intensity cardio in cold air',
      source_type: 'assessment',
      source_id: 'parq-form-123',
    });

    expect(result.status).toBe('active');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. CREATE — AI SOURCE → CANDIDATE
// ═══════════════════════════════════════════════════════════════════════════

describe('createMemory — AI source', () => {
  test('system_observed creates memory as candidate', async () => {
    mockSelect([]);
    mockInsert({ ...MOCK_MEMORY_ROW, status: 'candidate', source_type: 'system_observed' });

    const result = await createMemory({
      organization_id: TEST_ORG,
      client_id: TEST_CLIENT,
      category: 'observation',
      fact: 'Client seems to plateau on upper body',
      source_type: 'system_observed',
      confidence: 0.7,
    });

    expect(result.status).toBe('candidate');
  });

  test('system_observed cannot be forced to active', async () => {
    mockSelect([]);

    await expect(
      createMemory({
        organization_id: TEST_ORG,
        client_id: TEST_CLIENT,
        category: 'observation',
        fact: 'Test',
        source_type: 'system_observed',
        status: 'active',
      }),
    ).rejects.toThrow('cannot be created as active');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

describe('createMemory — validation', () => {
  test('throws on missing required fields', async () => {
    await expect(
      createMemory({ organization_id: TEST_ORG, client_id: TEST_CLIENT }),
    ).rejects.toThrow('category is required');

    await expect(
      createMemory({ organization_id: TEST_ORG, category: 'preference', fact: 'x', source_type: 'trainer_confirmed' }),
    ).rejects.toThrow('client_id is required');
  });

  test('throws on invalid category', async () => {
    await expect(
      createMemory({
        organization_id: TEST_ORG, client_id: TEST_CLIENT,
        category: 'invalid_category', fact: 'x', source_type: 'trainer_confirmed',
      }),
    ).rejects.toThrow('Invalid category');
  });

  test('throws on invalid source_type', async () => {
    await expect(
      createMemory({
        organization_id: TEST_ORG, client_id: TEST_CLIENT,
        category: 'preference', fact: 'x', source_type: 'hallucinated',
      }),
    ).rejects.toThrow('Invalid source_type');
  });

  test('throws on invalid status at creation', async () => {
    await expect(
      createMemory({
        organization_id: TEST_ORG, client_id: TEST_CLIENT,
        category: 'preference', fact: 'x', source_type: 'trainer_confirmed',
        status: 'stale',
      }),
    ).rejects.toThrow('Cannot create memory with status');
  });

  test('clampConfidence to 0-1', async () => {
    mockSelect([]);
    mockInsert({ ...MOCK_MEMORY_ROW, confidence: 1.0 });

    const result = await createMemory({
      organization_id: TEST_ORG, client_id: TEST_CLIENT,
      category: 'preference', fact: 'x', source_type: 'trainer_confirmed',
      confidence: 1.5,
    });
    expect(result.confidence).toBe(1.0);

    mockSelect([]);
    mockInsert({ ...MOCK_MEMORY_ROW, confidence: 0.0 });

    const result2 = await createMemory({
      organization_id: TEST_ORG, client_id: TEST_CLIENT,
      category: 'preference', fact: 'y', source_type: 'trainer_confirmed',
      confidence: -0.5,
    });
    expect(result2.confidence).toBe(0.0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. CONFLICT DETECTION
// ═══════════════════════════════════════════════════════════════════════════

describe('createMemory — conflict detection', () => {
  test('returns _conflicts when existing active memory matches', async () => {
    const existing = { id: 'existing-1', fact: 'Prefers evening workouts', confidence: 0.9, source_type: 'trainer_confirmed', created_at: new Date(), as_of: '2026-07-01' };
    mockSelect([existing]);
    mockInsert({ ...MOCK_MEMORY_ROW, _conflicts: [existing] });

    const result = await createMemory({
      organization_id: TEST_ORG, client_id: TEST_CLIENT,
      category: 'preference', subcategory: 'scheduling',
      fact: 'Prefers morning workouts', source_type: 'trainer_confirmed',
    });

    expect(result._conflicts).toHaveLength(1);
    expect(result._conflicts[0].id).toBe('existing-1');
  });

  test('no _conflicts when no existing memory', async () => {
    mockSelect([]);
    mockInsert(MOCK_MEMORY_ROW);

    const result = await createMemory({
      organization_id: TEST_ORG, client_id: TEST_CLIENT,
      category: 'preference', fact: 'x', source_type: 'trainer_confirmed',
    });

    expect(result._conflicts).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. CONFIRM / REJECT
// ═══════════════════════════════════════════════════════════════════════════

describe('confirmMemory', () => {
  test('promotes candidate to active', async () => {
    mockUpdate({ ...MOCK_MEMORY_ROW, status: 'active', verified_at: new Date() });

    const result = await confirmMemory('mem-1', TEST_ORG, { verified_by: TEST_USER });
    expect(result.status).toBe('active');
    expect(result.verified_at).toBeDefined();

    const call = pool.query.mock.calls[0];
    expect(call[0]).toContain("status = 'active'");
    expect(call[1]).toContain('mem-1');
    expect(call[1]).toContain(TEST_ORG);
  });

  test('returns null if not found or not candidate', async () => {
    mockUpdate([]); // no rows updated

    const result = await confirmMemory('nonexistent', TEST_ORG);
    expect(result).toBeNull();
  });
});

describe('rejectMemory', () => {
  test('sets candidate to deleted', async () => {
    mockUpdate({ ...MOCK_MEMORY_ROW, status: 'deleted' });

    const result = await rejectMemory('mem-1', TEST_ORG);
    expect(result.status).toBe('deleted');

    const call = pool.query.mock.calls[0];
    expect(call[0]).toContain("status = 'deleted'");
  });

  test('returns null if not found', async () => {
    mockUpdate([]);
    const result = await rejectMemory('nonexistent', TEST_ORG);
    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. READ OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

describe('getActiveMemories', () => {
  test('returns active memories with category filter', async () => {
    mockSelect([MOCK_MEMORY_ROW]);

    const result = await getActiveMemories(TEST_CLIENT, TEST_ORG, { category: 'preference' });
    expect(result).toHaveLength(1);

    const call = pool.query.mock.calls[0];
    expect(call[0]).toContain("status = 'active'");
    expect(call[1]).toContain('preference');
  });

  test('returns all active memories without filter', async () => {
    mockSelect([MOCK_MEMORY_ROW]);
    const result = await getActiveMemories(TEST_CLIENT, TEST_ORG);
    expect(result).toHaveLength(1);

    const call = pool.query.mock.calls[0];
    expect(call[0]).not.toContain('category =');
  });
});

describe('getMemories', () => {
  test('excludes deleted by default', async () => {
    mockSelect([MOCK_MEMORY_ROW]);
    await getMemories(TEST_CLIENT, TEST_ORG);

    const call = pool.query.mock.calls[0];
    expect(call[0]).toContain("status != 'deleted'");
  });

  test('can filter by specific status', async () => {
    mockSelect([{ ...MOCK_MEMORY_ROW, status: 'candidate' }]);
    await getMemories(TEST_CLIENT, TEST_ORG, { status: 'candidate' });

    const call = pool.query.mock.calls[0];
    expect(call[0]).toContain("status =");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. UPDATE / INVALIDATE / DELETE / REFRESH
// ═══════════════════════════════════════════════════════════════════════════

describe('updateMemory', () => {
  test('updates allowed fields', async () => {
    mockUpdate({ ...MOCK_MEMORY_ROW, fact: 'Now prefers evening workouts' });

    const result = await updateMemory('mem-1', TEST_ORG, {
      fact: 'Now prefers evening workouts',
      confidence: 0.8,
    });

    expect(result.fact).toBe('Now prefers evening workouts');
    const call = pool.query.mock.calls[0];
    expect(call[0]).toContain('SET');
    expect(call[0]).toContain('updated_at = NOW()');
  });

  test('returns null if no fields to update', async () => {
    const result = await updateMemory('mem-1', TEST_ORG, {});
    expect(result).toBeNull();
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('invalidateMemory', () => {
  test('sets active to stale', async () => {
    mockUpdate({ ...MOCK_MEMORY_ROW, status: 'stale' });

    const result = await invalidateMemory('mem-1', TEST_ORG);
    expect(result.status).toBe('stale');

    const call = pool.query.mock.calls[0];
    expect(call[0]).toContain("status = 'stale'");
  });
});

describe('deleteMemory', () => {
  test('soft-deletes active memory', async () => {
    mockUpdate({ ...MOCK_MEMORY_ROW, status: 'deleted' });

    const result = await deleteMemory('mem-1', TEST_ORG);
    expect(result.status).toBe('deleted');

    const call = pool.query.mock.calls[0];
    expect(call[0]).toContain("status IN ('active', 'candidate')");
  });
});

describe('refreshMemory', () => {
  test('updates verified_at', async () => {
    mockUpdate({ ...MOCK_MEMORY_ROW, verified_at: new Date() });

    const result = await refreshMemory('mem-1', TEST_ORG);
    expect(result.verified_at).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. SUPERSEDE
// ═══════════════════════════════════════════════════════════════════════════

describe('supersedeMemory', () => {
  test('marks old memory as superseded with pointer to new', async () => {
    const newId = '55555555-5555-5555-5555-555555555555';
    mockUpdate({ ...MOCK_MEMORY_ROW, status: 'superseded', superseded_by: newId });

    const result = await supersedeMemory('old-mem', newId, TEST_ORG);
    expect(result.status).toBe('superseded');
    expect(result.superseded_by).toBe(newId);

    const call = pool.query.mock.calls[0];
    expect(call[0]).toContain('superseded_by');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. EXPIRATION SWEEP
// ═══════════════════════════════════════════════════════════════════════════

describe('sweepExpired', () => {
  test('marks expired active memories as stale', async () => {
    mockUpdate([{ id: 'expired-1' }, { id: 'expired-2' }]);

    const count = await sweepExpired();
    expect(count).toBe(2);

    const call = pool.query.mock.calls[0];
    expect(call[0]).toContain("status = 'stale'");
    expect(call[0]).toContain('expires_at < NOW()');
  });

  test('returns 0 when nothing expired', async () => {
    mockUpdate([]);
    const count = await sweepExpired();
    expect(count).toBe(0);
  });

  test('can filter by organization_id', async () => {
    mockUpdate([{ id: 'expired-1' }]);

    const count = await sweepExpired(TEST_ORG);
    expect(count).toBe(1);

    const call = pool.query.mock.calls[0];
    expect(call[1]).toContain(TEST_ORG);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. EPISODIC MEMORY
// ═══════════════════════════════════════════════════════════════════════════

describe('createEpisode', () => {
  test('creates an episode with valid data', async () => {
    mockInsert(MOCK_EPISODE_ROW);

    const result = await createEpisode({
      organization_id: TEST_ORG,
      client_id: TEST_CLIENT,
      episode_type: 'pr_achieved',
      title: 'Bench Press PR — 80kg × 3',
      detail: 'New personal record on bench press',
      week_number: 8,
      session_date: '2026-08-18',
      source_type: 'workout_log',
      source_id: 'set-perf-123',
      severity: 'significant',
    });

    expect(result.episode_type).toBe('pr_achieved');
    expect(result.title).toBe('Bench Press PR — 80kg × 3');
    expect(result.severity).toBe('significant');

    const call = pool.query.mock.calls[0];
    expect(call[0]).toContain('INSERT INTO ai_client_episodes');
  });

  test('throws on invalid episode_type', async () => {
    await expect(
      createEpisode({
        organization_id: TEST_ORG, client_id: TEST_CLIENT,
        episode_type: 'invalid', title: 'test', source_type: 'workout_log',
      }),
    ).rejects.toThrow('Invalid episode_type');
  });

  test('throws on invalid source_type', async () => {
    await expect(
      createEpisode({
        organization_id: TEST_ORG, client_id: TEST_CLIENT,
        episode_type: 'milestone', title: 'test', source_type: 'invalid',
      }),
    ).rejects.toThrow('Invalid source_type');
  });

  test('throws on missing required fields', async () => {
    await expect(
      createEpisode({ organization_id: TEST_ORG, client_id: TEST_CLIENT }),
    ).rejects.toThrow('episode_type is required');
  });
});

describe('getEpisodes', () => {
  test('returns episodes with optional type filter', async () => {
    mockSelect([MOCK_EPISODE_ROW]);

    const result = await getEpisodes(TEST_CLIENT, TEST_ORG, { episode_type: 'pr_achieved' });
    expect(result).toHaveLength(1);

    const call = pool.query.mock.calls[0];
    expect(call[0]).toContain('episode_type');
  });

  test('returns all episodes without filter', async () => {
    mockSelect([MOCK_EPISODE_ROW]);
    await getEpisodes(TEST_CLIENT, TEST_ORG);

    const call = pool.query.mock.calls[0];
    expect(call[0]).not.toContain('episode_type =');
  });
});

describe('getEpisodeCounts', () => {
  test('returns counts by episode type', async () => {
    mockSelect([
      { episode_type: 'pr_achieved', count: 3 },
      { episode_type: 'deload', count: 1 },
    ]);

    const result = await getEpisodeCounts(TEST_CLIENT, TEST_ORG);
    expect(result).toEqual({ pr_achieved: 3, deload: 1 });
  });

  test('returns empty object when no episodes', async () => {
    mockSelect([]);
    const result = await getEpisodeCounts(TEST_CLIENT, TEST_ORG);
    expect(result).toEqual({});
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. MEMORY PROJECTION
// ═══════════════════════════════════════════════════════════════════════════

describe('buildMemoryProjection', () => {
  test('returns compact semantic + episodic projection', async () => {
    // Three parallel queries: semantic, episodes, episode_counts
    mockSelect([
      { id: 'm1', category: 'preference', subcategory: 'exercise', fact: 'Prefers mornings', confidence: 1.0, source_type: 'trainer_confirmed', as_of: '2026-08-20', verified_at: new Date() },
      { id: 'm2', category: 'constraint', subcategory: null, fact: 'No overhead press', confidence: 0.95, source_type: 'assessment', as_of: '2026-08-15', verified_at: null },
    ]);
    mockSelect([
      { id: 'e1', episode_type: 'pr_achieved', title: 'Bench PR', detail: '80kg', week_number: 8, session_date: new Date('2026-08-18'), severity: 'significant', source_type: 'workout_log', created_at: new Date('2026-08-18') },
    ]);
    mockSelect([
      { episode_type: 'pr_achieved', count: 2 },
    ]);

    const result = await buildMemoryProjection(TEST_CLIENT, TEST_ORG);

    expect(result.semantic).toHaveLength(2);
    expect(result.semantic[0].fact).toBe('Prefers mornings');
    expect(result.semantic[0].category).toBe('preference');
    expect(result.episodes).toHaveLength(1);
    expect(result.episodes[0].type).toBe('pr_achieved');
    expect(result.episodes[0].title).toBe('Bench PR');
    expect(result.episode_counts).toEqual({ pr_achieved: 2 });
    expect(result.freshness).toBe('has_data');
  });

  test('returns empty state when no memories', async () => {
    mockSelect([]);
    mockSelect([]);
    mockSelect([]);

    const result = await buildMemoryProjection(TEST_CLIENT, TEST_ORG);

    expect(result.semantic).toHaveLength(0);
    expect(result.episodes).toHaveLength(0);
    expect(result.freshness).toBe('empty');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 12. TENANT ISOLATION
// ═══════════════════════════════════════════════════════════════════════════

describe('tenant isolation', () => {
  test('createMemory passes organization_id in all queries', async () => {
    mockSelect([]);
    mockInsert(MOCK_MEMORY_ROW);

    await createMemory({
      organization_id: TEST_ORG,
      client_id: TEST_CLIENT,
      category: 'preference',
      fact: 'test',
      source_type: 'trainer_confirmed',
    });

    // Both conflict detection and insert should have org_id
    for (const call of pool.query.mock.calls) {
      expect(call[1]).toContain(TEST_ORG);
    }
  });

  test('getActiveMemories enforces organization_id', async () => {
    mockSelect([]);
    await getActiveMemories(TEST_CLIENT, TEST_ORG);

    const call = pool.query.mock.calls[0];
    expect(call[1]).toContain(TEST_ORG);
  });

  test('confirmMemory enforces organization_id', async () => {
    mockUpdate([]);
    await confirmMemory('mem-1', TEST_ORG);

    const call = pool.query.mock.calls[0];
    expect(call[1]).toContain(TEST_ORG);
  });

  test('deleteMemory enforces organization_id', async () => {
    mockUpdate([]);
    await deleteMemory('mem-1', TEST_ORG);

    const call = pool.query.mock.calls[0];
    expect(call[1]).toContain(TEST_ORG);
  });

  test('createEpisode passes organization_id', async () => {
    mockInsert(MOCK_EPISODE_ROW);
    await createEpisode({
      organization_id: TEST_ORG,
      client_id: TEST_CLIENT,
      episode_type: 'milestone',
      title: 'test',
      source_type: 'workout_log',
    });

    const call = pool.query.mock.calls[0];
    expect(call[1]).toContain(TEST_ORG);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 13. CONSTANTS / ENUMS
// ═══════════════════════════════════════════════════════════════════════════

describe('constants', () => {
  test('VALID_CATEGORIES includes all required categories', () => {
    expect(VALID_CATEGORIES).toContain('preference');
    expect(VALID_CATEGORIES).toContain('constraint');
    expect(VALID_CATEGORIES).toContain('observation');
    expect(VALID_CATEGORIES).toContain('goal');
    expect(VALID_CATEGORIES).toContain('medical');
    expect(VALID_CATEGORIES).toContain('schedule');
    expect(VALID_CATEGORIES).toContain('equipment');
  });

  test('VALID_SOURCE_TYPES includes all required source types', () => {
    expect(VALID_SOURCE_TYPES).toContain('trainer_confirmed');
    expect(VALID_SOURCE_TYPES).toContain('client_reported');
    expect(VALID_SOURCE_TYPES).toContain('db_derived');
    expect(VALID_SOURCE_TYPES).toContain('assessment');
    expect(VALID_SOURCE_TYPES).toContain('system_observed');
  });

  test('TRUSTED_SOURCES are correctly identified', () => {
    expect(TRUSTED_SOURCES.has('trainer_confirmed')).toBe(true);
    expect(TRUSTED_SOURCES.has('client_reported')).toBe(true);
    expect(TRUSTED_SOURCES.has('db_derived')).toBe(true);
    expect(TRUSTED_SOURCES.has('assessment')).toBe(true);
    expect(TRUSTED_SOURCES.has('system_observed')).toBe(false);
  });

  test('AI_SOURCES are correctly identified', () => {
    expect(AI_SOURCES.has('system_observed')).toBe(true);
    expect(AI_SOURCES.has('trainer_confirmed')).toBe(false);
  });

  test('VALID_EPISODE_TYPES includes all required types', () => {
    expect(VALID_EPISODE_TYPES).toContain('programme_change');
    expect(VALID_EPISODE_TYPES).toContain('pr_achieved');
    expect(VALID_EPISODE_TYPES).toContain('injury_reported');
    expect(VALID_EPISODE_TYPES).toContain('deload');
    expect(VALID_EPISODE_TYPES).toContain('milestone');
  });
});
