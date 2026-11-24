const request = require('supertest');
const express = require('express');
const { originCheck } = require('../middleware/originCheck');

function app() {
  const a = express();
  // Mounted exactly as server.js does — the mount path matters, because
  // Express strips it and req.path inside the middleware is the remainder.
  a.use('/api/', originCheck);
  a.get('/api/health', (_q, s) => s.json({ ok: true }));
  a.get('/api/clients', (_q, s) => s.json({ ok: true }));
  return a;
}

const OLD = process.env.FRONTEND_URL;
beforeAll(() => { process.env.FRONTEND_URL = 'https://www.619fitnessstudio.com/'; });
afterAll(() => { process.env.FRONTEND_URL = OLD; });

describe('originCheck', () => {
  it('exempts the health check even when a referer is present', async () => {
    // The old exemption compared req.path to '/api/health', which never
    // matched because the mount path is stripped. It only looked fine because
    // Render's probe sends no headers at all.
    const res = await request(app())
      .get('/api/health')
      .set('Referer', 'https://somewhere-else.example/');
    expect(res.status).toBe(200);
  });

  it('still blocks an unknown origin on a normal API route', async () => {
    const res = await request(app())
      .get('/api/clients')
      .set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
  });

  it('allows the configured frontend, trailing slash and all', async () => {
    const res = await request(app())
      .get('/api/clients')
      .set('Origin', 'https://www.619fitnessstudio.com');
    expect(res.status).toBe(200);
  });

  it('passes server-to-server calls that send neither header', async () => {
    const res = await request(app()).get('/api/clients');
    expect(res.status).toBe(200);
  });

  // ── The allowlist is an ORIGIN list, not a hostname list ──────────────────
  //
  // Two holes here, both audit findings:
  //
  //   1. localhost was allowed in EVERY environment. The CORS allowlist has
  //      always been production-aware; this middleware was not, so a page on
  //      http://localhost at the operator's own machine passed a check whose
  //      whole job is to refuse origins the deployment did not configure.
  //   2. The comparison used url.hostname, so `http://` and `https://` were
  //      interchangeable. A plaintext page on the real host — the one case an
  //      active network attacker can produce — passed the same check as the
  //      TLS site.

  it('rejects a localhost origin in production', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const res = await request(app())
        .get('/api/clients')
        .set('Origin', 'http://localhost:3000');
      expect(res.status).toBe(403);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it('still allows localhost outside production, where the dev server lives', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      for (const origin of ['http://localhost:3001', 'http://127.0.0.1:3001', 'http://[::1]:3001']) {
        const res = await request(app()).get('/api/clients').set('Origin', origin);
        expect([origin, res.status]).toEqual([origin, 200]);
      }
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it('rejects the same host over plain HTTP', async () => {
    const res = await request(app())
      .get('/api/clients')
      .set('Origin', 'http://www.619fitnessstudio.com');
    expect(res.status).toBe(403);
  });

  it('allows a full referer URL, path and all', async () => {
    const res = await request(app())
      .get('/api/clients')
      .set('Referer', 'https://www.619fitnessstudio.com/pt-os/clients?tab=payments');
    expect(res.status).toBe(200);
  });

  it('allows every origin listed in CORS_ORIGIN', async () => {
    const prev = process.env.CORS_ORIGIN;
    process.env.CORS_ORIGIN = 'https://app.example.test, https://admin.example.test';
    try {
      const a = await request(app()).get('/api/clients').set('Origin', 'https://app.example.test');
      const b = await request(app()).get('/api/clients').set('Origin', 'https://admin.example.test');
      expect([a.status, b.status]).toEqual([200, 200]);
    } finally {
      if (prev === undefined) delete process.env.CORS_ORIGIN;
      else process.env.CORS_ORIGIN = prev;
    }
  });
});
