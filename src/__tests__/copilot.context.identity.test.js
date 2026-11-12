'use strict';
// The trainer context engine's first gate: who is calling, which studio, and
// what they may do. Identity comes only from req.user (auth.js reloads it from
// the database); nothing in the body, query or headers may name a tenant.
//
// These are pure resolvers on purpose — no pool, no model, no side effect — so
// the matrix can be asserted without a database.

const {
  ContextError,
  LEVELS,
  clientAccessPolicy,
  resolveIdentity,
  resolveTenant,
  resolvePermissions,
  resolveTrainerContext,
} = require('../modules/copilot/context/trainer-context');

const TRAINER = {
  id: 'user-1',
  name: 'Trainer One',
  role: 'trainer',
  trainer_id: 'tr-1',
  organization_id: 'org-a',
  organization_name: 'Studio A',
};

const req = (user) => ({ user });

describe('resolveIdentity', () => {
  test('reads the authenticated trainer from req.user', () => {
    expect(resolveIdentity(req(TRAINER))).toEqual({
      userId: 'user-1',
      name: 'Trainer One',
      role: 'trainer',
      trainerId: 'tr-1',
    });
  });

  test('refuses an unauthenticated request', () => {
    expect(() => resolveIdentity(req(undefined))).toThrow(ContextError);
    expect(() => resolveIdentity(req(undefined))).toThrow(/not authenticated/i);
  });

  test('refuses a member even if they somehow reach the resolver', () => {
    expect(() => resolveIdentity(req({ ...TRAINER, role: 'member' }))).toThrow(/trainer/i);
  });

  test('refuses the platform operator on the tenant plane', () => {
    expect(() => resolveIdentity(req({ id: 'u', role: 'super_admin' }))).toThrow(ContextError);
  });

  test('a null trainer_id is reported as null, never invented', () => {
    const id = resolveIdentity(req({ ...TRAINER, trainer_id: null }));
    expect(id.trainerId).toBeNull();
  });
});

describe('resolveTenant', () => {
  test('the tenant is the organization on the authenticated user row', () => {
    expect(resolveTenant(req(TRAINER))).toEqual({
      organizationId: 'org-a',
      organizationName: 'Studio A',
    });
  });

  test('an account with no organization resolves to no tenant, not a global view', () => {
    expect(() => resolveTenant(req({ ...TRAINER, organization_id: null })))
      .toThrow(/organization/i);
  });

  test('a body or header organization id cannot override req.user', () => {
    const spoofed = {
      user: TRAINER,
      body: { organization_id: 'org-b' },
      query: { organization_id: 'org-b' },
      headers: { 'x-org-id': 'org-b' },
    };
    expect(resolveTenant(spoofed).organizationId).toBe('org-a');
  });
});

describe('resolvePermissions', () => {
  test('a trainer holds every execution level', () => {
    const p = resolvePermissions({ userId: 'user-1', role: 'trainer', trainerId: 'tr-1' });
    expect(p.levels).toEqual(LEVELS);
    expect(p.levels).toEqual(['READ', 'ANALYZE', 'DRAFT', 'EXECUTE']);
    // EXECUTE is never implied by a read: the approval gate is separate.
    expect(p.executeRequiresApproval).toBe(true);
  });

  test('every other role holds none, even when called directly', () => {
    expect(resolvePermissions({ userId: 'u', role: 'member' }).levels).toEqual([]);
    expect(resolvePermissions({ userId: 'u', role: 'super_admin' }).levels).toEqual([]);
  });
});

describe('client access policy', () => {
  test('defaults to the existing organization-wide visibility', () => {
    expect(clientAccessPolicy({})).toBe('organization_wide');
  });

  test('accepts the explicit assigned-clients-only policy', () => {
    expect(clientAccessPolicy({ COPILOT_CLIENT_ACCESS: 'assigned_clients_only' }))
      .toBe('assigned_clients_only');
  });

  test('an unknown value is a configuration error, not a silent widening', () => {
    expect(() => clientAccessPolicy({ COPILOT_CLIENT_ACCESS: 'assigned_only' }))
      .toThrow(/COPILOT_CLIENT_ACCESS/);
  });
});

describe('resolveTrainerContext', () => {
  test('composes identity, tenant, permissions and the client policy', () => {
    const ctx = resolveTrainerContext(req(TRAINER), { policy: 'organization_wide' });
    expect(ctx.identity.userId).toBe('user-1');
    expect(ctx.tenant.organizationId).toBe('org-a');
    expect(ctx.permissions.levels).toContain('READ');
    expect(ctx.clientAccess.policy).toBe('organization_wide');
  });

  test('the resolved policy cannot be widened by a request field', () => {
    const spoofed = {
      ...req(TRAINER),
      body: { client_access: 'organization_wide' },
    };
    const ctx = resolveTrainerContext(spoofed, { policy: 'assigned_clients_only' });
    expect(ctx.clientAccess.policy).toBe('assigned_clients_only');
  });
});
