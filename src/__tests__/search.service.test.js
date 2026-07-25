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

const { escapeLike, normalise, scopeClause } = require('../modules/search/search.service');

describe('scopeClause — tenant isolation', () => {
  test('a tenant user is pinned to their own organization', () => {
    const params = [];
    const sql = scopeClause({ scope: { applyFilter: true, orgId: 'org-1' }, trainerId: null }, 'c', params);
    expect(sql).toBe('c.organization_id = $1');
    expect(params).toEqual(['org-1']);
  });

  test('a trainer is pinned to their own roster ON TOP OF their organization', () => {
    const params = [];
    const sql = scopeClause({ scope: { applyFilter: true, orgId: 'org-1' }, trainerId: 'trn-9' }, 'c', params);
    // Both clauses, ANDed — the trainer filter must never replace the org one.
    expect(sql).toBe('c.organization_id = $1 AND c.trainer_id = $2');
    expect(params).toEqual(['org-1', 'trn-9']);
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

  test('only a platform-wide super admin gets an unfiltered clause', () => {
    const params = [];
    const sql = scopeClause({ scope: { applyFilter: false, orgId: null }, trainerId: null }, 'c', params);
    expect(sql).toBe('TRUE');
    expect(params).toEqual([]);
  });

  test('parameter numbering continues from whatever the caller already pushed', () => {
    const params = ['like', 'lower', 'digits'];
    const sql = scopeClause({ scope: { applyFilter: true, orgId: 'org-1' }, trainerId: 'trn-9' }, 'c', params);
    expect(sql).toBe('c.organization_id = $4 AND c.trainer_id = $5');
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
