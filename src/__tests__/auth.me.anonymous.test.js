// GET /api/auth/me must not treat "never signed in" as "session expired".
//
// The web app answers any 401 with a refresh attempt, and a failed refresh
// fires its session-expired handler. For a visitor with no cookies at all
// that whole path is noise on every landing-page load — so /me answers 200
// with no user. A refresh cookie still present is the one case that needs the
// 401: that is what makes the app refresh an expired access token and retry.

process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long!!';

jest.mock('otplib', () => ({
  verifySync: jest.fn(() => false),
  authenticator: { verify: jest.fn(() => false), generateSecret: jest.fn(() => 'S') },
}));

jest.mock('../db/pool', () => ({ query: jest.fn(), connect: jest.fn() }));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const pool = require('../db/pool');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/auth', require('../routes/auth'));

beforeEach(() => pool.query.mockReset());

describe('GET /api/auth/me', () => {
  it('answers 200 with no user when the caller has neither cookie', async () => {
    const res = await request(app).get('/api/auth/me');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ user: null });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('answers 401 when only the refresh cookie is left, so the app can refresh', async () => {
    const res = await request(app).get('/api/auth/me').set('Cookie', 'refresh_token=stale');

    expect(res.status).toBe(401);
    expect(pool.query).not.toHaveBeenCalled();
  });
});
