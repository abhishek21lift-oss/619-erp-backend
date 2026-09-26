'use strict';
// Member ↔ studio messaging, end to end against a real migrated database.
//
// Both sides of one conversation: the member through /api/me/messages (their
// own thread, no id taken from the request), the trainer through
// /api/messages/:clientId (an id, checked against their own studio). Real SQL,
// so a column name that does not exist — `notifications.read_at` was very
// nearly one — fails here rather than in production.
//
// Gated on RLS_TEST_DATABASE_URL like the other real-database suites. Locally:
//   ./scripts/rls-proof-setup.sh
//   RLS_TEST_DATABASE_URL=postgres://postgres@localhost:55432/rls_proof npx jest clientMessages.realDb

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('messaging against a real database', () => {
    it('has a database to run against', () => {
      throw new Error('RLS_TEST_DATABASE_URL is not set in CI — the messaging schema check would skip.');
    });
  });
}

const mockDbUrl = DB_URL;
jest.mock('../db/pool', () => {
  if (!mockDbUrl) return { query: jest.fn(), connect: jest.fn() };
  const { Pool } = jest.requireActual('pg');
  return new Pool({ connectionString: mockDbUrl, max: 4 });
});

// Unique to this suite: the real-database suites share one database in parallel.
const ORG = 'c1e70000-0000-4000-8000-000000000211';
const OTHER_ORG = 'c1e70000-0000-4000-8000-000000000212';
const CLIENT = 'msg-int-client';
const OTHER_CLIENT = 'msg-int-other-client';
const MEMBER_USER = 'msg-int-member';
const TRAINER_USER = 'msg-int-trainer';

