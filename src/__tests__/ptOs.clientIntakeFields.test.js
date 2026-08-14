// The two columns migration 163 adds to pt_clients, end to end over HTTP.
//
// Both were added for the redesigned intake form:
//   emergency_contact_relationship  — who the emergency contact IS. The row
//     already carried a name and a number and nothing saying whether that
//     person is a spouse, a mother or a neighbour.
//   client_source — where the client came from. A closed set (CLIENT_SOURCES),
//     because the whole point of the column is being grouped by, and
//     "Instagram" / "instagram" / "IG" are three channels to a GROUP BY.
//
// These tests post real requests through the router rather than asserting on
// the handler's source text. A regex that finds `client_source` in the file
// is equally satisfied by a column listed in the INSERT and never bound to a
// parameter — which is exactly the bug worth catching here, since both fields
// travel through a positional parameter list.
'use strict';

const queries = [];

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    queries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
    if (/^INSERT INTO pt_clients/i.test(String(sql).trim())) {
      return { rows: [{ id: 'new-client-id' }], rowCount: 1 };
    }
    if (/^UPDATE pt_clients/i.test(String(sql).trim())) {
      return { rows: [{ id: 'new-client-id', name: 'Anaya Rao' }], rowCount: 1 };
    }
    if (/SELECT final_amount, paid_amount FROM pt_clients/i.test(sql)) {
      return { rows: [{ final_amount: '0', paid_amount: '0' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }),
  connect: jest.fn(),
}));

jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../lib/activityLog', () => ({ logActivity: jest.fn(async () => {}) }));
jest.mock('../lib/subscription', () => ({
  clientLimitStatus: jest.fn(async () => ({ limit: null, count: 0, atLimit: false })),
}));

const ORG_A = '11111111-1111-1111-1111-111111111111';
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = { id: 'u1', role: 'admin', organization_id: ORG_A }; next(); },
  adminOnly: (_req, _res, next) => next(),
  adminOrManager: (_req, _res, next) => next(),
  adminManagerOrTrainer: (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
  requireSelfOrRole: () => (_req, _res, next) => next(),
  computeAccess: () => ({ allowed: true, state: 'active' }),
}));

const express = require('express');
const request = require('supertest');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/pt-os', require('../modules/pt-os/pt-os.routes'));
  return a;
}

const insert = () => queries.find((q) => /^INSERT INTO pt_clients/i.test(q.sql));
const update = () => queries.find((q) => /^UPDATE pt_clients SET/i.test(q.sql));

/** What the intake form posts once the operator has filled it in. */
const intake = (over = {}) => ({
  name: 'Anaya Rao',
  gender: 'Female',
  mobile: '9876543210',
  emergency_contact: 'Meera Rao',
  emergency_phone: '9812345678',
  emergency_contact_relationship: 'Mother',
  client_source: 'Instagram',
  ...over,
});

/**
 * The value bound to `col` in the INSERT, resolved through the parameter list
 * rather than read off the SQL — so a column named in the statement but never
 * bound fails, which is the whole failure mode of a positional INSERT.
 */
function insertedValue(col) {
  const q = insert();
  if (!q) return undefined;
  const cols = q.sql.match(/INSERT INTO pt_clients \(([^)]*)\)/i)[1]
    .split(',').map((c) => c.trim());
  const placeholders = q.sql.match(/VALUES \(([^)]*)\)/i)[1]
    .split(',').map((c) => c.trim());
  const idx = cols.indexOf(col);
  if (idx === -1) return undefined;
  const ph = placeholders[idx];
  const m = /^\$(\d+)$/.exec(ph);
  if (!m) return ph; // a literal, e.g. 'pending'
  return q.params[Number(m[1]) - 1];
}

beforeEach(() => { queries.length = 0; });

