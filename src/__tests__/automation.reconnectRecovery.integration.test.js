'use strict';
// Re-driving what a disconnected WhatsApp lost, against a real database.
//
// ── The gap ─────────────────────────────────────────────────────────────────
//
// The worker marks a message `failed` when the studio's WhatsApp is unusable,
// and correctly does not retry: no number of BullMQ attempts reconnects a
// socket only the studio can restore by scanning a QR. Nothing then acted on
// the reconnection.
//
// Production, 2026-09-11: a Welcome Message failed `whatsapp_logged_out` at
// 10:56, the studio reconnected at 11:04, and that message stayed failed
// permanently — its dedupe key means the same business event can never produce
// another row. The studio did everything right and the client heard nothing.
//
// ── Why this is DB-backed ───────────────────────────────────────────────────
//
// Every safety property of the feature is a SQL predicate: which failure
// reasons qualify, the age window, and the conditional UPDATE whose rowCount
// is the permission to enqueue. A mocked pool returns the fixture rows
// whatever those predicates say, so it could prove none of them. These run
// against real Postgres.

const { Pool } = require('pg');

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('reconnect recovery, against a real database', () => {
    it('has a database to run against', () => {
      throw new Error('RLS_TEST_DATABASE_URL is not set in CI — the reconnect proof would skip.');
    });
  });
}

const ORG_A = '6a6a6a6a-1111-4111-8111-111111111111';
const ORG_B = '6b6b6b6b-2222-4222-8222-222222222222';

let mockRealPool;
jest.mock('../db/pool', () => ({
  query: (...args) => mockRealPool.query(...args),
  connect: (...args) => mockRealPool.connect(...args),
}));
jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const repo = require('../modules/automation/automation.repository');

