'use strict';
// The write paths a studio's own trainers and admins actually use most —
// creating/editing/removing a client, recording/removing a payment, changing
// a trainer's commission — are now audited through activityLog's
// logActivity(), and there's a tenant-scoped way for a studio's own
// admin/manager to read the trail back (GET /activity-log). Pinned
// statically, same reasoning as this repo's other route-convention tests:
// these handlers are large enough that a full integration harness per route
// would be its own project, and what actually matters here — is the call
// present, is it scoped to the tenant, does it fire on the success path —
// is verifiable by reading the source.

const fs = require('fs');
const path = require('path');

const ptOs = fs.readFileSync(
  path.join(__dirname, '..', 'modules', 'pt-os', 'pt-os.routes.js'), 'utf8');
const payments = fs.readFileSync(
  path.join(__dirname, '..', 'routes', 'payments.js'), 'utf8');

describe('client writes are audited', () => {
  it('logs create, update and delete, each with the record\'s own id', () => {
    expect(ptOs).toMatch(/logActivity\(req, 'client\.create', 'pt_client', rows\[0\]\.id/);
    expect(ptOs).toMatch(/logActivity\(req, 'client\.update', 'pt_client', rows\[0\]\.id/);
    expect(ptOs).toMatch(/logActivity\(req, 'client\.delete', 'pt_client', rows\[0\]\.id/);
  });

  it('every logActivity call in this file is awaited, matching the rest of the app\'s convention', () => {
    const calls = [...ptOs.matchAll(/(await )?logActivity\(/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const m of calls) expect(m[1]).toBe('await ');
  });
});

describe('the trainer commission endpoint', () => {
  it('is gone with the staff roles, and so is its payout sibling', () => {
    // Commissions and payouts paid a studio's staff. The studio has one
    // trainer — its owner — so the endpoints were removed rather than kept
    // with nobody to pay.
    expect(ptOs).not.toContain("router.put('/commissions/:trainerId'");
    expect(ptOs).not.toContain("router.post('/payouts'");
  });
});

describe('payment writes are audited', () => {
  it('logs create only after COMMIT — never before, where a later rollback could make the row a lie', () => {
    const create = payments.slice(payments.indexOf("router.post('/', auth"));
    const commitAt = create.indexOf("tx.query('COMMIT')");
    const logAt = create.indexOf("logActivity(req, 'payment.create'");
    expect(commitAt).toBeGreaterThan(-1);
    expect(logAt).toBeGreaterThan(commitAt);
  });

  it('logs the delete on the one ledger it can delete from', () => {
    // Two, until migration 191. The second was the legacy `payments` fallback,
    // which ran when the pt_payments UPDATE matched nothing and carried no
    // organization clause — a cross-tenant delete by id against a populated
    // table, and a no-op against this one, which has been empty since PT-OS
    // shipped. pt_payments is the only ledger now, so there is one delete to
    // audit and it must still be audited.
    const del = payments.slice(payments.indexOf("router.delete('/:id'"));
    const calls = [...del.matchAll(/logActivity\(req, 'payment\.delete'/g)];
    expect(calls.length).toBe(1);
    // And it stays after the COMMIT, for the same reason the create does: a
    // log line written before a rollback is a record of something that did not
    // happen.
    const commitAt = del.indexOf("tx.query('COMMIT')");
    expect(commitAt).toBeGreaterThan(-1);
    expect(del.indexOf("logActivity(req, 'payment.delete'")).toBeGreaterThan(commitAt);
  });

  it('every logActivity call in this file is awaited', () => {
    const calls = [...payments.matchAll(/(await )?logActivity\(/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const m of calls) expect(m[1]).toBe('await ');
  });
});

describe('GET /activity-log — the studio-facing read of the trail', () => {
  const route = ptOs.slice(ptOs.indexOf("router.get('/activity-log'"));
  const body = route.slice(0, route.indexOf('module.exports'));

  it('is the studio trainer\'s only, not open to every signed-in role', () => {
    expect(route.slice(0, route.indexOf('wrap('))).toContain('requireTrainer');
  });

  it('filters to the caller\'s own organization unconditionally — never an optional clause a query param could skip', () => {
    // tenantScope() has no unfiltered case any more, and requireTrainer
    // refuses super_admin outright, so there is no "see everything" path to
    // leave open. The filter is unconditional, not behind an if.
    expect(body).toContain("const where = ['a.organization_id = $1']");
    expect(body).toContain('const params = [scope.orgId]');
    expect(body).not.toMatch(/if \(scope\.applyFilter\)/);
  });

  it('never accepts an org id from the request — only ever the caller\'s own', () => {
    expect(body).not.toMatch(/req\.query\.org(anization)?_id/);
    expect(body).not.toMatch(/req\.body\.org(anization)?_id/);
    expect(body).not.toMatch(/x-org-id/);
  });

  it('paginates rather than returning the whole table', () => {
    expect(body).toContain('LIMIT $');
    expect(body).toContain('OFFSET $');
    expect(body).toMatch(/Math\.min\(Math\.max\(parseInt\(req\.query\.limit/);
  });
});
