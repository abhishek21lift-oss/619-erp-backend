'use strict';
// The secure tool registry: one pipeline for every Copilot tool call.
//
// These tests pin the properties that matter more than any individual tool:
// the model cannot name a tool, a foreign client is denied before a handler
// runs, extra arguments are rejected, a slow tool cannot hang the request, and
// the audit event carries ids and a digest only — never argument values.

jest.mock('../modules/copilot/context/client-scope', () => ({
  resolveSelectedClient: jest.fn(),
}));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { z } = require('zod');
const { resolveSelectedClient } = require('../modules/copilot/context/client-scope');
const logger = require('../lib/logger');
const { createRegistry, ToolError, MAX_LEVELS } = require('../modules/copilot/tools/registry');

const TRAINER = {
  id: 'usr-1', name: 'Trainer One', role: 'trainer',
  trainer_id: 'tr-1', organization_id: 'org-a',
};
const req = (user = TRAINER) => ({ user });

/** A registry with two tools: a client-scoped read and a studio read. */
function fixture() {
  const calls = [];
  const registry = createRegistry([
    {
      name: 'get_client_profile',
      label: 'Client Profile',
      description: 'Profile for the selected client.',
      level: 'READ',
      clientScope: 'required',
      sensitivity: 'personal',
      timeoutMs: 1000,
      args: z.object({}).strict(),
      source: 'test.clientProfile',
      async run({ ctx, clientId }) {
        calls.push({ tool: 'client', ctx, clientId });
        return {
          data: { id: clientId, name: 'Asha' },
          provenance: {
            source: 'pt_clients', records: [{ type: 'pt_clients', id: clientId }],
            as_of: '2026-11-11', freshness: { as_of: '2026-11-11', age_days: 0, stale: false },
            missing: [],
          },
        };
      },
    },
    {
      name: 'get_pending_followups',
      label: 'Pending Follow-ups',
      description: 'Studio follow-ups.',
      level: 'READ',
      clientScope: 'none',
      sensitivity: 'personal',
      timeoutMs: 1000,
      args: z.object({ limit: z.number().int().min(1).max(50).default(15) }).strict(),
      source: 'test.followups',
      async run({ args }) {
        calls.push({ tool: 'followups', args });
        return { data: [], provenance: { missing: ['no follow-ups'] } };
      },
    },
  ]);
  return { registry, calls };
}

beforeEach(() => {
  jest.clearAllMocks();
  resolveSelectedClient.mockReset();
  resolveSelectedClient.mockResolvedValue({ id: 'c-1', name: 'Asha' });
});

describe('definitions', () => {
  test('rejects a duplicate tool name', () => {
    const def = {
      name: 'dup', description: 'x', level: 'READ', clientScope: 'none',
      sensitivity: 'personal', args: z.object({}).strict(), source: 'x',
      async run() { return { data: {} }; },
    };
    expect(() => createRegistry([def, def])).toThrow(/duplicate/i);
  });

  test('Phase 3 refuses to define anything above READ', () => {
    expect(MAX_LEVELS).toEqual(['READ']);
    expect(() => createRegistry([{
      name: 'write_tool', description: 'x', level: 'EXECUTE', clientScope: 'none',
      sensitivity: 'personal', args: z.object({}).strict(), source: 'x',
      async run() { return { data: {} }; },
    }])).toThrow(/READ-only/i);
  });

  test('exposes metadata without handlers', () => {
    const { registry } = fixture();
    const listed = registry.list();

    expect(listed.map((t) => t.name)).toEqual(['get_client_profile', 'get_pending_followups']);
    expect(listed[0]).toMatchObject({
      level: 'READ', clientScope: 'required', sensitivity: 'personal', timeoutMs: 1000,
    });
    expect(listed[0].run).toBeUndefined();
  });
});

