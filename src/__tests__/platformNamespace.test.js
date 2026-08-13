'use strict';
// The control plane has one boundary and two names, and every session-minting
// path says which plane it minted for.
//
// Both halves are structural: they are properties of how the app is wired
// rather than of what a single request returns, and each has a failure mode
// that no request-level test would notice.
//
//   · A second mount of the platform router with a weaker guard is invisible
//     until somebody finds it. The old `/api/super-admin` path still exists —
//     the mobile client ships compiled URLs and an operator's bookmark is not
//     something this repo can migrate — so there are genuinely two doors, and
//     what must be true is that they are the SAME door.
//
//   · A jwt.sign() added without an audience produces a token that
//     authenticates perfectly and then fails a boundary check somewhere far
//     away, months later, when PLATFORM_SESSION_ENFORCE is turned on. That is
//     the worst possible time to discover it, so it is caught here instead.

const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

/** Source with comments stripped, so a path named in prose is not a mount. */
const code = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const serverSrc = code(read('server.js'));

describe('the platform API mount', () => {
  it('serves the control plane under /api/platform', () => {
    expect(serverSrc).toMatch(/app\.use\('\/api\/platform',/);
  });

  it('keeps /api/super-admin mounted, so bookmarks and the mobile app still work', () => {
    expect(serverSrc).toMatch(/app\.use\('\/api\/super-admin',/);
  });

  it('guards both names with the same chain', () => {
    // The property that makes two names safe. If one mount ever grows its own
    // middleware list, this fails — which is the whole point, because the
    // weaker of two doors is the one that gets used.
    const mounts = [...serverSrc.matchAll(
      /app\.use\('(\/api\/(?:platform|super-admin))',\s*([^,]+),/g
    )];
    expect(mounts.length).toBe(2);
    const guards = mounts.map((m) => m[2].trim());
    expect(guards[0]).toBe(guards[1]);
    expect(guards[0]).toBe('...PLATFORM_GUARD');
  });

  it('and both serve the same router', () => {
    // Not two copies that could drift — one required module, mounted twice.
    expect(serverSrc).toMatch(
      /const platformRoutes = require\('\.\/modules\/platform\/super-admin\.routes'\)/
    );
    const uses = [...serverSrc.matchAll(/app\.use\('\/api\/(?:platform|super-admin)',[^;]*?(platformRoutes)/g)];
    expect(uses.length).toBe(2);
  });

  it('puts the boundary check in that chain, not just the role check', () => {
    // requireSuperAdmin answers "is this account a super admin". That was the
    // ENTIRE platform boundary before migration 161, and it is now one of four
    // facts — see middleware/platformAuth.js.
    const guard = /const PLATFORM_GUARD = \[([^\]]+)\]/.exec(serverSrc);
    expect(guard).not.toBeNull();
    const chain = guard[1];
    expect(chain).toMatch(/\bauth\b/);
    expect(chain).toMatch(/requireSuperAdmin\b/);
    expect(chain).toMatch(/requireSuperAdminMfa\b/);
    expect(chain).toMatch(/requirePlatformOwner\b/);
  });

  it('guards the platform-destructive reset tooling the same way', () => {
    // /api/admin wipes data across every tenant with no organization_id
    // filter (audit C-1). It is platform surface and takes the platform guard.
    expect(serverSrc).toMatch(/app\.use\('\/api\/admin',\s*\.\.\.PLATFORM_GUARD,/);
  });
});

describe('every session token declares its plane', () => {
  // Files that mint a token, and what each one must stamp on it.
  //
  // Enumerated rather than globbed so that a NEW minting site is a decision
  // somebody makes here, in a file about the boundary, rather than something
  // that slips in unnoticed. The count assertion below is what forces that.
  const MINTERS = [
    ['routes/auth.js', null],                                   // both planes — the door decides
    ['routes/auth-google.js', 'AUD_TENANT'],                    // studio door
    ['routes/auth-webauthn.js', 'AUD_TENANT'],                  // studio door (passkey)
    ['modules/platform/super-admin/impersonation.js', 'AUD_TENANT'], // operator entering a studio
  ];

  it.each(MINTERS.filter(([, aud]) => aud))('%s mints a %s session', (file, aud) => {
    expect(code(read(...file.split('/')))).toMatch(new RegExp(`aud:\\s*${aud}`));
  });

  it('routes/auth.js routes every mint through one helper that takes the audience', () => {
    // Four mint sites in that file — login, refresh, password change, and the
    // refresh-token rotation beside it. A helper means the audience cannot be
    // forgotten at one of them.
    const src = code(read('routes', 'auth.js'));
    expect(src).toMatch(/function signAccessToken\(userId, tokenVersion, audience\)/);
    expect(src).toMatch(/if \(audience\) payload\.aud = audience/);
  });

  it('login stamps the audience from the door, not from the role', () => {
    // A super admin who signs in at the studio door gets a STUDIO session. If
    // this read the role instead, the door would be decoration.
    const src = code(read('routes', 'auth.js'));
    expect(src).toMatch(/const audience = portal === 'platform'/);
  });

  it('impersonation mints a studio session, never a platform one', () => {
    const src = code(read('modules', 'platform', 'super-admin', 'impersonation.js'));
    expect(src).toMatch(/aud: AUD_TENANT/);
    expect(src).not.toMatch(/aud: AUD_PLATFORM/);
  });

  it('has no minting site outside that list', () => {
    // Walks the tree rather than trusting the list above to be current.
    // calendar.js signs an OAuth `state` value and auth-webauthn.js signs a
    // 5-minute action token; neither opens a session, so neither carries an
    // audience — they are named here so that being on this list is a decision
    // rather than an oversight.
    const NON_SESSION = ['routes/calendar.js'];
    const found = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== '__tests__') walk(p); continue; }
        if (!e.name.endsWith('.js')) continue;
        if (/\bjwt\.sign\(/.test(code(fs.readFileSync(p, 'utf8')))) {
          found.push(path.relative(SRC, p).replace(/\\/g, '/'));
        }
      }
    };
    walk(SRC);
    const expected = [...MINTERS.map(([f]) => f), ...NON_SESSION].sort();
    expect(found.sort()).toEqual(expected);
  });
});

describe('the audience survives a refresh', () => {
  // Access tokens live 15 minutes; refresh tokens live weeks. If the refresh
  // handler chose the audience itself, every distinction the door draws would
  // be laundered away by lunchtime.
  const src = code(read('routes', 'auth.js'));

  it('stores the plane on the refresh token', () => {
    expect(src).toMatch(/INSERT INTO refresh_tokens \(user_id, token_hash, expires_at, audience\)/);
  });

  it('reads it back rather than re-deciding', () => {
    expect(src).toMatch(/SELECT rt\.user_id, rt\.audience/);
    expect(src).toMatch(/signAccessToken\(user_id, token_version, audience\)/);
  });

  it('re-issues the rotated refresh token on the same plane', () => {
    expect(src).toMatch(/issueRefreshToken\(res, user_id, audience\)/);
  });

  it('still works on a database that has not applied migration 162', () => {
    // Migrations run at boot, so the window is narrow — but during it, nobody
    // being able to sign in is a worse outcome than an unlabelled session.
    expect(src).toMatch(/42703/);
  });
});

describe('the migrations that back this', () => {
  const dir = path.join(SRC, 'db', 'migrations');

  it('creates the explicit grant table', () => {
    const sql = fs.readFileSync(path.join(dir, '161_platform_owners.sql'), 'utf8');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS platform_owners/);
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/);
  });

  it('seeds it from the existing super admins, so the change lands inert', () => {
    // Without the seed, deploying 161 revokes the operator's own access.
    const sql = fs.readFileSync(path.join(dir, '161_platform_owners.sql'), 'utf8');
    expect(sql).toMatch(/INSERT INTO platform_owners/);
    expect(sql).toMatch(/WHERE u\.role = 'super_admin'/);
  });

  it('grants app_tenant nothing on it', () => {
    // A platform owner belongs to no studio, so there is no tenant-scoping
    // policy to write. RLS on with no policy for app_tenant IS the policy.
    const sql = fs.readFileSync(path.join(dir, '161_platform_owners.sql'), 'utf8');
    expect(sql).toMatch(/REVOKE ALL ON public\.platform_owners FROM app_tenant/);
  });

  it('adds the audience column the refresh path reads', () => {
    const sql = fs.readFileSync(path.join(dir, '162_refresh_token_audience.sql'), 'utf8');
    expect(sql).toMatch(/ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS audience/);
  });
});
