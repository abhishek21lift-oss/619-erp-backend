'use strict';
// The approval gate.
//
// ── What is being defended ─────────────────────────────────────────────────
//
// Everything in this module exists so that a write reaches the Hostinger API
// only after an identified operator has read what it will do. So the tests are
// about the ways that could quietly stop being true: a plan run twice, a plan
// run by somebody else, a plan whose stored parameters moved, a plan executed
// without the typed confirmation, a secret that ends up in the database, an
// execution that takes its parameters from the request instead of from what was
// approved.

jest.mock('../db/pool', () => ({ query: jest.fn(), connect: jest.fn() }));

jest.mock('../modules/platform/hostinger/credentials.service', () => {
  const actual = jest.requireActual('../modules/platform/hostinger/credentials.service');
  return { ...actual, status: jest.fn(), activeToken: jest.fn() };
});

jest.mock('../lib/hostinger/client', () => {
  const actual = jest.requireActual('../lib/hostinger/client');
  return { ...actual, call: jest.fn() };
});

const pool = require('../db/pool');
const client = require('../lib/hostinger/client');
const credentials = require('../modules/platform/hostinger/credentials.service');
const operations = require('../modules/platform/hostinger/operations.service');

const ACTOR = 'usr-superadmin-001';
const OTHER = 'usr-superadmin-002';

/** A pending approval row, as the execute path reads it back. */
function approvalRow(over = {}) {
  const stored = over.params || { path: { virtualMachineId: 7 } };
  return {
    id: '11111111-1111-4111-8111-111111111111',
    operation: 'vps.restart',
    params: stored,
    fingerprint: operations.fingerprintOf(over.operation || 'vps.restart', stored),
    safety: 'mutate',
    summary: { secret_fields: [] },
    actor: ACTOR,
    status: 'pending',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    consumed_at: null,
    ...over,
  };
}

/** Route each pool.query call to the handler whose pattern matches the SQL. */
function routeQueries(handlers) {
  pool.query.mockImplementation(async (sql, params) => {
    for (const [pattern, handler] of handlers) {
      if (pattern.test(sql)) return handler(sql, params);
    }
    return { rows: [] };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  operations.resetMemo();
  credentials.activeToken.mockResolvedValue({ token: 'hst_live_token_0123456789', credentialId: 'cred-1' });
  credentials.status.mockResolvedValue({ state: 'connected', key_configured: true, credential: { id: 'cred-1', hint: '…wxyz' } });
  client.call.mockResolvedValue({ ok: true, status: 200, data: { ok: true } });
});

describe('stable fingerprints', () => {
  it('does not depend on the order of keys', () => {
    const a = { path: { virtualMachineId: 1 }, query: { page: 2 } };
    const b = { query: { page: 2 }, path: { virtualMachineId: 1 } };
    expect(operations.fingerprintOf('vps.get', a)).toBe(operations.fingerprintOf('vps.get', b));
  });

  it('changes when any parameter changes, and when the operation changes', () => {
    const base = { path: { virtualMachineId: 1 } };
    expect(operations.fingerprintOf('vps.get', base)).not.toBe(operations.fingerprintOf('vps.get', { path: { virtualMachineId: 2 } }));
    expect(operations.fingerprintOf('vps.get', base)).not.toBe(operations.fingerprintOf('vps.stop', base));
  });
});

describe('plan', () => {
  it('stores the parameters, drops the secrets and names them for the operator', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'appr-1', created_at: 'now', expires_at: 'later' }] });

    const plan = await operations.plan({
      operationId: 'vps.recovery',
      params: { path: { virtualMachineId: 7 }, body: { root_password: 'super-secret-password' } },
      actorId: ACTOR,
      actorName: 'Owner',
    });

    expect(plan.approval_id).toBe('appr-1');
    expect(plan.safety).toBe('destructive');
    expect(plan.summary.requires_confirmation).toBe(true);
    expect(plan.summary.confirmation_text).toBe('vps.recovery');
    expect(plan.summary.secret_fields).toEqual(['root_password']);

    const [, inserted] = pool.query.mock.calls[0];
    const stored = JSON.parse(inserted[1]);
    // The whole reason the secret is re-entered at execute time.
    expect(JSON.stringify(stored)).not.toContain('super-secret-password');
    expect(stored.body).toBeUndefined();
    expect(JSON.stringify(plan)).not.toContain('super-secret-password');
  });

  it('refuses a read operation: reads do not need approval', async () => {
    await expect(operations.plan({
      operationId: 'vps.list',
      params: {},
      actorId: ACTOR,
    })).rejects.toMatchObject({ status: 400, code: 'HOSTINGER_NOT_APPROVABLE' });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('refuses an operation outside the catalogue', async () => {
    await expect(operations.plan({
      operationId: 'vps.formatDisk',
      params: {},
      actorId: ACTOR,
    })).rejects.toMatchObject({ status: 404, code: 'HOSTINGER_UNKNOWN_OPERATION' });
  });

  it('names the offending field when the parameters do not validate', async () => {
    await expect(operations.plan({
      operationId: 'vps.restart',
      params: { path: { virtualMachineId: 'not-a-number' } },
      actorId: ACTOR,
    })).rejects.toMatchObject({ status: 400, code: 'HOSTINGER_INVALID_PARAMS' });
  });

  it('requires an identified operator', async () => {
    await expect(operations.plan({
      operationId: 'vps.restart',
      params: { path: { virtualMachineId: 7 } },
      actorId: null,
    })).rejects.toMatchObject({ code: 'HOSTINGER_NO_ACTOR' });
  });
});

