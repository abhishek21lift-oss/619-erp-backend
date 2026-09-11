'use strict';
// No runtime code may read or write the legacy `attendance` table.
//
// ── What the duplication actually was ───────────────────────────────────────
//
// Two attendance tables, both tenant-scoped, both with an organization_id and
// an RLS policy — so unlike the `payments` case there was never a leak here.
// The defect was quieter and, for a user, worse: the two tables were not two
// copies of the same register, they were one register and one write-only hole.
//
// Everything that DISPLAYS attendance reads attendance_logs:
//
//   routes/attendance.js            the register, today-summary, bulk marking
//   routes/qr-checkin.js            scan, checkout, dashboard, my-history
//   modules/client-portal          GET /api/me/attendance
//   modules/pt-os/pt-os.service    a client's attendance history
//   modules/automation/…repository the missed-visit automation sweep
//   lib/ai/tools.js                the attendance_summary AI tool
//   modules/platform/super-admin   cross-studio activity analytics
//
// Exactly one writer used the other table: bookings.service.js checkIn(),
// mirroring a class check-in into `attendance`. Nothing read it back. A member
// checked in at the door for a class they had booked, the booking flipped to
// 'attended' — and the studio's attendance register, their own portal history
// and the missed-visit automation all carried on as though they had never
// turned up.
//
// `attendance` holds 0 rows in production and `bookings` holds 0 rows too, so
// no real check-in was ever lost to this. It was a live path waiting for the
// class-booking feature to be used.
//
// ── Why a source scan and not a request test ────────────────────────────────
//
// The defect is not "returns the wrong answer", it is "this query exists at
// all". Migration 192 drops the table, so after it any statement naming it is
// a guaranteed error rather than merely a write nobody reads — there is no
// file left where it would be acceptable.

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');

/**
 * `attendance` as a table name, never `attendance_logs` or
 * `biometric_attendance`.
 *
 * The `_` in attendance_logs is a word character, so a trailing \b already
 * refuses it; the negative lookbehind is what refuses biometric_attendance,
 * where the name is a suffix rather than a prefix.
 */
const LEGACY_SQL =
  /\b(?:FROM|UPDATE|INTO|JOIN|REFERENCES)\s+(?:public\.)?(?<![_a-z])attendance\b/i;

/** Runtime .js under src/, excluding tests and migrations. */
function runtimeFiles(dir = SRC, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === 'migrations' || e.name === 'node_modules') continue;
      runtimeFiles(full, out);
    } else if (e.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

const files = runtimeFiles();

/** Statements in `src` naming the legacy table, as "file:line  text". */
function offenders(re) {
  const found = [];
  for (const f of files) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (re.test(line)) found.push(`${path.relative(SRC, f)}:${i + 1}  ${line.trim()}`);
    });
  }
  return found;
}

describe('attendance_logs is the only attendance table', () => {
  it('scans a real set of runtime files', () => {
    // Without this the whole suite passes vacuously if the walk ever breaks —
    // which is exactly how the clients equivalent nearly shipped empty.
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.endsWith(path.join('modules', 'bookings', 'bookings.service.js')))).toBe(true);
  });

  it('no runtime file reads or writes the legacy attendance table', () => {
    expect(offenders(LEGACY_SQL)).toEqual([]);
  });

  it('no runtime file writes it specifically', () => {
    // Stated separately from the read case: a stray SELECT after migration 192
    // is a 500, but an INSERT is a 500 on a path that thinks it is recording
    // someone's arrival. Naming the write case makes a failure here readable.
    const WRITE = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:public\.)?(?<![_a-z])attendance\b/i;
    expect(offenders(WRITE)).toEqual([]);
  });

  it('the pattern distinguishes attendance from the tables that merely contain it', () => {
    // The assertions above are only worth anything if the regex is precise.
    // attendance_logs is the canonical table and biometric_attendance is a
    // real (legacy but present) table; matching either would make every test
    // here fail for the wrong reason, and loosening the regex to fix that
    // would silently stop it detecting the real thing.
    expect(LEGACY_SQL.test('FROM attendance_logs a')).toBe(false);
    expect(LEGACY_SQL.test('INTO attendance_logs (ref_id)')).toBe(false);
    expect(LEGACY_SQL.test('JOIN public.attendance_logs ON')).toBe(false);
    expect(LEGACY_SQL.test('FROM biometric_attendance ba')).toBe(false);

    expect(LEGACY_SQL.test('FROM attendance')).toBe(true);
    expect(LEGACY_SQL.test('INSERT INTO attendance (type, ref_id)')).toBe(true);
    expect(LEGACY_SQL.test('UPDATE public.attendance SET')).toBe(true);
    expect(LEGACY_SQL.test('JOIN attendance a ON a.ref_id = c.id')).toBe(true);
  });

  it('the class check-in mirror lands in attendance_logs', () => {
    // The one writer that had to move. Asserted positively as well as
    // negatively: "does not write `attendance`" is also satisfied by deleting
    // the mirror outright, which would lose the check-in entirely.
    const svc = fs.readFileSync(
      path.join(SRC, 'modules', 'bookings', 'bookings.service.js'), 'utf8');
    expect(svc).toMatch(/INSERT INTO attendance_logs/i);
    expect(svc).toMatch(/ON CONFLICT \(ref_id, ref_type, date\)/i);
    expect(svc).toMatch(/organization_id/);
  });

  it('migration 192 refuses to drop a table that still holds rows', () => {
    const mig = fs.readFileSync(
      path.join(SRC, 'db', 'migrations', '192_drop_legacy_attendance.sql'), 'utf8');

    // Pin the guard to its own abort, not merely to the presence of some
    // RAISE somewhere in the file — the file raises for other reasons too, so
    // a bare /RAISE EXCEPTION/ would survive the guard being downgraded to a
    // notice and the DROP running against live rows anyway.
    const guard = mig.slice(mig.indexOf('COUNT'), mig.indexOf('DROP TABLE'));
    expect(guard).toMatch(/RAISE EXCEPTION\s*\n?\s*'192 refused/);
    expect(mig).toMatch(/DROP TABLE IF EXISTS public\.attendance\b/i);
  });

  it('the domain manifest no longer claims the table', () => {
    const domains = require('../architecture/domains');
    expect(domains.DOMAINS.attendance.tables).toContain('attendance_logs');
    expect(domains.DOMAINS.attendance.tables).not.toContain('attendance');
  });
});
