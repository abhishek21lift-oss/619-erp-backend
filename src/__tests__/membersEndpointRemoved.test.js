'use strict';
// /api/v1/members is gone, and putting it back has to be a decision.
//
// It served nine routes off a table with no organization_id, so migration 157
// could not cover it at any stage of the RLS rollout — 157 discovers tables BY
// that column. list() had no org predicate for admin or manager either, so the
// endpoint had neither an application-layer nor a database-layer tenant
// boundary. Its four siblings with the same defect were deleted earlier; this
// one was kept because the frontend appeared to call two of its routes.
//
// Both were dead. `member.get` and `member.metrics` are defined in the
// frontend's api barrel and invoked from nowhere. A read-only count against
// production then returned: 0 rows, 0 organisations represented, 0
// attributable rows, 0 conflicting derivations, 0 duplicate member codes, no
// recent activity. So there was nothing to preserve and nothing to migrate.
//
// This test is the guard. Reintroducing the endpoint fails the build until
// someone deletes these assertions, which is the explicit decision the removal
// note asks for — and if it comes back, it must come back with a tenant
// boundary, because the table still has no organization_id.
//
// The TABLE moved to the archive schema with the rest of the gym-ERP surface
// (migration 244). It was never dropped.

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(SRC, 'server.js'), 'utf8');

describe('the /api/v1/members endpoint stays removed', () => {
  it('is not mounted', () => {
    // Any express mount of that path, however it is spelled.
    expect(server).not.toMatch(/app\.use\(\s*['"`]\/api\/v1\/members/);
  });

  it('has no module left to mount', () => {
    expect(fs.existsSync(path.join(SRC, 'modules', 'members'))).toBe(false);
  });

  it('is not reachable from anywhere else in the source', () => {
    // A second mount, a proxy, a router re-export — anything that would put
    // the path back without touching server.js.
    const offenders = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== '__tests__') walk(p); continue; }
        if (!p.endsWith('.js')) continue;
        fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
          if (/^\s*(\/\/|\*)/.test(line)) return;          // comments are fine
          if (/['"`]\/api\/v1\/members/.test(line) || /modules\/members/.test(line)) {
            offenders.push(`${path.relative(SRC, p)}:${i + 1}`);
          }
        });
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });

  it('records why, so reinstating it is a decision and not an accident', () => {
    // The guard is only half the mechanism. Someone deleting these assertions
    // should find the reasoning rather than have to reconstruct it.
    const note = fs.readFileSync(
      path.join(SRC, 'db', 'migrations', 'MEMBERS-TENANT-GAP.md'), 'utf8');
    expect(note).toMatch(/organization_id/);
    expect(note).toMatch(/157/);
    expect(server).toMatch(/MEMBERS-TENANT-GAP\.md/);
  });
});

describe('the members table is archived, not dropped', () => {
  it('no migration drops or truncates the members table', () => {
    const dir = path.join(SRC, 'db', 'migrations');
    const offenders = [];
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql'))) {
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      // `members` exactly — not member_memberships, team_members, founder_members.
      if (/\b(DROP\s+TABLE|TRUNCATE)\s+(IF\s+EXISTS\s+)?(public\.)?members\b/i.test(sql)) {
        offenders.push(f);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('244 moves it into the archive schema', () => {
    const mig = fs.readFileSync(
      path.join(SRC, 'db', 'migrations', '244_remove_gym_erp_surface.sql'), 'utf8');
    expect(mig).toMatch(/'members'/);
    expect(mig).toMatch(/SET SCHEMA archive/);
  });
});
