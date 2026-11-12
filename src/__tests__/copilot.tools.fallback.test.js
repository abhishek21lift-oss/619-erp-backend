'use strict';
// The fallback boundary: the legacy regex readers run ONLY when the planner
// matched no tool. A planned call always returns an envelope — denial,
// validation failure, timeout or execution error — and none of those may
// re-enter the old path. A registry crash is a failure too, not a no-match.

jest.mock('../db/pool', () => ({ query: jest.fn() }));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../modules/copilot/tools/execute', () => ({
  runRegistryTools: jest.fn(),
}));

const pool = require('../db/pool');
const { runRegistryTools } = require('../modules/copilot/tools/execute');
const { runTools } = require('../lib/ai/tools');

const ORG = '11111111-1111-1111-1111-111111111111';
const req = { user: { id: 'usr-1', role: 'trainer', organization_id: ORG } };

const FAILURE_CODES = [
  'FORBIDDEN',
  'UNAUTHENTICATED',
  'NO_TENANT',
  'CLIENT_REQUIRED',
  'CLIENT_NOT_FOUND',
  'BAD_ARGS',
  'TOOL_TIMEOUT',
  'TOOL_FAILED',
  'UNKNOWN_TOOL',
];

beforeEach(() => {
  pool.query.mockReset();
  runRegistryTools.mockReset();
});

describe('no match is the only fallback trigger', () => {
  test('null reaches the legacy reader', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ total_revenue: '5000', total_payments: '3' }],
    });
    runRegistryTools.mockResolvedValueOnce(null);

    const result = await runTools(req, 'What was our revenue this month?');

    expect(result.toolNames).toEqual(['Revenue']);
    expect(pool.query).toHaveBeenCalledTimes(1); // the legacy revenue query
  });
});

describe.each(FAILURE_CODES)('planned call failing with %s', (code) => {
  test('is returned as an honest failure and never reaches legacy readers', async () => {
    const envelopes = [{ ok: false, tool: 'get_client_profile', code, message: 'denied', status: 403 }];
    runRegistryTools.mockResolvedValueOnce({
      toolNames: ['Client Profile'],
      contextText: '[Client Profile] The current user is not permitted to view this data.',
      envelopes,
      runs: [{ tool: 'get_client_profile', run_id: 'run-1', ok: false, code }],
    });

    const result = await runTools(req, 'How is the attendance looking?', { clientId: 'client-1' });

    expect(result.toolNames).toEqual(['Client Profile']);
    expect(result.runs).toEqual([{ tool: 'get_client_profile', run_id: 'run-1', ok: false, code }]);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('registry crash', () => {
  test('is reported as a failure, not converted into a legacy run', async () => {
    runRegistryTools.mockRejectedValueOnce(new Error('registry exploded'));

    const result = await runTools(req, 'What was our revenue this month?');

    expect(result.toolNames).toEqual([]);
    expect(result.runs).toEqual([]);
    expect(result.contextText).toMatch(/live-data tool layer failed/);
    expect(result.contextText).toMatch(/could not be read/);
    expect(pool.query).not.toHaveBeenCalled();
  });
});
