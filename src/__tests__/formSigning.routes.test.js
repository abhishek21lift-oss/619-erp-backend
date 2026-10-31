// POST /api/public/form-signing/:token — the client's own submission.
//
// This route has no session. The token is the only credential, so two things
// must hold and neither is enforced anywhere else:
//
//   1. Whose record gets written is decided by the LINK, never by the body.
//      A body field named client_id or full_name must be ignored — otherwise
//      a leaked link becomes a way to sign somebody else's screening.
//   2. The link is spent inside the same transaction as the writes. A second
//      submission must not produce a second signed medical record.

'use strict';

process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long!!';

jest.mock('../db/pool', () => {
  const query = jest.fn();
  const connect = jest.fn();
  return { query, connect };
});

jest.mock('../lib/formLinks', () => ({
  resolve: jest.fn(),
  markUsed: jest.fn(),
  EXPIRY_HOURS: 168,
}));

jest.mock('../lib/screeningGate', () => ({
  maybeActivateClient: jest.fn(async () => false),
  PARQ_QUESTION_COUNT: 10,
}));

jest.mock('../lib/parqPdf', () => ({ generateConsentPdf: jest.fn(async () => 'https://files/consent.pdf') }));
jest.mock('../lib/activityLog', () => ({ logActivity: jest.fn(async () => {}) }));

const request = require('supertest');
const express = require('express');
const pool = require('../db/pool');
const formLinks = require('../lib/formLinks');

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use('/api/public/form-signing', require('../routes/form-signing'));

const TOKEN = 'a'.repeat(64);
const LINK = {
  id: 'link-1',
  client_id: 'ptc-real',
  organization_id: 'org-a',
  expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  client_name: 'Real Client',
  email: 'real@example.com',
  mobile: '9999999999',
  gender: 'Female',
  dob: '1990-01-01',
  address: null,
  emergency_contact: null,
  emergency_phone: null,
  occupation: null,
  trainer_id: 'tr-1',
  trainer_name: 'Trainer',
  studio_name: 'Studio',
  created_by: 'usr-1',
};

const SIG = 'data:image/png;base64,iVBORw0KGgo=';

const answers = () => Array.from({ length: 10 }, (_, i) => ({ question_id: i + 1, answer: 'no' }));

const body = (over = {}) => ({
  height_cm: 170,
  weight_kg: 70,
  current_health: { known_disease: false },
  past_history: { surgeries: false },
  family_history: [],
  parq_answers: answers(),
  acknowledgements: {
    understands_confidentiality: true, voluntary_participation: true, final_declaration: true,
  },
  physician_advised_against: false,
  exercise_consent_checked: true,
  exercise_consent_text: 'The consent text shown to the client.',
  signature: SIG,
  ...over,
});

let txQuery;
let txRelease;

beforeEach(() => {
  pool.query.mockReset().mockResolvedValue({ rows: [{}] });
  txQuery = jest.fn(async (sql) => {
    const s = String(sql);
    if (/INSERT INTO pt_parq_forms/.test(s)) return { rows: [{ id: 'form-1' }] };
    if (/INSERT INTO pt_consent_records/.test(s)) return { rows: [{ id: 'consent-1' }] };
    if (/FROM pt_informed_consents/.test(s)) return { rows: [] };
    if (/INSERT INTO pt_informed_consents/.test(s)) return { rows: [{ id: 'ic-1' }] };
    return { rows: [] };
  });
  txRelease = jest.fn();
  pool.connect.mockReset().mockResolvedValue({ query: txQuery, release: txRelease });

  formLinks.resolve.mockReset().mockResolvedValue(LINK);
  formLinks.markUsed.mockReset().mockResolvedValue(true);
});

const insertParams = (table) => {
  const call = txQuery.mock.calls.find(([sql]) => String(sql).includes(`INSERT INTO ${table}`));
  return call && call[1];
};

