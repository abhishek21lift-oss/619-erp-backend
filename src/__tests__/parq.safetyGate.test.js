// PAR-Q safety rules (assessment modules audit 2026-09-28, A-1..A-4, P-3/P-4).
//
//   A-1  a single cardiac "yes" is high risk on its own;
//   A-2  a PAR-Q cannot be written against another studio's client;
//   A-4  a clearance cannot be approved without the doctor, the date and the
//        certificate;
//   P-3  a form cannot be dated in the future (it would sit on top of the
//        real ones in the gate's "latest form" read);
//   P-4  PATCH validates, and — the zod 4 trap — omitting parq_answers does
//        not reset them to [] and re-score the client as low risk.
'use strict';

const { computeParqAnalysis, computeParqRisk } = require('../modules/pt-os/parq-scoring');

const ORG_A = '11111111-1111-1111-1111-111111111111';
const FORM_ID = 'parq-form-1';

let mockClientInOrg = true;
let mockDocs = [];
let mockExistingForm = null;
let mockExistingClearance = null;
const mockQueries = [];

function mockResult(rows) { return { rows, rowCount: rows.length }; }
function mockRoute(sql, params) {
  const text = String(sql).replace(/\s+/g, ' ').trim();
  mockQueries.push({ sql: text, params });
  if (/FROM pt_parq_documents/i.test(text)) return mockResult(mockDocs);
  if (/^SELECT \* FROM pt_medical_clearances WHERE id/i.test(text)) return mockResult(mockExistingClearance ? [mockExistingClearance] : []);
  if (/^UPDATE pt_medical_clearances/i.test(text)) return mockResult([{ ...mockExistingClearance, ...{ approval_status: 'approved' } }]);
  if (/^INSERT INTO pt_medical_clearances/i.test(text)) return mockResult([{ id: 'mc-1', parq_form_id: FORM_ID }]);
  if (/SELECT client_id, organization_id FROM pt_parq_forms/i.test(text)) return mockResult([{ client_id: 'c1', organization_id: ORG_A }]);
  if (/FOR UPDATE/i.test(text)) return mockResult(mockExistingForm ? [mockExistingForm] : []);
  if (/^INSERT INTO pt_parq_forms/i.test(text)) return mockResult([{ id: FORM_ID }]);
  if (/SELECT risk_level FROM pt_parq_forms/i.test(text)) return mockResult([{ risk_level: 'high' }]);
  if (/^UPDATE pt_parq_forms SET workout_gate_status/i.test(text)) return mockResult([{ workout_gate_status: 'blocked', risk_level: 'high' }]);
  if (/SELECT \* FROM pt_parq_forms WHERE id = \$1$/i.test(text)) return mockResult([{ id: FORM_ID }]);
  return mockResult([]);
}

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => mockRoute(sql, params)),
  connect: jest.fn(async () => ({ query: jest.fn(async (sql, params) => mockRoute(sql, params)), release: jest.fn() })),
}));
jest.mock('../lib/orgGuard', () => ({ clientInOrg: jest.fn(async () => mockClientInOrg) }));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../lib/activityLog', () => ({ logActivity: jest.fn() }));
jest.mock('../lib/parqPdf', () => ({ generateConsentPdf: jest.fn() }));
jest.mock('../lib/fileStorage', () => ({ saveFile: jest.fn() }));
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = { id: 'u1', role: 'trainer', organization_id: ORG_A }; next(); },
  requireTrainer: (_req, _res, next) => next(),
}));

const express = require('express');
const request = require('supertest');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/pt-os', require('../modules/pt-os/parq.routes'));
  a.use((err, _req, res, _next) => res.status(err.status || err.statusCode || 500).json({ error: err.message }));
  return a;
}

const yes = (id) => ({ question_id: id, answer: 'yes' });
const no = (id) => ({ question_id: id, answer: 'no' });

beforeEach(() => {
  mockClientInOrg = true;
  mockDocs = [];
  mockExistingForm = null;
  mockExistingClearance = null;
  mockQueries.length = 0;
});

describe('PAR-Q risk rule', () => {
  test.each([1, 3, 4, 5, '1', '3'])('a lone "yes" to red-flag question %p is high risk', (q) => {
    expect(computeParqAnalysis([yes(q)]).riskLevel).toBe('high');
  });

  test('a lone "yes" to a non-cardiac question stays medium', () => {
    for (const q of [2, 6, 7, 8, 9, 10]) expect(computeParqAnalysis([yes(q)]).riskLevel).toBe('medium');
  });

  test('three non-cardiac yeses are still high; none is low', () => {
    expect(computeParqAnalysis([yes(2), yes(6), yes(7)]).riskLevel).toBe('high');
    expect(computeParqAnalysis([no(1), no(3)]).riskLevel).toBe('low');
    expect(computeParqAnalysis(null).riskLevel).toBe('low');
  });

  test('exports the frontend name for the parity check', () => {
    expect(computeParqRisk).toBe(computeParqAnalysis);
  });
});

