// The classes/bookings module, attacked rather than read.
//
// ── What this exists to catch ──────────────────────────────────────────────
//
// Five tables in this feature had no organization_id, and were listed in
// tenantColumns.convention.test.js's KNOWN_GAPS as "legacy members feature /
// not yet retrofitted". That reason was wrong on the facts: the module is
// mounted at /api/bookings AND /api/v1/bookings, /api/classes/sessions is
// mounted too, and src/app/(bare)/member/classes/page.tsx calls
// api.bookings.create — a shipped page reachable by the `member` accounts
// client activation creates.
//
// Three of the four endpoints were BOLAs, and a role check is what disguised
// the worst of them:
//
//   POST /api/bookings/:id/check-in  requireRole('admin','manager','trainer')
//                                    — a role, never an owner. Any admin or
//                                    trainer of ANY studio could mark ANY
//                                    booking attended, and the mirrored
//                                    attendance row landed in the booking's
//                                    studio, not the caller's.
//   DELETE /api/bookings/:id         the role check only constrained `member`,
//                                    so staff of any studio could cancel any
//                                    booking on the platform.
//   GET  /api/bookings?member_id=X   member_id straight off the query string
//                                    for any non-member caller.
//   POST /api/bookings               session_id was never checked against the
//                                    caller's studio, so a member could book a
//                                    seat in another studio's class and spend
//                                    a credit against it.
//
// Nothing had leaked only because every table was empty. Same method as
// untenantedTables.authz.test.js: drive the real code with a studio-B caller
// against studio-A ids, and assert both the outcome AND that the SQL carried
// the caller's org — a handler can return nothing for an unrelated reason and
// look correct while remaining wide open.
'use strict';

const ORG_B = '22222222-2222-4222-8222-222222222222';
// The other studio's id. Only needed where a case has to make the caller's
// org and the booking's org actually differ.
const ORG_A = '11111111-1111-4111-8111-111111111111';

const mockQueries = [];
let mockRows = [];

const record = (sql, params) => {
  mockQueries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params: params || [] });
  return { rows: mockRows, rowCount: mockRows.length };
};

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => record(sql, params)),
  connect: jest.fn(async () => ({
    query: jest.fn(async (sql, params) => record(sql, params)),
    release: jest.fn(),
  })),
}));

jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn(),
}));
jest.mock('../lib/google-calendar', () => ({
  isConfigured: () => false,
  createBookingEvent: jest.fn(async () => {}),
  deleteBookingEvent: jest.fn(async () => {}),
}));

const svc = require('../modules/bookings/bookings.service');

/** The SQL statements that touched a given table. */
const touching = (table) =>
  mockQueries.filter((q) => new RegExp(`\\b${table}\\b`, 'i').test(q.sql));

beforeEach(() => {
  mockQueries.length = 0;
  mockRows = [];
});

const ctxB = {
  user_id: 'u-b', user_name: 'B Admin', organization_id: ORG_B,
  role: 'admin', member_id: null,
};

