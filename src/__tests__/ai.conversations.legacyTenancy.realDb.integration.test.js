'use strict';
// Legacy conversation endpoints — tenant ownership against a real PostgreSQL
// as the real `app_tenant` role.
//
// GET/PATCH/DELETE /api/ai/conversations/:id and GET /api/ai/conversations
// filtered on the authenticated user only. A trainer who moved studios (or an
// org-less legacy thread) could therefore still read, rename or delete another
// studio's conversation. These tests pin the authenticated organization into
// every path and prove a missing/NULL org fails closed.
//
// Skipped unless RLS_TEST_DATABASE_URL points at a disposable/staging database
// with an `app_tenant` login. RLS_TEST_TENANT_PASSWORD supplies its password.

const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('Legacy conversation tenancy real-database proof', () => {
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

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const aiRouter = TENANT_URL ? require('../routes/ai') : null;
const { auth, requireTrainer, invalidateUserCache } = TENANT_URL
  ? require('../middleware/auth')
  : {};

jest.setTimeout(60000);

const ORG_A = 'e5a10000-0000-4000-8000-000000000001';
const ORG_B = 'e5b20000-0000-4000-8000-000000000002';
const ORG_C = 'e5c30000-0000-4000-8000-000000000003';
const USER_A = 'e5a10000-0000-4000-8000-00000000000a';
const USER_B = 'e5b20000-0000-4000-8000-00000000000b';
const CONV_A = 'e5c00000-0000-4000-8000-0000000000a1';
const CONV_B = 'e5c00000-0000-4000-8000-0000000000b1';
const CONV_NULL = 'e5c00000-0000-4000-8000-0000000000c1';
const UNKNOWN = 'e5c00000-0000-4000-8000-0000000000ff';

const tokenFor = (id) => jwt.sign({ id, token_version: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
const cookie = (id) => `token=${tokenFor(id)}`;

describeIf('Legacy conversation tenancy against a real database', () => {
  let owner;
  let app;
  let appPool;

  beforeAll(async () => {
    owner = new Pool({ connectionString: DB_URL, max: 4 });
    appPool = require('../db/pool');

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    // Mirrors server.js: every /api/ai route is behind auth + trainer.
    app.use('/api/ai', auth, requireTrainer, aiRouter);
  });

  const cleanup = async () => {
    await owner.query('DELETE FROM ai_messages WHERE conversation_id IN ($1,$2,$3)', [CONV_A, CONV_B, CONV_NULL]);
    await owner.query('DELETE FROM ai_conversations WHERE id IN ($1,$2,$3)', [CONV_A, CONV_B, CONV_NULL]);
    await owner.query('DELETE FROM users WHERE id IN ($1,$2)', [USER_A, USER_B]);
    await owner.query('DELETE FROM organizations WHERE id IN ($1,$2,$3)', [ORG_A, ORG_B, ORG_C]);
  };

  const seed = async ({ convOrg = ORG_A, convUser = USER_A, convId = CONV_A } = {}) => {
    await owner.query(
      `INSERT INTO ai_conversations (id, user_id, organization_id, title)
       VALUES ($1,$2,$3,'legacy thread')`,
      [convId, convUser, convOrg]
    );
    await owner.query(
      `INSERT INTO ai_messages (conversation_id, role, content)
       VALUES ($1,'user','hello'), ($1,'assistant','hi')`,
      [convId]
    );
  };

  beforeEach(async () => {
    await cleanup();

    await owner.query(
      `INSERT INTO organizations (id, name, slug)
       VALUES ($1,'E5 Studio A','e5-studio-a'), ($2,'E5 Studio B','e5-studio-b'),
              ($3,'E5 Studio C','e5-studio-c')`,
      [ORG_A, ORG_B, ORG_C]
    );
    await owner.query(
      `INSERT INTO users (id, name, email, password, role, organization_id, is_active)
       VALUES ($1,'E5 Trainer A','e5-trainer-a@test.invalid','!x','trainer',$3,TRUE),
              ($2,'E5 Trainer B','e5-trainer-b@test.invalid','!x','trainer',$4,TRUE)`,
      [USER_A, USER_B, ORG_A, ORG_B]
    );
    invalidateUserCache();
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

  describe('same-user, same-studio access is preserved', () => {
    test('GET returns the conversation and its messages', async () => {
      await seed();
      const res = await request(app).get(`/api/ai/conversations/${CONV_A}`).set('Cookie', cookie(USER_A));
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(CONV_A);
      expect(res.body.data.messages).toHaveLength(2);
    });

    test('PATCH renames and pins the conversation', async () => {
      await seed();
      const res = await request(app)
        .patch(`/api/ai/conversations/${CONV_A}`)
        .set('Cookie', cookie(USER_A))
        .send({ title: 'renamed', pinned: true });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ id: CONV_A, title: 'renamed', pinned: true });
    });

    test('DELETE removes the conversation', async () => {
      await seed();
      const res = await request(app).delete(`/api/ai/conversations/${CONV_A}`).set('Cookie', cookie(USER_A));
      expect(res.status).toBe(200);
      const { rows } = await owner.query('SELECT id FROM ai_conversations WHERE id = $1', [CONV_A]);
      expect(rows).toHaveLength(0);
    });

    test('the list returns only the caller\'s same-studio conversations', async () => {
      await seed();
      await seed({ convOrg: ORG_B, convUser: USER_B, convId: CONV_B });
      await seed({ convOrg: null, convUser: USER_A, convId: CONV_NULL });

      const res = await request(app).get('/api/ai/conversations').set('Cookie', cookie(USER_A));
      expect(res.status).toBe(200);
      expect(res.body.data.map((row) => row.id)).toEqual([CONV_A]);
    });
  });

  describe('cross-tenant access is refused without disclosure', () => {
    test('another studio cannot read, rename or delete the thread', async () => {
      await seed();

      const foreignGet = await request(app).get(`/api/ai/conversations/${CONV_A}`).set('Cookie', cookie(USER_B));
      const foreignPatch = await request(app)
        .patch(`/api/ai/conversations/${CONV_A}`)
        .set('Cookie', cookie(USER_B))
        .send({ title: 'stolen' });
      const foreignDelete = await request(app)
        .delete(`/api/ai/conversations/${CONV_A}`)
        .set('Cookie', cookie(USER_B));

      expect(foreignGet.status).toBe(404);
      expect(foreignPatch.status).toBe(404);
      expect(foreignDelete.status).toBe(404);
      // An unknown id answers identically.
      const unknown = await request(app).get(`/api/ai/conversations/${UNKNOWN}`).set('Cookie', cookie(USER_B));
      expect(unknown.status).toBe(404);
      expect(foreignGet.body).toEqual(unknown.body);

      const { rows } = await owner.query(
        'SELECT title FROM ai_conversations WHERE id = $1', [CONV_A]
      );
      expect(rows[0].title).toBe('legacy thread');
    });

    test('a user moved to another studio cannot reach the old thread', async () => {
      await seed();
      await owner.query('UPDATE users SET organization_id = $2 WHERE id = $1', [USER_A, ORG_C]);
      invalidateUserCache();

      const res = await request(app).get(`/api/ai/conversations/${CONV_A}`).set('Cookie', cookie(USER_A));
      expect(res.status).toBe(404);
    });
  });

  describe('a missing organization fails closed', () => {
    test('a NULL-org conversation is invisible and immutable', async () => {
      await seed({ convOrg: null, convId: CONV_NULL });

      const get = await request(app).get(`/api/ai/conversations/${CONV_NULL}`).set('Cookie', cookie(USER_A));
      const patch = await request(app)
        .patch(`/api/ai/conversations/${CONV_NULL}`)
        .set('Cookie', cookie(USER_A))
        .send({ title: 'claimed' });
      const del = await request(app).delete(`/api/ai/conversations/${CONV_NULL}`).set('Cookie', cookie(USER_A));

      expect(get.status).toBe(404);
      expect(patch.status).toBe(404);
      expect(del.status).toBe(404);

      const { rows } = await owner.query(
        'SELECT title FROM ai_conversations WHERE id = $1', [CONV_NULL]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].title).toBe('legacy thread');
    });

    test('the database refuses a tenant account with no studio', async () => {
      await seed();
      // The route-level fail-closed case is the NULL-org conversation above.
      // An org-less trainer session is unreachable: the schema stops it first,
      // and auth.js repeats the check for any row that somehow bypassed it.
      await expect(
        owner.query('UPDATE users SET organization_id = NULL WHERE id = $1', [USER_A])
      ).rejects.toMatchObject({ code: '23514', constraint: 'users_tenant_or_platform' });
    });
  });
});
