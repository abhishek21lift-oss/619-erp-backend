'use strict';
// POST /api/attendance/bulk — one authorization query and one upsert, without
// losing the per-record answers the endpoint has always given.
//
// The old loop ran SELECT + INSERT per record: 200 records meant 400 round
// trips, and the 200-record cap was the only thing keeping it survivable. The
// replacement validates every record first, checks each subject table once,
// and writes the survivors in a single parameterized upsert.
//
// What must not change:
//   · partial success — a bad row fails alone, the others are still written;
//   · duplicates are accepted, last one wins, and are counted per submission;
//   · a subject from another studio is "Not found", never written;
//   · the response shape and the 200-record cap.

let mockState;

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    mockState.log.push({ sql: text, params });

    if (/FROM pt_clients/.test(text)) {
      return { rows: mockState.clients.map((id) => ({ id })) };
    }
    if (/FROM trainers/.test(text)) {
      return { rows: mockState.trainers.map((id) => ({ id })) };
    }
    if (/^INSERT INTO attendance_logs/.test(text)) {
      mockState.insertCount = (mockState.insertCount || 0) + 1;
      // First INSERT in a request is the batch; any later one is the per-row
      // fallback the route runs when that batch throws.
      if (mockState.bulkError && mockState.insertCount === 1) throw mockState.bulkError;
      if (mockState.rowErrorFor && params[1] === mockState.rowErrorFor) {
        throw new Error('row rejected');
      }
      return { rows: [], rowCount: 1 };
    }
    return { rows: [] };
  }),
}));

jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockState.user; next(); },
  requireTrainer: (...a) => jest.requireActual('../middleware/rbac').requireTrainer(...a),
}));

const express = require('express');
const request = require('supertest');
const { errorHandler } = require('../middleware/errorHandler');

const ORG_A = '0a000000-0000-4000-8000-000000000001';
const TRAINER_A = { id: 'usr-trainer-a', role: 'trainer', organization_id: ORG_A };

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/attendance', require('../routes/attendance'));
  a.use(errorHandler);
  return a;
}

function record(overrides = {}) {
  return {
    ref_id: 'ptc-1',
    type: 'client',
    date: '2026-10-20',
    status: 'present',
    ...overrides,
  };
}

beforeEach(() => {
  mockState = {
    log: [],
    clients: ['ptc-1', 'ptc-2'],
    trainers: ['tr-1'],
    user: TRAINER_A,
    bulkError: null,
    rowErrorFor: null,
    insertCount: 0,
  };
});

describe('POST /api/attendance/bulk', () => {
  it('checks subjects once and writes the batch in one statement', async () => {
    const res = await request(app())
      .post('/api/attendance/bulk')
      .send({ records: [record(), record({ ref_id: 'ptc-2' })] });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ processed: 2, failed: 0 });
    expect(mockState.log.filter((q) => /FROM pt_clients/.test(q.sql))).toHaveLength(1);
    const inserts = mockState.log.filter((q) => /^INSERT INTO attendance_logs/.test(q.sql));
    expect(inserts).toHaveLength(1);
    // Two tuples in one statement, each 12 binds.
    expect(inserts[0].sql).toMatch(/VALUES \(\$1,.+?\),\(\$13,/);
    expect(inserts[0].params).toHaveLength(24);
  });

  it('reports a subject from another studio as Not found and writes nothing for it', async () => {
    const res = await request(app())
      .post('/api/attendance/bulk')
      .send({ records: [record(), record({ ref_id: 'ptc-foreign' })] });

    expect(res.status).toBe(201);
    expect(res.body.processed).toBe(1);
    expect(res.body.failed).toBe(1);
    expect(res.body.errors[0]).toMatchObject({ index: 1, ref_id: 'ptc-foreign', error: 'Not found' });

    const insert = mockState.log.find((q) => /^INSERT INTO attendance_logs/.test(q.sql));
    expect(insert.params).not.toContain('ptc-foreign');
  });

  it('accepts duplicates, writes the last one, and counts every submission', async () => {
    const res = await request(app())
      .post('/api/attendance/bulk')
      .send({
        records: [
          record({ status: 'absent' }),
          record({ status: 'late' }),
        ],
      });

    expect(res.body.processed).toBe(2);
    const insert = mockState.log.find((q) => /^INSERT INTO attendance_logs/.test(q.sql));
    expect(insert.sql.match(/VALUES/g)).toHaveLength(1);
    // One tuple only: the conflict key is (ref_id, ref_type, date).
    expect(insert.params).toHaveLength(12);
    expect(insert.params[7]).toBe('late');
  });

  it('fails an invalid status alone instead of the whole batch', async () => {
    const res = await request(app())
      .post('/api/attendance/bulk')
      .send({
        records: [
          record(),
          record({ ref_id: 'ptc-2', status: 'here-ish' }),
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.processed).toBe(1);
    expect(res.body.failed).toBe(1);
    expect(res.body.errors[0].index).toBe(1);

    const insert = mockState.log.find((q) => /^INSERT INTO attendance_logs/.test(q.sql));
    expect(insert.params).not.toContain('here-ish');
  });

  it('uses the trainers table for trainer subjects', async () => {
    const res = await request(app())
      .post('/api/attendance/bulk')
      .send({ records: [record({ type: 'trainer', ref_id: 'tr-1' })] });

    expect(res.body.processed).toBe(1);
    expect(mockState.log.some((q) => /FROM trainers/.test(q.sql))).toBe(true);
  });

  it('falls back to per-row writes when the batch statement is rejected', async () => {
    mockState.bulkError = new Error('statement failed');
    mockState.rowErrorFor = 'ptc-2';

    const res = await request(app())
      .post('/api/attendance/bulk')
      .send({ records: [record(), record({ ref_id: 'ptc-2' })] });

    expect(res.status).toBe(201);
    expect(res.body.processed).toBe(1);
    expect(res.body.failed).toBe(1);
    expect(res.body.errors[0]).toMatchObject({ index: 1, ref_id: 'ptc-2', error: 'row rejected' });

    const inserts = mockState.log.filter((q) => /^INSERT INTO attendance_logs/.test(q.sql));
    expect(inserts).toHaveLength(3); // failed batch + two single-row retries
  });

  it('keeps the 200-record cap', async () => {
    const records = Array.from({ length: 201 }, (_, i) => record({ ref_id: `ptc-${i}` }));
    const res = await request(app())
      .post('/api/attendance/bulk')
      .send({ records });

    expect(res.status).toBe(400);
    expect(mockState.log).toHaveLength(0);
  });

  it('requires the id/date/status triple before any query', async () => {
    const res = await request(app())
      .post('/api/attendance/bulk')
      .send({ records: [{ ref_id: 'ptc-1', date: '2026-10-20' }] });

    expect(res.status).toBe(201);
    expect(res.body.processed).toBe(0);
    expect(res.body.errors[0]).toMatchObject({ index: 0, error: 'ref_id, date, and status required' });
    expect(mockState.log).toHaveLength(0);
  });
});
