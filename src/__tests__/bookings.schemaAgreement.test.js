// The booking module names columns the database actually has.
//
// ── BIZ-02 / BIZ-04 ─────────────────────────────────────────────────────────
//
// modules/bookings/bookings.service.js was written against a schema that was
// never migrated. `bookings` and `class_sessions` have exactly one definition
// in this repository — migration 015 — and the module disagreed with it about
// column names, about which columns exist, and about the legal statuses.
// Verified by building 015's schema and running the module's own SQL:
//
//   GET  /api/classes/sessions   ERROR: column cs.trainer_id does not exist
//   POST /api/bookings           ERROR: column "membership_id" ... does not exist
//   a full class → waitlist      ERROR: violates check constraint
//                                       "bookings_status_check"
//
// So no booking has ever been written, and the 402 NO_MEMBERSHIP the audit
// originally predicted was unreachable — the INSERT failed first, and before
// that the timetable itself 500'd, so no session id ever reached a member.
//
// ── Why the assertions are on source text ───────────────────────────────────
//
// This class of defect is invisible to a mocked pool: `pool.query` resolves
// whatever the mock says regardless of whether the SQL could ever parse. Two
// test files covered this module and both passed throughout. The defect is the
// SQL itself, so that is what is checked.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

/** Source with comments stripped — a column named in prose is not a query. */
const code = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const service = code(read('modules', 'bookings', 'bookings.service.js'));
const routes  = code(read('modules', 'bookings', 'bookings.routes.js'));
const classes = code(read('routes', 'classes.js'));

/**
 * Columns migration 015 gives class_sessions. Anything else qualified with the
 * `cs.` alias is a column that does not exist.
 */
const CLASS_SESSION_COLUMNS = [
  'id', 'template_id', 'title', 'description', 'instructor_id', 'instructor_name',
  'date', 'start_time', 'end_time', 'capacity', 'booked_count', 'location',
  'status', 'created_at', 'updated_at', 'organization_id',
];

describe('class_sessions is addressed by the columns it has', () => {
  it.each([['bookings.service.js', service], ['routes/classes.js', classes]])(
    '%s references no invented cs.* column', (_name, src) => {
      const referenced = [...src.matchAll(/\bcs\.([a-z_]+)/g)].map((m) => m[1]);
      const invented = [...new Set(referenced)].filter((c) => !CLASS_SESSION_COLUMNS.includes(c));
      expect(invented).toEqual([]);
    });

  it('computes starts_at/ends_at rather than selecting stored ones', () => {
    // The API response keeps starts_at/ends_at — the member Classes screen
    // reads them — but they are derived from date + start_time, which is where
    // the value actually lives. A stored copy would be a denormalisation that
    // can disagree with its own source.
    expect(service).toMatch(/\(cs\.date \+ cs\.start_time\)/);
    expect(classes).toMatch(/\(cs\.date \+ cs\.start_time\)/);
    expect(service).toMatch(/AS starts_at/);
    expect(classes).toMatch(/AS starts_at/);
  });

  it('joins the instructor column, not a trainer_id that never existed', () => {
    expect(classes).toMatch(/JOIN trainers t ON t\.id = cs\.instructor_id/);
    expect(service).not.toMatch(/cs\.trainer_id/);
  });
});

describe('bookings is written with the columns it has', () => {
  it('the INSERT names no column outside the table', () => {
    const insert = service.slice(service.indexOf('INSERT INTO bookings'));
    const cols = insert.slice(insert.indexOf('(') + 1, insert.indexOf(')'));
    // membership_id and position-without-a-migration were the two that failed.
    // position exists now (182); membership_id belongs to the abandoned model.
    expect(cols).not.toMatch(/membership_id/);
    expect(cols).toMatch(/session_id/);
    expect(cols).toMatch(/client_id/);
    expect(cols).toMatch(/organization_id/);
  });

  it('uses checked_in, never a second spelling of it', () => {
    // 'attended' was never in the CHECK. Adding it would have left two
    // spellings of one state, which is how a status column stops meaning
    // anything; the existing spelling wins instead.
    expect(service).not.toMatch(/'attended'/);
    expect(service).toMatch(/status='checked_in'/);
  });

  it('reads no table from the abandoned v3 membership model', () => {
    for (const src of [service, routes, classes]) {
      expect(src).not.toMatch(/member_memberships/);
    }
  });
});

describe('the client is identified by a column that is populated', () => {
  it('the routes take pt_client_id, never member_id, for a member session', () => {
    // req.user.member_id is always NULL for a real client account
    // (middleware/rbac.js, migration 154). Reading it meant a member listing
    // their bookings got [] and a member booking got 400 "member_id required".
    expect(routes).toMatch(/req\.user\.pt_client_id/);
    expect(routes).not.toMatch(/=\s*req\.user\.member_id/);
  });

  it('the calendar lookup joins users on pt_client_id', () => {
    expect(service).toMatch(/WHERE u\.pt_client_id = \$1/);
  });

  it('no query filters bookings on member_id', () => {
    const filters = [...service.matchAll(/\bb?\.?member_id\s*=/g)];
    expect(filters).toEqual([]);
  });
});

describe('the check-in mirror lands where somebody reads it', () => {
  it('writes attendance_logs, not the write-only attendance table', () => {
    expect(service).toMatch(/INSERT INTO attendance_logs/);
    expect(service).not.toMatch(/INSERT INTO attendance\s*\(/);
  });

  it('constrains method to what the CHECK allows', () => {
    // attendance_logs.method is CHECK-constrained and the route takes it from
    // the request body. An unrecognised value would abort the mirror AFTER the
    // booking was marked checked in, leaving the two records disagreeing.
    expect(service).toMatch(/ATTENDANCE_METHODS/);
    expect(service).toMatch(/'face', 'manual', 'qr', 'biometric'/);
  });
});