// Every question answered, with "yes" to the ones listed.
const answers = (...yeses) => Array.from({ length: 10 }, (_, i) => (yeses.includes(i + 1) ? yes(i + 1) : no(i + 1)));

describe('POST /parq/forms', () => {
  const body = { client_id: 'c1', full_name: 'Test', parq_answers: answers(3) };

  test('refuses another studio\'s client with 404, writing nothing', async () => {
    mockClientInOrg = false;
    const res = await request(app()).post('/api/pt-os/parq/forms').send(body);
    expect(res.status).toBe(404);
    expect(mockQueries.some((q) => /INSERT INTO pt_parq_forms/i.test(q.sql))).toBe(false);
  });

  test('refuses a future assessment date', async () => {
    const res = await request(app()).post('/api/pt-os/parq/forms')
      .send({ ...body, assessment_date: '2099-01-01' });
    expect(res.status).toBe(400);
  });

  test('stores a chest-pain yes as high risk, blocked', async () => {
    const res = await request(app()).post('/api/pt-os/parq/forms').send(body);
    expect(res.status).toBe(201);
    const insert = mockQueries.find((q) => /^INSERT INTO pt_parq_forms/i.test(q.sql));
    expect(insert.params).toContain('high');
    expect(insert.params).toContain('blocked');
  });

  test('numbers the assessment after the client\'s live ones, serialised per client', async () => {
    // Two PAR-Qs saved at once used to read the same count and share a
    // number; a deleted form also lowered the count and so reused one.
    await request(app()).post('/api/pt-os/parq/forms').send(body);
    const lock = mockQueries.findIndex((q) => /pg_advisory_xact_lock/.test(q.sql));
    const insert = mockQueries.findIndex((q) => /^INSERT INTO pt_parq_forms/i.test(q.sql));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(insert);
    expect(mockQueries[lock].params[0]).toBe(`parq:${body.client_id}`);
    expect(mockQueries[insert].sql).toMatch(/COALESCE\(MAX\(assessment_number\), 0\) \+ 1 FROM pt_parq_forms WHERE client_id = \$1 AND deleted_at IS NULL/);
  });
});

describe('PATCH /parq/forms/:id', () => {
  test('omitting parq_answers keeps the stored answers and their risk', async () => {
    mockExistingForm = { id: FORM_ID, status: 'submitted', parq_answers: answers(1), height_cm: null, weight_kg: null, bmi: null };
    const res = await request(app()).patch(`/api/pt-os/parq/forms/${FORM_ID}`).send({ trainer_name: 'Coach' });
    expect(res.status).toBe(200);
    const update = mockQueries.find((q) => /^UPDATE pt_parq_forms SET (?!workout_gate_status)/i.test(q.sql));
    expect(update.sql).not.toMatch(/parq_answers =/);
    expect(update.params).toContain('high');
  });

  test('rejects a malformed body', async () => {
    const res = await request(app()).patch(`/api/pt-os/parq/forms/${FORM_ID}`).send({ status: 'approved-by-me' });
    expect(res.status).toBe(400);
  });
});

