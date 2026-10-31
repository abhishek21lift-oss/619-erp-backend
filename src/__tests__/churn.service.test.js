'use strict';
jest.mock('../modules/pt-os/client-context', () => ({ sweepRoster: jest.fn() }));
jest.mock('../modules/pt-os/churn.repository', () => ({
  listRoster: jest.fn(), latestFollowups: jest.fn(), clientInOrg: jest.fn(), create: jest.fn(),
}));
jest.mock('../lib/appTime', () => ({
  ...jest.requireActual('../lib/appTime'),
  today: jest.fn(() => '2026-10-30'),
}));

const { sweepRoster } = require('../modules/pt-os/client-context');
const repo = require('../modules/pt-os/churn.repository');
const { buildChurnList, markFollowup } = require('../modules/pt-os/churn.service');

const TODAY = '2026-10-30';
const client = (o = {}) => ({
  id: 'cl-1', name: 'Asha', balance_amount: '0', pt_end_date: '2027-01-01', status: 'active', ...o,
});
const flagged = (o = {}) => ({
  client_id: 'cl-1', client_name: 'Asha', last_session: '2026-09-29', days_quiet: 31,
  term: { state: 'current', end: '2027-01-01', days_left: 63 },
  signals: [{ id: 'gone_quiet' }], ...o,
});

beforeEach(() => {
  jest.clearAllMocks();
  repo.latestFollowups.mockResolvedValue([]);
  sweepRoster.mockResolvedValue({ clients: 2, clients_detail: [] });
  repo.listRoster.mockResolvedValue([client(), client({ id: 'cl-2', name: 'Ravi' })]);
});

it('assesses the whole roster and lists only scored clients', async () => {
  sweepRoster.mockResolvedValue({ clients: 2, clients_detail: [flagged()] });
  const out = await buildChurnList('org-1');
  expect(out.assessed).toBe(2);
  expect(out.flagged).toBe(1);
  expect(out.rows.map((r) => r.client_id)).toEqual(['cl-1']);
  expect(out.rows[0].score).toBe(60);
});

it('coerces a NUMERIC balance string', async () => {
  repo.listRoster.mockResolvedValue([client({ balance_amount: '8000' })]);
  const out = await buildChurnList('org-1');
  expect(out.rows[0].reasons).toEqual([expect.objectContaining({ code: 'dues' })]);
});

it('treats an empty or malformed pt_end_date as unknown, not a crash', async () => {
  repo.listRoster.mockResolvedValue([client({ pt_end_date: '' })]);
  await expect(buildChurnList('org-1')).resolves.toMatchObject({ flagged: 0 });
});

it('scores an ended term only when the sweep flagged that client', async () => {
  repo.listRoster.mockResolvedValue([client({ pt_end_date: '2026-10-01' })]);
  expect((await buildChurnList('org-1')).flagged).toBe(0);
  sweepRoster.mockResolvedValue({ clients: 1, clients_detail: [flagged()] });
  const out = await buildChurnList('org-1');
  expect(out.rows[0].reasons.map((r) => r.code)).toContain('term_ended');
  expect(out.rows[0].reasons.map((r) => r.code)).not.toContain('term_ending_7');
});

it('merges a dues-only client that the sweep never flagged', async () => {
  repo.listRoster.mockResolvedValue([client({ balance_amount: 500 })]);
  sweepRoster.mockResolvedValue({ clients: 1, clients_detail: [] });
  const out = await buildChurnList('org-1');
  expect(out.rows[0]).toMatchObject({ client_id: 'cl-1', score: 15, band: 'medium' });
});

it('hides a contacted client until hide_until unless the score rose 15', async () => {
  repo.listRoster.mockResolvedValue([client()]);
  sweepRoster.mockResolvedValue({ clients: 1, clients_detail: [flagged({ days_quiet: 31 })] });
  repo.latestFollowups.mockResolvedValue([
    { client_id: 'cl-1', outcome: 'contacted', hide_until: '2026-11-06', risk_score: 60 },
  ]);
  let out = await buildChurnList('org-1');
  expect(out.rows).toHaveLength(0);
  expect(out.handled[0]).toMatchObject({ client_id: 'cl-1', outcome: 'contacted' });

  repo.listRoster.mockResolvedValue([client({ pt_end_date: '2026-11-02' })]);
  sweepRoster.mockResolvedValue({
    clients: 1,
    clients_detail: [flagged({ days_quiet: 31, term: { state: 'current', end: '2026-11-02', days_left: 3 } })],
  });
  out = await buildChurnList('org-1');
  expect(out.rows[0]).toMatchObject({ client_id: 'cl-1', risk_increased: true });
});