describe('authorization', () => {
  test('refuses an unauthenticated caller before any tool runs', async () => {
    const { registry, calls } = fixture();

    const out = await registry.run({ user: null }, 'get_pending_followups', {});

    expect(out).toMatchObject({ ok: false, code: 'UNAUTHENTICATED' });
    expect(calls).toHaveLength(0);
    expect(resolveSelectedClient).not.toHaveBeenCalled();
  });

  test('refuses a member before any tool runs', async () => {
    const { registry, calls } = fixture();

    const out = await registry.run(req({ id: 'u2', role: 'member', organization_id: 'org-a' }), 'get_pending_followups', {});

    expect(out).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(calls).toHaveLength(0);
  });

  test('refuses an unregistered tool without touching context or data', async () => {
    const { registry, calls } = fixture();

    const out = await registry.run(req(), 'executeSQL', {});

    expect(out).toMatchObject({ ok: false, code: 'UNKNOWN_TOOL' });
    expect(calls).toHaveLength(0);
    expect(resolveSelectedClient).not.toHaveBeenCalled();
  });

  test('an org-less account is refused, never given a global view', async () => {
    const { registry, calls } = fixture();

    const out = await registry.run(req({ ...TRAINER, organization_id: null }), 'get_pending_followups', {});

    expect(out).toMatchObject({ ok: false, code: 'NO_TENANT' });
    expect(calls).toHaveLength(0);
  });
});

describe('client scope', () => {
  test('a required client tool refuses when no client is selected', async () => {
    const { registry, calls } = fixture();

    const out = await registry.run(req(), 'get_client_profile', {});

    expect(out).toMatchObject({ ok: false, code: 'CLIENT_REQUIRED' });
    expect(calls).toHaveLength(0);
  });

  test('a foreign, deleted or unassigned client is denied before the handler', async () => {
    resolveSelectedClient.mockResolvedValue(null);
    const { registry, calls } = fixture();

    const out = await registry.run(req(), 'get_client_profile', {}, { clientId: 'c-foreign' });

    expect(out).toMatchObject({ ok: false, code: 'CLIENT_NOT_FOUND' });
    expect(calls).toHaveLength(0);
    expect(resolveSelectedClient).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-a', policy: 'organization_wide' }),
      'c-foreign'
    );
  });

  test('a visible client is resolved once and passed to the handler', async () => {
    const { registry, calls } = fixture();

    const out = await registry.run(req(), 'get_client_profile', {}, { clientId: 'c-1' });

    expect(out.ok).toBe(true);
    expect(out.data).toEqual({ id: 'c-1', name: 'Asha' });
    expect(calls[0].clientId).toBe('c-1');
    expect(calls[0].ctx.tenant.organizationId).toBe('org-a');
  });

  test('a client id sent inside args is rejected by the strict schema', async () => {
    const { registry, calls } = fixture();

    const out = await registry.run(req(), 'get_client_profile', { client_id: 'c-1' }, { clientId: 'c-1' });

    expect(out).toMatchObject({ ok: false, code: 'BAD_ARGS' });
    expect(calls).toHaveLength(0);
  });
});

describe('argument validation', () => {
  test('rejects a wrong type before the handler', async () => {
    const { registry, calls } = fixture();

    const out = await registry.run(req(), 'get_pending_followups', { limit: 'all' });

    expect(out).toMatchObject({ ok: false, code: 'BAD_ARGS' });
    expect(calls).toHaveLength(0);
  });

  test('rejects an oversized limit', async () => {
    const { registry, calls } = fixture();

    const out = await registry.run(req(), 'get_pending_followups', { limit: 5000 });

    expect(out).toMatchObject({ ok: false, code: 'BAD_ARGS' });
    expect(calls).toHaveLength(0);
  });

  test('applies schema defaults', async () => {
    const { registry, calls } = fixture();

    await registry.run(req(), 'get_pending_followups', {});

    expect(calls[0].args).toEqual({ limit: 15 });
  });
});

