'use strict';
// Message opt-out, against a real migrated database (Phase 2, migration 226).
//
// A client may opt out of WhatsApp and email separately. An opt-out stops
// reminders and promotional messages; a payment receipt still goes. Every
// stopped message is recorded as 'suppressed', once, and uses no quota. The
// opt-out is honoured at queue time AND at send time, and the studio broadcast
// reaches only its own clients.

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('Message opt-out, against a real database', () => {
    it('has a database to run against', () => {
      throw new Error('RLS_TEST_DATABASE_URL is not set in CI — the opt-out proof would skip.');
    });
  });
}

const mockDbUrl = DB_URL;
jest.mock('../db/pool', () => {
  if (!mockDbUrl) return { query: jest.fn(), connect: jest.fn() };
  const { Pool } = jest.requireActual('pg');
  return new Pool({ connectionString: mockDbUrl, max: 4 });
});
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
// The queue is not under test: a queued row is enough to prove it would send.
const mockEnqueue = jest.fn(async (_kind, data) => ({ id: `job-${data.logId}` }));
jest.mock('../services/whatsapp.service', () => ({
  ...jest.requireActual('../services/whatsapp.service'),
  enqueueWhatsapp: (...a) => mockEnqueue(...a),
}));
const mockTransportSend = jest.fn(async () => ({ status: 'sent', provider_id: 'P1', provider: 'test' }));
jest.mock('../modules/messaging/transport', () => ({
  ...jest.requireActual('../modules/messaging/transport'),
  send: (...a) => mockTransportSend(...a),
}));
const mockEmail = jest.fn(async () => ({ sent: true, messageId: 'M1' }));
jest.mock('../lib/email', () => ({ ...jest.requireActual('../lib/email'), sendRaw: (...a) => mockEmail(...a) }));
jest.mock('../lib/redis', () => ({ ...jest.requireActual('../lib/redis'), ensureReady: async () => false }));

const ORG = 'c1e70000-0000-4000-8000-000000000401';
const OTHER_ORG = 'c1e70000-0000-4000-8000-000000000402';
const USER = 'pto-trainer-user';
const mockUser = { id: USER, name: 'PTO Trainer', role: 'trainer', organization_id: ORG };
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  requireTrainer: (...a) => jest.requireActual('../middleware/rbac').requireTrainer(...a),
  requireTrainerOrSelf: (...a) => jest.requireActual('../middleware/rbac').requireTrainerOrSelf(...a),
  computeAccess: () => ({ allowed: true, state: 'active' }),
}));
jest.mock('../middleware/rbac', () => ({
  ...jest.requireActual('../middleware/rbac'),
  requireTrainer: (_req, _res, next) => next(),
}));

const { randomUUID } = require('crypto');

