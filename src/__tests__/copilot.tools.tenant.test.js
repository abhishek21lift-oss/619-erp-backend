'use strict';
// Cross-tenant and cross-client denial at the registry boundary.
//
// These deliberately run the REAL Phase 2 client-scope resolver against a
// mocked pool, rather than mocking the resolver away: the property under test
// is that a client id from another studio, or one the caller is not assigned,
// never reaches a handler. A stub would only prove the stub works.

jest.mock('../db/pool', () => ({ query: jest.fn() }));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { z } = require('zod');
const pool = require('../db/pool');
const { createRegistry } = require('../modules/copilot/tools/registry');

const ORG_A = '11111111-1111-1111-1111-111111111111';

const TRAINER = {
  id: 'usr-1', name: 'Trainer One', role: 'trainer',
  trainer_id: 'tr-1', organization_id: ORG_A,
};

function fixture() {
  const calls = [];
  const registry = createRegistry([{
    name: 'get_client_profile',
    label: 'Client Profile',
    description: 'Profile for the selected client.',
    level: 'READ',
    clientScope: 'required',
    sensitivity: 'personal',
    args: z.object({}).strict(),
    source: 'test.clientProfile',
    async run({ clientId }) {
      calls.push(clientId);
      return {
        data: { id: clientId },
        provenance: { source: 'pt_clients', records: [{ type: 'pt_clients', id: clientId }] },
      };
    },
  }]);
  return { registry, calls };
}

const req = (user = TRAINER) => ({ user });

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.COPILOT_CLIENT_ACCESS;
});

afterEach(() => {
  delete process.env.COPILOT_CLIENT_ACCESS;
});

describe('tenant isolation', () => {
  test('a client id from another studio is denied and no handler runs', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] }); // shared tenant gate finds nothing
    const { registry, calls } = fixture();

    const out = await registry.run(req(), 'get_client_profile', {}, { clientId: 'client-org-b' });

    expect(out).toMatchObject({ ok: false, code: 'CLIENT_NOT_FOUND' });
    expect(calls).toEqual([]);

    // The gate itself carries both the client id and the caller's org.
    const [sql, params] = pool.query.mock.calls[0];
    expect(String(sql)).toMatch(/organization_id = \$2/);
    expect(params).toEqual(['client-org-b', ORG_A]);
  });

  test('the same client id is allowed inside its own studio', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'client-a', name: 'Asha' }] });
    const { registry, calls } = fixture();

    const out = await registry.run(req(), 'get_client_profile', {}, { clientId: 'client-a' });

    expect(out.ok).toBe(true);
    expect(calls).toEqual(['client-a']);
    expect(pool.query.mock.calls[0][1]).toEqual(['client-a', ORG_A]);
  });

  test('an org-less account cannot reach a client tool at all', async () => {
    const { registry, calls } = fixture();

    const out = await registry.run(
      req({ ...TRAINER, organization_id: null }),
      'get_client_profile',
      {},
      { clientId: 'client-a' }
    );

    expect(out).toMatchObject({ ok: false, code: 'NO_TENANT' });
    expect(calls).toEqual([]);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('assigned_clients_only policy', () => {
  beforeEach(() => {
    process.env.COPILOT_CLIENT_ACCESS = 'assigned_clients_only';
  });

  test('an unassigned client is denied after the tenant gate passes', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 'client-a', name: 'Asha' }] }) // visible to the studio
      .mockResolvedValueOnce({ rows: [] });                                // not assigned to tr-1
    const { registry, calls } = fixture();

    const out = await registry.run(req(), 'get_client_profile', {}, { clientId: 'client-a' });

    expect(out).toMatchObject({ ok: false, code: 'CLIENT_NOT_FOUND' });
    expect(calls).toEqual([]);

    const [sql, params] = pool.query.mock.calls[1];
    expect(String(sql)).toMatch(/organization_id = \$2/);
    expect(String(sql)).toMatch(/trainer_id = \$3/);
    expect(params).toEqual(['client-a', ORG_A, 'tr-1']);
  });

  test('an assigned client is allowed', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 'client-a', name: 'Asha' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'client-a' }] });
    const { registry, calls } = fixture();

    const out = await registry.run(req(), 'get_client_profile', {}, { clientId: 'client-a' });

    expect(out.ok).toBe(true);
    expect(calls).toEqual(['client-a']);
  });

  test('a caller with no trainer id holds no assignments and is denied without a query', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'client-a', name: 'Asha' }] });
    const { registry, calls } = fixture();

    const out = await registry.run(
      req({ ...TRAINER, trainer_id: null }),
      'get_client_profile',
      {},
      { clientId: 'client-a' }
    );

    expect(out).toMatchObject({ ok: false, code: 'CLIENT_NOT_FOUND' });
    expect(calls).toEqual([]);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  test('the default policy is organization-wide, so shipping changes no studio access', async () => {
    delete process.env.COPILOT_CLIENT_ACCESS;
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'client-a', name: 'Asha' }] });
    const { registry } = fixture();

    const out = await registry.run(req(), 'get_client_profile', {}, { clientId: 'client-a' });

    expect(out.ok).toBe(true);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});
