'use strict';
// POST /api/ai/progress/analyze — bounded historical context (audit P2-1).
//
// The progress report prompt must not grow with the client's entire history:
// strength_logs, weekly_checkins and pt_assessments are now selected at the
// DATABASE as newest-first with a hard LIMIT, then reversed back into
// chronological order for the model. This suite proves the ROUTE wires that
// window correctly — the bound lives in the SQL, not in a JS slice.

jest.mock('../db/pool', () => ({ query: jest.fn() }));
jest.mock('../lib/ai/embeddings', () => ({
  embedText: jest.fn().mockResolvedValue(new Array(384).fill(0.1)),
  embedBatch: jest.fn().mockResolvedValue([new Array(384).fill(0.1)]),
  toVectorLiteral: jest.fn((v) => `[${v.join(',')}]`),
  EMBEDDING_DIM: 384,
}));
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = { id: 'u1', role: 'admin', organization_id: 'org-1' }; next(); },
  adminOnly: (_req, _res, next) => next(),
}));
jest.mock('../lib/ai/router', () => ({ routedStream: jest.fn(), routedChat: jest.fn() }));
jest.mock('../lib/ai/models', () => ({ models: { primary: 'primary-model' } }));
jest.mock('../lib/ai/usage', () => ({
  logUsage: jest.fn().mockResolvedValue(undefined),
  getUserUsage: jest.fn(),
  getModelStats: jest.fn(),
}));
jest.mock('../lib/ai/knowledgeBase', () => ({ retrieveContext: jest.fn() }));
jest.mock('../lib/ai/tools', () => ({ runTools: jest.fn() }));
jest.mock('../lib/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));

const request = require('supertest');
const express = require('express');
const pool = require('../db/pool');
const { routedStream } = require('../lib/ai/router');

process.env.OPENROUTER_API_KEY = 'test-key';
const app = express();
app.use(express.json());
app.use('/api/ai', require('../routes/ai'));

const CLIENT = { id: 'client-1', name: 'Priya Sharma', gender: 'female', dob: '1992-05-10', pt_start_date: '2025-01-10' };

const DEFAULT_META = { model: 'primary-model', tier: 'primary', used_fallback: false };

/** An async iterator that yields `obj` as JSON then returns `meta`. */
function streamJson(obj, meta = DEFAULT_META) {
  let done = false;
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          if (done) return Promise.resolve({ done: true, value: meta });
          done = true;
          return Promise.resolve({ done: false, value: JSON.stringify(obj) });
        },
      };
    },
  };
}

const row = (created_at, extra = {}) => ({ created_at, ...extra });

/** The 7 Promise.all queries run by /progress/analyze, keyed by SQL. */
function mockProgressDB({ assessments = [], checkins = [], logs = [], client = CLIENT } = {}) {
  pool.query.mockImplementation((sql) => {
    if (sql.includes('FROM pt_clients WHERE id=$1')) return Promise.resolve({ rows: client ? [client] : [] });
    if (sql.includes('FROM pt_assessments WHERE client_id=$1')) return Promise.resolve({ rows: assessments });
    if (sql.includes('FROM pt_goals WHERE client_id=$1')) return Promise.resolve({ rows: [] });
    if (sql.includes('FROM weekly_checkins WHERE client_id=$1')) return Promise.resolve({ rows: checkins });
    if (sql.includes('FROM strength_logs WHERE client_id=$1')) return Promise.resolve({ rows: logs });
    if (sql.includes('FROM pt_sessions WHERE client_id=$1')) return Promise.resolve({ rows: [{ total_sessions: 4, sessions_30d: 2 }] });
    if (sql.includes('FROM progress_photos WHERE client_id=$1')) return Promise.resolve({ rows: [{ total_photos: 3 }] });
    return Promise.resolve({ rows: [] });
  });
}

const sqlAt = (i) => pool.query.mock.calls[i][0];
const userPrompt = () => routedStream.mock.calls[0][0].messages.find((m) => m.role === 'user').content;
const contextData = () => JSON.parse(userPrompt().slice(userPrompt().indexOf('{')));

beforeEach(() => {
  pool.query.mockReset();
  routedStream.mockReset();
});

