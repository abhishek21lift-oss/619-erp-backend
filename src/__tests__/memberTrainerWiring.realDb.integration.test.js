'use strict';
// The member ↔ trainer wiring, against a real migrated database.
//
// Each case was a place the member app and the trainer's side disagreed:
//
//   - the member's screens named the trainer three different ways, so a
//     rename on My Profile showed a member two names for one coach, and the
//     dashboard read a legacy specialisation column nobody fills in;
//   - a member who changed their mobile kept getting WhatsApp on the old
//     number, because every client row also carries `whatsapp`;
//   - a member's own goals were never readable by their trainer;
//   - a weekly check-in reached the trainer silently.

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('member ↔ trainer wiring, against a real database', () => {
    it('has a database to run against', () => {
      throw new Error('RLS_TEST_DATABASE_URL is not set in CI — the member wiring proof would skip.');
    });
  });
}

const mockDbUrl = DB_URL;
jest.mock('../db/pool', () => {
  if (!mockDbUrl) return { query: jest.fn(), connect: jest.fn() };
  const { Pool } = jest.requireActual('pg');
  return new Pool({ connectionString: mockDbUrl, max: 4 });
});

const ORG = 'c1e70000-0000-4000-8000-0000000002a1';
const OTHER_ORG = 'c1e70000-0000-4000-8000-0000000002a2';
const TRAINER = 'mtw-trainer';
const TRAINER_USER = 'mtw-trainer-user';
const CLIENT = 'mtw-client';
const CLIENT_SPLIT = 'mtw-client-split';
const MEMBER = 'mtw-member';

