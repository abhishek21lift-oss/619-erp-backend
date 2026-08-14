#!/usr/bin/env node
'use strict';
// Rebuild personal_records from training history.
//
// Migration 167 copies the old workout log into the training domain but writes
// no records, because whether a lift was a record depends on what the client's
// best was AT THE TIME — a question SQL can only answer by reimplementing
// modules/training/records.js. Two implementations of "is this a PR" is one
// too many, and the one that drifts awards the wrong ones quietly.
//
// So this replays the history through that module. Same Epley cap, same
// lower-is-better set for time and pace, same one-live-record-per-key rule the
// live completion path uses.
//
// ── Why this has to be run ─────────────────────────────────────────────────
//
// Until it does, personal_records is empty for every migrated client, and the
// FIRST session they complete after the cutover reads as a personal record —
// a 60kg squat celebrated by someone whose real best is 140. That is worse
// than showing no records at all, because it is wrong rather than absent.
//
// ── Re-running is safe ─────────────────────────────────────────────────────
//
// Each client's currently-held records are read first, and a candidate only
// writes if it beats what is held. A second run finds the best already there,
// so nothing improves and nothing is written. It converges rather than
// accumulating.
//
// Usage:
//   node scripts/backfill-training-records.js            # do it
//   node scripts/backfill-training-records.js --dry-run  # say what it would do
//   node scripts/backfill-training-records.js --client <id>

const pool = require('../src/db/pool');
const records = require('../src/modules/training/records');

const DRY_RUN = process.argv.includes('--dry-run');
const CLIENT_ARG = (() => {
  const i = process.argv.indexOf('--client');
  return i >= 0 ? process.argv[i + 1] : null;
})();

/**
 * Sessions oldest first, and that ordering is the whole correctness argument:
 * replaying out of order would let a lighter later lift supersede a heavier
 * earlier one, which is exactly the bug the record engine exists to prevent.
 *
 * created_at breaks ties within a day so two sessions on one date replay in
 * the order they happened.
 */
const SESSIONS_SQL = `
  SELECT id, organization_id, client_id, session_date
    FROM training_sessions
   WHERE status = 'COMPLETED'
     AND deleted_at IS NULL
     AND ($1::text IS NULL OR client_id = $1)
   ORDER BY client_id, session_date ASC, created_at ASC
`;

const PERFORMANCES_SQL = `
  SELECT id, exercise_id, exercise_name
    FROM exercise_performances
   WHERE session_id = $1
   ORDER BY order_index ASC
`;

const SETS_SQL = `
  SELECT id, set_number, actual_reps, actual_weight, weight_unit, completed
    FROM set_performances
   WHERE exercise_performance_id = $1
   ORDER BY set_number ASC
`;

const CARDIO_SQL = `
  SELECT * FROM cardio_performances WHERE exercise_performance_id = $1
`;

const HELD_SQL = `
  SELECT record_type, reps, value
    FROM personal_records
   WHERE client_id = $1 AND exercise_id = $2 AND superseded_at IS NULL
`;

/**
 * The replay itself, against any pg handle.
 *
 * Separated from main() so it can be run inside a caller-owned transaction and
 * rolled back — a backfill whose only proof is "we ran it in production and it
 * looked right" is not proven at all. `ownTransaction: false` is for exactly
 * that case: the caller has already opened one, so each write must not open
 * another.
 */