describe('a link that is not live', () => {
  it('answers 404 and opens no transaction', async () => {
    formLinks.resolve.mockResolvedValue(null);
    const res = await request(app).post(`/api/public/form-signing/${TOKEN}`).send(body());
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('LINK_INVALID');
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

describe('an incomplete submission', () => {
  it('refuses a PAR-Q with a question unanswered, before writing anything', async () => {
    const res = await request(app)
      .post(`/api/public/form-signing/${TOKEN}`)
      .send(body({ parq_answers: answers().slice(0, 9) }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INCOMPLETE_PARQ');
    expect(res.body.error.missing).toEqual([10]);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('refuses a submission with an agreement unchecked', async () => {
    const res = await request(app)
      .post(`/api/public/form-signing/${TOKEN}`)
      .send(body({ acknowledgements: { understands_confidentiality: true, voluntary_participation: true } }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('ACKNOWLEDGEMENTS_INCOMPLETE');
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

describe('a valid submission', () => {
  it('writes the screening against the LINK\u2019s client and organization', async () => {
    const res = await request(app).post(`/api/public/form-signing/${TOKEN}`).send(body());
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ parq_form_id: 'form-1', risk_level: 'low' });

    const params = insertParams('pt_parq_forms');
    expect(params).toContain('ptc-real');
    expect(params).toContain('org-a');
    expect(params).toContain('Real Client');
  });

  it('ignores client_id and full_name supplied by the browser', async () => {
    // The signature covers a medical record. Who it belongs to comes from the
    // token, and a body field must not be able to redirect it.
    await request(app)
      .post(`/api/public/form-signing/${TOKEN}`)
      .send(body({ client_id: 'ptc-someone-else', full_name: 'Someone Else' }));
    const params = insertParams('pt_parq_forms');
    expect(params).not.toContain('ptc-someone-else');
    expect(params).not.toContain('Someone Else');
  });

  it('spends the link in the transaction and commits once', async () => {
    await request(app).post(`/api/public/form-signing/${TOKEN}`).send(body());
    expect(formLinks.markUsed).toHaveBeenCalledWith('link-1', { client: expect.objectContaining({ query: txQuery }) });
    const sqls = txQuery.mock.calls.map(([sql]) => String(sql));
    expect(sqls[0]).toBe('BEGIN');
    // Spend-before-write: the loser of two concurrent submissions must roll
    // back before it has written a row.
    const usedAt = formLinks.markUsed.mock.invocationCallOrder[0];
    const insertAt = txQuery.mock.invocationCallOrder[sqls.findIndex((s) => s.includes('INSERT INTO pt_parq_forms'))];
    expect(usedAt).toBeLessThan(insertAt);
    expect(sqls).toContain('COMMIT');
  });

  it('refuses a link another submission already spent', async () => {
    formLinks.markUsed.mockResolvedValue(false);
    const res = await request(app).post(`/api/public/form-signing/${TOKEN}`).send(body());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('LINK_USED');
    expect(insertParams('pt_parq_forms')).toBeFalsy();
    const sqls = txQuery.mock.calls.map(([sql]) => String(sql));
    expect(sqls).toContain('ROLLBACK');
  });

  it('signs a draft consent when one is waiting, rather than creating another', async () => {
    txQuery.mockImplementation(async (sql) => {
      const s = String(sql);
      if (/INSERT INTO pt_parq_forms/.test(s)) return { rows: [{ id: 'form-1' }] };
      if (/INSERT INTO pt_consent_records/.test(s)) return { rows: [{ id: 'consent-1' }] };
      if (/FROM pt_informed_consents/.test(s)) return { rows: [{ id: 'ic-existing', status: 'draft', version: 1 }] };
      if (/UPDATE pt_informed_consents/.test(s)) return { rows: [{ id: 'ic-existing' }] };
      return { rows: [] };
    });
    await request(app).post(`/api/public/form-signing/${TOKEN}`).send(body());
    expect(txQuery.mock.calls.some(([sql]) => /INSERT INTO pt_informed_consents/.test(String(sql)))).toBe(false);
    expect(txQuery.mock.calls.some(([sql]) => /UPDATE pt_informed_consents/.test(String(sql)))).toBe(true);
  });

  it('leaves a completed consent untouched and records only the PAR-Q', async () => {
    txQuery.mockImplementation(async (sql) => {
      const s = String(sql);
      if (/INSERT INTO pt_parq_forms/.test(s)) return { rows: [{ id: 'form-1' }] };
      if (/INSERT INTO pt_consent_records/.test(s)) return { rows: [{ id: 'consent-1' }] };
      if (/FROM pt_informed_consents/.test(s)) return { rows: [{ id: 'ic-done', status: 'completed', version: 1 }] };
      return { rows: [] };
    });
    const res = await request(app).post(`/api/public/form-signing/${TOKEN}`).send(body());
    expect(res.status).toBe(201);
    const sqls = txQuery.mock.calls.map(([sql]) => String(sql));
    expect(sqls.some((s) => /UPDATE pt_informed_consents/.test(s))).toBe(false);
    expect(sqls.some((s) => /INSERT INTO pt_informed_consents/.test(s))).toBe(false);
  });
});