describeIf('member ↔ trainer wiring, against a real database', () => {
  let pool;
  let app;
  let trainerApp;
  let asClient = CLIENT;

  beforeAll(async () => {
    pool = require('../db/pool');
    await pool.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Wiring Studio', 'mtw-studio'), ($2, 'Other Studio', 'mtw-other')
      ON CONFLICT (id) DO NOTHING`, [ORG, OTHER_ORG]);
    // The legacy trainers row carries an old name and an old specialisation —
    // the state a studio is in after the trainer edits My Profile.
    await pool.query(`INSERT INTO trainers (id, name, specialization, organization_id) VALUES ($1, 'Old Name', 'Legacy spec', $2)
      ON CONFLICT (id) DO NOTHING`, [TRAINER, ORG]);
    await pool.query(`INSERT INTO users (id, name, email, password, role, organization_id, trainer_id, is_active)
      VALUES ($1, 'Rohan Mehta', 'rohan@mtw.test', '!x', 'trainer', $2, $3, TRUE) ON CONFLICT (id) DO NOTHING`,
    [TRAINER_USER, ORG, TRAINER]);
    await pool.query(`INSERT INTO user_profiles (user_id, specialisations, designation)
      VALUES ($1, '["Powerlifting", "Rehab", "Mobility"]'::jsonb, 'Head coach') ON CONFLICT (user_id) DO NOTHING`, [TRAINER_USER]);
    await pool.query(`INSERT INTO pt_clients (id, name, mobile, whatsapp, organization_id, trainer_id, trainer_name)
      VALUES ($1, 'Asha', '9000000001', '9000000001', $2, $3, 'Old Name'),
             ($4, 'Bina', '9000000002', '9111111111', $2, $3, 'Old Name')
      ON CONFLICT (id) DO NOTHING`, [CLIENT, ORG, TRAINER, CLIENT_SPLIT]);
    await pool.query(`INSERT INTO users (id, name, email, password, role, organization_id, pt_client_id, is_active)
      VALUES ($1, 'Asha', 'asha@mtw.test', '!x', 'member', $2, $3, TRUE) ON CONFLICT (id) DO NOTHING`, [MEMBER, ORG, CLIENT]);

    const express = require('express');
    app = express();
    app.use(express.json());
    app.use('/api/me', (req, _res, next) => {
      req.user = { id: MEMBER, role: 'member', organization_id: ORG, pt_client_id: asClient };
      next();
    }, require('../modules/client-portal/client-portal.routes'));
    app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));

    const goals = require('../modules/client-portal/member-goals.service');
    trainerApp = { goalsForStudio: goals.goalsForStudio };
  });

  afterAll(async () => {
    await pool.query('DELETE FROM notifications WHERE user_id = $1', [TRAINER_USER]);
    await pool.query('DELETE FROM member_goals WHERE client_id = ANY($1)', [[CLIENT, CLIENT_SPLIT]]);
    await pool.query('DELETE FROM weekly_checkins WHERE client_id = ANY($1)', [[CLIENT, CLIENT_SPLIT]]);
    await pool.query('DELETE FROM user_profiles WHERE user_id = $1', [TRAINER_USER]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[MEMBER, TRAINER_USER]]);
    await pool.query('DELETE FROM pt_clients WHERE id = ANY($1)', [[CLIENT, CLIENT_SPLIT]]);
    await pool.query('DELETE FROM trainers WHERE id = $1', [TRAINER]);
    await pool.query('DELETE FROM organizations WHERE id = ANY($1)', [[ORG, OTHER_ORG]]);
    await pool.end();
  });

  const request = () => require('supertest')(app);

  it('names one trainer everywhere, from the account and My Profile the trainer edits', async () => {
    const profile = await request().get('/api/me/profile');
    const coach = await request().get('/api/me/coach');
    const thread = await request().get('/api/me/messages');
    expect(profile.status).toBe(200);
    expect(profile.body.data.trainer_name).toBe('Rohan Mehta');
    expect(profile.body.data.trainer_specialization).toBe('Powerlifting · Rehab');
    expect(coach.body.data.name).toBe('Rohan Mehta');
    expect(thread.body.data.with.trainer_name).toBe('Rohan Mehta');
  });

  it('carries a trainer rename to trainers.name and every client\'s trainer_name', async () => {
    const { syncTrainerName } = require('../lib/memberTrainer');
    await syncTrainerName(pool, TRAINER_USER, 'Rohan M.');
    const { rows: [t] } = await pool.query('SELECT name FROM trainers WHERE id = $1', [TRAINER]);
    const { rows: cs } = await pool.query('SELECT DISTINCT trainer_name FROM pt_clients WHERE trainer_id = $1', [TRAINER]);
    expect(t.name).toBe('Rohan M.');
    expect(cs).toEqual([{ trainer_name: 'Rohan M.' }]);
  });

  it('moves WhatsApp with the mobile when they were the same number, and tells the trainer', async () => {
    const res = await request().patch('/api/me/profile').send({ mobile: '9876543210' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ mobile: '9876543210', whatsapp: '9876543210' });
    const { rows } = await pool.query(
      `SELECT title FROM notifications WHERE user_id = $1 AND type = 'member_contact'`, [TRAINER_USER]);
    expect(rows.map((r) => r.title)).toContain('Asha updated their contact details');
  });

  it('leaves a WhatsApp number that deliberately differed, unless one is given', async () => {
    asClient = CLIENT_SPLIT;
    try {
      const kept = await request().patch('/api/me/profile').send({ mobile: '9000000099' });
      expect(kept.body.data).toMatchObject({ mobile: '9000000099', whatsapp: '9111111111' });
      const set = await request().patch('/api/me/profile').send({ whatsapp: '+91 98888 77777' });
      expect(set.body.data).toMatchObject({ mobile: '9000000099', whatsapp: '9888877777' });
    } finally {
      asClient = CLIENT;
    }
  });

  it('tells the trainer about a weekly check-in once, not once per edit', async () => {
    const body = { mood: 'good', sleep_hours: 7, energy_level: 4 };
    expect((await request().post('/api/me/checkins').send(body)).status).toBeLessThan(300);
    expect((await request().post('/api/me/checkins').send({ ...body, sleep_hours: 8 })).status).toBeLessThan(300);
    const { rows } = await pool.query(
      `SELECT link FROM notifications WHERE user_id = $1 AND type = 'member_checkin'`, [TRAINER_USER]);
    expect(rows).toEqual([{ link: `/pt-os/clients/${CLIENT}?tab=checkins` }]);
  });

  it('lets a member set and remove their own photo, checking the bytes rather than the claimed type', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const ok = await request().post('/api/me/photo').send({ photo: `data:image/png;base64,${png}` });
    expect(ok.status).toBe(200);
    expect(ok.body.data.photo_url).toBe(`data:image/png;base64,${png}`);

    // Text dressed up as a JPEG: the prefix claims an image, the bytes do not.
    const fake = Buffer.from('<script>alert(1)</script>').toString('base64');
    const bad = await request().post('/api/me/photo').send({ photo: `data:image/jpeg;base64,${fake}` });
    expect(bad.status).toBe(400);
    expect((await request().post('/api/me/photo').send({ photo: 'javascript:alert(1)' })).status).toBe(400);

    const gone = await request().delete('/api/me/photo');
    expect(gone.body.data.photo_url).toBeNull();
  });

  it('lets the trainer read the member\'s own goals, and only in their own studio', async () => {
    const made = await request().post('/api/me/goals').send({ kind: 'sessions', target_value: 20 });
    expect(made.status).toBeLessThan(300);
    const mine = await trainerApp.goalsForStudio(CLIENT, ORG);
    expect(mine.goals.map((g) => g.kind)).toContain('sessions');
    expect(await trainerApp.goalsForStudio(CLIENT, OTHER_ORG)).toBeNull();
  });
});
