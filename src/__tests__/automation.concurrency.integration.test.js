'use strict';
// The three races, run against a real database rather than described.
//
// ── Why none of these can be a mocked test ──────────────────────────────────
//
// Every one of these fixes is a property of a SQL statement under concurrency:
// whether an UPDATE's CASE refuses to move a status backwards, whether two
// transactions can both pass a count check, whether a predicate excludes a row.
// A mocked pool returns what the fixture told it to no matter what the SQL
// says — earlier in this work a dropped `AND organization_id = $2` passed a
// full mocked suite — so a mocked "proof" of any of this would be a proof of
// the fixture.
//
// Gated on RLS_TEST_DATABASE_URL like the other integration suites, and failing
// loudly in CI if that is missing, so it cannot quietly skip in the one place
// it matters. Stand one up with scripts/rls-proof-setup.sh.

const { Pool } = require('pg');

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('automation concurrency, against a real database', () => {
    it('has a database to run against', () => {
      throw new Error(
        'RLS_TEST_DATABASE_URL is not set in CI, so the automation concurrency '
        + 'proofs would silently skip.'
      );
    });
  });
}

const ORG_A = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ORG_B = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

describeIf('automation concurrency, against a real database', () => {
  let owner;
  let repo;

  const statusOf = async (id) => {
    const { rows } = await owner.query(
      'SELECT status, sent_at, delivered_at, read_at, external_id, provider FROM communication_logs WHERE id = $1',
      [id]
    );
    return rows[0];
  };

  /** A queued automation row, ready to be driven through the ladder. */
  let seq = 0;
  const seed = async (orgId, over = {}) => {
    seq += 1;
    const { rows } = await owner.query(
      `INSERT INTO communication_logs
         (organization_id, recipient_type, recipient_id, recipient_name, recipient_phone,
          channel, direction, template, message, status, automation_rule_id, automation_dedupe_key)
       VALUES ($1,'client','conc-client','Asha','+919000009001','whatsapp','outgoing',
               'T','Hi',$2,$3,$4)
       RETURNING id`,
      [orgId, over.status || 'queued', over.ruleId || 'conc-rule-a', over.dedupeKey || `conc-seed-${seq}`]
    );
    return rows[0].id;
  };

  beforeAll(async () => {
    owner = new Pool({ connectionString: DB_URL, max: 12 });

    process.env.DATABASE_URL = DB_URL;
    jest.resetModules();
    repo = require('../modules/automation/automation.repository');

    await owner.query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1,'Conc A','conc-a'), ($2,'Conc B','conc-b')
       ON CONFLICT (id) DO NOTHING`, [ORG_A, ORG_B]);
    await owner.query(
      `INSERT INTO pt_clients (id, name, mobile, organization_id) VALUES
         ('conc-client','Asha','+919000009001',$1)
       ON CONFLICT (id) DO NOTHING`, [ORG_A]);
    await owner.query(
      `INSERT INTO automation_rules (id, organization_id, name, trigger_event, template, is_active, channel, delay_minutes) VALUES
         ('conc-rule-a', $1, 'R', 'payment_received', 'Hi', TRUE, 'whatsapp', 0),
         ('conc-rule-delay', $1, 'D', 'membership_expiring', 'Hi', TRUE, 'whatsapp', 4320),
         ('conc-rule-b', $2, 'R', 'payment_received', 'Hi', TRUE, 'whatsapp', 0)
       ON CONFLICT (id) DO NOTHING`, [ORG_A, ORG_B]);
  });

  afterAll(async () => {
    await owner.query('DELETE FROM communication_logs WHERE organization_id IN ($1,$2)', [ORG_A, ORG_B]);
    await owner.query("DELETE FROM automation_rules WHERE id LIKE 'conc-rule-%'");
    await owner.query('DELETE FROM pt_clients WHERE organization_id IN ($1,$2)', [ORG_A, ORG_B]);
    await owner.query('DELETE FROM whatsapp_automation_settings WHERE organization_id IN ($1,$2)', [ORG_A, ORG_B]);
    await owner.query('DELETE FROM organizations WHERE id IN ($1,$2)', [ORG_A, ORG_B]);
    await owner.end();
    const pool = require('../db/pool');
    if (pool.end) await pool.end().catch(() => {});
  });

  // ── FIX 1 ─────────────────────────────────────────────────────────────────
  //
  // The worker's markSent and the webhook's applyReceipt run concurrently and
  // neither can see the other. WhatsApp acknowledges to the sending socket and
  // reports delivery over a separate path, and nothing orders the two — so a
  // receipt can land while the send call is still in flight. Before this fix
  // markSent then wrote 'sent' over 'delivered': the message really had been
  // delivered, the log said otherwise, and nothing errored.
  describe('the status ladder never runs backwards', () => {
    test('delivered → markSent() stays delivered', async () => {
      const id = await seed(ORG_A);
      await repo.markSent(ORG_A, id, { providerId: 'WAM-L1', provider: 'baileys' });
      expect(await repo.applyReceipt(ORG_A, 'WAM-L1', 'delivered', null)).toBe(1);
      expect((await statusOf(id)).status).toBe('delivered');

      // The retry that used to undo it.
      await repo.markSent(ORG_A, id, { providerId: 'WAM-L1', provider: 'baileys' });
      expect((await statusOf(id)).status).toBe('delivered');
    });

    test('read → markSent() stays read', async () => {
      const id = await seed(ORG_A);
      await repo.markSent(ORG_A, id, { providerId: 'WAM-L2', provider: 'baileys' });
      await repo.applyReceipt(ORG_A, 'WAM-L2', 'read', null);
      expect((await statusOf(id)).status).toBe('read');

      await repo.markSent(ORG_A, id, { providerId: 'WAM-L2', provider: 'baileys' });
      expect((await statusOf(id)).status).toBe('read');
    });

    test('queued → markSent() still becomes sent', async () => {
      // The other half. A markSent that refused everything would pass both
      // tests above and break the product.
      const id = await seed(ORG_A);
      expect(await repo.markSent(ORG_A, id, { providerId: 'WAM-L3', provider: 'baileys' })).toBe(1);
      const row = await statusOf(id);
      expect(row.status).toBe('sent');
      expect(row.external_id).toBe('WAM-L3');
      expect(row.sent_at).not.toBeNull();
    });

    test('the send is still recorded on a row the ladder will not move', async () => {
      // external_id is a fact about the send, not about the ladder — and it is
      // what a LATER receipt matches on. Refusing to record it on an already
      // delivered row would strand every read receipt that follows.
      const id = await seed(ORG_A, { status: 'delivered' });
      await repo.markSent(ORG_A, id, { providerId: 'WAM-L4', provider: 'baileys' });
      const row = await statusOf(id);
      expect(row.status).toBe('delivered');
      expect(row.external_id).toBe('WAM-L4');
      expect(row.provider).toBe('baileys');
    });

    test('sent_at is the first send, not the last retry', async () => {
      const id = await seed(ORG_A);
      await repo.markSent(ORG_A, id, { providerId: 'WAM-L5', provider: 'baileys' });
      const first = (await statusOf(id)).sent_at;
      await new Promise((r) => setTimeout(r, 25));
      await repo.markSent(ORG_A, id, { providerId: 'WAM-L5', provider: 'baileys' });
      expect((await statusOf(id)).sent_at.toISOString()).toBe(first.toISOString());
    });

    test('markFailed cannot bury a message the client already received', async () => {
      // The retry path reaches here: the gateway's send-once refuses a second
      // attempt with DUPLICATE_MESSAGE, which arrives as a failure, while the
      // first attempt was delivered and its receipt already applied.
      const id = await seed(ORG_A, { status: 'delivered' });
      expect(await repo.markFailed(ORG_A, id, { reason: 'duplicate_in_flight' })).toBe(0);
      expect((await statusOf(id)).status).toBe('delivered');

      const readId = await seed(ORG_A, { status: 'read' });
      await repo.markFailed(ORG_A, readId, { reason: 'duplicate_in_flight' });
      expect((await statusOf(readId)).status).toBe('read');
    });

    test('a queued row can still be failed', async () => {
      const id = await seed(ORG_A);
      expect(await repo.markFailed(ORG_A, id, { reason: 'not_connected' })).toBe(1);
      expect((await statusOf(id)).status).toBe('failed');
    });

    test('and neither can be done to another studio\'s row', async () => {
      const id = await seed(ORG_A);
      expect(await repo.markSent(ORG_B, id, { providerId: 'X', provider: 'baileys' })).toBe(0);
      expect(await repo.markFailed(ORG_B, id, { reason: 'x' })).toBe(0);
      expect((await statusOf(id)).status).toBe('queued');
    });

    test('racing markSent against a receipt, 25 times, never lands on sent', async () => {
      // The actual race, run concurrently rather than in the fixed order the
      // tests above use. Whichever wins, the row must not end below the
      // receipt: that is what monotonic means.
      for (let i = 0; i < 25; i += 1) {
        const id = await seed(ORG_A);
        // external_id has to exist for the receipt to match, which is the real
        // sequence: the first attempt records it, the retry races the receipt.
        await owner.query('UPDATE communication_logs SET external_id = $2 WHERE id = $1', [id, `WAM-R${i}`]);

        await Promise.all([
          repo.markSent(ORG_A, id, { providerId: `WAM-R${i}`, provider: 'baileys' }),
          repo.applyReceipt(ORG_A, `WAM-R${i}`, 'delivered', null),
        ]);

        const row = await statusOf(id);
        expect(['delivered', 'read']).toContain(row.status);
        expect(row.delivered_at).not.toBeNull();
      }
    });
  });

  // ── FIX 2 ─────────────────────────────────────────────────────────────────
  //
  // sendsToday() + compare + insert is a check-then-act with a window in it.
  // Two events both read 199 against a limit of 200 and both insert. The limit
  // bounds how many messages a studio's own number emits before Meta treats it
  // as spam, so exceeding it is the risk the setting exists to prevent.
  describe('the daily limit is a hard limit under concurrency', () => {
    const LIMIT = 10;

    const entry = (orgId, n) => ({
      orgId,
      recipientType: 'client',
      recipientId: 'conc-client',
      recipientName: 'Asha',
      recipientPhone: '+919000009001',
      template: 'T',
      message: 'Hi',
      ruleId: orgId === ORG_A ? 'conc-rule-a' : 'conc-rule-b',
      dedupeKey: `conc-limit-${orgId}-${n}`,
    });

    const countToday = async (orgId) => {
      const { rows } = await owner.query(
        `SELECT COUNT(*)::INT AS n FROM communication_logs
          WHERE organization_id = $1 AND automation_rule_id IS NOT NULL
            AND created_at >= date_trunc('day', NOW())`, [orgId]);
      return rows[0].n;
    };

    beforeEach(async () => {
      await owner.query('DELETE FROM communication_logs WHERE organization_id IN ($1,$2)', [ORG_A, ORG_B]);
    });

    test('40 simultaneous events against a limit of 10 produce exactly 10', async () => {
      const results = await Promise.all(
        Array.from({ length: 40 }, (_, i) => repo.insertQueuedWithinLimit(entry(ORG_A, i), LIMIT))
      );

      const queued = results.filter((r) => r.outcome === 'queued');
      const refused = results.filter((r) => r.outcome === 'daily_limit_reached');

      expect(queued).toHaveLength(LIMIT);
      expect(refused).toHaveLength(40 - LIMIT);
      // The assertion that matters: the DATABASE, not the return values.
      expect(await countToday(ORG_A)).toBe(LIMIT);
    });

    test('one studio cannot consume another\'s quota', async () => {
      // Both studios fill their own limit at the same time. If the count or
      // the insert were not org-bound, one would starve the other.
      await Promise.all([
        ...Array.from({ length: 20 }, (_, i) => repo.insertQueuedWithinLimit(entry(ORG_A, i), LIMIT)),
        ...Array.from({ length: 20 }, (_, i) => repo.insertQueuedWithinLimit(entry(ORG_B, i), LIMIT)),
      ]);

      expect(await countToday(ORG_A)).toBe(LIMIT);
      expect(await countToday(ORG_B)).toBe(LIMIT);
    });

    test('deduplication still refuses a repeated event, and it costs no quota', async () => {
      const same = entry(ORG_A, 'repeated');
      const results = await Promise.all(
        Array.from({ length: 12 }, () => repo.insertQueuedWithinLimit(same, LIMIT))
      );

      expect(results.filter((r) => r.outcome === 'queued')).toHaveLength(1);
      expect(results.filter((r) => r.outcome === 'duplicate_event')).toHaveLength(11);
      expect(await countToday(ORG_A)).toBe(1);

      // And the eleven refusals did not eat into the limit: nine more distinct
      // events still fit.
      await Promise.all(Array.from({ length: 9 }, (_, i) => repo.insertQueuedWithinLimit(entry(ORG_A, `after-${i}`), LIMIT)));
      expect(await countToday(ORG_A)).toBe(LIMIT);
    });

    test('a limit of zero, and a studio with no settings row, queue nothing', async () => {
      // settingsFor() defaults an absent row to daily_send_limit 0 — closed,
      // like every other default in the repository.
      expect((await repo.insertQueuedWithinLimit(entry(ORG_A, 'zero'), 0)).outcome).toBe('daily_limit_reached');
      expect((await repo.insertQueuedWithinLimit(entry(ORG_A, 'undef'), undefined)).outcome).toBe('daily_limit_reached');
      expect(await countToday(ORG_A)).toBe(0);
    });

    test('the limit counts queued rows, not only sent ones', async () => {
      // Otherwise a studio whose messages are all still in the queue could
      // queue an unbounded number of them.
      await Promise.all(Array.from({ length: LIMIT }, (_, i) => repo.insertQueuedWithinLimit(entry(ORG_A, i), LIMIT)));
      const { rows } = await owner.query(
        `SELECT COUNT(*)::INT AS n FROM communication_logs WHERE organization_id = $1 AND status = 'queued'`, [ORG_A]);
      expect(rows[0].n).toBe(LIMIT);
      expect((await repo.insertQueuedWithinLimit(entry(ORG_A, 'over'), LIMIT)).outcome).toBe('daily_limit_reached');
    });
  });

  // ── FIX 3 ─────────────────────────────────────────────────────────────────
  //
  // The row is written before the job is enqueued. If the enqueue never
  // happens, the row is stranded at 'queued' and its dedupe key makes that
  // permanent. These prove which rows the recovery sweep will consider.
  describe('the orphan candidate query', () => {
    const OLD = "NOW() - INTERVAL '2 hours'";

    beforeEach(async () => {
      await owner.query('DELETE FROM communication_logs WHERE organization_id IN ($1,$2)', [ORG_A, ORG_B]);
    });

    const seedAged = async (orgId, { age, status = 'queued', ruleId = 'conc-rule-a', key }) => {
      const { rows } = await owner.query(
        `INSERT INTO communication_logs
           (organization_id, recipient_type, recipient_id, recipient_name, recipient_phone,
            channel, direction, template, message, status, automation_rule_id,
            automation_dedupe_key, created_at)
         VALUES ($1,'client','conc-client','Asha','+919000009001','whatsapp','outgoing','T','Hi',
                 $2,$3,$4, NOW() - make_interval(secs => $5))
         RETURNING id`,
        [orgId, status, ruleId, key, age]
      );
      return rows[0].id;
    };

    const ids = (rows) => rows.map((r) => r.id).sort();
    const sweep = (orgId) => repo.orphanCandidates(orgId, { olderThanSec: 900, maxAgeSec: 6 * 3600 });

    test('a stranded queued row past the grace period is a candidate', async () => {
      const id = await seedAged(ORG_A, { age: 7200, key: 'orph-1' });
      expect(ids(await sweep(ORG_A))).toEqual([id]);
    });

    test('a row inside the grace period is not — the engine may still be mid-flight', async () => {
      await seedAged(ORG_A, { age: 30, key: 'orph-2' });
      expect(await sweep(ORG_A)).toEqual([]);
    });

    test('a row older than the gateway\'s send-once memory is left for a human', async () => {
      // Past that TTL the gateway can no longer recognise a message it already
      // sent, so the guarantee that makes a re-drive safe has expired.
      await seedAged(ORG_A, { age: 9 * 3600, key: 'orph-3' });
      expect(await sweep(ORG_A)).toEqual([]);
    });

    test('rows that already left queued are never candidates', async () => {
      for (const status of ['sent', 'delivered', 'read', 'failed']) {
        await seedAged(ORG_A, { age: 7200, status, key: `orph-${status}` });
      }
      expect(await sweep(ORG_A)).toEqual([]);
    });

    test('a non-automation row is never a candidate', async () => {
      // automation_rule_id IS NULL — a hand-sent message has no job to recover.
      await owner.query(
        `INSERT INTO communication_logs
           (organization_id, recipient_type, recipient_id, recipient_phone, channel, direction,
            message, status, created_at)
         VALUES ($1,'client','conc-client','+919000009001','whatsapp','outgoing','Hi','queued', ${OLD})`,
        [ORG_A]
      );
      expect(await sweep(ORG_A)).toEqual([]);
    });

    test('one studio never sees another\'s stranded rows', async () => {
      const a = await seedAged(ORG_A, { age: 7200, key: 'orph-a' });
      const b = await seedAged(ORG_B, { age: 7200, ruleId: 'conc-rule-b', key: 'orph-b' });
      expect(ids(await sweep(ORG_A))).toEqual([a]);
      expect(ids(await sweep(ORG_B))).toEqual([b]);
    });

    test('the REMAINING delay is what comes back, not zero', async () => {
      // A "three days before expiry" reminder recovered with no delay would be
      // delivered the moment the sweep noticed it — the exact failure the
      // enqueue path refuses to risk when it declines to send inline.
      const id = await seedAged(ORG_A, { age: 7200, ruleId: 'conc-rule-delay', key: 'orph-delay' });
      const [row] = await sweep(ORG_A);
      expect(row.id).toBe(id);
      // 4320 minutes of delay, two hours already elapsed.
      const expected = (4320 * 60 - 7200) * 1000;
      expect(row.remainingDelayMs).toBeGreaterThan(expected - 60_000);
      expect(row.remainingDelayMs).toBeLessThanOrEqual(expected);
      expect(typeof row.remainingDelayMs).toBe('number');
    });

    test('a delay that has already elapsed comes back as zero, never negative', async () => {
      const id = await seedAged(ORG_A, { age: 7200, key: 'orph-past' });
      const [row] = await sweep(ORG_A);
      expect(row.id).toBe(id);
      expect(row.remainingDelayMs).toBe(0);
    });
  });
});