describe('execute', () => {
  it('requires an approval id', async () => {
    await expect(operations.execute({
      operationId: 'vps.restart',
      actorId: ACTOR,
    })).rejects.toMatchObject({ status: 400, code: 'HOSTINGER_APPROVAL_REQUIRED' });
  });

  it('runs with the STORED parameters, never the ones in the request', async () => {
    const row = approvalRow();
    routeQueries([
      [/FROM platform_hostinger_approvals\s+WHERE id = \$1/, () => ({ rows: [row] })],
      [/UPDATE platform_hostinger_approvals\s+SET status = 'consumed'/, () => ({ rows: [{ id: row.id }] })],
      [/SET result = \$2/, () => ({ rows: [] })],
    ]);

    await operations.execute({
      operationId: 'vps.restart',
      approvalId: row.id,
      actorId: ACTOR,
      // A request that tries to restart a different machine.
      params: { path: { virtualMachineId: 999 } },
    });

    expect(client.call).toHaveBeenCalledTimes(1);
    expect(client.call.mock.calls[0][0].pathParams).toEqual({ virtualMachineId: 7 });
  });

  it('refuses an approval that belongs to another operator', async () => {
    routeQueries([[/FROM platform_hostinger_approvals/, () => ({ rows: [approvalRow({ actor: OTHER })] })]]);
    await expect(operations.execute({
      operationId: 'vps.restart',
      approvalId: 'x',
      actorId: ACTOR,
    })).rejects.toMatchObject({ status: 403, code: 'HOSTINGER_APPROVAL_NOT_YOURS' });
    expect(client.call).not.toHaveBeenCalled();
  });

  it('refuses an approval for a different operation', async () => {
    routeQueries([[/FROM platform_hostinger_approvals/, () => ({ rows: [approvalRow({ operation: 'vps.stop' })] })]]);
    await expect(operations.execute({
      operationId: 'vps.restart',
      approvalId: 'x',
      actorId: ACTOR,
    })).rejects.toMatchObject({ status: 409, code: 'HOSTINGER_APPROVAL_MISMATCH' });
  });

  it('refuses to run an approval twice', async () => {
    routeQueries([[/FROM platform_hostinger_approvals/, () => ({ rows: [approvalRow({ status: 'consumed' })] })]]);
    await expect(operations.execute({
      operationId: 'vps.restart',
      approvalId: 'x',
      actorId: ACTOR,
    })).rejects.toMatchObject({ status: 409, code: 'HOSTINGER_ALREADY_EXECUTED' });
  });

  it('refuses an expired approval and marks it expired', async () => {
    const marks = [];
    const row = approvalRow({ expires_at: new Date(Date.now() - 1000).toISOString() });
    routeQueries([
      [/FROM platform_hostinger_approvals/, () => ({ rows: [row] })],
      [/SET status = 'expired'/, (sql, params) => { marks.push(params); return { rows: [] }; }],
    ]);
    await expect(operations.execute({
      operationId: 'vps.restart',
      approvalId: row.id,
      actorId: ACTOR,
    })).rejects.toMatchObject({ status: 409, code: 'HOSTINGER_APPROVAL_EXPIRED' });
    expect(marks).toEqual([[row.id]]);
    expect(client.call).not.toHaveBeenCalled();
  });

  it('voids an approval whose stored parameters no longer match the fingerprint', async () => {
    const voided = [];
    const row = approvalRow({ fingerprint: 'deadbeef' });
    routeQueries([
      [/FROM platform_hostinger_approvals/, () => ({ rows: [row] })],
      [/SET status = 'denied'/, (_sql, params) => { voided.push(params); return { rows: [] }; }],
    ]);
    await expect(operations.execute({
      operationId: 'vps.restart',
      approvalId: row.id,
      actorId: ACTOR,
    })).rejects.toMatchObject({ status: 409, code: 'HOSTINGER_APPROVAL_TAMPERED' });
    expect(voided).toHaveLength(1);
    expect(client.call).not.toHaveBeenCalled();
  });

  it('requires the operation id to be typed for a destructive call', async () => {
    const row = approvalRow({ operation: 'vps.snapshot.delete', safety: 'destructive', params: { path: { virtualMachineId: 7 } } });
    routeQueries([[/FROM platform_hostinger_approvals/, () => ({ rows: [row] })]]);

    await expect(operations.execute({
      operationId: 'vps.snapshot.delete',
      approvalId: row.id,
      actorId: ACTOR,
      confirmation: 'yes',
    })).rejects.toMatchObject({ status: 400, code: 'HOSTINGER_CONFIRMATION_REQUIRED', details: { expected: 'vps.snapshot.delete' } });
    expect(client.call).not.toHaveBeenCalled();
  });

  it('claims the row atomically and loses the race without calling the API', async () => {
    const row = approvalRow();
    routeQueries([
      [/FROM platform_hostinger_approvals/, () => ({ rows: [row] })],
      // Another request already consumed it between the read and the claim.
      [/SET status = 'consumed'/, () => ({ rows: [] })],
    ]);
    await expect(operations.execute({
      operationId: 'vps.restart',
      approvalId: row.id,
      actorId: ACTOR,
    })).rejects.toMatchObject({ status: 409, code: 'HOSTINGER_ALREADY_EXECUTED' });
    expect(client.call).not.toHaveBeenCalled();
  });

  it('asks for a required secret again, and never reads it from storage', async () => {
    const row = approvalRow({
      operation: 'vps.recovery',
      safety: 'destructive',
      params: { path: { virtualMachineId: 7 } },
      summary: { secret_fields: ['root_password'] },
    });
    routeQueries([[/FROM platform_hostinger_approvals/, () => ({ rows: [row] })]]);

    await expect(operations.execute({
      operationId: 'vps.recovery',
      approvalId: row.id,
      actorId: ACTOR,
      confirmation: 'vps.recovery',
    })).rejects.toMatchObject({ status: 400, code: 'HOSTINGER_SECRET_REQUIRED' });
    expect(client.call).not.toHaveBeenCalled();
  });

  it('forwards a re-supplied secret to the API and stores nothing', async () => {
    const row = approvalRow({
      operation: 'vps.recovery',
      safety: 'destructive',
      params: { path: { virtualMachineId: 7 } },
      summary: { secret_fields: ['root_password'] },
    });
    const writes = [];
    routeQueries([
      [/FROM platform_hostinger_approvals/, () => ({ rows: [row] })],
      [/SET status = 'consumed'/, () => ({ rows: [{ id: row.id }] })],
      [/SET result = \$2/, (sql, params) => { writes.push(params); return { rows: [] }; }],
    ]);

    const result = await operations.execute({
      operationId: 'vps.recovery',
      approvalId: row.id,
      actorId: ACTOR,
      confirmation: 'vps.recovery',
      secrets: { root_password: 'a-temporary-root-password' },
    });

    expect(result.ok).toBe(true);
    expect(client.call.mock.calls[0][0].body).toEqual({ root_password: 'a-temporary-root-password' });
    for (const [, params] of writes) {
      expect(JSON.stringify(params)).not.toContain('a-temporary-root-password');
    }
  });

  it('releases the claim when the credential is gone, so the operator can retry', async () => {
    const row = approvalRow();
    const releases = [];
    routeQueries([
      [/FROM platform_hostinger_approvals/, () => ({ rows: [row] })],
      [/SET status = 'consumed'/, () => ({ rows: [{ id: row.id }] })],
      [/SET status = 'pending', consumed_at = NULL/, (_sql, params) => { releases.push(params); return { rows: [] }; }],
    ]);
    credentials.activeToken.mockRejectedValueOnce(new credentials.HostingerError(409, 'HOSTINGER_NOT_CONNECTED', 'gone'));

    await expect(operations.execute({
      operationId: 'vps.restart',
      approvalId: row.id,
      actorId: ACTOR,
    })).rejects.toMatchObject({ code: 'HOSTINGER_NOT_CONNECTED' });
    expect(releases).toEqual([[row.id]]);
  });

  it('reports an upstream failure without throwing, and records the outcome', async () => {
    const row = approvalRow();
    const writes = [];
    routeQueries([
      [/FROM platform_hostinger_approvals/, () => ({ rows: [row] })],
      [/SET status = 'consumed'/, () => ({ rows: [{ id: row.id }] })],
      [/SET result = \$2/, (_sql, params) => { writes.push(params); return { rows: [] }; }],
    ]);
    client.call.mockResolvedValueOnce({ ok: false, status: 500, error: { code: 'HTTP_500', message: 'boom', correlationId: 'c1' } });

    const result = await operations.execute({
      operationId: 'vps.restart',
      approvalId: row.id,
      actorId: ACTOR,
    });
    expect(result.ok).toBe(false);
    expect(JSON.parse(writes[0][1]).ok).toBe(false);
  });
});

