'use strict';
// The exercise library's rules, tested without a database.
//
// The ones worth pinning down are the ones that are expensive to get wrong:
// who may edit what (a trainer editing another trainer's exercise, or anyone
// editing the shared library that every studio reads), and the slug/keyword
// derivation that search depends on.

jest.mock('../db/pool', () => ({ query: jest.fn(), connect: jest.fn() }));

const svc = require('../modules/exercises/exercises.service');

const admin   = { id: 'u-admin',   role: 'admin' };
const manager = { id: 'u-mgr',     role: 'manager' };
const trainer = { id: 'u-trainer', role: 'trainer' };
const other   = { id: 'u-other',   role: 'trainer' };
const staff   = { id: 'u-staff',   role: 'staff' };
const member  = { id: 'u-member',  role: 'member' };

const ORG = '11111111-1111-1111-1111-111111111111';
const custom = (over = {}) => ({
  id: 'ex-1', name: 'Landmine Squat', organization_id: ORG, created_by: trainer.id, ...over,
});
const shared = (over = {}) => ({
  id: 'ex-lib', name: 'Barbell Squat', organization_id: null, created_by: null, ...over,
});

describe('slugify', () => {
  test('lower-cases, collapses punctuation to single hyphens and trims', () => {
    expect(svc.slugify('Barbell  Bench   Press!')).toBe('barbell-bench-press');
    expect(svc.slugify('619 Deadlift')).toBe('619-deadlift');
    expect(svc.slugify('  Coach Abhishek\'s Bench Variation ')).toBe('coach-abhishek-s-bench-variation');
  });

  test('a name of pure punctuation slugs to empty rather than to junk', () => {
    // create() turns this into a generated fallback; it must not silently
    // become '-' or '---', which would collide across every such name.
    expect(svc.slugify('!!!')).toBe('');
  });
});

describe('canCreate', () => {
  test('admins, managers and trainers may create; staff and members may not', () => {
    expect(svc.canCreate(admin)).toBe(true);
    expect(svc.canCreate(manager)).toBe(true);
    expect(svc.canCreate(trainer)).toBe(true);
    expect(svc.canCreate(staff)).toBe(false);
    expect(svc.canCreate(member)).toBe(false);
    expect(svc.canCreate(undefined)).toBe(false);
  });
});

describe('canModify', () => {
  test('nobody may edit a shared library exercise — it is read by every studio', () => {
    for (const user of [admin, manager, trainer]) {
      const r = svc.canModify(user, shared());
      expect(r.ok).toBe(false);
      expect(r.status).toBe(403);
      expect(r.message).toMatch(/shared library/i);
    }
  });

  test('an admin may edit any of their own studio\'s custom exercises', () => {
    expect(svc.canModify(admin, custom()).ok).toBe(true);
    expect(svc.canModify(manager, custom()).ok).toBe(true);
  });

  test('a trainer may edit only what they created', () => {
    expect(svc.canModify(trainer, custom({ created_by: trainer.id })).ok).toBe(true);
    const denied = svc.canModify(other, custom({ created_by: trainer.id }));
    expect(denied.ok).toBe(false);
    expect(denied.status).toBe(403);
    expect(denied.message).toMatch(/only edit exercises they created/i);
  });

  test('staff are read-only even on their own studio\'s exercises', () => {
    const r = svc.canModify(staff, custom());
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
  });

  test('a missing exercise is a 404, not a 403 — it must not confirm existence', () => {
    const r = svc.canModify(admin, null);
    expect(r).toMatchObject({ ok: false, status: 404 });
  });
});

describe('readPayload', () => {
  test('trims text, blanks become null, numbers are coerced', () => {
    const p = svc.readPayload({
      name: '  Landmine Squat  ', description: '', sets_default: '4', rest_seconds: 'not-a-number',
    });
    expect(p.name).toBe('Landmine Squat');
    expect(p.description).toBeNull();
    expect(p.sets_default).toBe(4);
    expect(p.rest_seconds).toBeNull();
  });

  test('partial mode touches only the keys actually sent', () => {
    const p = svc.readPayload({ name: 'New Name' }, { partial: true });
    expect(p).toEqual({ name: 'New Name' });
    expect('description' in p).toBe(false);
  });

  test('unknown keys are ignored rather than reaching the INSERT', () => {
    const p = svc.readPayload({ name: 'X', is_active: false, id: 'spoofed', organization_id: 'other-org' });
    expect(p.id).toBeUndefined();
    expect(p.organization_id).toBeUndefined();
    expect(p.is_active).toBeUndefined();
  });
});