describe('POST /api/ai/progress/analyze — bounded historical context (P2-1)', () => {
  test('the three historical queries are bounded at the database with LIMIT', async () => {
    mockProgressDB();
    routedStream.mockReturnValue(streamJson({ summary: 'ok' }));
    const res = await request(app).post('/api/ai/progress/analyze').send({ client_id: 'client-1' });
    expect(res.status).toBe(200);

    const assessments = sqlAt(1);
    const checkins = sqlAt(3);
    const logs = sqlAt(4);
    expect(assessments).toMatch(/ORDER BY created_at DESC LIMIT 20/);
    expect(checkins).toMatch(/ORDER BY created_at DESC LIMIT 12/);
    expect(logs).toMatch(/ORDER BY created_at DESC LIMIT 20/);
    // The bound is in the SQL, never a JS slice of an unbounded fetch.
    expect(assessments).not.toMatch(/created_at ASC/);
    expect(checkins).not.toMatch(/created_at ASC/);
    expect(logs).not.toMatch(/created_at ASC/);
  });

  test('newest records are selected (ORDER BY created_at DESC)', async () => {
    mockProgressDB();
    routedStream.mockReturnValue(streamJson({ summary: 'ok' }));
    await request(app).post('/api/ai/progress/analyze').send({ client_id: 'client-1' });

    expect(sqlAt(1)).toMatch(/ORDER BY created_at DESC/);
    expect(sqlAt(3)).toMatch(/ORDER BY created_at DESC/);
    expect(sqlAt(4)).toMatch(/ORDER BY created_at DESC/);
  });

  test('the newest-N rows are reversed back into chronological order in the prompt', async () => {
    mockProgressDB({
      assessments: [row('2026-07-01'), row('2026-06-01'), row('2026-05-01')],
      checkins: [row('2026-07-05'), row('2026-06-05'), row('2026-05-05')],
      logs: [
        row('2026-07-10', { exercise_name: 'Squat', weight_kg: 100, reps_done: 5 }),
        row('2026-06-10', { exercise_name: 'Deadlift', weight_kg: 120, reps_done: 5 }),
      ],
    });
    routedStream.mockReturnValue(streamJson({ summary: 'ok' }));
    const res = await request(app).post('/api/ai/progress/analyze').send({ client_id: 'client-1' });
    expect(res.status).toBe(200);

    const ctx = contextData();
    expect(ctx.assessments.map((r) => r.created_at)).toEqual(['2026-05-01', '2026-06-01', '2026-07-01']);
    expect(ctx.weekly_checkins.map((r) => r.created_at)).toEqual(['2026-05-05', '2026-06-05', '2026-07-05']);
    expect(ctx.strength_logs.map((r) => r.created_at)).toEqual(['2026-06-10', '2026-07-10']);
  });

  test('records outside the window are excluded — the DB LIMIT keeps them out of the prompt', async () => {
    // Simulate the bounded query: the database applies DESC LIMIT 12 and
    // returns only the newest 12 of a 25-row history, newest-first.
    const all25 = Array.from({ length: 25 }, (_, i) => row(`2026-01-${String(i + 1).padStart(2, '0')}`));
    const newest12 = all25.slice(13).reverse();
    mockProgressDB({ checkins: newest12 });
    routedStream.mockReturnValue(streamJson({ summary: 'ok' }));
    const res = await request(app).post('/api/ai/progress/analyze').send({ client_id: 'client-1' });
    expect(res.status).toBe(200);

    expect(sqlAt(3)).toMatch(/ORDER BY created_at DESC LIMIT 12/);
    const ctx = contextData();
    expect(ctx.weekly_checkins).toHaveLength(12);
    const prompt = userPrompt();
    // The 13 oldest rows never entered the prompt; the newest 12 did.
    for (const r of all25.slice(0, 13)) expect(prompt).not.toContain(r.created_at);
    for (const r of newest12) expect(prompt).toContain(r.created_at);
  });

  test('a short history (under the window) is passed through unchanged and chronological', async () => {
    mockProgressDB({
      checkins: [row('2026-07-05'), row('2026-06-05'), row('2026-05-05')], // 3 < 12, newest-first as DESC returns
    });
    routedStream.mockReturnValue(streamJson({ summary: 'ok' }));
    const res = await request(app).post('/api/ai/progress/analyze').send({ client_id: 'client-1' });
    expect(res.status).toBe(200);

    const ctx = contextData();
    expect(ctx.weekly_checkins.map((r) => r.created_at)).toEqual(['2026-05-05', '2026-06-05', '2026-07-05']);
  });

  test('a cross-tenant client 404s with a JSON error before any output is produced', async () => {
    mockProgressDB({ client: null }); // org-scoped parent gate yields no row
    const res = await request(app).post('/api/ai/progress/analyze').send({ client_id: 'other-org-client' });

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
    // The org predicate is on the parent lookup itself, and its org param is
    // bound — never derived from the request body.
    expect(pool.query.mock.calls[0][0]).toContain('($2::uuid IS NULL OR organization_id=$2)');
    expect(pool.query.mock.calls[0][1][0]).toBe('other-org-client');
    expect(pool.query.mock.calls[0][1][1]).toBe('org-1');
    // Nothing is streamed, prompted, or handed to the model.
    expect(routedStream).not.toHaveBeenCalled();
    expect(res.text).not.toContain('data:');
  });

  test('the tenant predicate stays in the SQL and every parameter stays bound', async () => {
    mockProgressDB();
    routedStream.mockReturnValue(streamJson({ summary: 'ok' }));
    const res = await request(app).post('/api/ai/progress/analyze').send({ client_id: 'client-1' });
    expect(res.status).toBe(200);

    const [parentSql, parentParams] = pool.query.mock.calls[0];
    expect(parentSql).toContain('($2::uuid IS NULL OR organization_id=$2)');
    expect(parentParams[0]).toBe('client-1');
    expect(parentParams[1]).toBe('org-1');

    // Child queries are keyed by client_id only (already gated by the parent)
    // and never interpolate request-body values into the SQL text.
    for (let i = 1; i < pool.query.mock.calls.length; i++) {
      expect(pool.query.mock.calls[i][1][0]).toBe('client-1');
    }
  });
});