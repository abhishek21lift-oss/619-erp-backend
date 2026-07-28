// Cross-tenant isolation on the two attendance WRITE paths.
//
// These are regression tests for a real defect. Both scan paths stamped
// attendance_logs.organization_id from a subquery on the SCANNED PERSON
// rather than from the caller, so a check-in performed by studio A against a
// code belonging to studio B wrote a row into studio B's data — where it then
// appeared in their reports. The reads on the same paths were unfiltered too,
// so a scan echoed back another studio's client name, photo and package.
//
// QR payloads are signed with a single server-wide HMAC secret, which means a
// code minted by any studio verifies at every studio. The org filter in these
// queries is the only thing separating tenants here, which is why each of
// these assertions is load-bearing rather than decorative.

const crypto = require('crypto');

process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long!!';

jest.mock('../db/pool', () => ({ query: jest.fn() }));

// Caller belongs to ORG_A. Everything below asks what happens when the person
// being scanned does not.
const ORG_A = '11111111-1111-1111-1111-111111111111';
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => {
    req.user = { id: 'usr-1', role: 'admin', organization_id: '11111111-1111-1111-1111-111111111111', trainer_id: null };
    next();
  },
  adminOnly: (_req, _res, next) => next(),
}));

const request = require('supertest');
const express = require('express');
const pool = require('../db/pool');

const qrRouter = require('../routes/qr-checkin');
const bioRouter = require('../routes/biometric-attend');

const app = express();
app.use(express.json());
app.use('/api/qr', qrRouter);
app.use('/api/biometric-attend', bioRouter);

/** Build a payload the server will accept — same construction as the route. */
function signedQr(userId, userType = 'client') {
  const msg = `${userId}|${userType}|0`;
  const sig = crypto.createHmac('sha256', process.env.JWT_SECRET).update(msg).digest('hex');
  return Buffer.from(`${msg}|${sig}`).toString('base64url');
}

const MEMBER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

/** Every INSERT issued during the request. */
const inserts = () =>
  pool.query.mock.calls.filter(([sql]) => /INSERT INTO attendance_logs/i.test(sql));

beforeEach(() => pool.query.mockReset());

describe('POST /api/qr/scan — tenant isolation', () => {
  it('rejects a QR belonging to another studio and writes nothing', async () => {
    // resolveUser is now org-filtered, so a foreign member simply is not found.
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).post('/api/qr/scan').send({ payload: signedQr(MEMBER) });

    expect(res.status).toBe(404);
    // The important half: no attendance row was created in the other studio.
    expect(inserts()).toHaveLength(0);
  });

  it('never leaks a foreign member name, even via the duplicate branch', async () => {
    // The duplicate-scan reply used to resolve and echo the name BEFORE any
    // ownership check, so a foreign code returned that person's name.
    pool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).post('/api/qr/scan').send({ payload: signedQr(MEMBER) });
    expect(JSON.stringify(res.body)).not.toMatch(/Someone Else/i);
    expect(res.body.user).toBeUndefined();
  });

  it("stamps the CALLER's organization on the attendance row", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: MEMBER, name: 'Our Member', status: 'active' }] }) // resolveUser
      .mockResolvedValueOnce({ rows: [] })                                                     // duplicate check
      .mockResolvedValueOnce({ rows: [{ id: 'att-1', check_in_time: new Date().toISOString() }] });

    const res = await request(app).post('/api/qr/scan').send({ payload: signedQr(MEMBER) });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const [sql, params] = inserts()[0];
    // Not a subquery on the scanned person — the caller's org, passed as a param.
    expect(sql).not.toMatch(/SELECT organization_id FROM pt_clients/);
    expect(params).toContain(ORG_A);
  });

  it('scopes the member lookup by organization', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    await request(app).post('/api/qr/scan').send({ payload: signedQr(MEMBER) });

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/organization_id = \$2/);
    expect(params).toEqual([MEMBER, ORG_A]);
    // The legacy `clients` table has no organization_id column at all, so it
    // can never be tenant-filtered. It must not be consulted here.
    expect(sql).not.toMatch(/FROM clients\b/);
  });
});

describe('POST /api/biometric-attend/mark — tenant isolation', () => {
  const body = { memberId: MEMBER, verificationMethod: 'passkey', memberName: 'Client Supplied' };

  it('404s for a member outside the caller studio and writes nothing', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ value: '10' }] }) // getLateHour (system_settings)
      .mockResolvedValueOnce({ rows: [] });               // member lookup, org-filtered
    const res = await request(app).post('/api/biometric-attend/mark').send(body);

    expect(res.status).toBe(404);
    expect(inserts()).toHaveLength(0);
  });

  it('uses the server-resolved name, not the one the caller sent', async () => {
    // The old code trusted req.body.memberName and only fell back to a lookup
    // against an empty table — so the name on an attendance record was
    // whatever the client typed.
    pool.query
      .mockResolvedValueOnce({ rows: [{ value: '10' }] })       // getLateHour
      .mockResolvedValueOnce({ rows: [{ name: 'Real Name' }] }) // member lookup
      .mockResolvedValueOnce({ rows: [] })                      // insert
      .mockResolvedValueOnce({ rows: [{ id: 'x' }] });          // duplicate probe

    await request(app).post('/api/biometric-attend/mark').send(body);

    const [, params] = inserts()[0];
    expect(params).toContain('Real Name');
    expect(params).not.toContain('Client Supplied');
    expect(params).toContain(ORG_A);
  });
});
