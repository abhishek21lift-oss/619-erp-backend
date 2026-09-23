'use strict';
// 208_trainer_members_role_model.sql — the migration that makes the role model
// a database rule rather than an application convention.
//
// Pinned here, in the style of the other migration tests, because the ways this
// file could be wrong are all one-word edits that still run cleanly:
//
//   · a CHECK that lists a role it should not, or omits one it must
//   · the DEFAULT left on users.role, so an INSERT that forgets its role
//     silently creates a studio OWNER (that default was 'trainer')
//   · the one-trainer-per-studio index dropped, or written without the
//     partial WHERE, so a soft-deleted owner blocks the studio's real one
//   · a destructive step (DELETE, role rewrite) reaching production without
//     the backup that makes it recoverable
//   · the preflight softened into a "fix it up" UPDATE, which is how a
//     migration silently picks a winner between two accounts
//
// The behaviour was verified against a production-shaped fixture database
// before this was written: the file applies, is idempotent on a second run,
// and every attack insert (a second live trainer, a retired role, a
// super_admin holding an organization) is rejected by the constraints.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'db', 'migrations', '208_trainer_members_role_model.sql');
const sql = fs.readFileSync(FILE, 'utf8');
/** Comments stripped, so no assertion can be satisfied by prose. */
const body = sql.replace(/--[^\n]*/g, ' ');

const RETIRED = ['admin', 'manager', 'reception', 'receptionist', 'staff'];

describe('208_trainer_members_role_model.sql', () => {
  it('is read, so nothing below can pass vacuously', () => {
    expect(sql.length).toBeGreaterThan(2000);
  });

  it('is the only 208, and the never-applied one is gone', () => {
    const dir = path.dirname(FILE);
    const files = fs.readdirSync(dir).filter((f) => f.startsWith('208'));
    expect(files).toEqual(['208_trainer_members_role_model.sql']);
  });
});

