'use strict';
// F1 — Copilot conversation tenancy, proven against a real PostgreSQL as the
// real `app_tenant` role.
//
// Phase 4.3D found POST /api/ai/chat inserting conversations with no
// organization_id. Every symptom followed: tool runs could not resolve the
// conversation through the org-scoped subselect, per-conversation history
// 404'd, and provenance was lost. These tests run the actual route and the
// actual ledger against a real database, with tokens the real auth middleware
// verifies, so the organization is the one carried by the authenticated user
// row — never one supplied by the caller.
//
// Skipped unless RLS_TEST_DATABASE_URL points at a disposable/staging database
// with an `app_tenant` login. RLS_TEST_TENANT_PASSWORD supplies its password.

const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('Copilot conversation tenancy real-database proof', () => {
    it('has a database to run against', () => {
      throw new Error('RLS_TEST_DATABASE_URL is not set in CI');
    });
  });
}

const TENANT_URL = DB_URL
  ? (() => {
      const url = new URL(DB_URL);
      url.username = 'app_tenant';
      url.password = process.env.RLS_TEST_TENANT_PASSWORD || 'localproof';
      return url.toString();
    })()
  : null;

const original = {
  DATABASE_URL: process.env.DATABASE_URL,
  ADMIN_DATABASE_URL: process.env.ADMIN_DATABASE_URL,
  TENANT_RLS_ENFORCE: process.env.TENANT_RLS_ENFORCE,
  JWT_SECRET: process.env.JWT_SECRET,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
};

if (TENANT_URL) {
  process.env.DATABASE_URL = TENANT_URL;
  process.env.ADMIN_DATABASE_URL = DB_URL;
  process.env.TENANT_RLS_ENFORCE = 'on';
  process.env.JWT_SECRET = 'f'.repeat(64);
  process.env.OPENROUTER_API_KEY = 'test-key';
}

jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn(),
}));
jest.mock('../lib/ai/router', () => ({
  routedChat: jest.fn(),
  routedStream: jest.fn(async function* () { yield 'ok'; }),
}));
jest.mock('../lib/ai/knowledgeBase', () => ({ retrieveContext: jest.fn(async () => []) }));
jest.mock('../lib/ai/usage', () => ({
  logUsage: jest.fn(async () => {}),
  getUserUsage: jest.fn(),
  getModelStats: jest.fn(),
}));
jest.mock('../lib/sse-heartbeat', () => ({ startSseHeartbeat: jest.fn(() => () => {}) }));

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const aiRouter = TENANT_URL ? require('../routes/ai') : null;
const copilotRouter = TENANT_URL ? require('../modules/copilot/copilot.routes') : null;
const { auth } = TENANT_URL ? require('../middleware/auth') : {};
const { requireTrainer } = TENANT_URL ? require('../middleware/rbac') : {};

jest.setTimeout(60000);

const ORG_A = 'f1a10000-0000-4000-8000-000000000001';
const ORG_B = 'f1b20000-0000-4000-8000-000000000002';
const USER_A = 'f1a10000-0000-4000-8000-00000000000a';
const USER_B = 'f1b20000-0000-4000-8000-00000000000b';
const MEMBER_A = 'f1a10000-0000-4000-8000-0000000000cc';

const tokenFor = (id) => jwt.sign({ id, token_version: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });

/** Every `data:` frame the route wrote, parsed in order. */
const frames = (text) => text
  .split('\n\n')
  .map((block) => block.split('\n').find((line) => line.startsWith('data: ')))
  .filter(Boolean)
  .map((line) => JSON.parse(line.slice(6)));

const startConversationId = (text) => {
  const start = frames(text).find((f) => f.type === 'start');
  return start ? start.conversation_id : null;
};

