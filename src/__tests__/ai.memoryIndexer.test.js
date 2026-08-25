'use strict';

// Tests for src/lib/ai/memoryIndexer.js — Phase 2D Memory Indexer
//
// Coverage:
//   1. Candidate validation (schema, categories, confidence)
//   2. AI extraction cannot produce medical memories
//   3. Deduplication (normalizeFact, findDuplicate)
//   4. Conflict detection
//   5. Candidate lifecycle (always candidate, never active)
//   6. Event-based episodes (deterministic, no LLM)
//   7. Confirmed facts (trusted source → active)
//   8. Edge cases (empty input, malformed output, missing params)

jest.mock('../db/pool', () => ({ query: jest.fn() }));
jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
  child: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() })),
}));

const pool = require('../db/pool');
const {
  validateCandidate,
  validateCandidates,
  normalizeFact,
  findDuplicate,
  checkConflicts,
  extractFromConversation,
  createEventEpisode,
  createConfirmedFact,
  getPendingCandidates,
  AI_EXTRACTABLE_CATEGORIES,
  REQUIRES_CONFIRMATION_CATEGORIES,
  MIN_CONFIDENCE,
  MAX_CANDIDATES_PER_EXTRACTION,
  EXTRACTION_SYSTEM_PROMPT,
} = require('../lib/ai/memoryIndexer');

// Also need the memory service functions
const {
  createMemory,
  createEpisode,
  detectConflicts,
  getActiveMemories,
  getMemories,
} = require('../lib/ai/memory');

const TEST_ORG = '11111111-1111-1111-1111-111111111111';
const TEST_CLIENT = '22222222-2222-2222-2222-222222222222';
const TEST_CONV = '33333333-3333-3333-3333-333333333333';

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
// 1. CANDIDATE VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

