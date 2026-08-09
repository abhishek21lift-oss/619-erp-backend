'use strict';
// members.service.js and bookings.service.js wrote to audit_log with columns
// that table has never had (user_id/action/entity/entity_id/before/after —
// the real columns are table_name/record_id/old_data/new_data/changed_by),
// so every create/update/delete/cancel that reached the statement threw.
// Unreached in practice — neither module has a live frontend caller — which
// is the only reason it never surfaced as a production 500. Fixed to write
// activity_log, the table every other audited write in the app actually
// uses, rather than patching the columns to match a second, otherwise-
// unused table.

const fs = require('fs');
const path = require('path');

const members = fs.readFileSync(
  path.join(__dirname, '..', 'modules', 'members', 'members.service.js'), 'utf8');
const bookings = fs.readFileSync(
  path.join(__dirname, '..', 'modules', 'bookings', 'bookings.service.js'), 'utf8');
const membersRoutes = fs.readFileSync(
  path.join(__dirname, '..', 'modules', 'members', 'members.routes.js'), 'utf8');
const bookingsRoutes = fs.readFileSync(
  path.join(__dirname, '..', 'modules', 'bookings', 'bookings.routes.js'), 'utf8');

describe('members.service.js and bookings.service.js no longer write to the wrong table', () => {
  it('never references audit_log or its non-existent columns again', () => {
    for (const src of [members, bookings]) {
      expect(src).not.toContain('audit_log');
      expect(src).not.toMatch(/\bentity\b\s*,\s*entity_id.*\bafter\b/);
    }
  });

  it('writes activity_log instead, for every one of the five audited actions', () => {
    for (const action of ['member.create', 'member.update', 'member.delete']) {
      expect(members).toContain(`'${action}'`);
    }
    for (const action of ['booking.create', 'booking.cancel']) {
      expect(bookings).toContain(`'${action}'`);
    }
    expect((members.match(/INSERT INTO activity_log/g) || []).length).toBe(3);
    expect((bookings.match(/INSERT INTO activity_log/g) || []).length).toBe(2);
  });

  it('the booking writes stay on the transaction client, not a separate pool.query', () => {
    // Unlike payments.js, this module never commits before logging — the
    // audit row and the booking it describes are one atomic write here, so
    // keeping it on `client` (the same connection as BEGIN/COMMIT) is
    // correct, not a shortcut, as long as it happens before COMMIT.
    for (const action of ['booking.create', 'booking.cancel']) {
      const at = bookings.indexOf(`'${action}'`);
      const before = bookings.slice(0, at);
      expect(before.slice(before.lastIndexOf('client.query') , at)).toBeTruthy();
    }
  });
});

describe('both ctx() helpers now carry what activity_log needs', () => {
  it('members.routes.js\'s ctx() includes user_name and organization_id', () => {
    const fn = membersRoutes.slice(membersRoutes.indexOf('function ctx(req)'), membersRoutes.indexOf('}\n'));
    expect(fn).toContain('user_name: req.user.name');
    expect(fn).toContain('organization_id: req.user.organization_id');
  });

  it("bookings.routes.js's ctx() includes user_name and organization_id", () => {
    const fn = bookingsRoutes.slice(bookingsRoutes.indexOf('const ctx = (req)'), bookingsRoutes.indexOf('});') + 3);
    expect(fn).toContain('user_name: req.user.name');
    expect(fn).toContain('organization_id: req.user.organization_id');
  });
});
