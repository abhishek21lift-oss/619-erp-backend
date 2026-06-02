jest.mock('../db/pool', () => {
  const store = [
    {
      id: 'usr-1',
      name: 'Admin',
      email: 'admin@619fitness.com',
      password: '$2a$10$abcdefghijklmnopqrstuv', // not a real hash; bcrypt.compare mocked below
      role: 'admin',
      trainer_id: null,
      member_id: null,
      is_active: true,
      token_version: 0,
    },
  ];
  return {
    query: jest.fn(async function(sql, params) {
      if (/SELECT \* FROM users WHERE LOWER\(email\)/i.test(sql)) {
        const email = (params && params[0]) || '';
        const row = store.find(u => u.email.toLowerCase() === email.toLowerCase()) || null;
        return { rows: row ? [row] : [] };
      }
      if (/UPDATE users SET last_login/i.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    }),
  };
});

jest.mock('bcryptjs', () => ({
  compare: jest.fn(async function(plain, hash) {
    return plain === 'correct-password' && hash && hash.length > 0;
  }),
}));

const request = require('supertest');
const express = require('express');
process.env.JWT_SECRET = 'a'.repeat(64);
process.env.DATABASE_URL = 'postgres://test';
process.env.FRONTEND_URL = 'https://test.example.com';
process.env.NODE_ENV = 'test';

const authRouter = require('../routes/auth');
const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);

describe('POST /api/auth/login', () => {
  it('returns 200 and sets a token cookie for valid credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@619fitness.com', password: 'correct-password' });
    expect(res.status).toBe(200);
    expect(res.body.user).toBeDefined();
    expect(res.body.user.email).toBe('admin@619fitness.com');
    expect(res.headers['set-cookie']).toBeDefined();
    expect(res.headers['set-cookie'].join(';')).toMatch(/token=/);
  });

  it('returns 401 for invalid credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@619fitness.com', password: 'wrong-password' });
    expect(res.status).toBe(401);
  });

  it('returns 401 for an unknown email', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@619fitness.com', password: 'correct-password' });
    expect(res.status).toBe(401);
  });
});
