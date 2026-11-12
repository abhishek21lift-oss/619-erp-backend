'use strict';
// Client resolution for the Copilot.
//
// Two properties matter and are asserted separately:
//
//   1. Tenant isolation is non-negotiable. A client id is resolved through the
//      shared findVisibleClient() gate, so another studio's id returns null
//      before any policy read runs.
//   2. The access policy is a second, narrower filter. `organization_wide`
//      preserves today's behaviour; `assigned_clients_only` additionally
//      requires pt_clients.trainer_id to match the caller.

jest.mock('../modules/pt-os/client-read.service', () => ({
  findVisibleClient: jest.fn(),
}));
jest.mock('../db/pool', () => ({ query: jest.fn() }));

const pool = require('../db/pool');
const { findVisibleClient } = require('../modules/pt-os/client-read.service');
const {
  resolveSelectedClient,
  listVisibleClients,
} = require('../modules/copilot/context/client-scope');

const ORG_WIDE = {
  organizationId: 'org-a',
  trainerId: 'tr-1',
  policy: 'organization_wide',
};
const ASSIGNED = { ...ORG_WIDE, policy: 'assigned_clients_only' };

beforeEach(() => {
  pool.query.mockReset();
  findVisibleClient.mockReset();
});

describe('resolveSelectedClient — tenant gate first', () => {
  test('no client id resolves to no client and reads nothing', async () => {
    expect(await resolveSelectedClient(ORG_WIDE, null)).toBeNull();
    expect(findVisibleClient).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('a client from another studio is not found', async () => {
    findVisibleClient.mockResolvedValue(null);

    expect(await resolveSelectedClient(ORG_WIDE, 'foreign-client')).toBeNull();
    expect(findVisibleClient).toHaveBeenCalledWith('org-a', 'foreign-client');
    // The shared gate said no; no policy query may follow.
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('organization_wide returns the shared gate result unchanged', async () => {
    findVisibleClient.mockResolvedValue({ id: 'c1', name: 'Asha' });

    expect(await resolveSelectedClient(ORG_WIDE, 'c1')).toEqual({ id: 'c1', name: 'Asha' });
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('resolveSelectedClient — assigned_clients_only', () => {
  test('a client assigned to this trainer resolves', async () => {
    findVisibleClient.mockResolvedValue({ id: 'c1', name: 'Asha' });
    pool.query.mockResolvedValue({ rows: [{ id: 'c1', name: 'Asha' }] });

    expect(await resolveSelectedClient(ASSIGNED, 'c1')).toEqual({ id: 'c1', name: 'Asha' });

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('organization_id = $2');
    expect(sql).toContain('trainer_id = $3');
    expect(params).toEqual(['c1', 'org-a', 'tr-1']);
  });

  test('a client assigned to another trainer is denied', async () => {
    findVisibleClient.mockResolvedValue({ id: 'c1', name: 'Asha' });
    pool.query.mockResolvedValue({ rows: [] });

    expect(await resolveSelectedClient(ASSIGNED, 'c1')).toBeNull();
  });

  test('a caller with no trainer id sees nothing rather than everyone', async () => {
    findVisibleClient.mockResolvedValue({ id: 'c1', name: 'Asha' });

    expect(await resolveSelectedClient({ ...ASSIGNED, trainerId: null }, 'c1')).toBeNull();
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('listVisibleClients', () => {
  test('organization_wide lists only this studio, with no trainer filter', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 'c1', name: 'Asha' }] });

    const rows = await listVisibleClients(ORG_WIDE);

    expect(rows).toEqual([{ id: 'c1', name: 'Asha' }]);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('organization_id = $1');
    expect(sql).toContain('deleted_at IS NULL');
    expect(sql).not.toContain('trainer_id');
    expect(params).toEqual(['org-a', 100]);
  });

  test('assigned_clients_only binds the trainer id into the same query', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await listVisibleClients(ASSIGNED);

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('organization_id = $1');
    expect(sql).toContain('trainer_id = $2');
    expect(params).toEqual(['org-a', 'tr-1', 100]);
  });

  test('assigned_clients_only with no trainer id returns nothing, unqueried', async () => {
    expect(await listVisibleClients({ ...ASSIGNED, trainerId: null })).toEqual([]);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('the page size is bounded', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await listVisibleClients(ORG_WIDE, { limit: 5000 });
    expect(pool.query.mock.calls[0][1]).toEqual(['org-a', 100]);

    await listVisibleClients(ORG_WIDE, { limit: 0 });
    expect(pool.query.mock.calls[1][1]).toEqual(['org-a', 1]);
  });
});
