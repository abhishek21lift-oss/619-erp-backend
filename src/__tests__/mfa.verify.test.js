jest.mock('otplib', () => ({
  authenticator: {
    check: jest.fn(),
    generateSecret: jest.fn(() => 'JBSWY3DPEHPK3PXP'),
  },
}));

jest.mock('../db/pool', () => ({
  query: jest.fn(),
}));

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'a'.repeat(64);

const profileRouter = require('../routes/profile');
const pool = require('../db/pool');
const { authenticator } = require('otplib');

const app = express();
app.use(express.json());
app.use('/api/profile', profileRouter);

const trainerToken = jwt.sign(
  { id: 'usr-1', token_version: 0 },
  process.env.JWT_SECRET,
  { expiresIn: '1h' }
);

function withAuth(req) {
  return req.set('Authorization', 'Bearer ' + trainerToken);
}

const adminUser = {
  id: 'usr-1', name: 'Admin', email: 'admin@619fitness.com', role: 'admin',
  trainer_id: null, member_id: null, branch_id: null, is_active: true, token_version: 0,
};

describe('POST /api/profile/mfa/verify', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function mockProfilePool({ mfaSecret }) {
    pool.query.mockImplementation(async function() {
      if (/FROM\s+users/i.test(arguments[0])) {
        return { rows: [adminUser] };
      }
      if (/INSERT INTO user_profiles/i.test(arguments[0])) {
        return { rows: [] };
      }
      if (/SELECT mfa_secret FROM user_profiles/i.test(arguments[0])) {
        return { rows: [{ mfa_secret: mfaSecret }] };
      }
      if (/UPDATE user_profiles/i.test(arguments[0])) {
        return { rows: [] };
      }
      return { rows: [] };
    });
  }

  it('returns 400 if no secret is stored on the user', async () => {
    mockProfilePool({ mfaSecret: null });
    const res = await withAuth(request(app).post('/api/profile/mfa/verify').send({ code: '123456' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/setup required/i);
  });

  it('returns 400 for an incorrect TOTP code', async () => {
    mockProfilePool({ mfaSecret: 'JBSWY3DPEHPK3PXP' });
    authenticator.check.mockReturnValue(false);
    const res = await withAuth(request(app).post('/api/profile/mfa/verify').send({ code: '000000' }));
    expect(res.status).toBe(400);
    expect(authenticator.check).toHaveBeenCalledWith('000000', 'JBSWY3DPEHPK3PXP', { window: 1 });
  });

  it('returns 200 with recovery codes for a correct TOTP code', async () => {
    mockProfilePool({ mfaSecret: 'JBSWY3DPEHPK3PXP' });
    authenticator.check.mockReturnValue(true);
    const res = await withAuth(request(app).post('/api/profile/mfa/verify').send({ code: '123456' }));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.recoveryCodes)).toBe(true);
    expect(res.body.recoveryCodes).toHaveLength(8);
  });
});
