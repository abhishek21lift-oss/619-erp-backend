'use strict';
// Lifestyle still stores occupation_type because its activity score is computed
// from it, but the stored value is now a scoring snapshot: the Client Interview
// occupation when one exists, otherwise the supplied legacy value, otherwise
// the existing row value. These are route contracts, not SQL-engine tests:
// the pool is mocked for the same reason lifestyle.mentalHealth.routes.test.js
// does it.

const express = require('express');
const request = require('supertest');

const ORG = '11111111-1111-4111-8111-111111111111';
const CLIENT = '44444444-4444-4444-8444-444444444444';

let mockQueries = [];
let mockClientInOrg = true;
let mockLifestyleRows = [];
let mockInterviewOccupation = null;

jest.mock('../db/pool', () => {
  const query = jest.fn(async (sql, params = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    mockQueries.push({ text, params });
    if (/^SELECT 1 FROM pt_clients/i.test(text)) {
      return { rows: mockClientInOrg ? [{ ok: 1 }] : [], rowCount: mockClientInOrg ? 1 : 0 };
    }
    if (/FROM pt_client_interviews/i.test(text)) {
      return { rows: mockInterviewOccupation ? [{ occupation_type: mockInterviewOccupation }] : [], rowCount: mockInterviewOccupation ? 1 : 0 };
    }
    if (/SELECT water_intake_liters, meals_per_day, breakfast_regularity, late_night_eating/i.test(text)) {
      return { rows: [{}], rowCount: 1 };
    }
    if (/^SELECT \* FROM pt_lifestyle_assessments WHERE id =/i.test(text)) {
      return { rows: mockLifestyleRows, rowCount: mockLifestyleRows.length };
    }
    if (/^UPDATE pt_lifestyle_assessments SET/i.test(text)) {
      return { rows: [{ id: 'l1' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const clientQuery = jest.fn(async (sql, params = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    mockQueries.push({ text, params });
    if (/^INSERT INTO pt_lifestyle_assessments/i.test(text)) return { rows: [{ id: 'new-l1' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  return {
    query,
    connect: jest.fn(async () => ({ query: clientQuery, release: jest.fn() })),
  };
});
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = { id: 'u1', role: 'trainer', organization_id: ORG }; next(); },
  requireTrainer: (_req, _res, next) => next(),
}));
jest.mock('../lib/activityLog', () => ({ logActivity: jest.fn(async () => {}) }));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn() }));

const app = express();
app.use(express.json());
app.use('/api/progress', require('../modules/progress/progress.routes'));
app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));

beforeEach(() => {
  mockQueries = [];
  mockClientInOrg = true;
  mockLifestyleRows = [];
  mockInterviewOccupation = null;
});

describe('Lifestyle — interview occupation snapshot', () => {
  it('scores a new Lifestyle row with the interview occupation, not the body value', async () => {
    mockInterviewOccupation = 'desk_job';
    const res = await request(app).post('/api/progress/lifestyle-assessments')
      .send({ client_id: CLIENT, occupation_type: 'retired', daily_steps_bracket: '5000_8000' });
    expect(res.status).toBe(201);
    const params = mockQueries.find((q) => /INSERT INTO pt_lifestyle_assessments/i.test(q.text)).params;
    expect(params).toContain('desk_job');
    expect(params).not.toContain('retired');
  });

  it('keeps the legacy value when there is no interview occupation', async () => {
    mockInterviewOccupation = null;
    mockLifestyleRows = [{ id: 'l1', client_id: CLIENT, occupation_type: 'student' }];
    const res = await request(app).patch('/api/progress/lifestyle-assessments/l1')
      .send({ daily_steps_bracket: '8000_10000' });
    expect(res.status).toBe(200);
    expect(mockQueries.find((q) => /UPDATE pt_lifestyle_assessments SET/i.test(q.text)).params)
      .toContain('student');
  });

  it('replaces the snapshot with the interview occupation on edit', async () => {
    mockInterviewOccupation = 'active_job';
    mockLifestyleRows = [{ id: 'l1', client_id: CLIENT, occupation_type: 'student' }];
    const res = await request(app).patch('/api/progress/lifestyle-assessments/l1')
      .send({ daily_steps_bracket: '8000_10000' });
    expect(res.status).toBe(200);
    const update = mockQueries.find((q) => /UPDATE pt_lifestyle_assessments SET/i.test(q.text));
    expect(update.text).toContain('occupation_type =');
    expect(update.params).toContain('active_job');
  });

  it('still refuses an empty patch when no interview occupation exists', async () => {
    mockInterviewOccupation = null;
    mockLifestyleRows = [{ id: 'l1', client_id: CLIENT, occupation_type: 'student' }];
    const res = await request(app).patch('/api/progress/lifestyle-assessments/l1').send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NO_FIELDS');
  });

  it('writes the interview occupation on an otherwise empty patch', async () => {
    mockInterviewOccupation = 'desk_job';
    mockLifestyleRows = [{ id: 'l1', client_id: CLIENT, occupation_type: 'student' }];
    const res = await request(app).patch('/api/progress/lifestyle-assessments/l1').send({});
    expect(res.status).not.toBe(400);
    expect(res.body.error?.code).not.toBe('NO_FIELDS');
    const update = mockQueries.find((q) => /UPDATE pt_lifestyle_assessments SET/i.test(q.text));
    expect(update).toBeTruthy();
    expect(update.text).toContain('occupation_type =');
    expect(update.params).toContain('desk_job');
  });
});
