'use strict';
// Two migrations with the same numeric prefix are a clean-rebuild trap.
//
// The runner applies files in filename order, so a fresh database can apply a
// different order than production did. Production's history is the authority
// and already-applied files must never be renamed, so this is an allowlist,
// not a repair: the numbers below are frozen, and any NEW duplicate fails.
//
// Remove an entry only when both files are known to be interchangeable in
// order, which for migrations is almost never.

const fs = require('fs');
const path = require('path');

const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');

// Prefixes already applied before this guard existed. Do not add to this set.
const KNOWN_DUPLICATES = new Set(['131', '140', '174', '175', '176']);

describe('migration numeric prefixes', () => {
  it('has no duplicate prefix outside the frozen allowlist', () => {
    const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'));
    const byPrefix = new Map();

    for (const file of files) {
      const m = /^(\d+)_/.exec(file);
      if (!m) continue; // non-numbered files are handled by the runner
      if (!byPrefix.has(m[1])) byPrefix.set(m[1], []);
      byPrefix.get(m[1]).push(file);
    }

    const duplicates = [...byPrefix.entries()]
      .filter(([, list]) => list.length > 1)
      .map(([prefix]) => prefix)
      .filter((prefix) => !KNOWN_DUPLICATES.has(prefix));

    expect(duplicates).toEqual([]);
  });

  it('does not let the allowlist rot: every entry is still a real duplicate', () => {
    const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'));
    for (const prefix of KNOWN_DUPLICATES) {
      const matches = files.filter((f) => f.startsWith(`${prefix}_`));
      expect(matches.length).toBeGreaterThan(1);
    }
  });
});