describe('the preflight refuses rather than guesses', () => {
  it('raises on a role it does not recognise', () => {
    expect(body).toMatch(/RAISE EXCEPTION '208: % user\(s\) hold a role this migration does not recognise/);
  });

  it('raises on a studio account with no studio, and a platform account with one', () => {
    expect(body).toMatch(/RAISE EXCEPTION '208: % studio\/member account\(s\) have no organization_id/);
    expect(body).toMatch(/RAISE EXCEPTION '208: % super_admin account\(s\) belong to an organization/);
  });

  it('raises rather than choosing between two live staff accounts in one studio', () => {
    // The step that must never become an UPDATE. Picking a winner here decides
    // who owns somebody's business.
    expect(body).toMatch(/RAISE EXCEPTION '208: % organization\(s\) have more than one live staff account/);
  });

  it('raises on a cross-organization trainer link', () => {
    expect(body).toMatch(/RAISE EXCEPTION '208: % staff account\(s\) are linked to a trainer profile in a different organization/);
  });

  it('checks the subject and recipient types it is about to constrain', () => {
    expect(body).toMatch(/RAISE EXCEPTION '208: % attendance row\(s\)/);
    expect(body).toMatch(/RAISE EXCEPTION '208: % communication row\(s\)/);
  });
});

describe('every destructive step is recoverable', () => {
  it('backs the changed users up before rewriting their role', () => {
    const backup = body.indexOf('INSERT INTO archive.role_model_users_backup');
    const rewrite = body.indexOf("SET role = 'trainer'");
    expect(backup).toBeGreaterThan(-1);
    expect(rewrite).toBeGreaterThan(backup);
  });

  it('backs the permission rows up before deleting them', () => {
    const backup = body.indexOf('INSERT INTO archive.role_model_settings_backup');
    const del = body.indexOf('DELETE FROM system_settings');
    expect(backup).toBeGreaterThan(-1);
    expect(del).toBeGreaterThan(backup);
  });

  it('keeps the backups out of public, where the application would see them', () => {
    expect(body).toContain('CREATE SCHEMA IF NOT EXISTS archive');
    expect(body).not.toMatch(/CREATE TABLE IF NOT EXISTS public\./);
    // The earlier, never-applied 208 left its backup in public if it ever ran.
    expect(body).toContain("to_regclass('public._backup_admin_rename')");
  });

  it('invalidates every session minted under an old role', () => {
    // auth.js compares token_version on every request, so bumping it refuses
    // access and refresh tokens alike the moment they are next used.
    expect(body).toMatch(/SET role = 'trainer',\s*token_version = token_version \+ 1/);
  });
});

describe('the constraints the application now relies on', () => {
  it('allows exactly the three roles', () => {
    expect(body).toMatch(/ADD CONSTRAINT users_role_check\s*CHECK \(role IN \('super_admin', 'trainer', 'member'\)\)/);
    for (const role of RETIRED) {
      expect(body).not.toMatch(new RegExp(`CHECK \\(role IN \\([^)]*'${role}'`));
    }
  });

  it('drops the default, so no insert can create an owner by omission', () => {
    expect(body).toContain('ALTER TABLE users ALTER COLUMN role DROP DEFAULT');
    expect(body).not.toMatch(/ALTER COLUMN role SET DEFAULT/);
  });

  it('keeps the platform operator outside every studio', () => {
    expect(body).toMatch(/ADD CONSTRAINT users_platform_role_no_org\s*CHECK \(role <> 'super_admin' OR organization_id IS NULL\)/);
  });

  it('allows one live trainer per studio, ignoring soft-deleted rows', () => {
    // Partial, and on deleted_at IS NULL: without that, a studio that has ever
    // replaced its trainer could never have another one.
    expect(body).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_one_trainer_per_org\s*ON users \(organization_id\)\s*WHERE role = 'trainer' AND deleted_at IS NULL/);
  });

  it('narrows the subject and recipient types to what still exists', () => {
    expect(body).toMatch(/attendance_logs_ref_type_check\s*CHECK \(ref_type IN \('client', 'trainer'\)\)/);
    expect(body).toMatch(/communication_logs_recipient_type_check\s*CHECK \(recipient_type IN \('lead', 'client', 'trainer'\)\)/);
  });
});

describe('the data it moves', () => {
  it('maps every retired role onto trainer, and no other role', () => {
    // Sliced out of the raw file, where the section markers still are: `body`
    // has its comments stripped.
    const update = sql.slice(sql.indexOf('UPDATE users'), sql.indexOf('-- ── 3'));
    for (const role of RETIRED) expect([role, update.includes(`'${role}'`)]).toEqual([role, true]);
    expect(update).not.toContain("'member'");
    expect(update).not.toContain("'super_admin'");
  });

  it('gives a live trainer without a profile one in their OWN organization', () => {
    expect(body).toMatch(/INSERT INTO trainers \(name, email, organization_id\)/);
    expect(body).toMatch(/VALUES \(r\.name, r\.email, r\.organization_id\)/);
  });

  it('remaps announcement audiences instead of leaving them addressed to nobody', () => {
    expect(body).toMatch(/ALTER COLUMN audience_roles SET DEFAULT ARRAY\['trainer'\]::text\[\]/);
    expect(body).toMatch(/UPDATE platform_announcements/);
  });

  it('removes the per-role permission rows, and only those', () => {
    expect(body).toMatch(/DELETE FROM system_settings WHERE key LIKE 'perm\\_%'/);
    expect(body.match(/DELETE FROM/g) || []).toHaveLength(1);
  });
});

describe('it is safe to run twice', () => {
  it('guards every object it creates', () => {
    const created = body.match(/CREATE (TABLE|UNIQUE INDEX|INDEX|SCHEMA)[^;]*/g) || [];
    expect(created.length).toBeGreaterThan(2);
    const unguarded = created.filter((stmt) => !/IF NOT EXISTS/.test(stmt)).map((stmt) => stmt.slice(0, 60));
    expect(unguarded).toEqual([]);
  });

  it('drops each constraint before adding it', () => {
    for (const name of [
      'users_role_check',
      'users_platform_role_no_org',
      'attendance_logs_ref_type_check',
      'communication_logs_recipient_type_check',
    ]) {
      const drop = body.indexOf(`DROP CONSTRAINT IF EXISTS ${name}`);
      const add = body.indexOf(`ADD CONSTRAINT ${name}`);
      expect([name, drop > -1, add > drop]).toEqual([name, true, true]);
    }
  });

  it('re-runs its role rewrite over an empty set rather than a wrong one', () => {
    // Second run: no user holds a retired role, so both the backup INSERT and
    // the UPDATE select nothing. Neither is written as "everything that is not
    // a member", which would rewrite super_admin on the second pass.
    const backup = body.slice(body.indexOf('INSERT INTO archive.role_model_users_backup'));
    expect(backup).toMatch(/WHERE role IN \('admin', 'manager', 'reception', 'receptionist', 'staff'\)/);
  });
});

describe('it verifies what it claims to have done', () => {
  it('re-reads the roles, the profiles and the default', () => {
    const verify = body.slice(body.lastIndexOf('DO $$'));
    expect(verify).toMatch(/208 verify: % user\(s\) still hold a removed role/);
    expect(verify).toMatch(/208 verify: % live trainer\(s\) without a trainer profile/);
    expect(verify).toMatch(/208 verify: users\.role still has a default/);
  });
});
