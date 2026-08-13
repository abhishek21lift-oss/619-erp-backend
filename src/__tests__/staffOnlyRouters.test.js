// The staff-only routers, asserted at the mount.
//
// requireStaff went in for /api/pt-os and stopped there. Its own comment in
// middleware/rbac.js gives the reason it exists — read routes gated on `auth`
// alone were "survivable only because no account had ever held the `member`
// role" — and client logins create those accounts by the hundred.
//
// This is not a cross-tenant issue: tenantScope() still confines everything to
// one studio. It is a privilege one. A logged-in CLIENT could read their own
// gym's staff data — the client roster with contact details and notes, the
// studio's revenue and outstanding dues, and every progress record in the
// organisation.
//
// Asserted at the MOUNT rather than per-handler, because the mount is where the
// fix lives and where a refactor would silently drop it.
'use strict';

const fs = require('fs');
const path = require('path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

const STAFF_ONLY = [
  'clients',        // GET / returns c.* for up to 1000 rows
  'progress',       // nine GETs whose client_id is optional
  'reports',        // revenue, dues, trainer performance
  'trainers',
  'payments',
  'attendance',
  'expenses',
  'invoices',
  'communication',
  'search',
];

describe('every staff-only router is mounted behind requireStaff', () => {
  test.each(STAFF_ONLY)('/api/%s', (name) => {
    const mount = new RegExp(`app\\.use\\('/api/${name}',[^;]*requireStaff[^;]*require\\(`);
    expect(server).toMatch(mount);
  });

  test.each(STAFF_ONLY)('/api/%s is not mounted without one', (name) => {
    // The failing shape written out, so a reviewer can see exactly what
    // regressed if this goes red.
    const lines = server.split('\n').filter((l) => l.includes(`app.use('/api/${name}'`));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toContain('requireStaff');
  });
});

describe('the gate is ordered so a client learns nothing extra', () => {
  test.each(['reports', 'expenses', 'invoices', 'communication', 'attendance'])(
    'requireStaff precedes the feature gate on /api/%s', (name) => {
      const line = server.split('\n').find((l) => l.includes(`app.use('/api/${name}'`));
      expect(line.indexOf('requireStaff')).toBeLessThan(line.indexOf('gate('));
    },
  );
});

describe('the client portal is unaffected', () => {
  test('/api/me is still mounted for clients, not staff', () => {
    // The portal calls exactly one endpoint. Gating the routers above breaks
    // nothing it uses — verified against 619-erp-frontend, where no screen
    // under app/(bare)/member, /client or /member-login references any of them.
    expect(server).toMatch(/app\.use\('\/api\/me',\s*auth,\s*requireClient,/);
  });
});

describe('requireStaff still means what it says', () => {
  const { requireStaff, STAFF_ROLES } = require('../middleware/rbac');

  const run = (user) => {
    let status = null;
    let passed = false;
    const res = { status: (s) => { status = s; return res; }, json: () => res };
    requireStaff({ user }, res, () => { passed = true; });
    return { passed, status };
  };

  test('a member is refused', () => {
    expect(run({ role: 'member', organization_id: 'org-1' }))
      .toMatchObject({ passed: false, status: 403 });
  });

  test.each(STAFF_ROLES)('%s is admitted', (role) => {
    expect(run({ role, organization_id: 'org-1' }).passed).toBe(true);
  });

  test('member is absent from the allow-list', () => {
    expect(STAFF_ROLES).not.toContain('member');
  });
});