describe('toArray', () => {
  test('accepts an array or a comma-separated string, de-duplicated case-insensitively', () => {
    expect(svc.toArray(['a', 'b', 'A', ' b '])).toEqual(['a', 'b']);
    expect(svc.toArray('squat, hinge ,squat')).toEqual(['squat', 'hinge']);
    expect(svc.toArray('')).toEqual([]);
    expect(svc.toArray(null)).toBeNull();
  });
});

describe('validate', () => {
  test('a name is required on create and must fit the column', () => {
    expect(svc.validate({}).name).toMatch(/required/i);
    expect(svc.validate({ name: 'x'.repeat(161) }).name).toMatch(/160/);
    expect(svc.validate({ name: 'Fine' }).name).toBeUndefined();
  });

  test('difficulty and muscle_group are checked against what the column allows', () => {
    // The DB has CHECK constraints on both; catching it here turns a 500 into
    // a field-level message.
    expect(svc.validate({ name: 'x', difficulty: 'olympian' }).difficulty).toBeTruthy();
    expect(svc.validate({ name: 'x', difficulty: 'advanced' }).difficulty).toBeUndefined();
    expect(svc.validate({ name: 'x', muscle_group: 'Elbows' }).muscle_group).toBeTruthy();
    // 'Neck' was rejected by the old constraint; migration 141 admits it.
    expect(svc.validate({ name: 'x', muscle_group: 'Neck' }).muscle_group).toBeUndefined();
  });

  test('partial validation does not demand a name that was not being changed', () => {
    expect(svc.validate({ difficulty: 'beginner' }, { partial: true })).toEqual({});
  });
});

describe('buildSearchKeywords', () => {
  test('gathers the facets a trainer would type, lower-cased and de-duplicated', () => {
    const kw = svc.buildSearchKeywords({
      target_muscle: 'Quadriceps', muscle_group: 'Legs', equipment: 'Barbell',
      mechanic: 'compound', force: 'push', category: 'Strength',
      movement_pattern: 'Squat', tags: ['Unilateral', 'quadriceps'],
    });
    expect(kw).toEqual(expect.arrayContaining(['quadriceps', 'legs', 'barbell', 'compound', 'squat', 'unilateral']));
    expect(kw.filter((k) => k === 'quadriceps')).toHaveLength(1);
  });

  test('keeps what the trainer typed themselves', () => {
    const kw = svc.buildSearchKeywords({ muscle_group: 'Legs' }, ['hack squat', 'machine']);
    expect(kw).toEqual(expect.arrayContaining(['hack squat', 'machine', 'legs']));
  });

  test('drops nulls and blanks instead of emitting empty terms', () => {
    const kw = svc.buildSearchKeywords({ target_muscle: null, equipment: '   ', muscle_group: 'Back' });
    expect(kw).toEqual(['back']);
  });
});

describe('uniqueSlug', () => {
  test('returns the plain slug when nothing holds it', async () => {
    const db = { query: jest.fn(async () => ({ rows: [] })) };
    await expect(svc.uniqueSlug(db, 'Landmine Squat')).resolves.toBe('landmine-squat');
  });

  test('walks a numeric suffix past the taken ones', async () => {
    let calls = 0;
    const db = { query: jest.fn(async () => ({ rows: (++calls <= 2) ? [{ '?column?': 1 }] : [] })) };
    await expect(svc.uniqueSlug(db, 'Landmine Squat')).resolves.toBe('landmine-squat-3');
  });

  test('an unnameable exercise still gets a usable slug', async () => {
    const db = { query: jest.fn(async () => ({ rows: [] })) };
    await expect(svc.uniqueSlug(db, '!!!')).resolves.toBe('exercise');
  });
});