async function backfill({ db = pool, clientId = null, dryRun = false, ownTransaction = true,
  out = process.stdout } = {}) {
  const clients = new Map(); // client_id|exercise_id → Map(recordKey → value)
  const { rows: sessions } = await db.query(SESSIONS_SQL, [clientId]);

  let written = 0;
  let considered = 0;

  for (const session of sessions) {
    const { rows: performances } = await db.query(PERFORMANCES_SQL, [session.id]);

    for (const perf of performances) {
      // A performance with no exercise_id cannot hold a record: records are
      // per movement, and "some exercise that was deleted" is not one.
      if (!perf.exercise_id) continue;

      const { rows: sets } = await db.query(SETS_SQL, [perf.id]);
      const { rows: cardio } = await db.query(CARDIO_SQL, [perf.id]);

      const candidates = [
        ...records.candidatesFromSets(sets),
        ...cardio.flatMap((c) => records.candidatesFromCardio(c)),
      ];
      if (!candidates.length) continue;
      considered += candidates.length;

      // Held records are read once per client+exercise and then maintained in
      // memory. Re-reading per session would be one query per exercise per
      // session, and the in-memory copy is authoritative anyway because this
      // process is the only writer during a backfill.
      const cacheKey = `${session.client_id}|${perf.exercise_id}`;
      if (!clients.has(cacheKey)) {
        const { rows: current } = await db.query(HELD_SQL, [session.client_id, perf.exercise_id]);
        clients.set(cacheKey, new Map(current.map((r) => [
          records.recordKey({ record_type: r.record_type, reps: r.reps }), Number(r.value),
        ])));
      }
      const held = clients.get(cacheKey);

      for (const win of records.selectImprovements(candidates, held)) {
        held.set(records.recordKey(win), Number(win.value));
        written += 1;
        if (dryRun) {
          out.write(
            `  would set ${perf.exercise_name} ${win.record_type} = ${win.value}${win.unit ?? ''}`
            + ` (${session.client_id}, ${session.session_date.toISOString().slice(0, 10)})\n`
          );
          continue;
        }
        await writeRecord(db, session, perf, win, ownTransaction);
      }
    }
  }

  out.write(
    `\n${dryRun ? '[dry run] ' : ''}${sessions.length} completed sessions replayed, `
    + `${considered} candidates considered, ${written} records ${dryRun ? 'would be ' : ''}written.\n`
  );
  return { sessions: sessions.length, considered, written };
}

function main() {
  return backfill({ clientId: CLIENT_ARG, dryRun: DRY_RUN });
}

async function writeRecord(db, session, perf, win, ownTransaction) {
  const client = ownTransaction ? await pool.connect() : db;
  try {
    if (ownTransaction) await client.query('BEGIN');
    // Supersede before inserting: the partial unique index allows exactly one
    // live record per key, so the other order collides.
    await client.query(
      `UPDATE personal_records SET superseded_at = NOW()
        WHERE client_id = $1 AND exercise_id = $2 AND record_type = $3
          AND COALESCE(reps, -1) = COALESCE($4::smallint, -1) AND superseded_at IS NULL`,
      [session.client_id, perf.exercise_id, win.record_type, win.reps ?? null]
    );
    await client.query(
      `INSERT INTO personal_records
         (organization_id, client_id, exercise_id, exercise_name, record_type,
          value, unit, reps, session_id, exercise_performance_id,
          set_performance_id, cardio_performance_id, achieved_on)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [session.organization_id, session.client_id, perf.exercise_id, perf.exercise_name,
        win.record_type, win.value, win.unit ?? null, win.reps ?? null, session.id, perf.id,
        win.set_performance_id ?? null, win.cardio_performance_id ?? null, session.session_date]
    );
    if (ownTransaction) await client.query('COMMIT');
  } catch (err) {
    if (ownTransaction) await client.query('ROLLBACK').catch(() => {});
    else throw err;
    // One unwritable record must not abandon the rest of the history. Named
    // loudly so a run that half-worked cannot be mistaken for one that worked.
    process.stderr.write(
      `  FAILED ${perf.exercise_name} ${win.record_type} for ${session.client_id}: ${err.message}\n`
    );
  } finally {
    if (ownTransaction) client.release();
  }
}

if (require.main === module) {
  main()
    .then(() => pool.end())
    .catch((err) => {
      process.stderr.write(`backfill failed: ${err.stack}\n`);
      pool.end().finally(() => process.exit(1));
    });
}

module.exports = { main, backfill };