describe('reads', () => {
  it('runs directly and never asks for an approval', async () => {
    const result = await operations.read({ operationId: 'vps.list', params: {}, token: 't' });
    expect(result.ok).toBe(true);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('refuses to run a write', async () => {
    await expect(operations.read({
      operationId: 'vps.snapshot.delete',
      params: { path: { virtualMachineId: 1 } },
      token: 't',
    })).rejects.toMatchObject({ status: 400, code: 'HOSTINGER_APPROVAL_REQUIRED' });
  });

  it('strips a write-only credential out of the parameters it records', () => {
    const publicParams = operations.publicParams('vps.recovery', {
      path: { virtualMachineId: 7 },
      body: { root_password: 'secret-value-here' },
    });
    expect(JSON.stringify(publicParams)).not.toContain('secret-value-here');
  });
});

describe('lastSample', () => {
  // The metrics endpoint returns one timestamp map PER METRIC, under the API's
  // own key names. Reading it as an array of samples yields null for every
  // real payload, which is silent: the assistant simply loses the one number
  // the operator asked about.
  it('reads the documented shape and keeps the latest reading of each metric', () => {
    const sample = operations.lastSample({
      cpu_usage: { unit: '%', usage: { '1742269600': 1.1, '1742269700': 4.2 } },
      ram_usage: { unit: '%', usage: { '1742269600': 20, '1742269700': 31.5 } },
      disk_space: { unit: 'GB', usage: { '1742269700': 12.25 } },
      uptime: { unit: 's', usage: { '1742269700': 86400 } },
      incoming_traffic: { unit: 'MB', usage: { '1742269700': 900 } },
    });
    expect(sample).toEqual({
      cpu_usage: { unit: '%', value: 4.2, at: 1742269700 },
      ram_usage: { unit: '%', value: 31.5, at: 1742269700 },
      disk_space: { unit: 'GB', value: 12.25, at: 1742269700 },
      uptime: { unit: 's', value: 86400, at: 1742269700 },
    });
  });

  it('degrades to null rather than throwing when the shape moves', () => {
    expect(operations.lastSample(null)).toBeNull();
    expect(operations.lastSample([])).toBeNull();
    expect(operations.lastSample({ cpu_usage: { usage: {} } })).toBeNull();
    expect(operations.lastSample({ cpu_usage: { unit: '%' } })).toBeNull();
  });
});

describe('dashboard', () => {
  it('renders the connect prompt instead of erroring when nothing is connected', async () => {
    credentials.status.mockResolvedValue({ state: 'not_connected', key_configured: true, credential: null });
    const snapshot = await operations.dashboard({ force: true });
    expect(snapshot.connected).toBe(false);
    expect(snapshot.credential.state).toBe('not_connected');
    expect(snapshot.websites).toBeNull();
    expect(client.call).not.toHaveBeenCalled();
  });

  it('keeps a partial failure in its own slot and says what was sampled', async () => {
    client.call.mockImplementation(async ({ operationId }) => {
      if (operationId === 'vps.list') return { ok: false, status: 500, error: { code: 'HTTP_500', message: 'vps down' } };
      if (operationId === 'hosting.website.list') {
        return { ok: true, status: 200, data: { data: [
          { domain: 'a.com', username: 'u1' },
          { domain: 'b.com', username: 'u1' },
        ] } };
      }
      return { ok: true, status: 200, data: { data: [] } };
    });

    const snapshot = await operations.dashboard({ force: true });
    expect(snapshot.connected).toBe(true);
    expect(snapshot.vps.ok).toBe(false);
    expect(snapshot.vps.error.message).toBe('vps down');
    expect(snapshot.websites.ok).toBe(true);
    // SSL is checked for the sample only, and the sample size is stated.
    expect(snapshot.sampled).toEqual({ ssl_checked: 2, ssl_total: 2, metrics_checked: 0, metrics_total: 0 });
  });

  it('serves a repeat request from the memo so a refresh storm cannot spend the quota', async () => {
    await operations.dashboard({ force: true });
    const before = client.call.mock.calls.length;
    const second = await operations.dashboard({});
    expect(client.call.mock.calls.length).toBe(before);
    expect(second.cached).toBe(true);
  });
});

describe('history', () => {
  it('reads only this module’s rows from activity_log', async () => {
    const seen = [];
    pool.query.mockImplementation(async (sql, params) => {
      seen.push([sql, params]);
      return { rows: [{ total: 3 }] };
    });
    const result = await operations.history({ limit: 500, offset: -1 });
    expect(seen[0][0]).toContain("action LIKE 'hostinger.%'");
    expect(seen[0][1]).toEqual([200, 0, null]); // clamped, not trusted
    expect(result.total).toBe(3);
  });
});
