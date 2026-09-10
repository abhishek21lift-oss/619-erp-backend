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

  // ── The sweep's queries ───────────────────────────────────────────────────
  //
  // Six of the twelve trigger events are found by a daily scan rather than
  // produced by a request, and a scan is the one shape where "every client
  // whose membership expires in 7 days" is naturally written across every
  // studio at once. So each of these has two halves: it finds the row it
  // should, and it does not find the identical row belonging to Studio B.
  //
  // Every predicate below is a date comparison, and a mocked pool would return
  // whatever the fixture said no matter what the WHERE clause did — which is
  // precisely how a missing `AND organization_id = $2` survived a full mocked
  // suite earlier in this work. Hence: real dates, real Postgres, CURRENT_DATE
  // arithmetic rather than literals so the fixtures stay true tomorrow.
  describe('the sweep queries', () => {
    const ORG_C = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';

    beforeAll(async () => {
      await owner.query(
        `INSERT INTO organizations (id, name, slug) VALUES ($1, 'Studio C', 'auto-c')
         ON CONFLICT (id) DO NOTHING`, [ORG_C]);
      // Automation OFF. It exists to prove orgsWithAutomationOn is a filter and
      // not just a list of everyone who has ever opened the settings page.
      await owner.query(
        `INSERT INTO whatsapp_automation_settings (organization_id, automation_enabled)
         VALUES ($1, FALSE)
         ON CONFLICT (organization_id) DO UPDATE SET automation_enabled = FALSE`, [ORG_C]);

      await owner.query(`
        INSERT INTO pt_clients
          (id, name, mobile, whatsapp, organization_id, trainer_id, dob, joining_date, pt_end_date)
        VALUES
          -- Studio A
          ('sw-exp7-a',   'Expiring',   '+919000001001', NULL, $1, 'auto-trainer-a', NULL, NULL, CURRENT_DATE + 7),
          ('sw-exp6-a',   'NotYet',     '+919000001002', NULL, $1, 'auto-trainer-a', NULL, NULL, CURRENT_DATE + 6),
          ('sw-gone-a',   'Lapsed',     '+919000001003', NULL, $1, 'auto-trainer-a', NULL, NULL, CURRENT_DATE - 1),
          ('sw-old-a',    'LongGone',   '+919000001004', NULL, $1, 'auto-trainer-a', NULL, NULL, CURRENT_DATE - 30),
          ('sw-bday-a',   'Birthday',   '+919000001005', NULL, $1, 'auto-trainer-a',
             (CURRENT_DATE - INTERVAL '30 years'), NULL, CURRENT_DATE + 60),
          ('sw-bdayx-a',  'BirthdayEx', '+919000001006', NULL, $1, 'auto-trainer-a',
             (CURRENT_DATE - INTERVAL '30 years'), NULL, CURRENT_DATE - 1),
          ('sw-anni-a',   'Anniv',      '+919000001007', NULL, $1, 'auto-trainer-a', NULL,
             (CURRENT_DATE - INTERVAL '2 years'), CURRENT_DATE + 60),
          ('sw-today-a',  'JoinedNow',  '+919000001008', NULL, $1, 'auto-trainer-a', NULL,
             CURRENT_DATE, CURRENT_DATE + 60),
          ('sw-away-a',   'Away',       '+919000001009', NULL, $1, 'auto-trainer-a', NULL, NULL, CURRENT_DATE + 60),
          ('sw-here-a',   'Here',       '+919000001010', NULL, $1, 'auto-trainer-a', NULL, NULL, CURRENT_DATE + 60),
          ('sw-never-a',  'NeverCame',  '+919000001011', NULL, $1, 'auto-trainer-a', NULL, NULL, CURRENT_DATE + 60),
          -- No number at all. The engine would refuse it; the sweep should not
          -- hand it over in the first place.
          ('sw-nophone-a','NoPhone',    NULL,            '',   $1, 'auto-trainer-a',
             (CURRENT_DATE - INTERVAL '30 years'), NULL, CURRENT_DATE + 7),
          -- Studio B, deliberately identical to A's rows in every respect but
          -- the organization. Each of these is what a dropped tenant predicate
          -- would return.
          ('sw-exp7-b',   'Expiring',   '+919000002001', NULL, $2, 'auto-trainer-b', NULL, NULL, CURRENT_DATE + 7),
          ('sw-gone-b',   'Lapsed',     '+919000002002', NULL, $2, 'auto-trainer-b', NULL, NULL, CURRENT_DATE - 1),
          ('sw-bday-b',   'Birthday',   '+919000002003', NULL, $2, 'auto-trainer-b',
             (CURRENT_DATE - INTERVAL '30 years'), NULL, CURRENT_DATE + 60),
          ('sw-anni-b',   'Anniv',      '+919000002004', NULL, $2, 'auto-trainer-b', NULL,
             (CURRENT_DATE - INTERVAL '2 years'), CURRENT_DATE + 60),
          ('sw-away-b',   'Away',       '+919000002005', NULL, $2, 'auto-trainer-b', NULL, NULL, CURRENT_DATE + 60)
        ON CONFLICT (id) DO NOTHING`, [ORG_A, ORG_B]);

      await owner.query(`
        INSERT INTO attendance_logs (id, ref_id, ref_type, date, organization_id) VALUES
          ('sw-att-1', 'sw-away-a', 'client', CURRENT_DATE - 40, $1),
          ('sw-att-2', 'sw-away-a', 'client', CURRENT_DATE - 20, $1),
          ('sw-att-3', 'sw-here-a', 'client', CURRENT_DATE - 40, $1),
          ('sw-att-4', 'sw-here-a', 'client', CURRENT_DATE - 2,  $1),
          ('sw-att-5', 'sw-away-b', 'client', CURRENT_DATE - 20, $2)
        ON CONFLICT (id) DO NOTHING`, [ORG_A, ORG_B]);

      await owner.query(`
        INSERT INTO pt_leads (id, organization_id, name, mobile, status, follow_up_date, trainer_id) VALUES
          ('sw-lead-due-a',  $1, 'Due',       '+919000003001', 'new',       CURRENT_DATE - 1, 'auto-trainer-a'),
          ('sw-lead-soon-a', $1, 'NotYet',    '+919000003002', 'contacted', CURRENT_DATE + 3, 'auto-trainer-a'),
          ('sw-lead-conv-a', $1, 'Converted', '+919000003003', 'converted', CURRENT_DATE - 1, 'auto-trainer-a'),
          ('sw-lead-lost-a', $1, 'Lost',      '+919000003004', 'lost',      CURRENT_DATE - 1, 'auto-trainer-a'),
          ('sw-lead-due-b',  $2, 'Due',       '+919000004001', 'new',       CURRENT_DATE - 1, 'auto-trainer-b')
        ON CONFLICT (id) DO NOTHING`, [ORG_A, ORG_B]);

      await owner.query(`
        INSERT INTO automation_rules (id, organization_id, name, trigger_event, template, is_active, channel) VALUES
          ('sw-rule-1', $1, 'Birthday',  'birthday',            'Happy birthday {{name}}', TRUE,  'whatsapp'),
          ('sw-rule-2', $1, 'Expiring',  'membership_expiring', 'Renew in {{days}}',       TRUE,  'whatsapp'),
          ('sw-rule-3', $1, 'Off',       'anniversary',         'Congrats',                FALSE, 'whatsapp'),
          ('sw-rule-4', $1, 'Emailed',   'attendance_missed',   'Missed you',              TRUE,  'email'),
          ('sw-rule-5', $2, 'BFollowup', 'followup_due',        'Still interested?',       TRUE,  'whatsapp')
        ON CONFLICT (id) DO NOTHING`, [ORG_A, ORG_B]);
    });

    afterAll(async () => {
      await owner.query(`DELETE FROM automation_rules WHERE id LIKE 'sw-rule-%'`);
      await owner.query(`DELETE FROM pt_leads WHERE id LIKE 'sw-lead-%'`);
      await owner.query(`DELETE FROM attendance_logs WHERE id LIKE 'sw-att-%'`);
      await owner.query(`DELETE FROM pt_clients WHERE id LIKE 'sw-%'`);
      await owner.query(`DELETE FROM whatsapp_automation_settings WHERE organization_id = $1`, [ORG_C]);
      await owner.query(`DELETE FROM organizations WHERE id = $1`, [ORG_C]);
    });

    const ids = (rows) => rows.map((r) => r.id).sort();

    describe('which studios and which events', () => {
      test('only studios with automation switched on are candidates', async () => {
        const orgs = await repo.orgsWithAutomationOn();
        expect(orgs).toEqual(expect.arrayContaining([ORG_A, ORG_B]));
        expect(orgs).not.toContain(ORG_C);
      });

      test('the active-event list is this studio\'s, and excludes off and non-whatsapp rules', async () => {
        const a = await repo.activeTriggerEventsFor(ORG_A);
        expect(a.sort()).toEqual(['birthday', 'membership_expiring']);
        // anniversary is inactive; attendance_missed is an email rule and the
        // engine has no email transport — a studio must not have its roster
        // scanned for an event that could never be delivered.
        expect(a).not.toContain('anniversary');
        expect(a).not.toContain('attendance_missed');
        // And B's rule is B's.
        expect(a).not.toContain('followup_due');
        expect(await repo.activeTriggerEventsFor(ORG_B)).toEqual(['followup_due']);
      });
    });

    describe('membership_expiring', () => {
      test('finds this studio\'s client at exactly 7 days, not the other studio\'s', async () => {
        const rows = await repo.membershipExpiringIn(ORG_A, 7);
        expect(ids(rows)).toEqual(['sw-exp7-a']);
        expect(ids(await repo.membershipExpiringIn(ORG_B, 7))).toEqual(['sw-exp7-b']);
      });

      test('the bucket is exact, so 6 days out is not 7 days out', async () => {
        // A range would put sw-exp6-a in the 7-bucket today and the 3-bucket in
        // three days, which is how one membership becomes three messages.
        expect(ids(await repo.membershipExpiringIn(ORG_A, 7))).not.toContain('sw-exp6-a');
        expect(ids(await repo.membershipExpiringIn(ORG_A, 6))).toEqual(['sw-exp6-a']);
      });

      test('the expiry date comes back as a string, not a Date', async () => {
        // It goes straight into an idempotency key. A JS Date would be
        // stringified through the local timezone and could name yesterday.
        const [row] = await repo.membershipExpiringIn(ORG_A, 7);
        expect(typeof row.end_date).toBe('string');
        expect(row.end_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      });

      test('a client with no number is not offered at all', async () => {
        expect(ids(await repo.membershipExpiringIn(ORG_A, 7))).not.toContain('sw-nophone-a');
      });
    });

    describe('membership_expired', () => {
      test('yesterday only — never the whole back catalogue', async () => {
        // The failure this guards against happens exactly once, on the first
        // morning after deploy: `pt_end_date < CURRENT_DATE` would message
        // every lapsed client a studio has ever had, and the dedupe key would
        // faithfully prevent only the SECOND such message.
        const rows = await repo.membershipExpiredYesterday(ORG_A);
        // Two, not one: sw-bdayx-a's membership also ended yesterday — it
        // exists to prove the birthday query excludes lapsed clients, and it
        // is correctly included here for the same reason it is excluded there.
        expect(ids(rows)).toEqual(['sw-bdayx-a', 'sw-gone-a']);
        // The one that matters: a membership that ended a month ago is not
        // news today.
        expect(ids(rows)).not.toContain('sw-old-a');
      });

      test('and only this studio\'s', async () => {
        expect(ids(await repo.membershipExpiredYesterday(ORG_B))).toEqual(['sw-gone-b']);
      });
    });

    describe('birthday', () => {
      test('matches the month and day across a 30-year gap', async () => {
        const rows = await repo.birthdaysToday(ORG_A);
        expect(ids(rows)).toContain('sw-bday-a');
        expect(ids(rows)).not.toContain('sw-bday-b');
      });

      test('but not someone whose membership has already ended', async () => {
        // Same date of birth, expired membership. A birthday message to
        // somebody who left is a studio that has not noticed they left.
        expect(ids(await repo.birthdaysToday(ORG_A))).not.toContain('sw-bdayx-a');
      });

      test('today comes back as a string from the database, not from Node', async () => {
        const [row] = await repo.birthdaysToday(ORG_A);
        expect(row.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      });
    });

    describe('anniversary', () => {
      test('finds the two-year client and counts the years', async () => {
        const rows = await repo.anniversariesToday(ORG_A);
        expect(ids(rows)).toContain('sw-anni-a');
        expect(rows.find((r) => r.id === 'sw-anni-a').years).toBe(2);
        expect(ids(rows)).not.toContain('sw-anni-b');
      });

      test('never on the joining day itself', async () => {
        // "Happy 0 year anniversary", sent the same morning member_created
        // fired, is the sort of thing that makes a studio switch automation off.
        expect(ids(await repo.anniversariesToday(ORG_A))).not.toContain('sw-today-a');
      });
    });

    describe('attendance_missed', () => {
      test('the long-absent client, and not the one who came in on Tuesday', async () => {
        const rows = await repo.attendanceMissedFor(ORG_A, 14);
        // sw-here-a also has a 40-day-old row. If the query looked at ANY
        // attendance rather than the most recent, it would be here too.
        expect(ids(rows)).toEqual(['sw-away-a']);
      });

      test('never someone who has no attendance history at all', async () => {
        // 34 clients and 12 attendance rows in production, so getting this
        // wrong nudges almost the whole roster on the first morning. What
        // enforces it is `HAVING (CURRENT_DATE - MAX(a.date)) >= $2` being
        // NULL — not the inner join, which says the same thing twice. A
        // COALESCE added to that HAVING is what this test is really watching
        // for, and it does fail on one.
        expect(ids(await repo.attendanceMissedFor(ORG_A, 14))).not.toContain('sw-never-a');
      });

      test('and not the other studio\'s absentee', async () => {
        expect(ids(await repo.attendanceMissedFor(ORG_A, 14))).not.toContain('sw-away-b');
        expect(ids(await repo.attendanceMissedFor(ORG_B, 14))).toEqual(['sw-away-b']);
      });

      test('the window widens and narrows with the threshold', async () => {
        expect(ids(await repo.attendanceMissedFor(ORG_A, 25))).toEqual([]);
        expect(ids(await repo.attendanceMissedFor(ORG_A, 1))).toEqual(['sw-away-a', 'sw-here-a']);
      });
    });

    describe('followup_due', () => {
      test('overdue leads only, and neither the converted nor the lost', async () => {
        const rows = await repo.followupsDue(ORG_A);
        expect(ids(rows)).toEqual(['sw-lead-due-a']);
      });

      test('and only this studio\'s leads', async () => {
        expect(ids(await repo.followupsDue(ORG_A))).not.toContain('sw-lead-due-b');
        expect(ids(await repo.followupsDue(ORG_B))).toEqual(['sw-lead-due-b']);
      });
    });

    describe('the lead recipient', () => {
      test("Studio A cannot resolve Studio B's lead", async () => {
        expect(await repo.leadRecipient(ORG_A, 'sw-lead-due-b')).toBeNull();
      });

      test('and resolves its own, with the number and the trainer', async () => {
        const lead = await repo.leadRecipient(ORG_A, 'sw-lead-due-a');
        expect(lead).toMatchObject({
          id: 'sw-lead-due-a', phone: '+919000003001', trainer_id: 'auto-trainer-a',
        });
      });
    });
  });
});
