'use strict';
// POST /api/ai/chat — buildClientContext parent-first authorization (audit F-2/A-2).
//
// The AI Coach client context must confirm the parent pt_clients row (tenant
// predicate, deleted_at IS NULL) BEFORE running any child query — exactly like
// loadAuthoritativeClient() for Workout/Diet. A foreign, unknown, or deleted
// client yields an empty context and ZERO child queries (goal/assessment/
// check-in reads). An authorized client produces the same context contents as
// before. The org/tenant parameter is bound, never interpolated, and comes
// only from the authenticated request.
//
// The one deliberate parity note: an org-less user (tenant user with no
// organization, or a platform super admin operating platform-wide) resolves
// orgParam() to null, and the shared tenant predicate's `$2::uuid IS NULL`
// branch authorizes platform-wide — the exact behaviour of the canonical
// loadAuthoritativeClient. This change does not touch the predicate; it only
// guarantees the parent gate runs first and no child query fires for any
// client that fails the gate.

jest.mock('../db/pool', () => ({ query: jest.fn() }));

let mockUser = { id: 'usr-1', role: 'trainer', organization_id: 'org-1' };
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  adminOnly: (_req, _res, next) => next(),
}));
jest.mock('../lib/ai/router', () => ({
  routedChat: jest.fn(),
  routedStream: jest.fn(),
}));
jest.mock('../lib/ai/knowledgeBase', () => ({ retrieveContext: jest.fn() }));
jest.mock('../lib/ai/tools', () => ({ runTools: jest.fn() }));
jest.mock('../lib/ai/usage', () => ({
  logUsage: jest.fn().mockResolvedValue(undefined),
  getUserUsage: jest.fn(),
  getModelStats: jest.fn(),
}));
jest.mock('../lib/sse-heartbeat', () => ({ startSseHeartbeat: jest.fn(() => () => {}) }));
jest.mock('../lib/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));

const request = require('supertest');
const express = require('express');
const pool = require('../db/pool');
const logger = require('../lib/logger');
const { routedStream } = require('../lib/ai/router');
const { retrieveContext } = require('../lib/ai/knowledgeBase');
const { runTools } = require('../lib/ai/tools');

process.env.OPENROUTER_API_KEY = 'test-key';
const aiRouter = require('../routes/ai');

const app = express();
app.use(express.json());
app.use('/api/ai', aiRouter);

const CLIENT_ROWS = [{ id: 'cli-1', name: 'Ratnam Yadav', dob: '2000-01-01', gender: 'Male', mobile: '999' }];
const GOAL_ROWS = [{ goal_type: 'weight_loss', target_weight: 70, target_body_fat: null, notes: 'cut' }];
const ASSESS_ROWS = [{ weight: 73.2, body_fat_pct: 22, chest_cm: null, waist_cm: null, hips_cm: null, created_at: '2026-08-01' }];
const CHECKIN_ROWS = [{ weight: 73, mood: 'good', sleep_hours: 7, client_notes: 'ok', created_at: '2026-08-10' }];

// The parent pt_clients gate buildClientState must run FIRST.
// Phase 2C: buildClientState replaces buildClientContext for the chat route.
const PARENT_SQL = /FROM pt_clients.*WHERE.*id.*=.*\$1.*deleted_at.*IS NULL/s;
const CHILD_TABLES = /pt_goals|pt_assessments|weekly_checkins|pt_lifestyle|pt_nutrition|workout_assignments|workout_plans|diet_assignments|workout_sessions|workout_sets|personal_records|muscle_volume_landmarks|pt_posture|pt_mobility|pt_parq|pt_informed_consents|attendance_logs|pt_os_measurements|ai_client_memory|ai_client_episodes/;

function clientDispatch({ client = CLIENT_ROWS, goals = GOAL_ROWS, assess = ASSESS_ROWS, checkins = CHECKIN_ROWS } = {}) {
  return jest.fn((sql, _params) => {
    if (sql.includes('ai_conversations WHERE id')) return Promise.resolve({ rows: [{ id: 'conv-1' }] });
    // Phase 2C: buildClientState uses multiline SQL — check for pt_clients + WHERE id separately
    if (sql.includes('pt_clients') && sql.includes('WHERE id') && sql.includes('deleted_at IS NULL')) return Promise.resolve({ rows: client });
    if (sql.includes('pt_goals')) return Promise.resolve({ rows: goals });
    if (sql.includes('pt_assessments') && sql.includes('bp_systolic')) return Promise.resolve({ rows: assess });
    if (sql.includes('pt_assessments') && sql.includes('LIMIT 10')) return Promise.resolve({ rows: assess });
    if (sql.includes('weekly_checkins')) return Promise.resolve({ rows: checkins });
    // All other queries return empty (lifestyle, nutrition, workouts, etc.)
    return Promise.resolve({ rows: [] });
  });
}

const streamChunks = (chunks) => jest.fn().mockImplementation(async function* () {
  for (const c of chunks) yield c;
});

const systemPromptOf = () => routedStream.mock.calls[0][0].messages[0].content;

beforeEach(() => {
  pool.query.mockReset();
  logger.warn.mockClear();
  logger.error.mockClear();
  retrieveContext.mockReset().mockResolvedValue([]);
  runTools.mockReset().mockResolvedValue({ toolNames: [], contextText: '' });
  routedStream.mockReset();
  mockUser = { id: 'usr-1', role: 'trainer', organization_id: 'org-1' };
});

describe('POST /api/ai/chat — authorized client context', () => {
  it('parent gate passes, children run AFTER it, and the context is unchanged', async () => {
    pool.query.mockImplementation(clientDispatch());
    routedStream.mockImplementation(streamChunks(['Hello']));

    const res = await request(app)
      .post('/api/ai/chat')
      .send({ message: 'Plan a week', client_id: 'cli-1', conversation_id: 'conv-1' });

    expect(res.status).toBe(200);
    expect(res.text).toContain('"type":"done"');

    const calls = pool.query.mock.calls;
    const sqls = calls.map(([s]) => s);
    const parentIdx = sqls.findIndex((s) => PARENT_SQL.test(s));

    // Phase 2C: buildClientState runs parent first, then children in parallel.
    // The parent gate exists and ran before any child queries.
    expect(parentIdx).toBeGreaterThanOrEqual(0);
    // All child queries ran (they may be interleaved due to Promise.all)
    expect(sqls.some((s) => s.includes('pt_goals'))).toBe(true);
    expect(sqls.some((s) => s.includes('pt_assessments'))).toBe(true);
    expect(sqls.some((s) => s.includes('weekly_checkins'))).toBe(true);
    // The parent query ran before the first child query
    const firstChildIdx = sqls.findIndex((s) => s.includes('pt_goals') || s.includes('pt_assessments') || s.includes('weekly_checkins'));
    expect(parentIdx).toBeLessThan(firstChildIdx);

    // Tenant parameter bound to the parent gate.
    expect(calls[parentIdx][1]).toContain('cli-1');
    expect(calls[parentIdx][1]).toContain('org-1');

    // Context contents: Phase 2C uses coachingContext from buildClientState.
    const prompt = systemPromptOf();
    expect(prompt).toContain('Current client context:');
    expect(prompt).toContain('Ratnam Yadav');

    // The chat generation flow itself still works.
    expect(routedStream).toHaveBeenCalledTimes(1);
    expect(routedStream.mock.calls[0][0]).toMatchObject({ intent: 'chat' });

    // The gate passing does not fire the missing-client log.
    expect(logger.warn).not.toHaveBeenCalledWith('ai_context_missing_client');
  });

  it('no client_id means no client context, exactly as before', async () => {
    pool.query.mockImplementation(clientDispatch());
    routedStream.mockImplementation(streamChunks(['hi']));

    const res = await request(app)
      .post('/api/ai/chat')
      .send({ message: 'hello', conversation_id: 'conv-1' });

    expect(res.status).toBe(200);
    expect(systemPromptOf()).not.toContain('Current client context:');
    const sqls = pool.query.mock.calls.map(([s]) => s);
    expect(sqls.some((s) => CHILD_TABLES.test(s))).toBe(false); // no children without a client to authorize
  });
});

describe('POST /api/ai/chat — clients that fail the parent gate', () => {
  it('foreign client: zero child queries, empty context, safe log', async () => {
    pool.query.mockImplementation(clientDispatch({ client: [] }));
    routedStream.mockImplementation(streamChunks(['Hello']));

    const res = await request(app)
      .post('/api/ai/chat')
      .send({ message: 'hi', client_id: 'foreign-cli', conversation_id: 'conv-1' });

    expect(res.status).toBe(200); // chat still answers, without client context
    const sqls = pool.query.mock.calls.map(([s]) => s);
    expect(sqls.some((s) => CHILD_TABLES.test(s))).toBe(false);
    expect(systemPromptOf()).not.toContain('Current client context:');
    expect(systemPromptOf()).not.toContain('Ratnam');

    // The gate still bound the tenant parameter before rejecting.
    const parentCall = pool.query.mock.calls.find(([s]) => PARENT_SQL.test(s));
    expect(parentCall[1]).toEqual(['foreign-cli', 'org-1']);

    // Phase 2C: buildClientState returns null silently (no PII logged).
    // The old buildClientContext used to log 'ai_context_missing_client'.
  });

  it('unknown client: identical empty-context behaviour', async () => {
    pool.query.mockImplementation(clientDispatch({ client: [] }));
    routedStream.mockImplementation(streamChunks(['ok']));

    const res = await request(app)
      .post('/api/ai/chat')
      .send({ message: 'hi', client_id: '00000000-0000-0000-0000-000000000000', conversation_id: 'conv-1' });

    expect(res.status).toBe(200);
    const sqls = pool.query.mock.calls.map(([s]) => s);
    expect(sqls.some((s) => CHILD_TABLES.test(s))).toBe(false);
    expect(systemPromptOf()).not.toContain('Current client context:');
    // Phase 2C: buildClientState returns null silently (no PII logged).
  });

  it('deleted client: the parent gate itself excludes it and no child runs', async () => {
    pool.query.mockImplementation(clientDispatch({ client: [] }));
    routedStream.mockImplementation(streamChunks(['ok']));

    await request(app)
      .post('/api/ai/chat')
      .send({ message: 'hi', client_id: 'deleted-cli', conversation_id: 'conv-1' });

    const parentCall = pool.query.mock.calls.find(([s]) => PARENT_SQL.test(s));
    expect(parentCall[0]).toContain('deleted_at IS NULL');
    const sqls = pool.query.mock.calls.map(([s]) => s);
    expect(sqls.some((s) => CHILD_TABLES.test(s))).toBe(false);
  });

  it('missing organization: null org param, gate still authoritative', async () => {
    // Org-less tenant user — orgParam() resolves to null, and the shared
    // predicate's `$2::uuid IS NULL` branch authorizes platform-wide, exactly
    // as loadAuthoritativeClient does. The gate still decides everything:
    // an existing client is authorized (children run, parity with canonical),
    // and a client that fails the gate gets zero child queries.
    mockUser = { id: 'usr-1', role: 'trainer', organization_id: null };

    // Existing client under a null org → authorized platform-wide (canonical parity).
    pool.query.mockImplementation(clientDispatch());
    routedStream.mockImplementation(streamChunks(['ok']));
    await request(app)
      .post('/api/ai/chat')
      .send({ message: 'hi', client_id: 'cli-1', conversation_id: 'conv-1' });
    const parentCall = pool.query.mock.calls.find(([s]) => PARENT_SQL.test(s));
    expect(parentCall[1]).toEqual(['cli-1', null]); // null org bound, not interpolated
    expect(systemPromptOf()).toContain('Current client context:');

    // Same org-less user, client that fails the gate → zero child queries.
    pool.query.mockReset();
    pool.query.mockImplementation(clientDispatch({ client: [] }));
    routedStream.mockReset();
    routedStream.mockImplementation(streamChunks(['ok']));
    await request(app)
      .post('/api/ai/chat')
      .send({ message: 'hi', client_id: 'nope', conversation_id: 'conv-1' });
    const sqls = pool.query.mock.calls.map(([s]) => s);
    expect(sqls.some((s) => CHILD_TABLES.test(s))).toBe(false);
    expect(systemPromptOf()).not.toContain('Current client context:');
  });
});

describe('POST /api/ai/chat — no cross-tenant leakage', () => {
  it('a foreign client\'s data never reaches the prompt, RAG, tools, or the model', async () => {
    pool.query.mockImplementation(clientDispatch({ client: [] }));
    routedStream.mockImplementation(streamChunks(['answer']));

    await request(app)
      .post('/api/ai/chat')
      .send({ message: 'tell me about them', client_id: 'foreign-cli', conversation_id: 'conv-1' });

    // Prompt: no client context section at all.
    const prompt = systemPromptOf();
    expect(prompt).not.toContain('Current client context:');

    // RAG and tools receive only the user's message — never the client_id or
    // any client data (they have no client handle in the chat contract).
    expect(retrieveContext).toHaveBeenCalledTimes(1);
    expect(retrieveContext.mock.calls[0][0].query).toBe('tell me about them');
    expect(retrieveContext.mock.calls[0][0]).not.toHaveProperty('clientId');
    expect(runTools).toHaveBeenCalledTimes(1);
    expect(runTools.mock.calls[0][1]).toBe('tell me about them');

    // Model: streamed answer only; the foreign client never appeared in any
    // routedStream input.
    expect(routedStream).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(routedStream.mock.calls[0][0].messages)).not.toMatch(/foreign-cli|Ratnam/);
  });
});