'use strict';
// Phase 6 — the RLS guard in the production-audit preflight.
//
// A role without BYPASSRLS reads zero rows from an RLS-enabled table. That is
// not an error the wrapper can see, so the preflight has to decide from the
// catalog whether the report would be empty for the wrong reason. These are
// the cases that decision covers.

const { rlsHiddenTables } = require('../../scripts/phase6-production-audit');

const table = (over = {}) => ({
  relname: 'pt_clients',
  rowsecurity: true,
  force_row_security: false,
  is_owner: false,
  ...over,
});

describe('rlsHiddenTables', () => {
  test('a SELECT-only role without BYPASSRLS cannot see RLS rows', () => {
    expect(rlsHiddenTables([table()], { superuser: false, bypassrls: false }))
      .toEqual(['pt_clients']);
  });

  test('BYPASSRLS is enough', () => {
    expect(rlsHiddenTables([table()], { superuser: false, bypassrls: true })).toEqual([]);
  });

  test('a superuser is never filtered', () => {
    expect(rlsHiddenTables([table()], { superuser: true, bypassrls: false })).toEqual([]);
  });

  test('a table owner sees everything unless row security is FORCED', () => {
    expect(rlsHiddenTables([table({ is_owner: true })], { superuser: false, bypassrls: false }))
      .toEqual([]);
    expect(rlsHiddenTables([table({ is_owner: true, force_row_security: true })], { superuser: false, bypassrls: false }))
      .toEqual(['pt_clients']);
  });

  test('a table without RLS is always visible', () => {
    expect(rlsHiddenTables([table({ rowsecurity: false })], { superuser: false, bypassrls: false }))
      .toEqual([]);
  });

  test('every hidden table is named, not just the first', () => {
    const hidden = rlsHiddenTables(
      [table(), table({ relname: 'pt_assessments' }), table({ relname: 'pt_goals', rowsecurity: false })],
      { superuser: false, bypassrls: false },
    );
    expect(hidden).toEqual(['pt_clients', 'pt_assessments']);
  });
});