it('returns a passed mark to the list when it still scores', async () => {
  repo.listRoster.mockResolvedValue([client()]);
  sweepRoster.mockResolvedValue({ clients: 1, clients_detail: [flagged()] });
  repo.latestFollowups.mockResolvedValue([]); // no mark for this client
  const out = await buildChurnList('org-1');
  expect(out.rows).toHaveLength(1);
});

it('does not hide a client whose latest mark has expired', async () => {
  repo.listRoster.mockResolvedValue([client()]);
  sweepRoster.mockResolvedValue({ clients: 1, clients_detail: [flagged()] });
  // The repository returns the newest mark whatever its date; a newer 7-day
  // mark that ran out must not let an older, longer snooze hide the client.
  repo.latestFollowups.mockResolvedValue([
    { client_id: 'cl-1', outcome: 'contacted', hide_until: '2026-10-29', risk_score: 60 },
  ]);
  const out = await buildChurnList('org-1');
  expect(out.rows).toHaveLength(1);
  expect(out.handled).toHaveLength(0);
});

it('counts bands over visible and handled clients together', async () => {
  repo.listRoster.mockResolvedValue([client(), client({ id: 'cl-2', name: 'Ravi' })]);
  sweepRoster.mockResolvedValue({
    clients: 2,
    clients_detail: [flagged(), flagged({ client_id: 'cl-2', client_name: 'Ravi' })],
  });
  repo.latestFollowups.mockResolvedValue([
    { client_id: 'cl-2', outcome: 'snoozed', hide_until: '2026-11-10', risk_score: 60 },
  ]);
  const out = await buildChurnList('org-1');
  expect(out.bands.critical).toBe(2);
  expect(out.rows).toHaveLength(1);
  expect(out.handled).toHaveLength(1);
});

it('does not truncate a 600-client roster', async () => {
  repo.listRoster.mockResolvedValue(Array.from({ length: 600 }, (_, i) =>
    client({ id: `cl-${i}`, name: `Client ${i}` })));
  sweepRoster.mockResolvedValue({ clients: 600, clients_detail: [] });
  expect((await buildChurnList('org-1')).assessed).toBe(600);
});

it('hides every marked client even when more than 100 are handled', async () => {
  const clients = Array.from({ length: 101 }, (_, i) =>
    client({ id: `cl-${i}`, name: `Client ${i}` }));
  repo.listRoster.mockResolvedValue(clients);
  sweepRoster.mockResolvedValue({
    clients: 101,
    clients_detail: clients.map((c) => flagged({ client_id: c.id, client_name: c.name })),
  });
  repo.latestFollowups.mockResolvedValue(clients.map((c) => ({
    client_id: c.id, outcome: 'contacted', hide_until: '2026-11-06', risk_score: 60,
  })));
  const out = await buildChurnList('org-1');
  expect(out.rows).toHaveLength(0);
  expect(out.handled).toHaveLength(100);
});

it('markFollowup returns null when the client is not in the list', async () => {
  repo.clientInOrg.mockResolvedValue(false);
  expect(await markFollowup('org-1', 'nope', { outcome: 'contacted', snoozeUntil: '2026-11-06' }))
    .toBeNull();
  expect(repo.create).not.toHaveBeenCalled();
});

it('markFollowup stores the score the list showed', async () => {
  repo.clientInOrg.mockResolvedValue(true);
  repo.listRoster.mockResolvedValue([client()]);
  sweepRoster.mockResolvedValue({ clients: 1, clients_detail: [flagged()] });
  repo.create.mockResolvedValue({ id: 'f-1', outcome: 'contacted', hide_until: '2026-11-06', risk_score: 60 });
  const mark = await markFollowup('org-1', 'cl-1', {
    outcome: 'contacted', snoozeUntil: '2026-11-06', note: 'called', today: TODAY,
  });
  expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ riskScore: 60, hideUntil: '2026-11-06' }));
  expect(mark.risk_score).toBe(60);
});