describeIf('Message opt-out, against a real database', () => {
  let pool;
  let engine;
  let request;
  const clients = [];

  beforeAll(async () => {
    pool = require('../db/pool');
    engine = require('../modules/automation/automation.engine');
    for (const [id, slug] of [[ORG, 'pto-studio'], [OTHER_ORG, 'pto-other']]) {
      await pool.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $2) ON CONFLICT (id) DO NOTHING`, [id, slug]);
    }
    await pool.query(`INSERT INTO users (id, name, email, password, role, organization_id, is_active)
      VALUES ($1, 'PTO Trainer', 'pto@test.invalid', '!x', 'trainer', $2, TRUE) ON CONFLICT (id) DO NOTHING`, [USER, ORG]);
    await pool.query(`INSERT INTO whatsapp_automation_settings (organization_id, automation_enabled, daily_send_limit)
      VALUES ($1, TRUE, 100) ON CONFLICT (organization_id) DO UPDATE SET automation_enabled = TRUE, daily_send_limit = 100`, [ORG]);
    for (const event of ['birthday', 'payment_received', 'membership_expiring']) {
      await pool.query(`INSERT INTO automation_rules (name, trigger_event, template, organization_id)
        VALUES ($1, $1, 'Hi {{name}}', $2)`, [event, ORG]);
    }
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/pt-os', require('../modules/pt-os/pt-os.routes'));
    app.use('/api/v1/notifications', require('../modules/notifications/notifications.routes'));
    app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
    request = () => require('supertest')(app);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM communication_logs WHERE organization_id = ANY($1)', [[ORG, OTHER_ORG]]);
    await pool.query('DELETE FROM notification_log WHERE recipient_member_id = ANY($1)', [clients]);
    await pool.query('DELETE FROM automation_rules WHERE organization_id = $1', [ORG]);
    await pool.query('DELETE FROM whatsapp_automation_settings WHERE organization_id = $1', [ORG]);
    await pool.query('DELETE FROM activity_log WHERE user_id = $1', [USER]);
    await pool.query('DELETE FROM pt_clients WHERE id = ANY($1)', [clients]);
    await pool.query('DELETE FROM users WHERE id = $1', [USER]);
    await pool.query('DELETE FROM organizations WHERE id = ANY($1)', [[ORG, OTHER_ORG]]);
    await pool.end();
  });

  beforeEach(() => { mockEnqueue.mockClear(); mockTransportSend.mockClear(); mockEmail.mockClear(); });

  async function client({ whatsapp = false, email = false, org = ORG } = {}) {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO pt_clients (id, name, mobile, email, status, organization_id, whatsapp_opt_out, email_opt_out)
       VALUES ($1, 'Opt Client', $2, $1 || '@test.invalid', 'active', $3, $4, $5)`,
      [id, `96${String(Date.now() + clients.length).slice(-8)}`, org, whatsapp, email]);
    clients.push(id);
    return id;
  }
  const logs = async (id) => (await pool.query(
    `SELECT status, failure_reason, automation_dedupe_key FROM communication_logs WHERE recipient_id = $1 ORDER BY created_at`, [id])).rows;
  // The sweeps key each event on the client and the day, so the dedupe key is per client.
  const emit = (id, event, eventKey = `${id}:2026-10-02`) => engine.emit({ orgId: ORG, event, subjectId: id, eventKey });

  describe('automation (WhatsApp)', () => {
    it('a client who has not opted out is queued as before', async () => {
      const id = await client();
      expect((await emit(id, 'birthday')).outcome).toBe('queued');
      expect((await logs(id)).map((r) => r.status)).toEqual(['queued']);
    });

    it('an opted-out client gets a suppressed record, not a message', async () => {
      const id = await client({ whatsapp: true });
      const out = await emit(id, 'birthday');
      expect(out.outcome).toBe('opted_out');
      expect(mockEnqueue).not.toHaveBeenCalled();
      expect(await logs(id)).toEqual([{ status: 'suppressed', failure_reason: 'opted_out', automation_dedupe_key: expect.stringMatching(/^birthday:/) }]);
    });

    it('the same event again writes nothing more — one record per event', async () => {
      const id = await client({ whatsapp: true });
      await emit(id, 'membership_expiring');
      await emit(id, 'membership_expiring');
      expect(await logs(id)).toHaveLength(1);
    });

    it('a payment receipt still goes to an opted-out client', async () => {
      const id = await client({ whatsapp: true });
      expect((await emit(id, 'payment_received', `pay-${id}`)).outcome).toBe('queued');
    });

    it('suppressed records use none of the daily quota', async () => {
      const repo = require('../modules/automation/automation.repository');
      const before = await repo.sendsToday(ORG);
      await emit(await client({ whatsapp: true }), 'birthday');
      expect(await repo.sendsToday(ORG)).toBe(before);
    });

    it('opting out after a message was queued stops it at send time', async () => {
      const id = await client();
      const out = await emit(id, 'birthday');
      const logId = out.results[0].logId;
      await pool.query('UPDATE pt_clients SET whatsapp_opt_out = TRUE WHERE id = $1', [id]);

      const { processAutomationJob } = jest.requireActual('../services/whatsapp.service');
      const res = await processAutomationJob({ data: { logId, orgId: ORG }, attemptsMade: 0, opts: { attempts: 3 } });
      expect(res).toEqual({ status: 'skipped', reason: 'opted_out' });
      expect(mockTransportSend).not.toHaveBeenCalled();
      expect((await logs(id))[0]).toMatchObject({ status: 'suppressed', failure_reason: 'opted_out' });
    });
  });

  describe('recording the preference', () => {
    it('PATCH sets the flags, stamps who and when, and keeps it in the activity log', async () => {
      const id = await client();
      const res = await request().patch(`/api/pt-os/clients/${id}`).send({ whatsapp_opt_out: true });
      expect(res.status).toBe(200);
      const { rows: [c] } = await pool.query(
        'SELECT whatsapp_opt_out, email_opt_out, comm_prefs_updated_by, comm_prefs_updated_at FROM pt_clients WHERE id = $1', [id]);
      expect(c).toMatchObject({ whatsapp_opt_out: true, email_opt_out: false, comm_prefs_updated_by: USER });
      expect(c.comm_prefs_updated_at).toBeTruthy();
      const { rows: audit } = await pool.query(
        `SELECT 1 FROM activity_log WHERE action = 'client.update' AND entity_id = $1 AND (new_data->>'whatsapp_opt_out')::boolean`, [id]);
      expect(audit).toHaveLength(1);
    });

    it('a non-boolean is refused', async () => {
      expect((await request().patch(`/api/pt-os/clients/${await client()}`).send({ email_opt_out: 'yes' })).status).toBe(400);
    });
  });

  describe('the studio broadcast', () => {
    const broadcast = (ids, channels) => request().post('/api/v1/notifications/broadcast')
      .send({ type: 'membership_expiring', member_ids: ids, data: { days: 3, plan: 'PT' }, channels });

    it('reaches only this studio\'s clients; another studio\'s id is skipped, not looked up elsewhere', async () => {
      const mine = await client();
      const theirs = await client({ org: OTHER_ORG });
      const res = await broadcast([mine, theirs], ['inapp']);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ count: 1, skipped: 1 });
    });

    it('an email opt-out stops the email and records it as suppressed', async () => {
      const id = await client({ email: true });
      await broadcast([id], ['email']);
      expect(mockEmail).not.toHaveBeenCalled();
      const { rows } = await pool.query(
        `SELECT status, error FROM notification_log WHERE recipient_member_id = $1 AND channel = 'email'`, [id]);
      expect(rows).toEqual([{ status: 'suppressed', error: 'opted_out' }]);
    });
  });
});
