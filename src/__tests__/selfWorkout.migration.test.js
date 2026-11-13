'use strict';
// 284_trainer_controlled_self_workout.sql — the trainer's permission, the
// server-side in-progress member session, the prescription snapshot and the
// review state.
//
// Pinned as static SQL, like booking.migration.test.js: the migration runner is
// not part of this suite, so the file itself is the contract.

const fs = require('fs');
const path = require('path');

const MIGRATION = path.join(__dirname, '..', 'db', 'migrations', '284_trainer_controlled_self_workout.sql');
const sql = fs.readFileSync(MIGRATION, 'utf8');
// Comments stripped and whitespace collapsed: column alignment is not a fact
// this test pins.
const body = sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ');

describe('284_trainer_controlled_self_workout.sql', () => {
  it('is read, so nothing below can pass vacuously', () => {
    expect(sql.length).toBeGreaterThan(500);
  });

  it('adds the permission OFF by default', () => {
    expect(body).toMatch(
      /ALTER TABLE pt_clients ADD COLUMN IF NOT EXISTS allow_self_workout BOOLEAN NOT NULL DEFAULT FALSE/i
    );
  });

  it('adds the session lifecycle and snapshot columns', () => {
    for (const column of [
      'prescribed JSONB',
      'draft JSONB',
      'started_at TIMESTAMPTZ',
      'submitted_at TIMESTAMPTZ',
      'review_status TEXT',
      'reviewed_at TIMESTAMPTZ',
      'review_feedback TEXT',
    ]) {
      expect(body).toContain(`ADD COLUMN IF NOT EXISTS ${column}`);
    }
    expect(body).toMatch(/reviewed_by TEXT REFERENCES users\(id\) ON DELETE SET NULL/i);
    expect(body).toMatch(/prescribed_index INTEGER/i);
  });

  it('pins the review states and refuses review on studio sessions', () => {
    expect(body).toMatch(
      /review_status IS NULL OR review_status IN \('pending', 'approved', 'changes_requested'\)/
    );
    expect(body).toMatch(/review_status IS NULL OR source = 'member'/);
  });

  it('indexes the pending review queue by studio', () => {
    expect(body).toMatch(
      /CREATE INDEX IF NOT EXISTS workout_sessions_pending_review_idx ON workout_sessions \(organization_id, submitted_at DESC\) WHERE review_status = 'pending'/
    );
  });

  it('allows only one open member session per client', () => {
    expect(body).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS workout_sessions_one_open_member_idx ON workout_sessions \(client_id\) WHERE source = 'member' AND status = 'in_progress'/
    );
  });

  it('is additive: no table is dropped, truncated or emptied', () => {
    expect(body).not.toMatch(/DROP TABLE|TRUNCATE|DELETE FROM/i);
    expect(body).not.toMatch(/\bBEGIN\b|\bCOMMIT\b/i);
  });
});
