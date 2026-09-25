'use strict';
// Google Calendar connect: the code is exchanged only for the user who
// started the flow.
//
// The callback used to verify `state` and save tokens straight onto
// state.user_id — who STARTED the flow — without checking who FINISHED it. A
// consent link minted on an attacker's account and clicked by a victim wrote
// the victim's Google Calendar onto the attacker's ERP account. Now the
// callback only forwards code + state, and POST /complete (behind auth)
// refuses a state minted for anyone but the signed-in caller.

process.env.JWT_SECRET = 'a'.repeat(64);
process.env.DATABASE_URL = 'postgres://test';
process.env.FRONTEND_URL = 'https://app.example.com';
process.env.GOOGLE_CALENDAR_REDIRECT_URI = 'https://api.example.com/api/calendar/callback';

jest.mock('../db/pool', () => ({ query: jest.fn(async () => ({ rows: [] })) }));

jest.mock('../lib/google-calendar', () => ({
  isConfigured: jest.fn(() => true),
  generateAuthUrl: jest.fn((state) => `https://accounts.google.com/o/oauth2/auth?state=${state}`),
  saveTokensFromCode: jest.fn(async () => {}),
  getStatus: jest.fn(async () => ({ connected: false })),
  disconnect: jest.fn(async () => {}),
}));

let mockUser = { id: 'usr-victim', role: 'trainer', organization_id: 'org-1' };
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = { ...mockUser }; next(); },
}));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const cal = require('../lib/google-calendar');

const app = express();
app.use(express.json());
app.use('/api/calendar', require('../routes/calendar'));

const stateFor = (userId, extra = {}) =>
  jwt.sign({ user_id: userId, purpose: 'calendar_oauth', ...extra }, process.env.JWT_SECRET, { expiresIn: '10m' });

beforeEach(() => {
  cal.saveTokensFromCode.mockClear();
  mockUser = { id: 'usr-victim', role: 'trainer', organization_id: 'org-1' };
});

describe('GET /callback stores nothing', () => {
  it('forwards code and state to the Integrations page without exchanging the code', async () => {
    const state = stateFor('usr-attacker');
    const res = await request(app).get('/api/calendar/callback').query({ code: 'c0de', state });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.location);
    expect(loc.origin + loc.pathname).toBe('https://app.example.com/settings/integrations');
    expect(loc.searchParams.get('calendar')).toBe('confirm');
    expect(loc.searchParams.get('code')).toBe('c0de');
    expect(loc.searchParams.get('state')).toBe(state);
    expect(cal.saveTokensFromCode).not.toHaveBeenCalled();
  });

  it('reports a denied consent', async () => {
    const res = await request(app).get('/api/calendar/callback').query({ error: 'access_denied' });
    expect(res.headers.location).toMatch(/calendar=denied/);
  });

  it('reports missing parameters', async () => {
    const res = await request(app).get('/api/calendar/callback').query({ code: 'x' });
    expect(res.headers.location).toMatch(/calendar=error&reason=missing_params/);
  });
});

describe('POST /complete binds the connection to the signed-in user', () => {
  it('refuses a state minted for a different user (the CSRF case) and never exchanges the code', async () => {
    const res = await request(app).post('/api/calendar/complete')
      .send({ code: 'victim-code', state: stateFor('usr-attacker') });
    expect(res.status).toBe(403);
    expect(cal.saveTokensFromCode).not.toHaveBeenCalled();
  });

  it('connects the caller when the state is their own', async () => {
    const res = await request(app).post('/api/calendar/complete')
      .send({ code: 'own-code', state: stateFor('usr-victim') });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connected: true });
    expect(cal.saveTokensFromCode).toHaveBeenCalledWith('usr-victim', 'own-code');
  });

  it('refuses a forged or expired state', async () => {
    const forged = jwt.sign({ user_id: 'usr-victim', purpose: 'calendar_oauth' }, 'not-the-secret');
    const expired = jwt.sign(
      { user_id: 'usr-victim', purpose: 'calendar_oauth', exp: Math.floor(Date.now() / 1000) - 10 },
      process.env.JWT_SECRET,
    );
    for (const state of [forged, expired, 'garbage']) {
      const res = await request(app).post('/api/calendar/complete').send({ code: 'c', state });
      expect(res.status).toBe(400);
    }
    expect(cal.saveTokensFromCode).not.toHaveBeenCalled();
  });

  it('refuses a token minted for another purpose', async () => {
    const state = jwt.sign({ user_id: 'usr-victim', purpose: 'webauthn_action' }, process.env.JWT_SECRET);
    const res = await request(app).post('/api/calendar/complete').send({ code: 'c', state });
    expect(res.status).toBe(400);
    expect(cal.saveTokensFromCode).not.toHaveBeenCalled();
  });

  it('requires both code and state', async () => {
    const res = await request(app).post('/api/calendar/complete').send({ state: stateFor('usr-victim') });
    expect(res.status).toBe(400);
  });

  it('answers 502 when Google rejects the code', async () => {
    cal.saveTokensFromCode.mockRejectedValueOnce(new Error('invalid_grant'));
    const res = await request(app).post('/api/calendar/complete')
      .send({ code: 'bad', state: stateFor('usr-victim') });
    expect(res.status).toBe(502);
  });
});

describe('GET /auth-url', () => {
  it('no longer returns the redirect URI to the browser', async () => {
    const res = await request(app).get('/api/calendar/auth-url');
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/^https:\/\/accounts\.google\.com\//);
    expect(res.body).not.toHaveProperty('_debug_redirect_uri');
  });
});
