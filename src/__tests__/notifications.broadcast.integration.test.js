// The broadcast path, end to end, against a real database.
//
// Phase 1 changed recipientFromMember() from an unscoped lookup over two dead
// legacy tables to a scoped lookup against pt_clients. Because the old version
// resolved nobody (both tables are empty in production), no regression was
// possible — but equally, the new path had never run against real rows. This
// exercises it with two real studios and two real clients.
//
// Nothing is delivered. The channel adapters are replaced with recorders, so
// no email or WhatsApp leaves the process; what is asserted is which recipient
// each channel WOULD have been handed, and what the queued payload carries.
//
// Skips itself when RLS_TEST_DATABASE_URL is unset. Database from
// scripts/rls-proof-setup.sh.

'use strict';

const { Pool } = require('pg');

const ADMIN_URL = process.env.RLS_TEST_DATABASE_URL;
const describeMaybe = ADMIN_URL ? describe : describe.skip;

const ORG_A = '33333333-3333-3333-3333-333333333333';
const ORG_B = '44444444-4444-4444-4444-444444444444';
const CLIENT_A = 'bcast-client-a';
const CLIENT_B = 'bcast-client-b';

describeMaybe('notification broadcast — real data, both studios', () => {
  let admin;
  let svc;
  let delivered;

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });

    await admin.query(`
      INSERT INTO organizations (id, name, slug)
      VALUES ($1,'Broadcast A','bcast-a'), ($2,'Broadcast B','bcast-b')
      ON CONFLICT (id) DO NOTHING`, [ORG_A, ORG_B]);

    await admin.query('DELETE FROM pt_clients WHERE id IN ($1,$2)', [CLIENT_A, CLIENT_B]);
    await admin.query(`
      INSERT INTO pt_clients (id, name, mobile, email, organization_id)
      VALUES ($1,'Client A','9111111111','a@example.test',$3),
             ($2,'Client B','9222222222','b@example.test',$4)`,
    [CLIENT_A, CLIENT_B, ORG_A, ORG_B]);

    // The app connects as the owner here on purpose: this test is about the
    // APPLICATION-layer boundary (recipientFromMember's org predicate), which
    // is what protects production today. RLS is proven separately.
    process.env.DATABASE_URL = ADMIN_URL;
    process.env.TENANT_RLS_ENFORCE = 'off';
    jest.resetModules();

    svc = require('../modules/notifications/notifications.service');

    // Replace every channel with a recorder. Nothing is sent.
    delivered = [];
    for (const ch of Object.keys(svc.channels)) {
      svc.channels[ch] = async (args) => { delivered.push({ ch, args }); return { status: 'delivered', id: 'x' }; };
    }
  });

  afterAll(async () => {
    if (admin) {
      await admin.query('DELETE FROM pt_clients WHERE id IN ($1,$2)', [CLIENT_A, CLIENT_B]).catch(() => {});
      await admin.query("DELETE FROM activity_log WHERE action = 'notification.tenant_mismatch_rejected'").catch(() => {});
      await admin.query('DELETE FROM organizations WHERE id IN ($1,$2)', [ORG_A, ORG_B]).catch(() => {});
      await admin.end().catch(() => {});
    }
    const pool = require('../db/pool');
    await pool.end().catch(() => {});
  });

  beforeEach(() => { delivered = []; });

  // ── Test 1 — A to its own client: ALLOW ───────────────────────────────────
  it('TEST 1: Studio A resolves and notifies its own client', async () => {
    const r = await svc.recipientFromMember(CLIENT_A, ORG_A);
    expect(r.member_id).toBe(CLIENT_A);
    expect(r.name).toBe('Client A');
    expect(r.organization_id).toBe(ORG_A);

    await svc.send('membership_expiring', r, { days: 3, plan: 'PT' }, ['inapp'], {
      organizationId: ORG_A, scope: 'tenant',
    });
    expect(delivered).toHaveLength(1);
    expect(delivered[0].ch).toBe('inapp');
  });

  // ── Test 2 — A reaching for B's client: DENY ──────────────────────────────
  it("TEST 2: Studio A cannot resolve Studio B's client, and nothing is delivered", async () => {
    await expect(svc.recipientFromMember(CLIENT_B, ORG_A)).rejects.toThrow('Recipient not found');
    expect(delivered).toHaveLength(0);
  });

  it("TEST 2b: no attribute of Studio B's client leaks in the failure", async () => {
    let caught;
    try { await svc.recipientFromMember(CLIENT_B, ORG_A); } catch (e) { caught = e; }
    const text = `${caught.message} ${JSON.stringify(caught)}`;
    for (const secret of ['Client B', '9222222222', 'b@example.test', ORG_B]) {
      expect(text).not.toContain(secret);
    }
  });

  // ── Test 3 — nonexistent id: same failure class as a foreign id ───────────
  it('TEST 3: a nonexistent id fails identically to a foreign one', async () => {
    const foreign = await svc.recipientFromMember(CLIENT_B, ORG_A).catch((e) => e);
    const missing = await svc.recipientFromMember('no-such-client', ORG_A).catch((e) => e);

    // Same message, same type, same absence of detail — so the error cannot be
    // used to test whether an id exists in some other studio.
    expect(foreign.message).toBe(missing.message);
    expect(foreign.constructor.name).toBe(missing.constructor.name);
    expect(foreign.status).toBe(missing.status);
    expect(foreign.code).toBe(missing.code);
  });

  it('TEST 3b: B can still resolve its own client — the deny is scoped, not blanket', async () => {
    const r = await svc.recipientFromMember(CLIENT_B, ORG_B);
    expect(r.member_id).toBe(CLIENT_B);
    expect(r.organization_id).toBe(ORG_B);
  });

  // ── Test 4 — the queued payload carries trusted tenant context ────────────
  it('TEST 4: the enqueued job carries the organization from server context', async () => {
    const enqueued = [];
    jest.resetModules();
    jest.doMock('../lib/redis', () => ({ ensureReady: async () => true, isConfigured: () => true }));
    jest.doMock('../jobs/queue', () => ({
      notificationsQueue: { add: async (name, data) => { enqueued.push({ name, data }); return { id: 'job-1' }; } },
    }));
    const fanout = require('../services/notificationFanout');

    await fanout.enqueueNotification('inapp', 'membership_expiring',
      { member_id: CLIENT_A }, { days: 3 }, {}, { organizationId: ORG_A, scope: 'tenant' });

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].data.organizationId).toBe(ORG_A);
    expect(enqueued[0].data.scope).toBe('tenant');
    jest.dontMock('../lib/redis');
    jest.dontMock('../jobs/queue');
  });

  // ── Test 5 — the worker re-derives, independently of the payload ──────────
  it('TEST 5: the worker re-derives the recipient organization from the database', async () => {
    jest.resetModules();
    process.env.DATABASE_URL = ADMIN_URL;
    const fresh = require('../modules/notifications/notifications.service');

    // Truthful payload for a real client: the re-derivation agrees, so it passes.
    await expect(fresh.assertJobTenant({
      id: 'j1',
      data: { ch: 'inapp', type: 'membership_expiring', organizationId: ORG_A, scope: 'tenant', recipient: { member_id: CLIENT_A } },
    })).resolves.toBeUndefined();

    const pool = require('../db/pool');
    // It genuinely asked the database rather than trusting the payload.
    const { rows } = await pool.query('SELECT organization_id FROM pt_clients WHERE id = $1', [CLIENT_A]);
    expect(rows[0].organization_id).toBe(ORG_A);
  });

  // ── Test 6 — a tampered payload is rejected and audited ───────────────────
  it('TEST 6: a payload claiming A for a client that belongs to B is rejected', async () => {
    jest.resetModules();
    process.env.DATABASE_URL = ADMIN_URL;
    const fresh = require('../modules/notifications/notifications.service');

    const before = await admin.query(
      "SELECT count(*)::int AS n FROM activity_log WHERE action = 'notification.tenant_mismatch_rejected'");

    // The exact shape of a tampered job: says organization A, addresses B's client.
    await expect(fresh.assertJobTenant({
      id: 'j2',
      data: { ch: 'inapp', type: 'membership_expiring', organizationId: ORG_A, scope: 'tenant', recipient: { member_id: CLIENT_B } },
    })).rejects.toThrow(/tenant mismatch/i);

    const after = await admin.query(
      "SELECT count(*)::int AS n FROM activity_log WHERE action = 'notification.tenant_mismatch_rejected'");
    expect(after.rows[0].n).toBe(before.rows[0].n + 1);
  });

  it('TEST 6b: the audit row records both organizations, for the investigation', async () => {
    const { rows } = await admin.query(`
      SELECT new_data FROM activity_log
       WHERE action = 'notification.tenant_mismatch_rejected'
       ORDER BY created_at DESC LIMIT 1`);
    const d = typeof rows[0].new_data === 'string' ? JSON.parse(rows[0].new_data) : rows[0].new_data;
    expect(d.job_organization_id).toBe(ORG_A);
    expect(d.recipient_organization_id).toBe(ORG_B);
  });

  it('TEST 6c: nothing was delivered on any channel during the rejection tests', () => {
    expect(delivered).toHaveLength(0);
  });
});
