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
    const result = await runTools(reqAs('trainer'), 'What is a good warm-up routine?');
    expect(result.toolNames).toEqual([]);
    expect(result.contextText).toBe('');
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('client_stats: triggers on "how many active clients" and formats the result', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ active: '12', inactive: '3', frozen: '1', expiring_soon: '2', total: '16' }],
    });
    const result = await runTools(reqAs('trainer'), 'How many active clients do we have?');
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
    const result = await runTools(reqAs('trainer'), 'What should I tell a new client about hydration?');
    expect(result.toolNames).not.toContain('Client Lookup');
  });

  // Regression: the original implementation only matched the literal phrasing
  // "client named X", so this — how people actually ask — ran no lookup at
  // all and the coach claimed it had no information about a real, onboarded
  // client.
  it('find_client: triggers on "Tell me about <Name>" and injects the record', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{
        name: 'Prakhar Sharma', status: 'active', package_type: '3 Month PT',
        trainer_name: 'Ravi', balance_amount: '0', paid_amount: '30000',
        final_amount: '30000', pt_start_date: null, pt_end_date: null, mobile: '9999999999',
      }],
    });
    const result = await runTools(reqAs('trainer'), 'Tell me about Prakhar Sharma');
    expect(result.toolNames).toContain('Client Lookup');
    expect(result.contextText).toMatch(/Prakhar Sharma/);
    expect(result.contextText).toMatch(/status: active/);
  });

  it('find_client: triggers on a bare capitalised name anywhere in the question', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{
        name: 'Prakhar Sharma', status: 'active', package_type: null, trainer_name: null,
        balance_amount: '5000', paid_amount: '0', final_amount: '5000',
        pt_start_date: null, pt_end_date: null, mobile: null,
      }],
    });
    const result = await runTools(reqAs('trainer'), 'Any update on Prakhar Sharma?');
    expect(result.toolNames).toContain('Client Lookup');
    expect(result.contextText).toMatch(/Prakhar Sharma/);
  });

  it('find_client: stays silent when a guessed name matches no client', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const result = await runTools(reqAs('trainer'), 'Tell me about Progressive Overload');
    // Ran a lookup, found nothing, and said nothing — the model should answer
    // the training question normally rather than explain a failed name search.
    expect(result.toolNames).not.toContain('Client Lookup');
    expect(result.contextText).toBe('');
  });

  it('find_client: scopes the lookup to the caller organization', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    await runTools(reqAs('trainer'), 'Tell me about Prakhar Sharma');
    const [, params] = pool.query.mock.calls[0];
    expect(params).toContain('org-1');
  });

  it('find_client: the trainer searches the whole studio, not a roster', async () => {
    // The trainer owns the studio; there is no assistant-coach narrowing. The
    // organization is still the boundary.
    pool.query.mockResolvedValueOnce({ rows: [] });
    await runTools(reqAs('trainer'), 'Tell me about Prakhar Sharma');
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).not.toMatch(/trainer_id = \$\d/);
    expect(params).not.toContain('trn-1');
    expect(params).toContain('org-1');
  });

  it('revenue_summary: denies a member without running the query', async () => {
    const result = await runTools(reqAs('member'), 'What was our revenue this month?');
    expect(result.toolNames).toContain('Revenue');
    expect(result.contextText).toMatch(/not permitted to view this data/);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('every studio tool refuses a removed staff role rather than mapping it', async () => {
    for (const role of ['admin', 'manager', 'reception', 'super_admin']) {
      pool.query.mockReset();
      const result = await runTools(reqAs(role), 'What was our revenue this month?');
      expect([role, result.contextText]).toEqual([role, expect.stringMatching(/not permitted to view this data/)]);
      expect(pool.query).not.toHaveBeenCalled();
    }
  });

  it('revenue_summary: runs for the trainer and formats INR', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ total_revenue: '45000', total_payments: '9' }] });
    const result = await runTools(reqAs('trainer'), 'What was our revenue this month?');
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

  it('search_exercises: carries the canonical visibility rule (deleted/archived + studio gate)', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    await runTools(reqAs('trainer'), 'What exercises for chest?');
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/e\.deleted_at IS NULL AND e\.archived_at IS NULL/);
    // Built-ins, or this studio's own customs — the rule routes/exercises.js
    // applies. No per-author narrowing: the studio has one trainer.
    expect(sql).toMatch(/e\.organization_id IS NULL OR e\.organization_id = \$\d+::uuid/);
    expect(sql).not.toMatch(/created_by/);
    // The gate must be bound from the authenticated request — never
    // interpolated, never taken from the message.
    expect(sql).not.toContain('org-1');
    expect(sql).not.toMatch(/\$\{[^}]+\}/);
    expect(params).toContain('org-1');
  });

  it('search_exercises: preserves the existing search behaviour for authorized built-ins', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    await runTools(reqAs('trainer'), 'What exercises for back?');
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/e\.muscle_group ILIKE \$1 OR e\.body_part ILIKE \$1 OR e\.target_muscle ILIKE \$1/);
    expect(sql).toMatch(/ORDER BY e\.name LIMIT 8/);
    expect(params[0]).toBe('%back%');
    // Same columns and tool output shape as before the patch.
    expect(sql).toMatch(/SELECT e\.name, e\.muscle_group, e\.body_part, e\.equipment, e\.difficulty/);
  });

  it('search_exercises: fails closed for a user without an org (org-less tenant user)', async () => {
    const result = await runTools(reqAs('trainer', { organization_id: null }), 'What exercises for chest?');
    // Tool still matched and reported honestly, but no query ran and no rows
    // were exposed — the existing empty-result convention of the tool.
    expect(result.toolNames).toContain('Exercise Search');
    expect(result.contextText).toMatch(/No exercises found/);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('search_exercises: fails closed for a platform-wide super admin (no target org)', async () => {
    // super_admin is not in the tool's allowed roles, so the role gate denies
    // it before run() — either way: no query, no rows. (Without the trusted
    // org context run() itself also returns [] — the double fail-closed.)
    const result = await runTools(
      { headers: {}, user: { id: 'usr-1', role: 'super_admin', organization_id: null } },
      'What exercises for chest?'
    );
    expect(result.toolNames).toContain('Exercise Search');
    expect(result.contextText).toMatch(/not permitted to view this data|No exercises found/);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('search_exercises: denies a role outside the allowed set without running the query', async () => {
    const result = await runTools(reqAs('member'), 'What exercises for chest?');
    expect(result.toolNames).toContain('Exercise Search');
    expect(result.contextText).toMatch(/not permitted to view this data/);
    expect(pool.query).not.toHaveBeenCalled();
  });

  // The leakage matrix, executed end to end: the mock plays a miniature
  // database that resolves rows by applying the tool's OWN bound parameters
  // against a fixed dataset. If the tool ever stops passing the trusted org
  // and user through, the simulated predicate silently returns only built-ins
  // (or everything), and the foreign-custom expectations below fail.
  it('search_exercises: leakage matrix — built-ins and own studio customs only (Org A vs Org B)', async () => {
    const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const USER_A = 'user-aaaa';
    const USER_B = 'user-bbbb';
    const DB = [
      { name: 'Barbell Back Squat', organization_id: null, created_by: null },
      { name: 'Org A Custom Squat', organization_id: ORG_A, created_by: USER_A },
      { name: 'Org B Custom Squat', organization_id: ORG_B, created_by: USER_B },
    ];
    pool.query.mockImplementation(async (_sql, params) => {
      // The tool's own bound org is the only thing this simulated predicate
      // trusts — the same rule routes/exercises.js applies.
      const org = params[1];
      return { rows: DB.filter((e) => e.organization_id === null || e.organization_id === org) };
    });

    const asA = await runTools(reqAs('trainer', { id: USER_A, organization_id: ORG_A }), 'What exercises for chest?');
    expect(asA.contextText).toContain('Barbell Back Squat');
    expect(asA.contextText).toContain('Org A Custom Squat');
    expect(asA.contextText).not.toContain('Org B Custom Squat');

    const asB = await runTools(reqAs('trainer', { id: USER_B, organization_id: ORG_B }), 'What exercises for chest?');
    expect(asB.contextText).toContain('Barbell Back Squat');
    expect(asB.contextText).toContain('Org B Custom Squat');
    expect(asB.contextText).not.toContain('Org A Custom Squat');
  });

  it('search_exercises: deleted and archived rows never surface', async () => {
    // The SQL is the security boundary (the repo's tenancy-test convention):
    // both predicates must be in the WHERE clause, and the query must not
    // fall back to the dead `visibility` column.
    pool.query.mockResolvedValueOnce({ rows: [] });
    await runTools(reqAs('trainer'), 'What exercises for chest?');
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toMatch(/e\.deleted_at IS NULL AND e\.archived_at IS NULL/);
    expect(sql).not.toMatch(/e\.visibility/);
  });

  it('caps at 2 tools even if more than 2 patterns match', async () => {
    pool.query.mockResolvedValue({ rows: [{}] });
    // "clients", "attendance" and "trainers" all appear — only the first 2 (by TOOLS array order) should run.
    const result = await runTools(reqAs('trainer'), 'How many active clients came in for attendance and how many trainers do we have?');
    expect(result.toolNames.length).toBeLessThanOrEqual(2);
  });
});
