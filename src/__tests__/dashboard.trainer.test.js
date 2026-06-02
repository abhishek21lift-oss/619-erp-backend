jest.mock('../db/pool', () => ({
  query: jest.fn(),
}));

const pool = require('../db/pool');
const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'a'.repeat(64);

const dashboardRouter = require('../routes/dashboard');
const app = express();
app.use(express.json());
app.use('/api/dashboard', dashboardRouter);

const trainerToken = jwt.sign(
  { id: 'usr-t', token_version: 0 },
  process.env.JWT_SECRET,
  { expiresIn: '1h' }
);

describe('GET /api/dashboard/summary — trainer scoping', () => {
  it('uses marked_by JOIN, not trainer_id, on attendance_logs', async () => {
    pool.query.mockImplementation(async function() {
      // auth middleware: SELECT user row
      if (/FROM users/i.test(arguments[0])) {
        return { rows: [{ id: 'usr-t', name: 'Trainer', email: 't@x.com', role: 'trainer', trainer_id: 'tr-1', member_id: null, branch_id: null, is_active: true, token_version: 0 }] };
      }
      return { rows: [{}] };
    });
    await request(app)
      .get('/api/dashboard/summary?period=today')
      .set('Authorization', 'Bearer ' + trainerToken);

    const calls = pool.query.mock.calls;
    const attendanceCall = calls.find(c => /FROM\s+attendance_logs/i.test(c[0]));
    expect(attendanceCall).toBeDefined();
    expect(attendanceCall[0]).toMatch(/a\.marked_by/);
    expect(attendanceCall[0]).toMatch(/u\.trainer_id/);
  });
});
