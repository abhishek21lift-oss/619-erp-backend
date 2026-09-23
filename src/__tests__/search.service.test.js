'use strict';
// Global search — the pure parts.
//
// Two things here are load-bearing enough to pin down in tests:
//
//   1. scopeClause. This is the ONLY thing standing between a coach and
//      another studio's client list. A regression that makes it emit TRUE for
//      a tenant user is a cross-tenant data leak, and it is exactly the kind of
//      change that looks harmless in a diff.
//
//   2. Input normalisation. LIKE wildcards in user input turn a search into a
//      full table dump, and a pasted "+91 …" number has to find a client whose
//      number is stored bare.
//
// The queries themselves need a database and are exercised through the route.

const {
  escapeLike, normalise, scopeClause, libraryScope, providerTypes, providersFor,
} = require('../modules/search/search.service');

describe('scopeClause — tenant isolation', () => {
  test('a tenant user is pinned to their own organization', () => {
    const params = [];
    const sql = scopeClause({ scope: { applyFilter: true, orgId: 'org-1' }, trainerId: null }, 'c', params);
    expect(sql).toBe('c.organization_id = $1');
    expect(params).toEqual(['org-1']);
  });

  test('a trainer id on the context narrows nothing — the organization is the boundary', () => {
    // The assistant-coach roster filter is gone: the trainer owns the studio.
    const params = [];
    const sql = scopeClause({ scope: { applyFilter: true, orgId: 'org-1' }, trainerId: 'trn-9' }, 'c', params);
    expect(sql).toBe('c.organization_id = $1');
    expect(params).toEqual(['org-1']);
  });

  test('an org-less tenant user matches nothing rather than everything', () => {
    // tenantScope() resolves a user with no organization to orgId=null and
    // still sets applyFilter, so the clause becomes `= NULL`, which is never
    // true. Fail closed.
    const params = [];
    const sql = scopeClause({ scope: { applyFilter: true, orgId: null }, trainerId: null }, 'c', params);
    expect(sql).toBe('c.organization_id = $1');
    expect(params).toEqual([null]);
  });

  test('nobody gets an unfiltered clause — not even a scope that claims "no filter"', () => {
    // There used to be a "TRUE" clause for a platform-wide super admin.
    const params = [];
    const sql = scopeClause({ scope: { applyFilter: false, orgId: null }, trainerId: null }, 'c', params);
    expect(sql).toBe('c.organization_id = $1');
    expect(params).toEqual([null]);
  });

  test('parameter numbering continues from whatever the caller already pushed', () => {
    const params = ['like', 'lower', 'digits'];
    const sql = scopeClause({ scope: { applyFilter: true, orgId: 'org-1' } }, 'c', params);
    expect(sql).toBe('c.organization_id = $4');
  });
});

describe('libraryScope — workout plans and diet templates', () => {
  // Migration 106 gave these tables an organization_id where NULL means
  // "shipped with the product". Getting this wrong in either direction is bad:
  // too strict hides the seeded templates from everyone, too loose exposes one
  // studio's authored programmes to the next.
  test('a studio sees the shared catalogue plus its own', () => {
    const params = ['like', 'lower'];
    const sql = libraryScope({ scope: { applyFilter: true, orgId: 'org-1' } }, 'x', params);
    expect(sql).toBe('(x.organization_id IS NULL OR x.organization_id = $3)');
    expect(params).toEqual(['like', 'lower', 'org-1']);
  });

  test('nobody sees everything: a scope that claims "no filter" still gets shared-plus-own', () => {
    const params = [];
    expect(libraryScope({ scope: { applyFilter: false, orgId: null } }, 'x', params))
      .toBe('(x.organization_id IS NULL OR x.organization_id = $1)');
    expect(params).toEqual([null]);
  });

  test('an org-less user still sees the shared catalogue, and nothing authored', () => {
    // `organization_id = NULL` matches no authored row, so the IS NULL branch
    // is the only one that can be true. Seeded templates stay usable.
    const params = [];
    const sql = libraryScope({ scope: { applyFilter: true, orgId: null } }, 'x', params);
    expect(sql).toBe('(x.organization_id IS NULL OR x.organization_id = $1)');
  });
});

describe('provider visibility', () => {
  const base = (over = {}) => ({
    q: normalise('rahul'), scope: { applyFilter: true, orgId: 'org-1' },
    userId: 'user-1', role: 'trainer', limit: 8, ...over,
  });

  test('clients lead, archived clients follow', () => {
    expect(providerTypes().slice(0, 2)).toEqual(['clients', 'archived_clients']);
  });

  test('the trainer is offered studio broadcasts — the studio is theirs', () => {
    // Withheld from an assistant coach once, because broadcasts had no
    // per-coach owner. The trainer owns the studio, so the group is offered.
    expect(providersFor(base({ role: 'trainer' }))).toContain('messages');
  });

  test('AI conversations need a user to scope to', () => {
    expect(providersFor(base({ userId: null }))).not.toContain('ai_conversations');
    expect(providersFor(base())).toContain('ai_conversations');
  });

  test('two-character queries only reach the cheap, selective groups', () => {
    // "ab" against 890 exercises is an arbitrary slice of the library, not an
    // answer. Same for every record type keyed on a client name.
    const types = providersFor(base({ q: normalise('ab') }));
    expect(types).toContain('clients');
    expect(types).not.toContain('exercises');
    expect(types).not.toContain('archived_clients');
    expect(types).not.toContain('invoices');
  });

  test('a three-character query opens the rest up', () => {
    const types = providersFor(base({ q: normalise('abc') }));
    expect(types).toEqual(expect.arrayContaining([
      'clients', 'archived_clients', 'exercises', 'workout_plans',
      'diet_plans', 'assessments', 'invoices', 'payments',
    ]));
  });
});

describe('escapeLike', () => {
  test('neutralises the LIKE wildcards', () => {
    // Unescaped, "%" alone matches every row in the table.
    expect(escapeLike('%')).toBe('\\%');
    expect(escapeLike('a_b')).toBe('a\\_b');
    expect(escapeLike('100%')).toBe('100\\%');
  });

  test('escapes the escape character itself', () => {
    expect(escapeLike('a\\b')).toBe('a\\\\b');
  });

  test('leaves ordinary text alone', () => {
    expect(escapeLike('rahul sharma')).toBe('rahul sharma');
  });
});

describe('normalise', () => {
  test('trims and lowercases, keeping the raw form for echoing back', () => {
    const q = normalise('  Rahul  ');
    expect(q.raw).toBe('Rahul');
    expect(q.lower).toBe('rahul');
  });

  test('the fuzzy form is NOT escaped — word_similarity is not a pattern match', () => {
    const q = normalise('100%');
    expect(q.like).toBe('100\\%');
    expect(q.lower).toBe('100%');
  });

  test('strips punctuation from phone numbers', () => {
    expect(normalise('98765-43210').digits).toBe('9876543210');
    expect(normalise('98765 43210').digits).toBe('9876543210');
  });

  test('drops a country code so a pasted +91 number finds a bare stored number', () => {
    expect(normalise('+91 98765 43210').digits).toBe('9876543210');
    expect(normalise('+919876543210').digits).toBe('9876543210');
  });

  test('keeps a partial number as typed', () => {
    expect(normalise('9876').digits).toBe('9876');
  });

  test('a name yields no digits, so the phone branch stays switched off', () => {
    expect(normalise('Rahul').digits).toBe('');
  });

  test('caps absurdly long input', () => {
    expect(normalise('a'.repeat(500)).raw).toHaveLength(120);
  });
});
