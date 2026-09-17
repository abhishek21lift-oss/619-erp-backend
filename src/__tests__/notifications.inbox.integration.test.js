'use strict';
// The notification centre, against a real database.
//
// ── The bug ─────────────────────────────────────────────────────────────────
//
// notifications.service.js named a `read_at` column in three queries. No
// migration creates one. The table has carried `is_read BOOLEAN` since
// schema.sql, and the index behind the inbox query is on
// (user_id, is_read, created_at DESC).
//
// So every call to the notification centre errored with
// `column "read_at" does not exist`:
//
//   · GET /api/v1/notifications — polled by the bell in the app shell on
//     every page, so this 500ed continuously for every signed-in user
//   · markRead, on opening any notification
//   · markAllRead
//
// It is the same shape as the `link` column bug that migration 124 repaired —
// a query naming a column that only ever existed in someone's hand-patched
// database — and it survived because every caller of the inbox is a poll
// whose failure the UI swallows: the bell simply shows nothing, which is
// indistinguishable from having no notifications.
//
// ── Why this test is an integration test ────────────────────────────────────
//
// A unit test with a mocked pool cannot catch it. The mock answers whatever
// the test tells it to, so the query can name any column at all and still
// pass. Only a real database has an opinion about which columns exist — which
// is precisely why the defect lived in a module that has unit tests.
//
// Gated on RLS_TEST_DATABASE_URL and loud in CI if that is missing, so it
// cannot quietly skip in the one place it matters.

const { Pool } = require('pg');

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('notification inbox, against a real database', () => {
    it('has a database to run against', () => {
      throw new Error('RLS_TEST_DATABASE_URL is not set in CI — the notification inbox proof would skip.');
    });
  });
}

const ORG = '99999999-9999-4999-8999-999999999991';
const USER = 'notif-user-a';
const OTHER = 'notif-user-b';

describeIf('notification inbox, against a real database', () => {
  let db;
  let service;

  beforeAll(async () => {
    db = new Pool({ connectionString: DB_URL, max: 4 });
    process.env.DATABASE_URL = DB_URL;
    // Required HERE, not at the top of the file: db/pool.js reads
    // DATABASE_URL when it is first loaded, so the require has to come after
    // the line above sets it.
    service = require('../modules/notifications/notifications.service');

    await db.query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1,'Notif Org','notif-org')
       ON CONFLICT (id) DO NOTHING`, [ORG]);
    await db.query(
      `INSERT INTO users (id, name, email, password, role, is_active, organization_id, created_at, updated_at)
       VALUES ($1,'Notif A','notif-a@e2e.test','x','admin',TRUE,$3,NOW(),NOW()),
              ($2,'Notif B','notif-b@e2e.test','x','admin',TRUE,$3,NOW(),NOW())
       ON CONFLICT (id) DO NOTHING`, [USER, OTHER, ORG]);
  });

  beforeEach(async () => {
    await db.query("DELETE FROM notifications WHERE user_id IN ($1,$2)", [USER, OTHER]);
    await db.query(
      `INSERT INTO notifications (id, user_id, type, title, body, link, is_read, created_at)
       VALUES ('notif-1',$1,'announcement','First','Body one','/a',FALSE, NOW() - INTERVAL '2 hours'),
              ('notif-2',$1,'dues','Second','Body two',NULL,FALSE, NOW() - INTERVAL '1 hour'),
              ('notif-3',$2,'dues','Not yours','Body three',NULL,FALSE, NOW())`,
      [USER, OTHER]);
  });

  afterAll(async () => {
    await db.query("DELETE FROM notifications WHERE user_id IN ($1,$2)", [USER, OTHER]);
    await db.end();
  });

  it('reads the inbox at all', async () => {
    // The whole bug in one assertion: this threw
    // `column "read_at" does not exist` on every single call.
    const rows = await service.inbox(USER);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id)).toEqual(['notif-2', 'notif-1']); // newest first
  });

  it('returns the shape the app shell reads', async () => {
    // AppShell derives its unread count from `read_at` being null, so the
    // field has to be there whatever the column beneath it is called.
    const [row] = await service.inbox(USER);
    expect(Object.keys(row).sort()).toEqual(
      ['body', 'created_at', 'id', 'link', 'read_at', 'title', 'type'].sort(),
    );
    // Unread notifications have no read timestamp.
    expect(row.read_at).toBeNull();
  });

  it('never serves one user another user\'s notifications', async () => {
    const rows = await service.inbox(USER);
    expect(rows.find((r) => r.title === 'Not yours')).toBeUndefined();
  });

  it('marks one as read, and says when', async () => {
    await service.markRead('notif-1', USER);

    const rows = await service.inbox(USER);
    const one = rows.find((r) => r.id === 'notif-1');
    const two = rows.find((r) => r.id === 'notif-2');

    // Read: carries a timestamp.
    expect(one.read_at).not.toBeNull();
    expect(new Date(one.read_at).getTime()).toBeGreaterThan(0);
    // Untouched: still unread.
    expect(two.read_at).toBeNull();
  });

  it('refuses to mark another user\'s notification read', async () => {
    await service.markRead('notif-3', USER);
    const { rows } = await db.query('SELECT is_read FROM notifications WHERE id = $1', ['notif-3']);
    expect(rows[0].is_read).toBe(false);
  });

  it('filters to unread only when asked', async () => {
    await service.markRead('notif-1', USER);
    const rows = await service.inbox(USER, { unreadOnly: true });
    expect(rows.map((r) => r.id)).toEqual(['notif-2']);
  });

  it('marks every one of a user\'s notifications read, and nobody else\'s', async () => {
    await service.markAllRead(USER);

    const mine = await service.inbox(USER);
    expect(mine.every((r) => r.read_at !== null)).toBe(true);

    const { rows } = await db.query('SELECT is_read FROM notifications WHERE id = $1', ['notif-3']);
    // Another user's notification is untouched.
    expect(rows[0].is_read).toBe(false);
  });

  it('keeps is_read and the projected read_at in agreement', async () => {
    // One source of truth. If a future change adds a real read_at column
    // alongside is_read, this is what notices them drifting apart — and the
    // announcement read-count in super-admin still reads is_read.
    await service.markRead('notif-1', USER);
    const rows = await service.inbox(USER);
    const { rows: raw } = await db.query(
      'SELECT id, is_read FROM notifications WHERE user_id = $1', [USER],
    );
    for (const r of raw) {
      const projected = rows.find((x) => x.id === r.id);
      expect(`${r.id}:${Boolean(projected.read_at)}`).toBe(`${r.id}:${r.is_read}`);
    }
  });
});
