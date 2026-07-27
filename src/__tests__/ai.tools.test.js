jest.mock('../db/pool', () => ({ query: jest.fn() }));

const pool = require('../db/pool');
const { runTools } = require('../lib/ai/tools');

function reqAs(role, overrides = {}) {
  return { user: { id: 'usr-1', role, organization_id: 'org-1', trainer_id: 'trn-1', ...overrides } };
}

describe('AI Coach tool-calling (runTools)', () => {
  beforeEach(() => {
    pool.query.mockReset();
  });

  it('runs nothing for a message that matches no tool', async () => {
    const result = await runTools(reqAs('admin'), 'What is a good warm-up routine?');
    expect(result.toolNames).toEqual([]);
    expect(result.contextText).toBe('');
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('client_stats: triggers on "how many active clients" and formats the result', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ active: '12', inactive: '3', frozen: '1', expiring_soon: '2', total: '16' }],
    });
    const result = await runTools(reqAs('manager'), 'How many active clients do we have?');
    expect(result.toolNames).toContain('Client Stats');
    expect(result.contextText).toMatch(/16 total.*12 active/s);
    expect(pool.query).toHaveBeenCalledTimes(1);
    // Tenant-scoped: organization_id must be in the query params.
    const [, params] = pool.query.mock.calls[0];
    expect(params).toContain('org-1');
  });

  it('find_client: extracts the name and reports "not found" on an empty result', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const result = await runTools(reqAs('trainer'), 'Can you look up the client named Priya Sharma?');
    expect(result.toolNames).toContain('Client Lookup');
    expect(result.contextText).toMatch(/No client matching "Priya Sharma"/);
  });

  it('find_client: does not trigger on an unrelated mention of the word "client"', async () => {
    const result = await runTools(reqAs('admin'), 'What should I tell a new client about hydration?');
    expect(result.toolNames).not.toContain('Client Lookup');
  });

  it('revenue_summary: denies a trainer role without running the query', async () => {
    const result = await runTools(reqAs('trainer'), 'What was our revenue this month?');
    expect(result.toolNames).toContain('Revenue');
    expect(result.contextText).toMatch(/not permitted to view this data/);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('revenue_summary: runs for an admin and formats INR', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ total_revenue: '45000', total_payments: '9' }] });
    const result = await runTools(reqAs('admin'), 'What was our revenue this month?');
    expect(result.contextText).toMatch(/₹45,000/);
    expect(result.contextText).toMatch(/9 payments/);
  });

  it('search_exercises: extracts a known muscle keyword', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ name: 'Barbell Row', equipment: 'barbell', difficulty: 'intermediate' }],
    });
    const result = await runTools(reqAs('trainer'), 'What exercises target back for a beginner?');
    expect(result.toolNames).toContain('Exercise Search');
    expect(result.contextText).toMatch(/Barbell Row/);
  });

  it('caps at 2 tools even if more than 2 patterns match', async () => {
    pool.query.mockResolvedValue({ rows: [{}] });
    // "clients", "attendance" and "trainers" all appear — only the first 2 (by TOOLS array order) should run.
    const result = await runTools(reqAs('admin'), 'How many active clients came in for attendance and how many trainers do we have?');
    expect(result.toolNames.length).toBeLessThanOrEqual(2);
  });
});