describeIf('member ↔ studio messaging against a real database', () => {
  let pool;
  let memberApp;
  let studioApp;

  function appAs(user, mount, routes) {
    const express = require('express');
    const a = express();
    a.use(express.json());
    a.use(mount, (req, _res, next) => { req.user = user; next(); }, require(routes));
    a.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
    return a;
  }

  beforeAll(async () => {
    pool = require('../db/pool');
    await pool.query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1, 'Message Studio', 'msg-int'), ($2, 'Elsewhere', 'msg-int-2')
       ON CONFLICT (id) DO NOTHING`, [ORG, OTHER_ORG]);
    await pool.query(
      `INSERT INTO pt_clients (id, name, mobile, organization_id)
       VALUES ($1, 'Ravi', '+919000021101', $2), ($3, 'Someone Else', '+919000021102', $4)
       ON CONFLICT (id) DO NOTHING`, [CLIENT, ORG, OTHER_CLIENT, OTHER_ORG]);
    await pool.query(
      `INSERT INTO users (id, name, email, password, role, organization_id, pt_client_id, is_active)
       VALUES ($1, 'Ravi', 'ravi@msg.test', '!not-a-hash', 'member', $2, $3, TRUE)
       ON CONFLICT (id) DO NOTHING`, [MEMBER_USER, ORG, CLIENT]);
    await pool.query(
      `INSERT INTO users (id, name, email, password, role, organization_id, is_active)
       VALUES ($1, 'Coach Asha', 'asha@msg.test', '!not-a-hash', 'trainer', $2, TRUE)
       ON CONFLICT (id) DO NOTHING`, [TRAINER_USER, ORG]);

    memberApp = appAs(
      { id: MEMBER_USER, role: 'member', organization_id: ORG, pt_client_id: CLIENT },
      '/api/me', '../modules/client-portal/client-portal.routes',
    );
    studioApp = appAs(
      { id: TRAINER_USER, name: 'Coach Asha', role: 'trainer', organization_id: ORG },
      '/api/messages', '../modules/client-messages/client-messages.routes',
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM client_messages WHERE organization_id = ANY($1::uuid[])`, [[ORG, OTHER_ORG]]);
    await pool.query(`DELETE FROM notifications WHERE user_id = ANY($1)`, [[MEMBER_USER, TRAINER_USER]]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [[MEMBER_USER, TRAINER_USER]]);
    await pool.query(`DELETE FROM pt_clients WHERE id = ANY($1)`, [[CLIENT, OTHER_CLIENT]]);
    await pool.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG, OTHER_ORG]]);
    await pool.end();
  });

  const member = () => require('supertest')(memberApp);
  const studio = () => require('supertest')(studioApp);

  test('a new member sees an empty thread with their studio', async () => {
    const res = await member().get('/api/me/messages');
    expect(res.status).toBe(200);
    expect(res.body.data.messages).toEqual([]);
    expect(res.body.data.with).toMatchObject({ studio_name: 'Message Studio', trainer_name: 'Coach Asha' });
  });

  test('a member message reaches the trainer: inbox, unread badge and one notification', async () => {
    const first = await member().post('/api/me/messages').send({ body: '  Can we move Friday to 7am?  ' });
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({ sender: 'member', body: 'Can we move Friday to 7am?', read_at: null });
    await member().post('/api/me/messages').send({ body: 'Also, knee feels better.' });

    const unread = await studio().get('/api/messages/unread-count');
    expect(unread.body.data.unread).toBe(2);

    const inbox = await studio().get('/api/messages');
    expect(inbox.body.data).toEqual([expect.objectContaining({
      client_id: CLIENT, client_name: 'Ravi', unread: 2, last_sender: 'member',
      last_body: 'Also, knee feels better.', has_login: true,
    })]);

    // Two messages, one notification: a burst is one "new message".
    const { rows } = await pool.query(
      `SELECT title, link FROM notifications WHERE user_id = $1 AND type = 'message'`, [TRAINER_USER]);
    expect(rows).toEqual([{ title: 'New message from Ravi', link: `/messages?client=${CLIENT}` }]);
  });

  test('the trainer opening the thread marks the member\'s messages read', async () => {
    const res = await studio().get(`/api/messages/${CLIENT}`);
    expect(res.status).toBe(200);
    expect(res.body.data.messages.map((m) => m.body)).toEqual(['Can we move Friday to 7am?', 'Also, knee feels better.']);
    expect(res.body.data.client).toMatchObject({ id: CLIENT, name: 'Ravi', has_login: true });

    const unread = await studio().get('/api/messages/unread-count');
    expect(unread.body.data.unread).toBe(0);
  });

  test('a trainer reply reaches the member and is marked read when they open it', async () => {
    const reply = await studio().post(`/api/messages/${CLIENT}`).send({ body: 'Friday 7am works. See you!' });
    expect(reply.status).toBe(201);
    expect(reply.body.data.sender).toBe('studio');

    expect((await member().get('/api/me/messages/unread-count')).body.data.unread).toBe(1);
    const { rows } = await pool.query(
      `SELECT title, link FROM notifications WHERE user_id = $1 AND type = 'message'`, [MEMBER_USER]);
    expect(rows).toEqual([{ title: 'New message from Coach Asha', link: '/member/messages' }]);

    const thread = await member().get('/api/me/messages');
    expect(thread.body.data.messages.map((m) => m.sender)).toEqual(['member', 'member', 'studio']);
    expect((await member().get('/api/me/messages/unread-count')).body.data.unread).toBe(0);
  });

  test('an empty or oversized message is refused on either side', async () => {
    expect((await member().post('/api/me/messages').send({ body: '   ' })).status).toBe(400);
    expect((await studio().post(`/api/messages/${CLIENT}`).send({ body: 'x'.repeat(2001) })).status).toBe(400);
  });

  test('the trainer cannot read or write another studio\'s client — a 404, not a 403', async () => {
    expect((await studio().get(`/api/messages/${OTHER_CLIENT}`)).status).toBe(404);
    expect((await studio().post(`/api/messages/${OTHER_CLIENT}`).send({ body: 'hi' })).status).toBe(404);
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM client_messages WHERE client_id = $1`, [OTHER_CLIENT]);
    expect(rows[0].n).toBe(0);
  });
});
