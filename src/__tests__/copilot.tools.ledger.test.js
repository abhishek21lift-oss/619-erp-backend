'use strict';
// The durable tool ledger: one row per attempt, tenant-scoped, sanitized and
// idempotent. The ledger is additive: its failure must never change the tool
// envelope the user already received.

jest.mock('../db/pool', () => ({ query: jest.fn() }));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const pool = require('../db/pool');
const logger = require('../lib/logger');
const {
  recordToolRun, conversationForUser, listToolRuns, getToolRun,
  classifyError, statusFor, safeArgs,
} = require('../modules/copilot/tools/ledger');

const ORG = '11111111-1111-1111-1111-111111111111';

const ENTRY = {
  organizationId: ORG,
  userId: 'usr-1',
  conversationId: 'conv-1',
  messageId: 'msg-1',
  correlationId: 'corr-1',
  toolName: 'get_client_profile',
  level: 'READ',
  sensitivity: 'personal',
  clientId: 'client-1',
  argsDigest: 'digest-1',
  argsMeta: { limit: 10, from: '2026-01-01' },
  ordinal: 0,
  selectionReason: 'profile_intent',
};

beforeEach(() => {
  pool.query.mockReset();
  logger.warn.mockClear();
});

describe('classification', () => {
  test('every security and execution code maps to its own category', () => {
    expect(classifyError('FORBIDDEN')).toBe('AUTHORIZATION_DENIED');
    expect(classifyError('UNAUTHENTICATED')).toBe('AUTHORIZATION_DENIED');
    expect(classifyError('NO_TENANT')).toBe('TENANT_SCOPE_DENIED');
    expect(classifyError('CLIENT_NOT_FOUND')).toBe('CLIENT_SCOPE_DENIED');
    expect(classifyError('BAD_ARGS')).toBe('ARGUMENT_VALIDATION_FAILED');
    expect(classifyError('TOOL_TIMEOUT')).toBe('TOOL_TIMEOUT');
    expect(classifyError('TOOL_FAILED')).toBe('TOOL_EXECUTION_FAILED');
    expect(classifyError('SOMETHING_ELSE')).toBe('TOOL_EXECUTION_FAILED');
  });

  test('status separates success, denial, timeout and execution failure', () => {
    expect(statusFor(true, null)).toBe('ok');
    expect(statusFor(false, 'AUTHORIZATION_DENIED')).toBe('denied');
    expect(statusFor(false, 'TENANT_SCOPE_DENIED')).toBe('denied');
    expect(statusFor(false, 'CLIENT_SCOPE_DENIED')).toBe('denied');
    expect(statusFor(false, 'TOOL_TIMEOUT')).toBe('timeout');
    expect(statusFor(false, 'ARGUMENT_VALIDATION_FAILED')).toBe('failed');
    expect(statusFor(false, 'TOOL_EXECUTION_FAILED')).toBe('failed');
  });
});

describe('argument sanitization', () => {
  test('keeps structural scalars only', () => {
    const safe = safeArgs({
      from: '2026-01-01', limit: 5, days: 28, flag: true,
      nested: { a: 1 }, tags: ['x'], when: new Date(),
    });
    expect(safe).toEqual({ from: '2026-01-01', limit: 5, days: 28, flag: true });
  });

  test('drops credentials and free text even when the key is scalar', () => {
    const safe = safeArgs({
      limit: 5, password: 'hunter2', access_token: 'tok', note: 'medical detail',
      message: 'raw prompt', query: 'client name',
    });
    expect(safe).toEqual({ limit: 5 });
    expect(JSON.stringify(safe)).not.toMatch(/hunter2|tok|medical|prompt|client name/);
  });

  test('a non-object or empty set becomes NULL, never a JSON string', () => {
    expect(safeArgs(null)).toBeNull();
    expect(safeArgs(['x'])).toBeNull();
    expect(safeArgs({ note: 'only free text' })).toBeNull();
  });
});