describe('medical clearance approval needs evidence', () => {
  const full = { doctor_name: 'Dr A', clearance_date: '2026-09-01', approval_status: 'approved' };

  test('approving with no doctor is refused', async () => {
    const res = await request(app()).post(`/api/pt-os/parq/forms/${FORM_ID}/clearance`)
      .send({ approval_status: 'approved' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CLEARANCE_EVIDENCE_REQUIRED');
  });

  test('approving without a certificate or an uploaded document is refused', async () => {
    const res = await request(app()).post(`/api/pt-os/parq/forms/${FORM_ID}/clearance`).send(full);
    expect(res.status).toBe(400);
  });

  test('approving with an uploaded certificate is accepted', async () => {
    mockDocs = [{ id: 'd1' }];
    const res = await request(app()).post(`/api/pt-os/parq/forms/${FORM_ID}/clearance`).send(full);
    expect(res.status).toBe(201);
  });

  test('approving with a certificate link is accepted; pending needs nothing', async () => {
    expect((await request(app()).post(`/api/pt-os/parq/forms/${FORM_ID}/clearance`)
      .send({ ...full, certificate_url: 'https://example.test/c.pdf' })).status).toBe(201);
    expect((await request(app()).post(`/api/pt-os/parq/forms/${FORM_ID}/clearance`)
      .send({ doctor_name: 'Dr A' })).status).toBe(201);
  });

  test('an expiry before the clearance date is refused', async () => {
    const res = await request(app()).post(`/api/pt-os/parq/forms/${FORM_ID}/clearance`)
      .send({ ...full, certificate_url: 'x', expiry_date: '2026-08-01' });
    expect(res.status).toBe(400);
  });

  test('PATCH to approved on a bare record is refused', async () => {
    mockExistingClearance = { id: 'mc-1', parq_form_id: FORM_ID, approval_status: 'pending', doctor_name: null };
    const res = await request(app()).patch('/api/pt-os/parq/clearance/mc-1').send({ approval_status: 'approved' });
    expect(res.status).toBe(400);
  });

  test('PATCH to approved on a complete record is accepted', async () => {
    mockExistingClearance = {
      id: 'mc-1', parq_form_id: FORM_ID, ...full, approval_status: 'pending', certificate_url: 'https://example.test/c.pdf',
    };
    const res = await request(app()).patch('/api/pt-os/parq/clearance/mc-1').send({ approval_status: 'approved' });
    expect(res.status).toBe(200);
  });
});

describe('a PAR-Q is only screened when every question is answered (safety audit 2026-09-29)', () => {
  const { logActivity } = require('../lib/activityLog');
  beforeEach(() => logActivity.mockClear());

  test('submitting with unanswered questions is refused and writes nothing', async () => {
    const res = await request(app()).post('/api/pt-os/parq/forms')
      .send({ client_id: 'c1', full_name: 'Test', status: 'submitted', parq_answers: [no(1), no(2)] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PARQ_INCOMPLETE');
    expect(res.body.error.unanswered).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
    expect(mockQueries.some((q) => /INSERT INTO pt_parq_forms/i.test(q.sql))).toBe(false);
  });

  test('omitting status means submitted, so it needs every answer too', async () => {
    const res = await request(app()).post('/api/pt-os/parq/forms').send({ client_id: 'c1', full_name: 'Test' });
    expect(res.status).toBe(400);
  });

  test('a draft may be partial, and is logged as a draft rather than a submission', async () => {
    const res = await request(app()).post('/api/pt-os/parq/forms')
      .send({ client_id: 'c1', full_name: 'Test', status: 'draft', parq_answers: [] });
    expect(res.status).toBe(201);
    expect(logActivity).toHaveBeenCalledWith(expect.anything(), 'parq.draft', 'pt_parq_forms', FORM_ID, expect.anything());
  });

  test('unknown or repeated question ids are refused', async () => {
    const base = { client_id: 'c1', full_name: 'Test', status: 'draft' };
    expect((await request(app()).post('/api/pt-os/parq/forms').send({ ...base, parq_answers: [no(11)] })).status).toBe(400);
    expect((await request(app()).post('/api/pt-os/parq/forms').send({ ...base, parq_answers: [no(2), yes(2)] })).status).toBe(400);
  });

  test('a draft cannot be submitted with gaps', async () => {
    mockExistingForm = { id: FORM_ID, status: 'draft', parq_answers: [no(1)] };
    const res = await request(app()).patch(`/api/pt-os/parq/forms/${FORM_ID}`).send({ status: 'submitted' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PARQ_INCOMPLETE');
  });

  test('a submitted form cannot be sent back to draft', async () => {
    mockExistingForm = { id: FORM_ID, status: 'submitted', parq_answers: answers(1) };
    const res = await request(app()).patch(`/api/pt-os/parq/forms/${FORM_ID}`).send({ status: 'draft' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PARQ_ALREADY_SUBMITTED');
  });

  test('changing answers on a submitted form is audited with the risk before and after', async () => {
    mockExistingForm = { id: FORM_ID, client_id: 'c1', status: 'submitted', risk_level: 'high', parq_answers: answers(1) };
    const res = await request(app()).patch(`/api/pt-os/parq/forms/${FORM_ID}`).send({ parq_answers: answers() });
    expect(res.status).toBe(200);
    expect(logActivity).toHaveBeenCalledWith(expect.anything(), 'parq.update', 'pt_parq_forms', FORM_ID,
      expect.objectContaining({ answers_changed: true, risk_level_before: 'high', risk_level_after: 'low' }));
  });

  test('marking reviewed is audited; changing answers afterwards needs a new review', async () => {
    mockExistingForm = { id: FORM_ID, client_id: 'c1', status: 'submitted', risk_level: 'medium', parq_answers: answers(2) };
    await request(app()).patch(`/api/pt-os/parq/forms/${FORM_ID}`).send({ status: 'reviewed' });
    expect(logActivity).toHaveBeenCalledWith(expect.anything(), 'parq.review', 'pt_parq_forms', FORM_ID, expect.anything());

    mockQueries.length = 0;
    mockExistingForm = { ...mockExistingForm, status: 'reviewed' };
    await request(app()).patch(`/api/pt-os/parq/forms/${FORM_ID}`).send({ status: 'reviewed', parq_answers: answers(2, 6) });
    const update = mockQueries.find((q) => /^UPDATE pt_parq_forms SET (?!workout_gate_status)/i.test(q.sql));
    expect(update.params).toContain('submitted');
  });
});