describe('bookings service is bounded by the caller\'s studio', () => {
  describe('checkIn — the role check was never an ownership check', () => {
    it('scopes the UPDATE by organization and refuses when nothing matches', async () => {
      await expect(svc.checkIn('booking-owned-by-A', { method: 'manual' }, ctxB))
        .rejects.toMatchObject({ status: 400 });

      const [update] = touching('bookings');
      expect(update.sql).toMatch(/UPDATE bookings/i);
      expect(update.sql).toMatch(/organization_id = \$\d/);
      expect(update.params).toContain(ORG_B);
    });

    it('never reaches the attendance mirror when the booking is not the caller\'s', async () => {
      await expect(svc.checkIn('booking-owned-by-A', {}, ctxB)).rejects.toThrow();
      // A row written here would have landed in studio A on studio B's say-so.
      expect(touching('attendance_logs')).toHaveLength(0);
    });

    it('stamps the attendance mirror from the booking, not from the caller', async () => {
      // The booking's own org wins, so the mirror cannot land in a different
      // studio from the booking it mirrors even if the two disagree.
      mockRows = [{ id: 'bk-1', member_id: 'm-1', organization_id: ORG_B }];
      await svc.checkIn('bk-1', { method: 'manual' }, ctxB);

      const insert = touching('attendance_logs')[0];
      expect(insert.sql).toMatch(/INSERT INTO attendance_logs/i);
      expect(insert.sql).toMatch(/organization_id/);
      expect(insert.params).toContain(ORG_B);
    });

    // `touching` anchors on \battendance\b, and the `_` in attendance_logs is a
    // word character — so this genuinely distinguishes the two tables rather
    // than matching the canonical one by accident.
    it('writes the canonical table and not the legacy one', async () => {
      mockRows = [{ id: 'bk-1', member_id: 'm-1', organization_id: ORG_B }];
      await svc.checkIn('bk-1', { method: 'manual' }, ctxB);

      expect(touching('attendance_logs')).toHaveLength(1);
      expect(touching('attendance')).toHaveLength(0);
    });

    it('takes the org from the booking even when the caller carries none', async () => {
      // The case the assertion above cannot reach. When ctx has no
      // organization_id the UPDATE runs without an org clause, so the caller's
      // org and the booking's org are no longer forced equal — and every other
      // fixture here sets them to the same value, which let a swap of
      // b.organization_id for ctx.organization_id pass the whole suite.
      // Stamping from ctx here would write undefined into a NOT NULL column.
      mockRows = [{ id: 'bk-1', member_id: 'm-1', organization_id: ORG_A }];
      await svc.checkIn('bk-1', { method: 'manual' }, {});

      const insert = touching('attendance_logs')[0];
      expect(insert.params).toContain(ORG_A);
      expect(insert.params).not.toContain(undefined);
    });

    it('clamps an unrecognised check-in method rather than failing the check-in', async () => {
      // attendance_logs.method carries a CHECK the legacy table did not, and
      // the route passes req.body.method through unvalidated. Without the
      // clamp this reaches Postgres as 'turnstile' and 500s.
      mockRows = [{ id: 'bk-1', member_id: 'm-1', organization_id: ORG_B }];
      await svc.checkIn('bk-1', { method: 'turnstile' }, ctxB);

      const insert = touching('attendance_logs')[0];
      expect(insert.params).toContain('manual');
      expect(insert.params).not.toContain('turnstile');
    });

    it('passes a recognised method through untouched', async () => {
      // The clamp must not flatten every method to 'manual' — that would make
      // the register claim every class check-in was typed in by hand.
      mockRows = [{ id: 'bk-1', member_id: 'm-1', organization_id: ORG_B }];
      await svc.checkIn('bk-1', { method: 'qr' }, ctxB);

      expect(touching('attendance_logs')[0].params).toContain('qr');
    });

    it('keeps the earliest check-in of the day on conflict', async () => {
      // Sharing a table means sharing its semantics: routes/attendance.js and
      // routes/qr-checkin.js both COALESCE so a second check-in cannot rewrite
      // when someone actually arrived. The legacy write overwrote it.
      mockRows = [{ id: 'bk-1', member_id: 'm-1', organization_id: ORG_B }];
      await svc.checkIn('bk-1', { method: 'manual' }, ctxB);

      const { sql } = touching('attendance_logs')[0];
      expect(sql).toMatch(/ON CONFLICT \(ref_id, ref_type, date\) DO UPDATE/i);
      expect(sql).toMatch(/check_in_time\s*=\s*COALESCE\(attendance_logs\.check_in_time/i);
    });
  });

  describe('cancel', () => {
    it('scopes the lookup by organization and 404s rather than 403s', async () => {
      await expect(svc.cancel('booking-owned-by-A', {}, ctxB))
        .rejects.toMatchObject({ status: 404 });

      const lookup = mockQueries.find((q) => /FROM bookings b/i.test(q.sql));
      expect(lookup.sql).toMatch(/b\.organization_id = \$\d/);
      expect(lookup.params).toContain(ORG_B);
    });
  });

  describe('book', () => {
    it('scopes the session lock by organization', async () => {
      await expect(svc.book({ session_id: 'session-in-A', member_id: 'm-1' }, ctxB))
        .rejects.toMatchObject({ status: 404 });

      const lock = mockQueries.find((q) => /FROM class_sessions/i.test(q.sql));
      expect(lock.sql).toMatch(/organization_id = \$\d/);
      expect(lock.sql).toMatch(/FOR UPDATE/i);
      expect(lock.params).toContain(ORG_B);
    });

    it('refuses outright when the caller has no studio', async () => {
      // A platform super admin operating platform-wide cannot pick a studio
      // implicitly; inserting NULL would hit migration 176's NOT NULL as an
      // opaque 500 instead.
      const platformCtx = { ...ctxB, organization_id: null, role: 'super_admin' };
      await expect(svc.book({ session_id: 's-1', member_id: 'm-1' }, platformCtx))
        .rejects.toMatchObject({ status: 400 });
      expect(mockQueries).toHaveLength(0);
    });

    it('stamps organization_id on the booking it creates', async () => {
      const src = require('fs').readFileSync(
        require('path').join(__dirname, '..', 'modules', 'bookings', 'bookings.service.js'), 'utf8');
      const insert = src.slice(src.indexOf('INSERT INTO bookings'));
      expect(insert.slice(0, insert.indexOf('RETURNING'))).toMatch(/organization_id/);
    });
  });

  describe('listForMember — member_id comes straight off the query string', () => {
    it('adds the organization predicate when the caller is a tenant user', async () => {
      await svc.listForMember('member-of-A', {}, { applyFilter: true, orgId: ORG_B });

      const [q] = mockQueries;
      expect(q.sql).toMatch(/b\.organization_id = \$\d/);
      expect(q.params).toContain(ORG_B);
    });

    it('omits it for a platform super admin operating platform-wide', async () => {
      await svc.listForMember('member-of-A', {}, { applyFilter: false, orgId: null });

      const [q] = mockQueries;
      expect(q.sql).not.toMatch(/b\.organization_id/);
      expect(q.params).not.toContain(null);
    });
  });
});
