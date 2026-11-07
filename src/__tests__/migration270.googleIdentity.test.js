'use strict';
// The migration is applied by hand, so its shape is pinned here. A future
// edit that drops the partial index, forgets the audit outcome, or starts
// destroying data fails before anyone points it at a database.
const fs = require('node:fs');
const path = require('node:path');

const SQL = fs.readFileSync(
  path.join(__dirname, '..', 'db', 'migrations', '270_google_identity.sql'),
  'utf8'
);

it('adds the Google identity columns without a backfill', () => {
  expect(SQL).toMatch(/ALTER TABLE users\s+ADD COLUMN IF NOT EXISTS google_sub TEXT/i);
  expect(SQL).toMatch(/ADD COLUMN IF NOT EXISTS google_linked_at TIMESTAMPTZ/i);
});

it('makes one Google subject linkable to one user only', () => {
  expect(SQL).toMatch(
    /CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_unique\s+ON users \(google_sub\) WHERE google_sub IS NOT NULL/i
  );
});

it('lets login_events store wrong_portal', () => {
  expect(SQL).toMatch(/DROP CONSTRAINT IF EXISTS login_events_outcome_check/i);
  expect(SQL).toMatch(/CHECK \(outcome IN \([^)]*'wrong_portal'\)/i);
});

it('contains no destructive statement', () => {
  expect(SQL).not.toMatch(/\b(DROP TABLE|TRUNCATE|DELETE FROM)\b/i);
});
