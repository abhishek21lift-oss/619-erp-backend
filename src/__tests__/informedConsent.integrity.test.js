// Informed Consent integrity (assessment modules audit 2026-09-28, C-1, C-2).
//
//   C-1  a content change to a draft that already carries a signature clears
//        every signature — the text signed is the text on the PDF. An
//        unchanged re-save (the wizard re-sends the whole form) does not.
//   C-2  only a completed consent can be revoked; the reason is recorded.
'use strict';

const ORG_A = '11111111-1111-1111-1111-111111111111';

let mockExisting = null;
let mockRevoke = null;
let mockPrior = [];
const mockQueries = [];
const mockTx = {
  query: jest.fn(async (sql, params) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    mockQueries.push({ sql: text, params });
    if (/FOR UPDATE/.test(text)) return { rows: mockExisting ? [mockExisting] : [] };
    return { rows: [] };
  }),
  release: jest.fn(),
};
jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    mockQueries.push({ sql: text, params });
    if (/^WITH target AS/.test(text)) return { rows: [mockRevoke] };
    if (/^SELECT \* FROM pt_informed_consents WHERE id = \$1$/.test(text)) return { rows: [mockExisting] };
    if (/^SELECT \* FROM pt_informed_consents WHERE id = \$1 AND organization_id/.test(text)) return { rows: mockExisting ? [mockExisting] : [] };
    if (/^SELECT id, status, version FROM pt_informed_consents/.test(text)) return { rows: mockPrior };
    if (/^SELECT name AS full_name/.test(text)) return { rows: [{ full_name: 'Mina Rao', trainer_id: null }] };
    if (/^INSERT INTO pt_informed_consents/.test(text)) return { rows: [{ id: 'ic-new', status: 'draft' }] };
    return { rows: [] };
  }),
  connect: jest.fn(async () => mockTx),
}));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../lib/activityLog', () => ({ logActivity: jest.fn() }));
jest.mock('../lib/informedConsentPdf', () => ({ generateInformedConsentPdf: jest.fn() }));
jest.mock('../lib/fileStorage', () => ({ saveFile: jest.fn() }));
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = { id: 'u1', role: 'trainer', organization_id: ORG_A }; next(); },
  requireTrainer: (_req, _res, next) => next(),
}));

const express = require('express');
const request = require('supertest');
const { logActivity } = require('../lib/activityLog');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/pt-os', require('../modules/pt-os/informed-consent.routes'));
  return a;
}

const signedDraft = () => ({
  id: 'ic-1', status: 'draft', full_name: 'Mina Rao', dob: new Date(1990, 4, 17), mobile: '9000000000',
  acknowledgements: { final_declaration: true, understands_confidentiality: true, voluntary_participation: true },
  physician_advised_against: false, medical_condition: null, exercise_consent_checked: true,
  client_signature: 'data:image/png;base64,AAA', trainer_signature: null, witness_signature: null,
});

const updateSql = () => mockQueries.find((q) => /^UPDATE pt_informed_consents SET/.test(q.sql) && !/archived/.test(q.sql));

beforeEach(() => { mockQueries.length = 0; mockExisting = signedDraft(); mockRevoke = null; mockPrior = []; logActivity.mockClear(); });

describe('PATCH after a signature', () => {
  test('changing signed content clears every signature', async () => {
    const res = await request(app()).patch('/api/pt-os/informed-consent/ic-1')
      .send({ medical_condition: 'Asthma' });
    expect(res.status).toBe(200);
    expect(updateSql().sql).toMatch(/client_signature = NULL/);
    expect(updateSql().sql).toMatch(/trainer_signature = NULL/);
    expect(logActivity).toHaveBeenCalledWith(expect.anything(), 'informed_consent.signatures_cleared',
      'pt_informed_consents', 'ic-1', expect.anything());
  });

  test('re-sending the same values keeps the signature (dates and key order included)', async () => {
    const res = await request(app()).patch('/api/pt-os/informed-consent/ic-1').send({
      full_name: 'Mina Rao', dob: '1990-05-17', mobile: '9000000000',
      acknowledgements: { voluntary_participation: true, final_declaration: true, understands_confidentiality: true },
      physician_advised_against: false, medical_condition: '',
    });
    expect(res.status).toBe(200);
    expect(updateSql().sql).not.toMatch(/signature = NULL/);
  });

  test('an unsigned draft is edited without touching signatures', async () => {
    mockExisting = { ...signedDraft(), client_signature: null };
    await request(app()).patch('/api/pt-os/informed-consent/ic-1').send({ medical_condition: 'Asthma' });
    expect(updateSql().sql).not.toMatch(/signature = NULL/);
  });
});

