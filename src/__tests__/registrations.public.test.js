'use strict';

// The public Start Free endpoint is unauthenticated. Its only job is to write
// an application row; no payload may turn into an account or a role.

jest.mock('../modules/platform/super-admin/shared', () => ({
  EMAIL_RE: /^[^@\s]+@[^@\s]+\.[^@\s]+$/,
  pool: { query: jest.fn() },
  logger: { info: jest.fn() },
  bcrypt: { hash: jest.fn(async () => 'hashed') },
  crypto: require('crypto'),
  audit: jest.fn(),
  slugify: jest.fn(),
  uniqueSlug: jest.fn(),
}));

const request = require('supertest');
const express = require('express');
const pool = require('../modules/platform/super-admin/shared').pool;

const app = express();
app.use(express.json());
app.use('/api/registrations', require('../routes/registrations'));

it('ignores role fields and writes only a studio_registrations row', async () => {
  pool.query
    .mockResolvedValueOnce({ rows: [] }) // duplicate check
    .mockResolvedValueOnce({ rows: [] }) // existing user check
    .mockResolvedValueOnce({ rows: [{ id: 'reg-1', status: 'pending' }] });

  const res = await request(app).post('/api/registrations').send({
    full_name: 'Asha Rao',
    business_name: 'Asha Strength',
    mobile: '9876543210',
    email: 'asha@example.com',
    password: 'Str0ng!pass',
    role: 'trainer',
    account_type: 'member',
    user_role: 'super_admin',
  });

  expect(res.status).toBe(201);
  const sql = pool.query.mock.calls.map(([text]) => text.replace(/\s+/g, ' '));
  expect(sql.filter((text) => /INSERT INTO users/i.test(text))).toEqual([]);
  expect(sql.filter((text) => /INSERT INTO trainers/i.test(text))).toEqual([]);
  expect(sql.filter((text) => /INSERT INTO studio_registrations/i.test(text))).toHaveLength(1);
  expect(pool.query.mock.calls.at(-1)[1]).not.toContain('trainer');
  expect(pool.query.mock.calls.at(-1)[1]).not.toContain('member');
  expect(pool.query.mock.calls.at(-1)[1]).not.toContain('super_admin');
});