describeIf('reconnect recovery, against a real database', () => {
  let ruleId;

  /** One failed automation message, `ageMin` minutes old. */
  const mkFailed = async (org, reason, ageMin = 5, status = 'failed') => {
    const { rows } = await mockRealPool.query(
      `INSERT INTO communication_logs
         (organization_id, recipient_type, recipient_id, recipient_name, recipient_phone,
          channel, direction, template, message, status, failure_reason,
          automation_rule_id, automation_dedupe_key, created_at)
       VALUES ($1,'client',$2,'C','9990000000','whatsapp','outgoing','T','hi',
               $3,$4,$5,$6, NOW() - make_interval(mins => $7))
       RETURNING id`,
      [org, ORG_A, status, reason, ruleId,
       `k:${Math.random()}`, ageMin]
    );
    return rows[0].id;
  };

  const statusOf = async (id) => {
    const { rows } = await mockRealPool.query(
      'SELECT status, failure_reason FROM communication_logs WHERE id = $1', [id]
    );
    return rows[0];
  };

  beforeAll(async () => {
    mockRealPool = new Pool({ connectionString: DB_URL, max: 4 });
    await mockRealPool.query(
      `INSERT INTO organizations (id, name, slug)
       VALUES ($1,'RC A','rc-a'), ($2,'RC B','rc-b') ON CONFLICT (id) DO NOTHING`,
      [ORG_A, ORG_B]
    );
    const { rows } = await mockRealPool.query(
      `INSERT INTO automation_rules
         (organization_id, name, trigger_event, channel, template, is_active, delay_minutes)
       VALUES ($1,'Welcome','member_created','whatsapp','hi',TRUE,0) RETURNING id`,
      [ORG_A]
    );
    ruleId = rows[0].id;
  });

  afterAll(async () => {
    await mockRealPool.query('DELETE FROM communication_logs WHERE organization_id = ANY($1)', [[ORG_A, ORG_B]]);
    await mockRealPool.query('DELETE FROM automation_rules WHERE organization_id = ANY($1)', [[ORG_A, ORG_B]]);
    await mockRealPool.query('DELETE FROM organizations WHERE id = ANY($1)', [[ORG_A, ORG_B]]);
    await mockRealPool.end();
  });

  // ── Which failures qualify ────────────────────────────────────────────────

  it('finds the production failure — whatsapp_logged_out', async () => {
    const id = await mkFailed(ORG_A, 'whatsapp_logged_out');
    const found = await repo.reconnectCandidates(ORG_A, { maxAgeSec: 7200 });
    expect(found.map((r) => r.id)).toContain(id);
  });

  it.each([
    ['whatsapp_disconnected'],
    ['whatsapp_never_connected'],
    ['not_connected'],
    ['instance_not_connected'],
    ['instance_not_found'],
  ])('re-drives %s — a reconnect is exactly what fixes it', async (reason) => {
    const id = await mkFailed(ORG_A, reason);
    const found = await repo.reconnectCandidates(ORG_A, { maxAgeSec: 7200 });
    expect(found.map((r) => r.id)).toContain(id);
  });

  it.each([
    ['gateway_not_configured', 'scanning a QR does not deploy a gateway'],
    ['duplicate_in_flight', 're-driving this is the one way to send twice'],
    ['no_organization', 'a caller bug a reconnect cannot fix'],
    ['no_recipient', 'a caller bug a reconnect cannot fix'],
    ['empty_message', 'a caller bug a reconnect cannot fix'],
  ])('leaves %s alone — %s', async (reason) => {
    const id = await mkFailed(ORG_A, reason);
    const found = await repo.reconnectCandidates(ORG_A, { maxAgeSec: 7200 });
    expect(found.map((r) => r.id)).not.toContain(id);
  });

  // ── The age window, which is the safety argument ──────────────────────────

  it('leaves a message older than the window failed, with its reason intact', async () => {
    // A welcome note three days late is worse than one never sent: the client
    // has to work out what it refers to. Old rows keep their reason so an
    // operator can still read what happened.
    const old = await mkFailed(ORG_A, 'whatsapp_logged_out', 60 * 24 * 3);
    const found = await repo.reconnectCandidates(ORG_A, { maxAgeSec: 7200 });
    expect(found.map((r) => r.id)).not.toContain(old);
    expect(await statusOf(old)).toEqual({ status: 'failed', failure_reason: 'whatsapp_logged_out' });
  });

  it('includes a message inside the window', async () => {
    const fresh = await mkFailed(ORG_A, 'whatsapp_logged_out', 30);
    const found = await repo.reconnectCandidates(ORG_A, { maxAgeSec: 7200 });
    expect(found.map((r) => r.id)).toContain(fresh);
  });

  // ── Statuses that are not this feature's business ─────────────────────────

  it.each([['sent'], ['delivered'], ['read'], ['queued']])(
    'never touches a %s row', async (status) => {
      const id = await mkFailed(ORG_A, null, 5, status);
      const found = await repo.reconnectCandidates(ORG_A, { maxAgeSec: 7200 });
      expect(found.map((r) => r.id)).not.toContain(id);
    }
  );

  // ── Tenant isolation ──────────────────────────────────────────────────────

  it('never returns another studio\'s failed messages', async () => {
    const mine = await mkFailed(ORG_A, 'whatsapp_logged_out');
    const theirs = await mkFailed(ORG_B, 'whatsapp_logged_out');

    const forA = await repo.reconnectCandidates(ORG_A, { maxAgeSec: 7200 });
    expect(forA.map((r) => r.id)).toContain(mine);
    expect(forA.map((r) => r.id)).not.toContain(theirs);

    const forB = await repo.reconnectCandidates(ORG_B, { maxAgeSec: 7200 });
    expect(forB.map((r) => r.id)).toContain(theirs);
    expect(forB.map((r) => r.id)).not.toContain(mine);
  });

  it('cannot requeue another studio\'s row even with its exact id', async () => {
    // The org is bound on the UPDATE, not assumed from the id. A reconnect in
    // studio B must not re-drive studio A's backlog.
    const theirs = await mkFailed(ORG_A, 'whatsapp_logged_out');
    expect(await repo.requeueFailed(ORG_B, theirs)).toBe(0);
    expect((await statusOf(theirs)).status).toBe('failed');
  });

  // ── The conditional requeue, which is what stops double sends ─────────────

  it('requeues once and only once, however many reconnects arrive', async () => {
    const id = await mkFailed(ORG_A, 'whatsapp_logged_out');

    // First reconnect wins and earns the right to enqueue.
    expect(await repo.requeueFailed(ORG_A, id)).toBe(1);
    expect(await statusOf(id)).toEqual({ status: 'queued', failure_reason: null });

    // A second reconnect — a retried webhook, or a flapping instance — finds
    // the row no longer failed and gets no permission to enqueue. That zero is
    // the whole idempotency guarantee at this layer.
    expect(await repo.requeueFailed(ORG_A, id)).toBe(0);
  });

  it('will not requeue a row that failed for a reason a reconnect cannot fix', async () => {
    // The predicate is re-asserted on the UPDATE, not only on the SELECT, so a
    // stale candidate list cannot be used to revive something it should not.
    const id = await mkFailed(ORG_A, 'duplicate_in_flight');
    expect(await repo.requeueFailed(ORG_A, id)).toBe(0);
    expect((await statusOf(id)).status).toBe('failed');
  });
});
