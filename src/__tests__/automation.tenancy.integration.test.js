'use strict';
// The automation permission gate, against a real database.
//
// ── Why this file exists alongside automation.engine.test.js ────────────────
//
// That suite mocks the pool. It proves the engine ASKS the right questions —
// that the grant lookup carries the caller's organization, that a refused
// permission queues nothing — and it cannot prove the answers are right,
// because the fixture supplies them.
//
// That distinction is not academic here. While writing this change, removing
// `AND organization_id = $2` from the repository's queued-message lookup broke
// nothing in the mocked suite: the fake returned the row whatever the SQL
// said, so a query that would have loaded ANOTHER STUDIO'S MESSAGE and sent it
// passed every test. The mutation was invisible.
//
// So the statements that decide whether a studio's client gets messaged are
// exercised here against real PostgreSQL, as the real `app_tenant` role where
// it matters, with nothing mocked.
//
// Gated on RLS_TEST_DATABASE_URL, like rls.isolation.integration.test.js, and
// for the same reason: it must never run against a database with anything to
// lose. Stand one up with scripts/rls-proof-setup.sh.

const { Pool } = require('pg');

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

// Skipping is right on a laptop and wrong in CI — see the same guard in
// rls.isolation.integration.test.js for what that omission already cost once.
if (process.env.CI && !DB_URL) {
  describe('automation tenancy, against a real database', () => {
    it('has a database to run against', () => {
      throw new Error(
        'RLS_TEST_DATABASE_URL is not set in CI, so the automation permission '
        + 'proof would silently skip. Restore the "Stand up the RLS isolation '
        + 'database" step and the env var in .github/workflows/ci.yml.'
      );
    });
  });
}

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describeIf('automation tenancy, against a real database', () => {
  let owner;
  let repo;

  beforeAll(async () => {
    owner = new Pool({ connectionString: DB_URL, max: 4 });

    // The repository reads its pool from src/db/pool, so it is pointed at this
    // database for the duration. Requiring it after the env var is set is what
    // makes that work — the module resolves DATABASE_URL at load time.
    process.env.DATABASE_URL = DB_URL;
    jest.resetModules();
    repo = require('../modules/automation/automation.repository');

    await owner.query(`
      INSERT INTO organizations (id, name, slug) VALUES
        ($1, 'Studio A', 'auto-a'), ($2, 'Studio B', 'auto-b')
      ON CONFLICT (id) DO NOTHING`, [ORG_A, ORG_B]);

    await owner.query(`
      INSERT INTO trainers (id, name, organization_id) VALUES
        ('auto-trainer-a', 'Ana', $1), ('auto-trainer-b', 'Ben', $2)
      ON CONFLICT (id) DO NOTHING`, [ORG_A, ORG_B]);

    await owner.query(`
      INSERT INTO pt_clients (id, name, mobile, organization_id, trainer_id) VALUES
        ('auto-client-a', 'Asha', '+919000000001', $1, 'auto-trainer-a'),
        ('auto-client-b', 'Bala', '+919000000002', $2, 'auto-trainer-b')
      ON CONFLICT (id) DO NOTHING`, [ORG_A, ORG_B]);

    await owner.query(`
      INSERT INTO whatsapp_automation_settings (organization_id, automation_enabled) VALUES
        ($1, TRUE), ($2, TRUE)
      ON CONFLICT (organization_id) DO UPDATE SET automation_enabled = TRUE`, [ORG_A, ORG_B]);

    await owner.query(`
      INSERT INTO whatsapp_automation_trainer_grants (organization_id, trainer_id) VALUES
        ($1, 'auto-trainer-a'), ($2, 'auto-trainer-b')
      ON CONFLICT DO NOTHING`, [ORG_A, ORG_B]);
  });

  afterAll(async () => {
    await owner.query(`DELETE FROM communication_logs WHERE organization_id IN ($1,$2)`, [ORG_A, ORG_B]);
    await owner.query(`DELETE FROM whatsapp_automation_trainer_grants WHERE organization_id IN ($1,$2)`, [ORG_A, ORG_B]);
    await owner.query(`DELETE FROM whatsapp_automation_settings WHERE organization_id IN ($1,$2)`, [ORG_A, ORG_B]);
    await owner.query(`DELETE FROM pt_clients WHERE organization_id IN ($1,$2)`, [ORG_A, ORG_B]);
    await owner.query(`DELETE FROM trainers WHERE organization_id IN ($1,$2)`, [ORG_A, ORG_B]);
    await owner.query(`DELETE FROM organizations WHERE id IN ($1,$2)`, [ORG_A, ORG_B]);
    await owner.end();
    const pool = require('../db/pool');
    if (pool.end) await pool.end().catch(() => {});
  });

  describe('the permission lookup', () => {
    test("Studio A cannot see Studio B's grant, even naming B's trainer directly", async () => {
      // Trainer ids are unique platform-wide, so matching on the id alone
      // WOULD find B's row. The org in the WHERE is the only thing stopping
      // it, and a grant is an authorisation record — so this is a bypass, not
      // a data leak.
      expect(await repo.trainerIsGranted(ORG_A, 'auto-trainer-b')).toBe(false);
      expect(await repo.trainerIsGranted(ORG_B, 'auto-trainer-a')).toBe(false);
    });

    test('each studio sees its own grant', async () => {
      // The other half. A check that answers "no" to everything is not a
      // permission system, and would pass the test above.
      expect(await repo.trainerIsGranted(ORG_A, 'auto-trainer-a')).toBe(true);
      expect(await repo.trainerIsGranted(ORG_B, 'auto-trainer-b')).toBe(true);
    });

    test('a studio with no settings row defaults to closed', async () => {
      const none = await repo.settingsFor('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
      expect(none.automation_enabled).toBe(false);
    });
  });

  describe('the recipient lookup', () => {
    test("Studio A cannot resolve Studio B's client", async () => {
      // Returning null is what makes the engine answer RECIPIENT_NOT_FOUND for
      // both "no such client" and "not yours" — the same answer on purpose.
      expect(await repo.clientRecipient(ORG_A, 'auto-client-b')).toBeNull();
    });

    test('and can resolve its own, with the trainer whose permission governs it', async () => {
      const own = await repo.clientRecipient(ORG_A, 'auto-client-a');
      expect(own).toMatchObject({ id: 'auto-client-a', trainer_id: 'auto-trainer-a' });
      expect(own.phone).toBe('+919000000001');
    });
  });

  describe('the queued message a worker loads', () => {
    let logIdA;

    beforeAll(async () => {
      logIdA = await repo.insertQueued({
        orgId: ORG_A, recipientType: 'client', recipientId: 'auto-client-a',
        recipientName: 'Asha', recipientPhone: '+919000000001',
        template: 'Thanks', message: 'Hi Asha', ruleId: null, dedupeKey: 'auto-int-1',
      });
      expect(logIdA).toBeTruthy();
    });

    test("Studio B's job payload cannot load Studio A's message", async () => {
      // THE test this file was written for. A job payload is not a credential:
      // it can be edited in Redis or built wrongly by a bug, so the
      // organization is an assertion against the row rather than a lookup key.
      //
      // Removing `AND organization_id = $2` from this query broke nothing in
      // the mocked suite — the fake returned the row regardless of the SQL. It
      // breaks this.
      expect(await repo.loadQueued(ORG_B, logIdA)).toBeNull();
    });

    test('and its own studio can', async () => {
      const row = await repo.loadQueued(ORG_A, logIdA);
      expect(row).toMatchObject({ id: logIdA, organization_id: ORG_A, status: 'queued' });
    });

    test("Studio B cannot mark Studio A's message sent", async () => {
      await repo.markSent(ORG_B, logIdA, { providerId: 'FORGED', provider: 'baileys' });
      const { rows } = await owner.query(
        'SELECT status, external_id FROM communication_logs WHERE id = $1', [logIdA],
      );
      expect(rows[0]).toMatchObject({ status: 'queued', external_id: null });
    });

    test('a duplicate business event is refused by the database, not by the engine', async () => {
      // The partial unique index is what makes this true even when two
      // requests race — an application-level check would have a window.
      const again = await repo.insertQueued({
        orgId: ORG_A, recipientType: 'client', recipientId: 'auto-client-a',
        recipientName: 'Asha', recipientPhone: '+919000000001',
        template: 'Thanks', message: 'Hi Asha', ruleId: null, dedupeKey: 'auto-int-1',
      });
      expect(again).toBeNull();
    });

    test('the same key in a DIFFERENT studio is a different message', async () => {
      // Two studios' business ids come from separate tables and will collide.
      // The constraint must not make one studio's automation block another's.
      const other = await repo.insertQueued({
        orgId: ORG_B, recipientType: 'client', recipientId: 'auto-client-b',
        recipientName: 'Bala', recipientPhone: '+919000000002',
        template: 'Thanks', message: 'Hi Bala', ruleId: null, dedupeKey: 'auto-int-1',
      });
      expect(other).toBeTruthy();
    });
  });

  describe('delivery receipts', () => {
    let logId;

    beforeAll(async () => {
      logId = await repo.insertQueued({
        orgId: ORG_A, recipientType: 'client', recipientId: 'auto-client-a',
        recipientName: 'Asha', recipientPhone: '+919000000001',
        template: 'Thanks', message: 'Hi Asha', ruleId: null, dedupeKey: 'auto-int-receipt',
      });
      await repo.markSent(ORG_A, logId, { providerId: 'WAMSG-INT-1', provider: 'baileys' });
    });

    test("a receipt naming another studio's message id applies to nothing", async () => {
      expect(await repo.applyReceipt(ORG_B, 'WAMSG-INT-1', 'read', null)).toBe(0);
      const { rows } = await owner.query('SELECT status FROM communication_logs WHERE id = $1', [logId]);
      expect(rows[0].status).toBe('sent');
    });

    test('the owning studio\'s receipt advances the row', async () => {
      expect(await repo.applyReceipt(ORG_A, 'WAMSG-INT-1', 'delivered', null)).toBe(1);
      const { rows } = await owner.query(
        'SELECT status, delivered_at IS NOT NULL AS d FROM communication_logs WHERE id = $1', [logId],
      );
      expect(rows[0]).toMatchObject({ status: 'delivered', d: true });
    });

    test('the status ladder never moves backwards', async () => {
      // WhatsApp does not promise receipts arrive in order, and the gateway's
      // outbox redelivers on any non-2xx. A late `delivered` must not pull a
      // read row back.
      await repo.applyReceipt(ORG_A, 'WAMSG-INT-1', 'read', null);
      await repo.applyReceipt(ORG_A, 'WAMSG-INT-1', 'delivered', null);
      const { rows } = await owner.query('SELECT status FROM communication_logs WHERE id = $1', [logId]);
      expect(rows[0].status).toBe('read');
    });
  });
});