describe('POST /informed-consent/:id/revoke', () => {
  test('revokes a completed consent and records the reason', async () => {
    mockRevoke = { prior_status: 'completed', record: { id: 'ic-1', status: 'revoked' } };
    const res = await request(app()).post('/api/pt-os/informed-consent/ic-1/revoke').send({ reason: 'Client withdrew' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('revoked');
    expect(logActivity).toHaveBeenCalledWith(expect.anything(), 'informed_consent.revoke',
      'pt_informed_consents', 'ic-1', { reason: 'Client withdrew' });
    expect(mockQueries.find((q) => /^WITH target/.test(q.sql)).sql).toMatch(/target\.status = 'completed'/);
  });

  test('a draft or archived consent is 409, an unknown one 404', async () => {
    mockRevoke = { prior_status: 'draft', record: null };
    const draft = await request(app()).post('/api/pt-os/informed-consent/ic-1/revoke');
    expect(draft.status).toBe(409);
    expect(draft.body.error.code).toBe('NOT_REVOCABLE');
    mockRevoke = { prior_status: null, record: null };
    expect((await request(app()).post('/api/pt-os/informed-consent/nope/revoke')).status).toBe(404);
  });
});

describe('safety audit 2026-09-29', () => {
  test('editing the exercise programme consent after a signature unsigns', async () => {
    await request(app()).patch('/api/pt-os/informed-consent/ic-1').send({ exercise_consent_checked: false });
    expect(updateSql().sql).toMatch(/client_signature = NULL/);
  });

  test('signing needs the exercise programme consent accepted', async () => {
    mockExisting = { ...signedDraft(), exercise_consent_checked: false };
    const res = await request(app()).post('/api/pt-os/informed-consent/ic-1/sign')
      .send({ signer: 'trainer', signature: 'data:image/png;base64,BBB' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('EXERCISE_CONSENT_REQUIRED');
  });

  test('a second live consent is a named 409, not a unique-violation 500', async () => {
    mockPrior = [{ id: 'ic-1', status: 'completed', version: 1 }];
    const res = await request(app()).post('/api/pt-os/informed-consent').send({ client_id: 'c1' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'ACTIVE_CONSENT_EXISTS', id: 'ic-1', status: 'completed' });
  });

  test('a consent started after a revocation is the next version of it', async () => {
    mockPrior = [{ id: 'ic-2', status: 'revoked', version: 2 }, { id: 'ic-1', status: 'archived', version: 1 }];
    const res = await request(app()).post('/api/pt-os/informed-consent').send({ client_id: 'c1' });
    expect(res.status).toBe(201);
    const insert = mockQueries.find((q) => /^INSERT INTO pt_informed_consents/.test(q.sql));
    expect(insert.params.slice(2, 4)).toEqual([3, 'ic-2']);
  });

  test('amending a completed consent carries the medical clearance forward', async () => {
    mockExisting = { ...signedDraft(), status: 'completed' };
    mockTx.query.mockImplementationOnce(async () => ({ rows: [] })); // BEGIN
    mockTx.query.mockImplementationOnce(async () => ({ rows: [mockExisting] })); // FOR UPDATE
    mockTx.query.mockImplementationOnce(async () => ({ rows: [] })); // archive
    mockTx.query.mockImplementationOnce(async (sql) => { mockQueries.push({ sql: String(sql).replace(/\s+/g, ' ') }); return { rows: [{ id: 'ic-v2' }] }; });
    await request(app()).patch('/api/pt-os/informed-consent/ic-1').send({ full_name: 'Mina Rao' });
    const copy = mockQueries.find((q) => /INSERT INTO pt_informed_consents/.test(q.sql));
    expect(copy.sql).toMatch(/medical_clearance_file_url/);
    expect(copy.sql).toMatch(/exercise_consent_text/);
  });
});