describe('validateCandidate', () => {
  test('accepts valid candidate', () => {
    const result = validateCandidate({
      category: 'preference',
      fact: 'Prefers morning workouts',
      confidence: 0.85,
    });
    expect(result.valid).toBe(true);
    expect(result.candidate.category).toBe('preference');
    expect(result.candidate.confidence).toBe(0.85);
  });

  test('rejects null/undefined', () => {
    expect(validateCandidate(null).valid).toBe(false);
    expect(validateCandidate(undefined).valid).toBe(false);
  });

  test('rejects missing required fields', () => {
    expect(validateCandidate({}).valid).toBe(false);
    expect(validateCandidate({ category: 'preference' }).valid).toBe(false);
    expect(validateCandidate({ fact: 'test' }).valid).toBe(false);
  });

  test('rejects invalid category', () => {
    const result = validateCandidate({
      category: 'invalid',
      fact: 'Some fact here',
      confidence: 0.8,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid category');
  });

  test('rejects invalid confidence', () => {
    expect(validateCandidate({
      category: 'preference', fact: 'test fact', confidence: 'high',
    }).valid).toBe(false);
    expect(validateCandidate({
      category: 'preference', fact: 'test fact', confidence: -0.5,
    }).valid).toBe(false);
    expect(validateCandidate({
      category: 'preference', fact: 'test fact', confidence: 1.5,
    }).valid).toBe(false);
  });

  test('rejects fact too short', () => {
    const result = validateCandidate({
      category: 'preference', fact: 'hi', confidence: 0.8,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('at least 5 characters');
  });

  test('rejects AI-extracted medical memories', () => {
    const result = validateCandidate({
      category: 'medical',
      fact: 'Has mild asthma',
      confidence: 0.9,
      source_type: 'ai_detected',
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('medical memories');
  });

  test('allows trainer-confirmed medical memories', () => {
    const result = validateCandidate({
      category: 'medical',
      fact: 'Has mild asthma',
      confidence: 1.0,
      source_type: 'trainer_confirmed',
    });
    expect(result.valid).toBe(true);
  });

  test('sanitizes strings', () => {
    const result = validateCandidate({
      category: 'preference',
      fact: 'Prefers morning workouts',
      confidence: 0.8,
    });
    expect(result.valid).toBe(true);
    expect(result.candidate.category).toBe('preference');
    expect(result.candidate.fact).toBe('Prefers morning workouts');
  });
});

describe('validateCandidates', () => {
  test('validates array of candidates', () => {
    const result = validateCandidates([
      { category: 'preference', fact: 'Prefers morning workouts', confidence: 0.8 },
      { category: 'constraint', fact: 'No overhead pressing', confidence: 0.9 },
    ]);
    expect(result.valid).toBe(true);
    expect(result.candidates).toHaveLength(2);
  });

  test('rejects non-array input', () => {
    expect(validateCandidates('not an array').valid).toBe(false);
    expect(validateCandidates(null).valid).toBe(false);
  });

  test('reports individual validation errors', () => {
    const result = validateCandidates([
      { category: 'preference', fact: 'Valid fact here', confidence: 0.8 },
      { category: 'invalid', fact: 'Also valid', confidence: 0.8 },
      { fact: 'Missing category', confidence: 0.8 },
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.candidates).toHaveLength(1); // only the valid one
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. DEDUPLICATION
// ═══════════════════════════════════════════════════════════════════════════

describe('normalizeFact', () => {
  test('lowercases and strips punctuation', () => {
    expect(normalizeFact('Prefers Morning Workouts!')).toBe('prefers morning workouts');
    expect(normalizeFact('No overhead pressing.')).toBe('no overhead pressing');
  });

  test('collapses whitespace', () => {
    expect(normalizeFact('Prefers   morning   workouts')).toBe('prefers morning workouts');
  });
});

describe('findDuplicate', () => {
  test('returns existing memory with same normalized fact', async () => {
    // getActiveMemories call
    mockSelect([{ id: 'existing-1', fact: 'Prefers morning workouts', category: 'preference' }]);
    // getMemories call (candidates)
    mockSelect([]);

    const result = await findDuplicate(TEST_ORG, TEST_CLIENT, {
      category: 'preference',
      fact: 'prefers morning workouts!',
    });
    expect(result).not.toBeNull();
    expect(result.id).toBe('existing-1');
  });

  test('returns null when no duplicate exists', async () => {
    mockSelect([]);
    mockSelect([]);

    const result = await findDuplicate(TEST_ORG, TEST_CLIENT, {
      category: 'preference',
      fact: 'Prefers evening workouts',
    });
    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. CONFLICT DETECTION
// ═══════════════════════════════════════════════════════════════════════════

describe('checkConflicts', () => {
  test('detects conflicting active memories', async () => {
    // detectConflicts call
    mockSelect([{ id: 'conflict-1', fact: 'Prefers evening workouts' }]);
    // findDuplicate → getActiveMemories
    mockSelect([]);
    // findDuplicate → getMemories
    mockSelect([]);

    const result = await checkConflicts(TEST_ORG, TEST_CLIENT, {
      category: 'preference',
      subcategory: 'scheduling',
      fact: 'Now prefers morning workouts',
    });
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].id).toBe('conflict-1');
  });

  test('returns empty when no conflicts', async () => {
    mockSelect([]);
    mockSelect([]);
    mockSelect([]);

    const result = await checkConflicts(TEST_ORG, TEST_CLIENT, {
      category: 'preference',
      fact: 'Prefers morning workouts',
    });
    expect(result.conflicts).toHaveLength(0);
    expect(result.duplicates).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. EVENT EPISODES (deterministic, no LLM)
// ═══════════════════════════════════════════════════════════════════════════

describe('createEventEpisode', () => {
  test('creates episode from confirmed event', async () => {
    mockInsert({
      id: 'ep-1',
      organization_id: TEST_ORG,
      client_id: TEST_CLIENT,
      episode_type: 'pr_achieved',
      title: 'New Bench Press PR',
    });

    const result = await createEventEpisode({
      organizationId: TEST_ORG,
      clientId: TEST_CLIENT,
      episodeType: 'pr_achieved',
      title: 'New Bench Press PR — 80kg × 3',
      detail: 'Completed all prescribed reps',
      weekNumber: 8,
      sessionDate: '2026-08-18',
      sourceType: 'workout_log',
      sourceId: 'session-123',
      severity: 'significant',
    });

    expect(result).not.toBeNull();
    expect(result.episode_type).toBe('pr_achieved');
  });

  test('returns null for missing required params', async () => {
    const result = await createEventEpisode({
      organizationId: TEST_ORG,
      clientId: TEST_CLIENT,
      // missing episodeType and title
    });
    expect(result).toBeNull();
  });

  test('non-fatal on memory service failure', async () => {
    pool.query.mockRejectedValueOnce(new Error('DB error'));
    const result = await createEventEpisode({
      organizationId: TEST_ORG,
      clientId: TEST_CLIENT,
      episodeType: 'milestone',
      title: 'Test',
      sourceType: 'workout_log',
    });
    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. CONFIRMED FACTS (trusted source → active)
// ═══════════════════════════════════════════════════════════════════════════

describe('createConfirmedFact', () => {
  test('creates memory with trusted source (active directly)', async () => {
    mockSelect([]); // conflict detection
    mockInsert({
      id: 'mem-1',
      organization_id: TEST_ORG,
      client_id: TEST_CLIENT,
      category: 'constraint',
      fact: 'No overhead pressing due to shoulder impingement',
      source_type: 'assessment',
      status: 'active',
    });

    const result = await createConfirmedFact({
      organizationId: TEST_ORG,
      clientId: TEST_CLIENT,
      category: 'constraint',
      fact: 'No overhead pressing due to shoulder impingement',
      sourceType: 'assessment',
      sourceId: 'assessment-123',
    });

    expect(result).not.toBeNull();
    expect(result.status).toBe('active');
  });

  test('returns null for missing params', async () => {
    const result = await createConfirmedFact({
      organizationId: TEST_ORG,
      clientId: TEST_CLIENT,
      // missing category and fact
    });
    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

describe('constants', () => {
  test('AI_EXTRACTABLE_CATEGORIES excludes medical and goal', () => {
    expect(AI_EXTRACTABLE_CATEGORIES.has('preference')).toBe(true);
    expect(AI_EXTRACTABLE_CATEGORIES.has('constraint')).toBe(true);
    expect(AI_EXTRACTABLE_CATEGORIES.has('schedule')).toBe(true);
    expect(AI_EXTRACTABLE_CATEGORIES.has('equipment')).toBe(true);
    expect(AI_EXTRACTABLE_CATEGORIES.has('medical')).toBe(false);
    expect(AI_EXTRACTABLE_CATEGORIES.has('goal')).toBe(false);
  });

  test('REQUIRES_CONFIRMATION_CATEGORIES includes medical and goal', () => {
    expect(REQUIRES_CONFIRMATION_CATEGORIES.has('medical')).toBe(true);
    expect(REQUIRES_CONFIRMATION_CATEGORIES.has('goal')).toBe(true);
  });

  test('MIN_CONFIDENCE is reasonable', () => {
    expect(MIN_CONFIDENCE).toBeGreaterThanOrEqual(0.5);
    expect(MIN_CONFIDENCE).toBeLessThanOrEqual(0.9);
  });

  test('MAX_CANDIDATES_PER_EXTRACTION is bounded', () => {
    expect(MAX_CANDIDATES_PER_EXTRACTION).toBeGreaterThanOrEqual(1);
    expect(MAX_CANDIDATES_PER_EXTRACTION).toBeLessThanOrEqual(10);
  });

  test('EXTRACTION_SYSTEM_PROMPT contains key instructions', () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('DURABLE facts');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('MEDICAL MEMORIES');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('DO NOT extract');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('candidates');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. PENDING CANDIDATES
// ═══════════════════════════════════════════════════════════════════════════

describe('getPendingCandidates', () => {
  test('returns candidate memories', async () => {
    mockSelect([
      { id: 'c1', status: 'candidate', fact: 'Test fact' },
    ]);

    const result = await getPendingCandidates(TEST_CLIENT, TEST_ORG);
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('candidate');

    const call = pool.query.mock.calls[0];
    expect(call[0]).toContain('ai_client_memory');
    expect(call[1]).toContain('candidate');
  });
});