describe('recordToolRun', () => {
  test('writes one tenant-stamped, sanitized success row', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'run-1' }] });

    const result = await recordToolRun({
      ...ENTRY,
      ok: true,
      durationMs: 12,
      provenance: {
        source: 'pt-os.client-read',
        records: [{ type: 'pt_clients', id: 'client-1' }],
        as_of: '2026-01-01',
        freshness: { stale: false },
        missing: [],
      },
      extraResultMeta: { empty: false },
    });

    expect(result).toEqual({ recorded: true, run_id: 'run-1', duplicate: false });
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO ai_tool_runs');
    // The conversation and message links are re-resolved through the caller's
    // own user AND organization; a foreign id can only become NULL.
    expect(sql).toMatch(/c\.user_id = \$2 AND c\.organization_id = \$1/);
    expect(sql).toMatch(/m\.id = \$4.*c\.user_id = \$2 AND c\.organization_id = \$1/s);
    // Append-only: the no-op conflict clause must never require UPDATE.
    expect(sql).toContain('ON CONFLICT (run_key) DO NOTHING');
    expect(sql).not.toMatch(/DO UPDATE|\bSET\b/);

    expect(params[0]).toBe(ORG);
    expect(params[1]).toBe('usr-1');
    expect(params[2]).toBe('conv-1');
    expect(params[3]).toBe('msg-1');
    expect(params[4]).toBe('corr-1');
    expect(params[6]).toBe('get_client_profile');
    expect(params[7]).toBe('READ');
    expect(params[8]).toBe('personal');
    expect(params[9]).toBe('client-1');
    expect(params[12]).toBe('ok');
    expect(params[13]).toBeNull();
    expect(params[14]).toBeNull();
    expect(JSON.parse(params[11])).toEqual({ limit: 10, from: '2026-01-01' });
    expect(JSON.parse(params[19])).toMatchObject({ records: 1, missing: [], stale: false });
    expect(params[20]).toBe(12);
    expect(params[21]).toBe('profile_intent');
  });

  test('records an authorization denial without a protected detail', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'run-2' }] });

    const result = await recordToolRun({
      ...ENTRY, argsMeta: null, ok: false, code: 'FORBIDDEN', durationMs: 1,
    });

    expect(result.run_id).toBe('run-2');
    const [, params] = pool.query.mock.calls[0];
    expect(params[12]).toBe('denied');
    expect(params[13]).toBe('FORBIDDEN');
    expect(params[14]).toBe('AUTHORIZATION_DENIED');
    expect(params[11]).toBeNull();
  });

  test('a missing tenant is a tenant denial and may store a NULL org', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'run-3' }] });

    await recordToolRun({ ...ENTRY, organizationId: null, ok: false, code: 'NO_TENANT', durationMs: 0 });

    const [, params] = pool.query.mock.calls[0];
    expect(params[0]).toBeNull();
    expect(params[12]).toBe('denied');
    expect(params[14]).toBe('TENANT_SCOPE_DENIED');
  });

  test('a timeout is status timeout, not a denial', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'run-4' }] });

    await recordToolRun({ ...ENTRY, ok: false, code: 'TOOL_TIMEOUT', durationMs: 5000 });

    const [, params] = pool.query.mock.calls[0];
    expect(params[12]).toBe('timeout');
    expect(params[14]).toBe('TOOL_TIMEOUT');
  });

  test('an execution failure is status failed', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'run-5' }] });

    await recordToolRun({ ...ENTRY, ok: false, code: 'TOOL_FAILED', durationMs: 8 });

    const [, params] = pool.query.mock.calls[0];
    expect(params[12]).toBe('failed');
    expect(params[13]).toBe('TOOL_FAILED');
    expect(params[14]).toBe('TOOL_EXECUTION_FAILED');
  });

  test('a retried request returns the existing row instead of a duplicate', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'run-1' }] });

    const result = await recordToolRun({ ...ENTRY, ok: true, durationMs: 2 });

    expect(result).toEqual({ recorded: true, run_id: 'run-1', duplicate: true });

    const [selectSql, selectParams] = pool.query.mock.calls[1];
    expect(selectSql).toMatch(/SELECT id FROM ai_tool_runs WHERE run_key = \$1/);
    expect(selectParams).toEqual([pool.query.mock.calls[0][1][5]]);
  });

  test('a conflict with no visible row is logged, never claimed as recorded', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await recordToolRun({ ...ENTRY, ok: true, durationMs: 2 });

    expect(result).toEqual({ recorded: false, run_id: null, duplicate: true });
    expect(logger.warn).toHaveBeenCalledWith(
      { tool: 'get_client_profile' },
      'copilot_tool_ledger_duplicate_unresolved'
    );
  });

  test('a serialization conflict is retried a bounded number of times', async () => {
    const serialization = Object.assign(new Error('could not serialize access'), { code: '40001' });
    pool.query
      .mockRejectedValueOnce(serialization)
      .mockResolvedValueOnce({ rows: [{ id: 'run-retry' }] });

    const result = await recordToolRun({ ...ENTRY, ok: true, durationMs: 2 });

    expect(result).toEqual({ recorded: true, run_id: 'run-retry', duplicate: false });

    pool.query.mockReset();
    pool.query.mockRejectedValue(serialization);
    const failed = await recordToolRun({ ...ENTRY, ok: true, durationMs: 2 });

    expect(failed).toEqual({ recorded: false, run_id: null, duplicate: false });
    expect(pool.query).toHaveBeenCalledTimes(3);
  });

  test('a new turn or a different tool gets a different key', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 'run-x' }] });

    await recordToolRun({ ...ENTRY, ok: true, durationMs: 0 });
    await recordToolRun({ ...ENTRY, toolName: 'get_client_snapshot', ok: true, durationMs: 0 });
    await recordToolRun({ ...ENTRY, correlationId: 'corr-2', ok: true, durationMs: 0 });

    const keys = pool.query.mock.calls.map(([, p]) => p[5]);
    expect(new Set(keys).size).toBe(3);
  });

  test('a ledger insert failure never throws and never reports a record', async () => {
    pool.query.mockRejectedValueOnce(new Error('relation ai_tool_runs does not exist'));

    await expect(recordToolRun({ ...ENTRY, ok: true, durationMs: 1 }))
      .resolves.toEqual({ recorded: false, run_id: null, duplicate: false });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'get_client_profile' }),
      'copilot_tool_ledger_write_failed'
    );
    // The log carries the error, never the arguments or the conversation text.
    const [, logged] = logger.warn.mock.calls[0];
    expect(JSON.stringify(logged)).not.toMatch(/conv-1|msg-1|corr-1/);
  });

  test('without a correlation id there is no write at all', async () => {
    const result = await recordToolRun({ ...ENTRY, correlationId: null, ok: true });

    expect(result).toEqual({ recorded: false, run_id: null, duplicate: false });
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('reads', () => {
  test('conversation ownership is re-checked with user and org', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'conv-1' }] });

    const found = await conversationForUser(ORG, 'usr-1', 'conv-1');

    expect(found).toEqual({ id: 'conv-1' });
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/id = \$1 AND user_id = \$2 AND organization_id = \$3/);
    expect(params).toEqual(['conv-1', 'usr-1', ORG]);
  });

  test('a foreign conversation resolves to null, like an unknown one', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await expect(conversationForUser(ORG, 'usr-1', 'foreign')).resolves.toBeNull();
  });

  test('the list query is tenant- and user-scoped and uses a keyset cursor', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await listToolRuns({
      organizationId: ORG, userId: 'usr-1', conversationId: 'conv-1',
      limit: 20, before: '2026-01-02T00:00:00Z', beforeId: 'run-9',
    });

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/organization_id = \$1 AND user_id = \$2 AND conversation_id = \$3/);
    expect(sql).toMatch(/\(created_at, id\) < \(\$4::timestamptz, \$5\)/);
    expect(sql).toContain('LIMIT $6');
    expect(params).toEqual([ORG, 'usr-1', 'conv-1', '2026-01-02T00:00:00Z', 'run-9', 20]);
  });

  test('the detail query is tenant- and user-scoped', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: 'run-1', tool_name: 'get_client_profile', level: 'READ', status: 'ok',
        error_code: null, error_category: null, duration_ms: 4, source: 'svc',
        source_as_of: '2026-01-01', freshness: { stale: false }, result_meta: { records: 1 },
        client_id: 'client-1', created_at: '2026-01-01T00:00:00Z',
        conversation_id: 'conv-1', message_id: 'msg-1', correlation_id: 'corr-1',
        sensitivity: 'personal', args_digest: 'digest-1', args_meta: { limit: 1 },
        source_refs: [{ type: 'pt_clients', id: 'client-1' }],
        // Never selected by the route, present only to prove it is dropped:
        organization_id: ORG, user_id: 'usr-1', run_key: 'secret-key',
      }],
    });

    const run = await getToolRun({ organizationId: ORG, userId: 'usr-1', id: 'run-1' });

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/id = \$1 AND organization_id = \$2 AND user_id = \$3/);
    expect(params).toEqual(['run-1', ORG, 'usr-1']);
    expect(run).toMatchObject({ id: 'run-1', tool: 'get_client_profile', client_scoped: true });
    expect(run).not.toHaveProperty('organization_id');
    expect(run).not.toHaveProperty('user_id');
    expect(run).not.toHaveProperty('run_key');
  });

  test('an unknown or foreign run returns null', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await expect(getToolRun({ organizationId: ORG, userId: 'usr-1', id: 'nope' }))
      .resolves.toBeNull();
  });
});
