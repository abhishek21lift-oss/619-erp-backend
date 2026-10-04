'use strict';
// Business insights + progress analyzer hardening.
//
// Business: dates are validated (400 on garbage/inverted/over-long), the
// metric fan-out is a single getOverview (no more double-computed revenue),
// pg COUNT strings are coerced before the prompt, and bizData carries
// grounded companions the model must quote (revenue_per_trainer,
// utilisation_pct, monthly_revenue) instead of inventing them.
//
// Progress: requireTrainer at the route (not just the mount), the parent
// client row resolves before any child read, and the done payload carries
// data_counts + weight_history so the client renders provenance and an
// honest weight chart from server rows, never model numerals.

jest.mock('../db/pool', () => ({ query: jest.fn() }));
jest.mock('../lib/ai/embeddings', () => ({
  embedText: jest.fn().mockResolvedValue(new Array(384).fill(0.1)),
  embedBatch: jest.fn().mockResolvedValue([new Array(384).fill(0.1)]),
  toVectorLiteral: jest.fn((v) => `[${v.join(',')}]`),
  EMBEDDING_DIM: 384,
}));

let mockUser = { id: 'u1', role: 'trainer', organization_id: 'org-1' };
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  requireTrainer: (...a) => jest.requireActual('../middleware/rbac').requireTrainer(...a),
}));

jest.mock('../lib/ai/router', () => ({ routedStream: jest.fn(), routedChat: jest.fn() }));
jest.mock('../lib/ai/models', () => ({ models: { primary: 'primary-model' } }));
jest.mock('../lib/ai/usage', () => ({
  logUsage: jest.fn().mockResolvedValue(undefined),
  getUserUsage: jest.fn(),
  getModelStats: jest.fn(),
}));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const OVERVIEW = {
  revenue: { total: 50000, count: 10 },
  renewals: {
    renewal_transactions: 8, renewal_revenue: 40000,
    expired_cohort: 10, renewed_of_cohort: 8, renewal_rate: 80, active_share_pct: 60,
  },
  dues: { debtor_count: 3, total_outstanding: 9000 },
  trainers: [
    { name: 'Asha', active_clients: 5, month_revenue: 20000, total_revenue: 30000 },
    { name: 'Ravi', active_clients: 4, month_revenue: 15000, total_revenue: 20000 },
  ],
  utilisation: { utilisation_pct: 75, this_month_total: 100, this_month_completed: 75 },
  monthly: [
    { month_num: 1, month_name: 'January', revenue: 20000 },
    { month_num: 2, month_name: 'February', revenue: 30000 },
  ],
};
jest.mock('../modules/insights/metric-engine', () => ({
  getOverview: jest.fn(async () => OVERVIEW),
}));
jest.mock('../modules/insights/insights-engine', () => ({
  buildBusinessInsights: jest.fn(() => []),
}));

const request = require('supertest');
const express = require('express');
const pool = require('../db/pool');
const { routedStream, routedChat } = require('../lib/ai/router');

process.env.OPENROUTER_API_KEY = 'test-key';

const app = express();
app.use(express.json());
// Mounted bare on purpose: the progress route's requireTrainer must hold
// even without the server.js studioGate wrapper.
app.use('/api/ai', require('../routes/ai'));

beforeEach(() => {
  jest.clearAllMocks();
  mockUser = { id: 'u1', role: 'trainer', organization_id: 'org-1' };
});

