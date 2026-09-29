'use strict';
// Attendance runs on the studio's day and the studio's clock, against a real
// database.
//
// Two defects this pins, both invisible to a mocked pool because each is a
// question about what Postgres does with a date or a timestamp:
//
//   · The QR scanner dated a check-in with the UTC date and the dashboard read
//     "today" as CURRENT_DATE (the database's UTC day). A 5:00 AM check-in in
//     India is 23:30 UTC the day before — it vanished from today's figures,
//     the "Just arrived" feed and the attendance page. The peak-hours chart
//     took EXTRACT(HOUR) of a timestamptz, which is the UTC hour.
//
//   · The manual attendance form sends '07:00' and the API built
//     `new Date(date + 'T' + time)` on a UTC server: 7:00 AM became 12:30 PM.

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('attendance on the studio day, against a real database', () => {
    it('has a database to run against', () => {
      throw new Error('RLS_TEST_DATABASE_URL is not set in CI — the studio-day proof would skip.');
    });
  });
}

const mockDbUrl = DB_URL;
jest.mock('../db/pool', () => {
  if (!mockDbUrl) return { query: jest.fn(), connect: jest.fn() };
  const { Pool } = jest.requireActual('pg');
  return new Pool({ connectionString: mockDbUrl, max: 4 });
});

const ORG = 'd4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4';
// `mock`-prefixed and self-contained, because jest.mock's factory is hoisted
// above every declaration in this file.
const mockUser = {
  id: 'sd-trainer-user', role: 'trainer', trainer_id: 'sd-trainer',
  organization_id: 'd4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4',
};

jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  requireTrainer: (...a) => jest.requireActual('../middleware/rbac').requireTrainer(...a),
  requireClient: (...a) => jest.requireActual('../middleware/rbac').requireClient(...a),
  requireTrainerOrSelf: (...a) => jest.requireActual('../middleware/rbac').requireTrainerOrSelf(...a),
  invalidateUserCache: jest.fn(),
}));

const { today: studioToday, studioInstant } = require('../lib/appTime');

describeIf('attendance on the studio day, against a real database', () => {
  let pool;
  let app;
  const TODAY = studioToday();

  beforeAll(async () => {
    pool = require('../db/pool');
    await pool.query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1, 'Studio Day', 'studio-day')
       ON CONFLICT (id) DO NOTHING`, [ORG]);
    // attendance_logs.marked_by references users, so the trainer is real.
    await pool.query(
      `INSERT INTO users (id, name, email, password, role, organization_id, is_active)
       VALUES ($1, 'Studio Day Trainer', 'sd-trainer@studio-day.test', '!not-a-hash', 'trainer', $2, TRUE)
       ON CONFLICT (id) DO NOTHING`, [mockUser.id, ORG]);
    await pool.query(
      `INSERT INTO pt_clients (id, name, mobile, organization_id) VALUES
         ('sd-early', 'Early Bird', '+919000019001', $1),
         ('sd-manual', 'Manual Entry', '+919000019002', $1)
       ON CONFLICT (id) DO NOTHING`, [ORG]);
    // Checked in at 5:00 AM studio time today — 23:30 UTC yesterday.
    await pool.query(
      `INSERT INTO attendance_logs (id, ref_id, ref_type, ref_name, date, check_in_time, method, status, organization_id)
       VALUES ('sd-log-early', 'sd-early', 'client', 'Early Bird', $2::date, $3::timestamptz, 'qr', 'present', $1)
       ON CONFLICT DO NOTHING`, [ORG, TODAY, studioInstant(TODAY, '05:00')]);

    const express = require('express');
    app = express();
    app.use(express.json());
    app.use('/api/qr', require('../routes/qr-checkin'));
    app.use('/api/attendance', require('../routes/attendance'));
    app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM attendance_logs WHERE ref_id LIKE 'sd-%'`);
    await pool.query(`DELETE FROM pt_clients WHERE id LIKE 'sd-%'`);
    await pool.query(`DELETE FROM users WHERE id = $1`, [mockUser.id]);
    await pool.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    await pool.end();
  });

  const request = () => require('supertest')(app);

  test('a 5 AM check-in counts as today on the scanner dashboard', async () => {
    const res = await request().get('/api/qr/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.today.total).toBe(1);
    expect(res.body.currently_inside.total).toBe(1);
    expect(res.body.recent_checkins.map((r) => r.ref_id)).toEqual(['sd-early']);
  });

  test('the peak-hours chart puts it at 5 AM, the studio hour, not 23:00 UTC', async () => {
    const res = await request().get('/api/qr/dashboard');
    expect(res.body.hourly).toEqual([{ hour: 5, count: 1 }]);
  });

  test('a manual 7:00 check-in is stored as 7:00 in the studio, not 7:00 UTC', async () => {
    const post = await request().post('/api/attendance').send({
      type: 'client', ref_id: 'sd-manual', ref_name: 'Manual Entry', date: TODAY, check_in: '07:00', status: 'present',
    });
    expect({ status: post.status, body: post.body }).toEqual({ status: 201, body: { message: 'Attendance marked' } });
    const { rows } = await pool.query(
      `SELECT check_in_time FROM attendance_logs WHERE ref_id = 'sd-manual' AND date = $1::date`, [TODAY]);
    expect(new Date(rows[0].check_in_time).toISOString()).toBe(studioInstant(TODAY, '07:00'));
  });

  test("today's summary reads the studio's day", async () => {
    const res = await request().get('/api/attendance/today-summary');
    expect(res.status).toBe(200);
    expect(Number(res.body.present)).toBeGreaterThanOrEqual(1);
  });
});