describeIf('Copilot conversation tenancy against a real database', () => {
  let owner;
  let app;
  let appPool;

  beforeAll(async () => {
    owner = new Pool({ connectionString: DB_URL, max: 4 });
    appPool = require('../db/pool');

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/ai/copilot', auth, requireTrainer, copilotRouter);
    app.use('/api/ai', aiRouter);
  });

  const cleanup = async () => {
    await owner.query('DELETE FROM ai_tool_runs WHERE organization_id IN ($1,$2)', [ORG_A, ORG_B]);
    await owner.query(`DELETE FROM ai_messages WHERE conversation_id IN (
      SELECT id FROM ai_conversations WHERE organization_id IN ($1,$2))`, [ORG_A, ORG_B]);
    await owner.query('DELETE FROM ai_conversations WHERE organization_id IN ($1,$2)', [ORG_A, ORG_B]);
    await owner.query('DELETE FROM pt_clients WHERE organization_id IN ($1,$2)', [ORG_A, ORG_B]);
    await owner.query('DELETE FROM users WHERE id IN ($1,$2,$3)', [USER_A, USER_B, MEMBER_A]);
    await owner.query('DELETE FROM organizations WHERE id IN ($1,$2)', [ORG_A, ORG_B]);
  };

  beforeEach(async () => {
    await cleanup();

    await owner.query(
      `INSERT INTO organizations (id, name, slug)
       VALUES ($1,'F1 Studio A','f1-studio-a'), ($2,'F1 Studio B','f1-studio-b')`,
      [ORG_A, ORG_B]
    );
    await owner.query(
      `INSERT INTO users (id, name, email, password, role, organization_id, is_active)
       VALUES ($1,'F1 Trainer A','f1-trainer-a@test.invalid','!x','trainer',$3,TRUE),
              ($2,'F1 Trainer B','f1-trainer-b@test.invalid','!x','trainer',$4,TRUE),
              ($5,'F1 Member A','f1-member-a@test.invalid','!x','member',$3,TRUE)`,
      [USER_A, USER_B, ORG_A, ORG_B, MEMBER_A]
    );
    // The auth cache holds a user row for 30s; clear it so fixtures created
    // between tests are what the next request authenticates as.
    const authModule = require('../middleware/auth');
    if (authModule.invalidateUserCache) authModule.invalidateUserCache();
  });

  afterAll(async () => {
    await cleanup();
    await appPool?.end();
    const ownerDiag = appPool?.ownerPoolForDiagnostics?.();
    if (ownerDiag && ownerDiag !== appPool) await ownerDiag.end().catch(() => {});
    await owner?.end();
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  describe('creation', () => {
    test('a new conversation is stamped with the authenticated organization', async () => {
      const res = await request(app)
        .post('/api/ai/chat')
        .set('Cookie', `token=${tokenFor(USER_A)}`)
        .send({ message: 'Plan my week' });

      expect(res.status).toBe(200);
      const convId = startConversationId(res.text);
      expect(convId).toBeTruthy();

      const { rows } = await owner.query(
        'SELECT user_id, organization_id FROM ai_conversations WHERE id = $1', [convId]
      );
      expect(rows[0]).toEqual({ user_id: USER_A, organization_id: ORG_A });
    });

    test('a client-supplied organization is ignored in body and headers', async () => {
      const res = await request(app)
        .post('/api/ai/chat')
        .set('Cookie', `token=${tokenFor(USER_A)}`)
        .set('x-organization-id', ORG_B)
        .set('x-org-id', ORG_B)
        .send({ message: 'Plan my week', organization_id: ORG_B, org_id: ORG_B });

      const convId = startConversationId(res.text);
      const { rows } = await owner.query(
        'SELECT organization_id FROM ai_conversations WHERE id = $1', [convId]
      );
      expect(rows[0].organization_id).toBe(ORG_A);
    });

    test('a second studio cannot create a conversation in the first', async () => {
      const res = await request(app)
        .post('/api/ai/chat')
        .set('Cookie', `token=${tokenFor(USER_B)}`)
        .send({ message: 'Plan my week', organization_id: ORG_A });

      const convId = startConversationId(res.text);
      const { rows } = await owner.query(
        'SELECT user_id, organization_id FROM ai_conversations WHERE id = $1', [convId]
      );
      expect(rows[0]).toEqual({ user_id: USER_B, organization_id: ORG_B });
    });

    test('a foreign client id is dropped rather than linked across studios', async () => {
      const foreignClient = randomUUID();
      await owner.query(
        `INSERT INTO pt_clients (id, name, organization_id) VALUES ($1,'Foreign Client',$2)`,
        [foreignClient, ORG_B]
      );

      const res = await request(app)
        .post('/api/ai/chat')
        .set('Cookie', `token=${tokenFor(USER_A)}`)
        .send({ message: 'Plan my week', client_id: foreignClient });

      const convId = startConversationId(res.text);
      const { rows } = await owner.query(
        'SELECT client_id, organization_id FROM ai_conversations WHERE id = $1', [convId]
      );
      expect(rows[0]).toEqual({ client_id: null, organization_id: ORG_A });
    });
  });

  describe('reuse and regeneration', () => {
    const createForA = async () => {
      const res = await request(app)
        .post('/api/ai/chat')
        .set('Cookie', `token=${tokenFor(USER_A)}`)
        .send({ message: 'Plan my week' });
      return startConversationId(res.text);
    };

    test('reuse cannot change the conversation organization', async () => {
      const convId = await createForA();

      const res = await request(app)
        .post('/api/ai/chat')
        .set('Cookie', `token=${tokenFor(USER_A)}`)
        .send({ message: 'And next week?', conversation_id: convId, organization_id: ORG_B });

      expect(res.status).toBe(200);
      const { rows } = await owner.query(
        'SELECT organization_id FROM ai_conversations WHERE id = $1', [convId]
      );
      expect(rows[0].organization_id).toBe(ORG_A);
    });

    test('regeneration preserves the conversation organization', async () => {
      const convId = await createForA();

      const res = await request(app)
        .post('/api/ai/chat')
        .set('Cookie', `token=${tokenFor(USER_A)}`)
        .send({ message: 'answer again', conversation_id: convId, regenerate: true });

      expect(res.status).toBe(200);
      const { rows } = await owner.query(
        'SELECT organization_id FROM ai_conversations WHERE id = $1', [convId]
      );
      expect(rows[0].organization_id).toBe(ORG_A);
    });

    test('a foreign conversation is refused before any turn is written', async () => {
      const convId = await createForA();
      const before = await owner.query(
        'SELECT count(*)::int AS n FROM ai_messages WHERE conversation_id = $1', [convId]
      );

      const res = await request(app)
        .post('/api/ai/chat')
        .set('Cookie', `token=${tokenFor(USER_B)}`)
        .send({ message: 'Read their thread', conversation_id: convId });

      expect(res.status).toBe(404);
      const after = await owner.query(
        'SELECT count(*)::int AS n FROM ai_messages WHERE conversation_id = $1', [convId]
      );
      expect(after.rows[0].n).toBe(before.rows[0].n);
    });
  });

  describe('tool provenance', () => {
    test('a tool run carries the conversation and originating message', async () => {
      const res = await request(app)
        .post('/api/ai/chat')
        .set('Cookie', `token=${tokenFor(USER_A)}`)
        .send({ message: "What's my schedule today?" });

      expect(res.status).toBe(200);
      const convId = startConversationId(res.text);
      expect(frames(res.text).find((f) => f.type === 'tools').tools).toBeTruthy();

      const runs = await owner.query(
        `SELECT tool_name, organization_id, user_id, conversation_id, message_id, status
           FROM ai_tool_runs WHERE conversation_id = $1`, [convId]
      );
      expect(runs.rows.length).toBeGreaterThan(0);
      expect(runs.rows[0]).toMatchObject({
        tool_name: 'get_trainer_schedule',
        organization_id: ORG_A,
        user_id: USER_A,
        conversation_id: convId,
      });
      expect(runs.rows[0].message_id).toBeTruthy();

      const message = await owner.query(
        'SELECT id FROM ai_messages WHERE id = $1 AND conversation_id = $2 AND role = $3',
        [runs.rows[0].message_id, convId, 'user']
      );
      expect(message.rows).toHaveLength(1);

      // The history endpoint returns that same run to its owner.
      const history = await request(app)
        .get(`/api/ai/copilot/conversations/${convId}/tool-runs`)
        .set('Cookie', `token=${tokenFor(USER_A)}`);
      expect(history.status).toBe(200);
      expect(history.body.runs.map((r) => r.tool)).toContain('get_trainer_schedule');

      const runId = history.body.runs[0].id;
      const single = await request(app)
        .get(`/api/ai/copilot/tool-runs/${runId}`)
        .set('Cookie', `token=${tokenFor(USER_A)}`);
      expect(single.status).toBe(200);
      expect(single.body.run.tool).toBe('get_trainer_schedule');
    });

    test('another studio cannot read the history or the run', async () => {
      const res = await request(app)
        .post('/api/ai/chat')
        .set('Cookie', `token=${tokenFor(USER_A)}`)
        .send({ message: "What's my schedule today?" });
      const convId = startConversationId(res.text);

      const runs = await owner.query(
        'SELECT id FROM ai_tool_runs WHERE conversation_id = $1 LIMIT 1', [convId]
      );
      const runId = runs.rows[0].id;

      const history = await request(app)
        .get(`/api/ai/copilot/conversations/${convId}/tool-runs`)
        .set('Cookie', `token=${tokenFor(USER_B)}`);
      expect(history.status).toBe(404);
      expect(history.body.error.code).toBe('CONVERSATION_NOT_FOUND');

      const single = await request(app)
        .get(`/api/ai/copilot/tool-runs/${runId}`)
        .set('Cookie', `token=${tokenFor(USER_B)}`);
      expect(single.status).toBe(404);
      expect(single.body.error.code).toBe('TOOL_RUN_NOT_FOUND');
    });

    test('a member token is rejected by the trainer-only mount', async () => {
      const res = await request(app)
        .get(`/api/ai/copilot/conversations/${randomUUID()}/tool-runs`)
        .set('Cookie', `token=${tokenFor(MEMBER_A)}`);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });
  });

  describe('the one-trainer-per-org constraint stays in force', () => {
    test('a second trainer in the same studio is refused by the database', async () => {
      await expect(owner.query(
        `INSERT INTO users (id, name, email, password, role, organization_id, is_active)
         VALUES ($1,'F1 Trainer A2','f1-trainer-a2@test.invalid','!x','trainer',$2,TRUE)`,
        [randomUUID(), ORG_A]
      )).rejects.toMatchObject({ code: '23505', constraint: 'uq_one_trainer_per_org' });
    });
  });
});
