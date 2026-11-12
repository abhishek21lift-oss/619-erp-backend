'use strict';
// Chat integration: the registry is tried first, the legacy regex readers
// remain the fallback, and the caller's selected client is the only way a
// client enters a tool.

jest.mock('../db/pool', () => ({ query: jest.fn() }));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../modules/pt-os/pt-os.service', () => ({
  getTrainerSchedule: jest.fn(),
  getTrainerWorkload: jest.fn(),
  getBalanceSheet: jest.fn(),
}));
jest.mock('../modules/pt-os/client-read.service', () => ({
  findVisibleClient: jest.fn(),
  getClientAttendance: jest.fn(),
  getClientProfile: jest.fn(),
  getClientSnapshot: jest.fn(),
  getClientTrainingBrief: jest.fn(),
}));
jest.mock('../modules/copilot/context/client-scope', () => ({
  resolveSelectedClient: jest.fn(),
}));

const pool = require('../db/pool');
const svc = require('../modules/pt-os/pt-os.service');
const clientRead = require('../modules/pt-os/client-read.service');
const { resolveSelectedClient } = require('../modules/copilot/context/client-scope');
const { runTools } = require('../lib/ai/tools');
const { today: studioToday } = require('../lib/appTime');

const ORG = '11111111-1111-1111-1111-111111111111';
const trainer = { id: 'usr-1', role: 'trainer', trainer_id: 'tr-1', organization_id: ORG };
const req = { user: trainer };
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

beforeEach(() => {
  jest.clearAllMocks();
  resolveSelectedClient.mockImplementation(async (_ctx, id) => (id ? { id, name: 'Asha' } : null));
});

describe('registry-first routing', () => {
  test('a selected-client attendance question uses the registry, not the legacy reader', async () => {
    clientRead.getClientAttendance.mockResolvedValueOnce([
      { id: 'a1', date: daysAgo(1), status: 'present' },
    ]);

    const result = await runTools(req, 'How is the attendance looking?', { clientId: 'client-1' });

    expect(result.toolNames).toEqual(['Client Attendance']);
    expect(result.contextText).toContain('source: copilot.context.assemble.attendanceSummary');
    expect(result.contextText).toContain(`as of ${daysAgo(1)}`);
    expect(result.contextText).toContain('"present":1');
    // The legacy attendance reader would have issued a COUNT(*) query.
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('a studio schedule question runs the registry schedule tool', async () => {
    svc.getTrainerSchedule.mockResolvedValueOnce([{
      id: 's1', session_date: new Date(), start_time: '07:00', end_time: '08:00',
      title: 'PT', status: 'scheduled', client_name: 'Asha', plan_name: null,
    }]);

    const result = await runTools(req, 'What is my schedule today?');

    expect(result.toolNames).toEqual(['Trainer Schedule']);
    expect(result.contextText).toContain('source: pt-os.service.getTrainerSchedule');
    expect(svc.getTrainerSchedule).toHaveBeenCalledWith(ORG, expect.objectContaining({
      from: studioToday(),
    }));
  });

  test('a member is refused by the registry and told so plainly', async () => {
    const result = await runTools(
      { user: { id: 'm1', role: 'member', organization_id: ORG } },
      'How is the attendance looking?',
      { clientId: 'client-1' }
    );

    expect(result.toolNames).toEqual(['Client Attendance']);
    expect(result.contextText).toMatch(/not permitted to view this data/);
    expect(clientRead.getClientAttendance).not.toHaveBeenCalled();
  });
});

describe('legacy fallback', () => {
  test('a revenue question still runs the legacy reader unchanged', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ total_revenue: '5000', total_payments: '3' }],
    });

    const result = await runTools(req, 'What was our revenue this month?');

    expect(result.toolNames).toEqual(['Revenue']);
    expect(result.contextText).toMatch(/Revenue .*5,000.*3 payments/);
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query.mock.calls[0][1]).toContain(ORG);
  });

  test('a message no tool answers runs nothing at all', async () => {
    const result = await runTools(req, 'What is a good warm-up routine?');

    expect(result).toEqual({ toolNames: [], contextText: '', runs: [] });
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('a client lookup without a selected client still reaches find_client', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 'c9', name: 'Prakhar Sharma', status: 'active' }],
    });

    const result = await runTools(req, 'Tell me about Prakhar Sharma');

    expect(result.toolNames).toEqual(['Client Lookup']);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});

describe('durable tool recording', () => {
  const correlation = {
    conversationId: 'conv-1', messageId: 'msg-1', correlationId: 'corr-1',
  };

  test('a registry success writes one ledger row and returns its run id', async () => {
    clientRead.getClientAttendance.mockResolvedValueOnce([
      { id: 'a1', date: daysAgo(1), status: 'present' },
    ]);
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'run-1', inserted: true }] });

    const result = await runTools(req, 'How is the attendance looking?', {
      clientId: 'client-1', ...correlation,
    });

    expect(result.runs).toEqual([
      { tool: 'get_attendance_summary', run_id: 'run-1', ok: true, code: null },
    ]);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO ai_tool_runs');
    expect(params[0]).toBe(ORG);
    expect(params[1]).toBe('usr-1');
    expect(params[2]).toBe('conv-1');
    expect(params[3]).toBe('msg-1');
    expect(params[4]).toBe('corr-1');
    expect(params[12]).toBe('ok');
  });

  test('a legacy success writes its attempt too', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ total_revenue: '5000', total_payments: '3' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'run-2', inserted: true }] });

    const result = await runTools(req, 'What was our revenue this month?', correlation);

    expect(result.runs).toEqual([
      { tool: 'revenue_summary', run_id: 'run-2', ok: true, code: null },
    ]);
    const [sql, params] = pool.query.mock.calls[1];
    expect(sql).toContain('INSERT INTO ai_tool_runs');
    expect(params[6]).toBe('revenue_summary');
    expect(params[12]).toBe('ok');
  });

  test('a legacy failure is recorded as failed, not as success', async () => {
    pool.query
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce({ rows: [{ id: 'run-3', inserted: true }] });

    const result = await runTools(req, 'What was our revenue this month?', correlation);

    expect(result.contextText).toMatch(/lookup failed just now/);
    expect(result.runs).toEqual([
      { tool: 'revenue_summary', run_id: 'run-3', ok: false, code: 'TOOL_FAILED' },
    ]);
    const [, params] = pool.query.mock.calls[1];
    expect(params[12]).toBe('failed');
    expect(params[13]).toBe('TOOL_FAILED');
    expect(params[14]).toBe('TOOL_EXECUTION_FAILED');
  });

  test('a ledger outage does not change the tool result or the context text', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ total_revenue: '5000', total_payments: '3' }] })
      .mockRejectedValueOnce(new Error('ledger missing'));

    const result = await runTools(req, 'What was our revenue this month?', correlation);

    expect(result.toolNames).toEqual(['Revenue']);
    expect(result.contextText).toMatch(/5,000/);
    expect(result.runs).toEqual([
      { tool: 'revenue_summary', run_id: null, ok: true, code: null },
    ]);
  });
});