describe('execution safety', () => {
  test('a slow handler returns TOOL_TIMEOUT instead of hanging', async () => {
    const registry = createRegistry([{
      name: 'slow_tool', description: 'x', level: 'READ', clientScope: 'none',
      sensitivity: 'personal', args: z.object({}).strict(), source: 'test.slow', timeoutMs: 10,
      run: () => new Promise((resolve) => setTimeout(() => resolve({ data: {} }), 50)),
    }]);

    const out = await registry.run(req(), 'slow_tool', {});

    expect(out).toMatchObject({ ok: false, code: 'TOOL_TIMEOUT' });
  });

  test('a thrown handler becomes a generic failure, not the raw error', async () => {
    const registry = createRegistry([{
      name: 'broken_tool', description: 'x', level: 'READ', clientScope: 'none',
      sensitivity: 'personal', args: z.object({}).strict(), source: 'test.broken',
      async run() { throw new Error('relation "secret_table" does not exist'); },
    }]);

    const out = await registry.run(req(), 'broken_tool', {});

    expect(out).toMatchObject({ ok: false, code: 'TOOL_FAILED' });
    expect(JSON.stringify(out)).not.toContain('secret_table');
    expect(logger.warn).toHaveBeenCalled();
  });

  test('sanitises dates, long strings, capped arrays and secret-looking keys', async () => {
    const registry = createRegistry([{
      name: 'dirty_tool', description: 'x', level: 'READ', clientScope: 'none',
      sensitivity: 'personal', args: z.object({}).strict(), source: 'test.dirty',
      async run() {
        return {
          data: {
            measured_on: new Date(2026, 10, 11),
            note: 'x'.repeat(5000),
            password: 'hunter2',
            rows: Array.from({ length: 150 }, (_, i) => i),
            nested: { token: 'abc', ok: true },
          },
        };
      },
    }]);

    const out = await registry.run(req(), 'dirty_tool', {});

    expect(out.data.measured_on).toBe('2026-11-11');
    expect(out.data.note.length).toBe(2000);
    expect(out.data.password).toBeUndefined();
    expect(out.data.nested.token).toBeUndefined();
    expect(out.data.nested.ok).toBe(true);
    expect(out.data.rows).toHaveLength(100);
  });
});

describe('provenance', () => {
  test('normalises a partial provenance object', async () => {
    const { registry } = fixture();

    const out = await registry.run(req(), 'get_pending_followups', {});

    expect(out.provenance).toEqual(expect.objectContaining({
      source: 'test.followups',
      records: [],
      as_of: null,
      missing: ['no follow-ups'],
    }));
  });

  test('a handler that returns nothing useful is not reported as success with empty data', async () => {
    const registry = createRegistry([{
      name: 'empty_tool', description: 'x', level: 'READ', clientScope: 'none',
      sensitivity: 'personal', args: z.object({}).strict(), source: 'test.empty',
      async run() { return null; },
    }]);

    const out = await registry.run(req(), 'empty_tool', {});

    expect(out).toMatchObject({ ok: false, code: 'TOOL_FAILED' });
  });
});

describe('audit', () => {
  test('records one event per successful run with ids, digest and no argument values', async () => {
    const { registry } = fixture();

    await registry.run(req(), 'get_pending_followups', { limit: 7 });

    expect(logger.info).toHaveBeenCalledTimes(1);
    const [fields, message] = logger.info.mock.calls[0];
    expect(message).toMatch(/tool/i);
    expect(fields).toMatchObject({
      event: 'copilot.tool.run',
      tool: 'get_pending_followups',
      user_id: 'usr-1',
      organization_id: 'org-a',
      level: 'READ',
      sensitivity: 'personal',
      status: 'ok',
    });
    expect(fields.args_digest).toMatch(/^[a-f0-9]{16}$/);
    expect(fields.latency_ms).toEqual(expect.any(Number));
    // The audit line must not carry the raw argument or client data.
    expect(JSON.stringify(fields)).not.toContain('"limit":7');
    expect(JSON.stringify(fields)).not.toContain('Asha');
  });

  test('records a failed run with its code', async () => {
    resolveSelectedClient.mockResolvedValue(null);
    const { registry } = fixture();

    await registry.run(req(), 'get_client_profile', {}, { clientId: 'c-foreign' });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [fields] = logger.warn.mock.calls[0];
    expect(fields).toMatchObject({
      event: 'copilot.tool.run', tool: 'get_client_profile',
      status: 'error', code: 'CLIENT_NOT_FOUND',
    });
  });
});

describe('ToolError', () => {
  test('carries a code and a status', () => {
    const err = new ToolError('BAD_ARGS', 400, 'nope');
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('BAD_ARGS');
    expect(err.status).toBe(400);
  });
});
