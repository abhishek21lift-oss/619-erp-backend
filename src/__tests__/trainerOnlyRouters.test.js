// The trainer-only routers, asserted at the mount.
//
// requireTrainer went in for /api/pt-os and stopped there. Its own comment in
// middleware/rbac.js gives the reason it exists — read routes gated on `auth`
// alone were "survivable only because no account had ever held the `member`
// role" — and client logins create those accounts by the hundred.
//
// This is not a cross-tenant issue: tenantScope() still confines everything to
// one studio. It is a privilege one. A logged-in CLIENT could read their own
// studio's back-office data — the client roster with contact details and notes, the
// studio's revenue and outstanding dues, and every progress record in the
// organisation.
//
// Asserted at the MOUNT rather than per-handler, because the mount is where the
// fix lives and where a refactor would silently drop it.
'use strict';

const fs = require('fs');
const path = require('path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

const TRAINER_ONLY = [
  // 'clients' was here until /api/clients was retired — a second HTTP surface
  // over pt_clients, whose handlers moved to /api/pt-os/clients. That mount
  // takes its place on this list rather than the entry simply disappearing:
  // the client API still exists and still must be trainer-only, and a list that
  // silently shrinks when a route moves is a guard that stops guarding.
  'pt-os',          // the client API: roster, profile, search, history, money
  'progress',       // nine GETs whose client_id is optional
  'reports',        // revenue, dues, trainer performance
  'payments',
  'attendance',
  'expenses',
  'invoices',
  'communication',
  'search',
];

// A mount satisfies "behind requireTrainer" one of two ways: the literal
// middleware inline (`auth, requireTrainer, ...gate(key)`), or the studioGate(key)
// combinator — `const studioGate = (key) => [auth, requireTrainer, requireFeature(key)]`
// — which bakes requireTrainer in without the word appearing at the call site.
// Both are asserted below; studioGate's own definition is checked separately so
// swapping a mount to it doesn't silently stop proving the ordering property.
const TRAINER_GATED = /requireTrainer|studioGate\(/;

describe('every trainer-only router is mounted behind requireTrainer', () => {
  test.each(TRAINER_ONLY)('/api/%s', (name) => {
    const mount = new RegExp(`app\\.use\\('/api/${name}',[^;]*(?:requireTrainer|studioGate\\()[^;]*require\\(`);
    expect(server).toMatch(mount);
  });

  test.each(TRAINER_ONLY)('/api/%s is not mounted without one', (name) => {
    // The failing shape written out, so a reviewer can see exactly what
    // regressed if this goes red.
    const lines = server.split('\n').filter((l) => l.includes(`app.use('/api/${name}'`));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatch(TRAINER_GATED);
  });
});

describe('the gate is ordered so a client learns nothing extra', () => {
  test.each(['attendance', 'communication'])(
    'requireTrainer precedes the feature gate on /api/%s', (name) => {
      const line = server.split('\n').find((l) => l.includes(`app.use('/api/${name}'`));
      expect(line.indexOf('requireTrainer')).toBeLessThan(line.indexOf('gate('));
    },
  );

  test.each(['reports', 'expenses', 'invoices'])(
    'studioGate(key) carries the same ordering on /api/%s', (name) => {
      const line = server.split('\n').find((l) => l.includes(`app.use('/api/${name}'`));
      expect(line).toMatch(/studioGate\(/);
    },
  );

  test('studioGate itself puts requireTrainer before requireFeature', () => {
    const def = server.split('\n').find((l) => l.includes('const studioGate ='));
    expect(def).toBeTruthy();
    expect(def.indexOf('requireTrainer')).toBeLessThan(def.indexOf('requireFeature'));
  });
});

describe('the client portal is unaffected', () => {
  test('/api/me is still mounted for clients, not the trainer', () => {
    // The portal calls exactly one endpoint. Gating the routers above breaks
    // nothing it uses — verified against 619-erp-frontend, where no screen
    // under app/(bare)/member, /client or /member-login references any of them.
    expect(server).toMatch(/app\.use\('\/api\/me',\s*auth,\s*requireClient,/);
  });
});

describe('requireTrainer still means what it says', () => {
  const { requireTrainer } = require('../middleware/rbac');

  const run = (user) => {
    let status = null;
    let passed = false;
    const res = { status: (s) => { status = s; return res; }, json: () => res };
    requireTrainer({ user }, res, () => { passed = true; });
    return { passed, status };
  };

  test('a member is refused', () => {
    expect(run({ role: 'member', organization_id: 'org-1' }))
      .toMatchObject({ passed: false, status: 403 });
  });

  test('the trainer of a studio is admitted', () => {
    expect(run({ role: 'trainer', organization_id: 'org-1' }).passed).toBe(true);
  });

  test.each(['super_admin', 'admin', 'manager', 'reception', 'staff'])('%s is refused', (role) => {
    expect(run({ role, organization_id: role === 'super_admin' ? null : 'org-1' }))
      .toMatchObject({ passed: false, status: 403 });
  });

  test('/api/trainers and /api/leave are not mounted at all', () => {
    // The staff-management surface went with the staff roles.
    expect(server).not.toMatch(/app\.use\('\/api\/(trainers|leave)'/);
  });
});
