'use strict';
// The in-process tool registry: schema validation, tenancy denial, and the
// difference between "no records" and "the knowledge base is down".

jest.mock('../modules/pt-os/client-read.service', () => ({
  getClientSummary: jest.fn(),
  getClientProfile: jest.fn(),
  getClientTrainingBrief: jest.fn(),
  getClientSubscriptions: jest.fn(),
  getClientRenewals: jest.fn(),
  getClientAttendance: jest.fn(),
  getClientPayments: jest.fn(),
  getClientCommunication: jest.fn(),
}));
jest.mock('../lib/ai/knowledgeBase', () => ({ retrieveContext: jest.fn() }));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const read = require('../modules/pt-os/client-read.service');
const { retrieveContext } = require('../lib/ai/knowledgeBase');
const { run, list, TOOLS } = require('../modules/client-agent/tools');

const ORG = 'org-1';

beforeEach(() => {
  jest.clearAllMocks();
  read.getClientProfile.mockResolvedValue({ id: 'c-1', name: 'Asha' });
});

describe('registry surface', () => {
  it('exposes every tool the Client Assistant had before consolidation', () => {
    // The mps-ai registry this replaced defined nine; no dead tool is carried
    // over just to make the count round.
    expect(list()).toHaveLength(9);
    expect([...TOOLS.keys()]).toEqual(expect.arrayContaining([
      'getClientSummary', 'getClientProfile', 'getClientTrainingBrief',
      'getClientSubscriptions', 'getClientRenewals', 'getClientAttendance',
      'getClientPayments', 'getClientCommunication', 'search_knowledge',
    ]));
  });
});

describe('run()', () => {
  it('refuses an unregistered tool without touching data', async () => {
    const result = await run({ name: 'executeSQL', args: {}, orgId: ORG });
    expect(result).toMatchObject({ ok: false, code: 'UNKNOWN_TOOL' });
    expect(read.getClientProfile).not.toHaveBeenCalled();
  });

  it('validates the client id before calling the read layer', async () => {
    const result = await run({
      name: 'getClientProfile', args: { clientId: '../../other-studio' }, orgId: ORG,
    });
    expect(result).toMatchObject({ ok: false, code: 'BAD_ARGS' });
    expect(read.getClientProfile).not.toHaveBeenCalled();
  });

  it('reports a foreign or deleted client as NOT_FOUND, never as empty data', async () => {
    read.getClientProfile.mockResolvedValue(null);

    const result = await run({ name: 'getClientProfile', args: { clientId: 'c-1' }, orgId: ORG });

    expect(result).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(read.getClientProfile).toHaveBeenCalledWith(ORG, 'c-1');
  });

  it('keeps a RAG outage distinct from an empty corpus', async () => {
    const err = new Error('index unavailable');
    err.code = 'RAG_UNAVAILABLE';
    retrieveContext.mockRejectedValue(err);

    const result = await run({
      name: 'search_knowledge', args: { q: 'policy on PAR-Q' }, orgId: ORG, userId: 'u-1',
    });

    expect(result).toMatchObject({ ok: false, code: 'RAG_UNAVAILABLE' });
    expect(result.message).toMatch(/unavailable/i);
    expect(retrieveContext).toHaveBeenCalledWith({
      organizationId: ORG,
      query: 'policy on PAR-Q',
      topK: undefined,
      route: 'client_agent',
      userId: 'u-1',
    });
  });

  it('returns labelled data for a valid read', async () => {
    const result = await run({ name: 'getClientProfile', args: { clientId: 'c-1' }, orgId: ORG });

    expect(result).toMatchObject({
      ok: true,
      tool: 'getClientProfile',
      label: 'client profile',
      data: { id: 'c-1', name: 'Asha' },
    });
  });
});