describe('business insights date validation', () => {
  test.each([
    ['garbage from', { from: 'not-a-date', to: '2026-09-01' }],
    ['garbage to', { from: '2026-08-01', to: 'yesterday' }],
    ['inverted range', { from: '2026-09-01', to: '2026-08-01' }],
    ['over-long range', { from: '2024-01-01', to: '2026-10-01' }],
  ])('%s is refused with 400 before any query runs', async (_label, body) => {
    const res = await request(app).post('/api/ai/business/insights').send(body);
    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('business insights grounded payload', () => {
  test('single overview, coerced counts, supplied KPI companions', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ active_members: '12', inactive_members: '3', new_members_period: '2' }] })
      .mockResolvedValueOnce({ rows: [{ total_sessions: '40', active_clients: '9' }] });
    routedChat.mockResolvedValue({
      content: '{"summary":"ok","kpis":{"mrr":50000,"renewal_rate_pct":80}}',
      model: 'm', tier: 'primary', used_fallback: false, usage: {}, latency_ms: 1,
    });

    const res = await request(app)
      .post('/api/ai/business/insights')
      .send({ from: '2026-09-01', to: '2026-09-30' });
    expect(res.status).toBe(200);

    // The user prompt is the second message; its bizData is the contract.
    const promptJson = JSON.parse(routedChat.mock.calls[0][0].messages[1].content
      .replace(/^Analyse the following gym business data and generate an executive insights report:\n\n/, ''));
    expect(promptJson.members).toEqual({ active_members: 12, inactive_members: 3, new_members_period: 2 });
    expect(promptJson.sessions).toEqual({ total_sessions: 40, active_clients: 9 });
    expect(promptJson.revenue_per_trainer).toBe(25000);
    expect(promptJson.utilisation_pct).toBe(75);
    expect(promptJson.monthly_revenue).toHaveLength(2);
    expect(promptJson.trainers[0]).toEqual({
      trainer_name: 'Asha', active_clients: 5, month_revenue: 20000, total_revenue: 30000,
    });
    // No per-trainer sessions key with a null nobody can defend.
    expect(promptJson.trainers[0]).not.toHaveProperty('sessions');
    // The response carries the same actuals the client renders as verified.
    expect(res.body.raw_data.revenue_per_trainer).toBe(25000);
    expect(res.body.raw_data.monthly_revenue).toHaveLength(2);
  });
});

describe('progress analyze route guard', () => {
  test('a member is refused at the route even without the mount gate', async () => {
    mockUser = { id: 'm1', role: 'member', organization_id: 'org-1' };
    const res = await request(app).post('/api/ai/progress/analyze').send({ client_id: 'c1' });
    expect(res.status).toBe(403);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('progress analyze grounded companions', () => {
  function mockProgressDb() {
    pool.query.mockImplementation((sql) => {
      if (sql.includes('FROM pt_clients')) {
        return Promise.resolve({ rows: [{ name: 'Priya', dob: '1992-05-10', gender: 'female', pt_start_date: '2026-01-01' }] });
      }
      if (sql.includes('FROM pt_assessments')) {
        return Promise.resolve({ rows: [
          { weight: '68', created_at: new Date('2026-09-01') },
          { weight: '70', created_at: new Date('2026-08-01') },
          { weight: null, created_at: new Date('2026-07-01') },
        ] });
      }
      if (sql.includes('FROM pt_goals')) return Promise.resolve({ rows: [{ goal_type: 'loss' }] });
      if (sql.includes('FROM weekly_checkins')) {
        return Promise.resolve({ rows: [{ weight: '69', created_at: new Date('2026-09-02') }] });
      }
      if (sql.includes('FROM strength_logs')) return Promise.resolve({ rows: [] });
      if (sql.includes('FROM pt_sessions')) {
        return Promise.resolve({ rows: [{ total_sessions: '30', sessions_30d: '8' }] });
      }
      return Promise.resolve({ rows: [{ total_photos: '0' }] });
    });
  }

  test('done payload carries data_counts and a coerced weight history', async () => {
    mockProgressDb();
    routedStream.mockImplementation(() => (async function* () {
      yield '{"summary":"steady progress"}';
      return { model: 'm', tier: 'primary', used_fallback: false, usage: {}, latency_ms: 5 };
    })());

    const res = await request(app).post('/api/ai/progress/analyze').send({ client_id: 'c1' });
    expect(res.status).toBe(200);
    // httpSSE buffers the stream; the test client reads the final text.
    const doneLine = res.text.split('\n').find((l) => l.includes('"done"'));
    const payload = JSON.parse(doneLine.replace(/^data: /, ''));
    expect(payload.data_counts).toEqual({ assessments: 3, checkins: 1, strength_logs: 0, goals: 1 });
    // Null-weight row dropped, pg numerics coerced, chronological order kept.
    expect(payload.weight_history).toEqual([
      { date: '2026-08-01', weight_kg: 70 },
      { date: '2026-09-01', weight_kg: 68 },
    ]);
  });

  test('wrong-org client stops before any child read', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    const res = await request(app).post('/api/ai/progress/analyze').send({ client_id: 'other-org-client' });
    expect(res.status).toBe(404);
    // Exactly one query ran: the parent gate. No child table was touched.
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query.mock.calls[0][0]).toMatch(/FROM pt_clients/);
  });
});