describe('POST /pt-os/clients stores the new intake fields', () => {
  test('the relationship is written to its own column', async () => {
    const res = await request(app()).post('/api/pt-os/clients').send(intake());
    expect(res.status).toBe(201);
    expect(insertedValue('emergency_contact_relationship')).toBe('Mother');
  });

  test('the acquisition channel is written to its own column', async () => {
    const res = await request(app()).post('/api/pt-os/clients').send(intake());
    expect(res.status).toBe(201);
    expect(insertedValue('client_source')).toBe('Instagram');
  });

  test('the emergency name and number still land where they always did', async () => {
    // The rename on the form was a label change. If it had moved the payload
    // keys, these two would be null and nobody would notice until an emergency.
    await request(app()).post('/api/pt-os/clients').send(intake());
    expect(insertedValue('emergency_contact')).toBe('Meera Rao');
    expect(insertedValue('emergency_phone')).toBe('9812345678');
  });

  test('unanswered is NULL, not an empty string', async () => {
    // Two representations of "not answered" means every report has to remember
    // both. The form posts '' for a select the operator skipped.
    const res = await request(app())
      .post('/api/pt-os/clients')
      .send(intake({ client_source: '', emergency_contact_relationship: '' }));
    expect(res.status).toBe(201);
    expect(insertedValue('client_source')).toBeNull();
    expect(insertedValue('emergency_contact_relationship')).toBeNull();
  });

  test('a client_source outside the list is refused', async () => {
    const res = await request(app())
      .post('/api/pt-os/clients')
      .send(intake({ client_source: 'Telepathy' }));
    expect(res.status).toBe(400);
    expect(insert()).toBeUndefined();
  });

  test('every option the form offers is accepted', async () => {
    // The form's dropdown and the server's enum are two lists that have to
    // agree; this is the half of that pair the server owns.
    for (const source of ['Walk-in', 'Instagram', 'WhatsApp', 'Referral',
      'Existing Member', 'Google', 'Website', 'Other']) {
      queries.length = 0;
      const res = await request(app()).post('/api/pt-os/clients').send(intake({ client_source: source }));
      expect([source, res.status]).toEqual([source, 201]);
      expect([source, insertedValue('client_source')]).toEqual([source, source]);
    }
  });

  test('address is optional — the form no longer requires it', async () => {
    const res = await request(app()).post('/api/pt-os/clients').send(intake({ address: undefined }));
    expect(res.status).toBe(201);
    expect(insertedValue('address')).toBeNull();
  });

  test('occupation is still accepted — the column did not go away', async () => {
    // The intake form stopped asking, but the lifestyle assessment still
    // writes it and the training brief still reads it.
    const res = await request(app()).post('/api/pt-os/clients').send(intake({ occupation: 'Teacher' }));
    expect(res.status).toBe(201);
    expect(insertedValue('occupation')).toBe('Teacher');
  });
});

describe('PATCH /pt-os/clients/:id can correct both fields', () => {
  test('the relationship is editable after onboarding', async () => {
    const res = await request(app())
      .patch('/api/pt-os/clients/c1')
      .send({ emergency_contact_relationship: 'Spouse' });
    expect(res.status).toBe(200);
    expect(update().params).toContain('Spouse');
  });

  test('the acquisition channel is editable after onboarding', async () => {
    const res = await request(app())
      .patch('/api/pt-os/clients/c1')
      .send({ client_source: 'Referral' });
    expect(res.status).toBe(200);
    expect(update().params).toContain('Referral');
  });

  test('the closed set is enforced on edit too, not only on create', async () => {
    // PATCH has no zod schema, so without an explicit check the enum enforced
    // at create is bypassable by editing the client a second later.
    const res = await request(app())
      .patch('/api/pt-os/clients/c1')
      .send({ client_source: 'ig-reels' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/client_source must be one of/i);
    expect(update()).toBeUndefined();
  });

  test('clearing the channel stores NULL rather than an empty string', async () => {
    const res = await request(app())
      .patch('/api/pt-os/clients/c1')
      .send({ client_source: '' });
    expect(res.status).toBe(200);
    expect(update().params).toContain(null);
    expect(update().params).not.toContain('');
  });
});
