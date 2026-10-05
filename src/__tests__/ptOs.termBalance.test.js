'use strict';
// The roster must show what the client owes on the CURRENT term — the same
// definition as GET /clients/:id. Stored balance_amount mixes a current-term
// fee with lifetime payments and understates any client who has ever renewed,
// so the list query computes the term-aware figure itself.

jest.mock('../db/pool', () => ({ query: jest.fn() }));
const pool = require('../db/pool');
const { getActiveClients } = require('../modules/pt-os/pt-os.service');

const answer = (rows) => { pool.query.mockReset(); pool.query.mockResolvedValue({ rows }); };

describe('getActiveClients term-aware balance', () => {
  test('each row carries current_term_balance computed like the detail endpoint', async () => {
    answer([{ id: 'c1', name: 'A', final_amount: 10000, paid_amount: 16000, balance_amount: 0, current_term_balance: 4000 }]);
    const [row] = await getActiveClients({ orgId: 'org-a' });
    const [sql] = pool.query.mock.calls[0];
    // Lifetime-minus-closed-terms, floored at zero — not stored balance.
    expect(sql).toMatch(/current_term_balance/);
    expect(sql).toMatch(/GREATEST\(COALESCE\(c\.final_amount, 0\)/);
    expect(sql).toMatch(/pt_client_subscriptions/);
    expect(row.current_term_balance).toBeDefined();
  });

  test('prior terms are subtracted via subscription history, bounded to closed terms', async () => {
    answer([{ id: 'c1', name: 'A' }]);
    await getActiveClients({ orgId: 'org-a' });
    const [sql] = pool.query.mock.calls[0];
    // Only terms starting strictly before the current one count as prior —
    // a junk or zero-value snapshot can only ever be ignored, never applied.
    expect(sql).toMatch(/s\.start_date < c\.pt_start_date/);
    expect(sql).toMatch(/LEFT JOIN LATERAL/);
  });
});
