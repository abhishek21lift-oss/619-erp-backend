#!/usr/bin/env node
'use strict';
/**
 * What WOULD change if every studio were collapsed to one active trainer.
 *
 * Reports. Changes nothing. There is no migration behind this yet — that is the
 * point: the numbers get looked at before anything is written.
 *
 * ── The rule the conversion has to obey ─────────────────────────────────────
 *
 * A trainers row is never deleted and a historical trainer_id is never
 * rewritten. Both destroy data and neither is reversible:
 *
 *   pt_commissions.trainer_id   ON DELETE CASCADE   (011b:48)
 *   pt_payouts.trainer_id       ON DELETE CASCADE   (011b:71)
 *   leave_requests.trainer_id   ON DELETE CASCADE   (schema.sql:543)
 *
 * so one DELETE takes commission history, payout history and leave records with
 * it, silently. And:
 *
 *   UNIQUE (trainer_id, client_id, month)  on pt_commissions   (011b:60)
 *   UNIQUE (trainer_id, month)             on pt_payouts       (011b:86)
 *
 * so rewriting two coaches' history onto one id collides, and one row of the
 * pair has to be dropped or summed.
 *
 * The conversion therefore ARCHIVES (status='inactive', a value the CHECK
 * already allows) and repoints only what points forward.
 *
 * ── Why this script discovers instead of assuming ───────────────────────────
 *
 * The predicate for "a booking that has not happened yet" was drafted as
 * status='scheduled' AND date >= today. That is an assumption about a status
 * vocabulary nobody has checked. Section 6 below prints the status values that
 * actually exist, per table, with how many are future-dated — so the predicate
 * can be verified against the real data before a migration relies on it. If a
 * status appears there that the plan does not name, the plan is wrong, not the
 * data.
 *
 * Section 7 prints the future-dated rows the conversion would deliberately NOT
 * touch, so "left alone" is a visible decision rather than an omission.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *
 *   ADMIN_DATABASE_URL=postgres://… node scripts/one-trainer-dry-run.js
 *   node scripts/one-trainer-dry-run.js --json     # machine-readable
 *
 * Prefers ADMIN_DATABASE_URL: after the RLS cutover, DATABASE_URL authenticates
 * as app_tenant and a cross-studio report would come back empty — silently,
 * because RLS filters rather than errors. The role it connected as is printed
 * first for exactly that reason.
 */

const { Pool } = require('pg');

const JSON_OUT = process.argv.includes('--json');
const URL = process.env.ADMIN_DATABASE_URL || process.env.DATABASE_URL;

if (!URL) {
  console.error('Set ADMIN_DATABASE_URL (preferred) or DATABASE_URL.');
  process.exit(2);
}

// Same reasoning as db/pool.js: Supabase's pooler chain is not in the system
// trust store. sslmode=disable in the URL means a local throwaway database.
const ssl = /sslmode=disable/.test(URL) ? false : { rejectUnauthorized: false };
const pool = new Pool({ connectionString: URL, ssl, max: 2, statement_timeout: 60000 });

/** Does this table exist? Production has drifted from this repo before. */
async function tableExists(name) {
  const { rows } = await pool.query('SELECT to_regclass($1) IS NOT NULL AS ok', [`public.${name}`]);
  return rows[0].ok;
}

/**
 * Which trainer survives in each studio.
 *
 * Prefer the row an owner's login points at: signup creates the organization,
 * a trainers row, and a role='admin' user linked to it, so that row IS the
 * studio's original trainer. Fall back to the oldest active row. Ties broken by
 * id so two runs agree.
 */
const SURVIVOR_CTE = `
  WITH active AS (
    SELECT t.id, t.organization_id, t.name, t.incentive_rate, t.created_at
      FROM trainers t
     WHERE t.deleted_at IS NULL AND t.status = 'active'
  ),
  owner_linked AS (
    SELECT DISTINCT u.organization_id, u.trainer_id
      FROM users u
     WHERE u.role = 'admin' AND u.deleted_at IS NULL AND u.trainer_id IS NOT NULL
  ),
  survivor AS (
    SELECT DISTINCT ON (a.organization_id)
           a.organization_id,
           a.id   AS trainer_id,
           a.name AS trainer_name,
           (ol.trainer_id IS NOT NULL) AS chosen_by_owner_link
      FROM active a
      LEFT JOIN owner_linked ol
             ON ol.organization_id = a.organization_id AND ol.trainer_id = a.id
     ORDER BY a.organization_id,
              (ol.trainer_id IS NOT NULL) DESC,
              a.created_at ASC,
              a.id ASC
  )`;

async function main() {
  const out = {};

  // ── 0. Who are we connected as ──────────────────────────────────────────
  // A cross-studio report run on the tenant connection after the RLS cutover
  // returns nothing and looks like "no surplus trainers anywhere".
  const role = (await pool.query(`
    SELECT current_user AS role,
           COALESCE((SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user), false) AS bypassrls,
           current_setting('app.org_id', true) AS app_org_id`)).rows[0];
  out.connection = role;

  // ── 1. Per-studio summary ───────────────────────────────────────────────
  const studios = (await pool.query(`${SURVIVOR_CTE}
    SELECT o.id, o.name AS studio,
           (SELECT count(*)::int FROM users u
             WHERE u.organization_id = o.id AND u.role = 'admin' AND u.deleted_at IS NULL) AS owners,
           (SELECT count(*)::int FROM users u
             WHERE u.organization_id = o.id AND u.role = 'trainer' AND u.deleted_at IS NULL) AS trainer_logins,
           (SELECT count(*)::int FROM users u
             WHERE u.organization_id = o.id AND u.role IN ('manager','reception') AND u.deleted_at IS NULL) AS mgr_recep,
           (SELECT count(*)::int FROM trainers t
             WHERE t.organization_id = o.id AND t.deleted_at IS NULL AND t.status = 'active') AS active_trainers,
           (SELECT count(*)::int FROM trainers t
             WHERE t.organization_id = o.id AND t.deleted_at IS NULL AND t.status <> 'active') AS already_inactive,
           s.trainer_id   AS survivor_id,
           s.trainer_name AS survivor,
           s.chosen_by_owner_link,
           (SELECT count(*)::int FROM pt_clients c
             WHERE c.organization_id = o.id AND c.deleted_at IS NULL) AS clients
      FROM organizations o
      LEFT JOIN survivor s ON s.organization_id = o.id
     ORDER BY active_trainers DESC, o.name`)).rows;
  out.studios = studios;

  // ── 2. Who would be archived ────────────────────────────────────────────
  const archived = (await pool.query(`${SURVIVOR_CTE}
    SELECT o.name AS studio, t.id, t.name, t.incentive_rate,
           (SELECT count(*)::int FROM pt_clients c
             WHERE c.trainer_id = t.id AND c.deleted_at IS NULL) AS assigned_clients,
           (SELECT count(*)::int FROM users u
             WHERE u.trainer_id = t.id AND u.role <> 'member' AND u.deleted_at IS NULL) AS staff_logins
      FROM trainers t
      JOIN organizations o ON o.id = t.organization_id
      LEFT JOIN survivor s ON s.organization_id = t.organization_id
     WHERE t.deleted_at IS NULL AND t.status = 'active'
       AND (s.trainer_id IS NULL OR t.id <> s.trainer_id)
     ORDER BY o.name, t.name`)).rows;
  out.would_archive = archived;

  // ── 3. What would be repointed (CURRENT — who is responsible now) ───────
  const current = [];
  const currentSpecs = [
    // Predicates are qualified with the `x` alias: every one of these queries
    // joins `trainers t`, which has its own deleted_at and status.
    ['pt_clients', 'trainer_id', 'x.deleted_at IS NULL', 'assigned client'],
    ['pt_leads', 'trainer_id', 'TRUE', 'lead owner'],
    ['workout_assignments', 'trainer_id', "x.status = 'active'", 'live workout prescription'],
    ['diet_assignments', 'trainer_id', "x.status = 'active'", 'live diet prescription'],
    ['training_assignments', 'trainer_id', "x.status = 'ASSIGNED'", 'live training assignment'],
  ];
  for (const [table, col, pred, what] of currentSpecs) {
    if (!(await tableExists(table))) { current.push({ table, what, rows: null, note: 'table absent' }); continue; }
    const { rows } = await pool.query(`${SURVIVOR_CTE}
      SELECT count(*)::int AS n
        FROM ${table} x
        JOIN trainers t ON t.id = x.${col}
        LEFT JOIN survivor s ON s.organization_id = t.organization_id
       WHERE ${pred} AND t.deleted_at IS NULL AND t.status = 'active'
         AND (s.trainer_id IS NULL OR t.id <> s.trainer_id)`);
    current.push({ table, column: col, what, rows: rows[0].n });
  }
  // users.trainer_id on role='member' rows means "my trainer", not "I am this
  // trainer" (client-login.js:168-184). Same column, two semantics — counted
  // separately because the migration must split on role.
  const memberLinks = (await pool.query(`${SURVIVOR_CTE}
    SELECT count(*)::int AS n
      FROM users u
      JOIN trainers t ON t.id = u.trainer_id
      LEFT JOIN survivor s ON s.organization_id = t.organization_id
     WHERE u.role = 'member' AND u.deleted_at IS NULL
       AND t.deleted_at IS NULL AND t.status = 'active'
       AND (s.trainer_id IS NULL OR t.id <> s.trainer_id)`)).rows[0].n;
  current.push({ table: 'users', column: "trainer_id (role='member')", what: "client's assigned trainer", rows: memberLinks });
  out.would_repoint_current = current;

  // ── 4. Future bookings, under the DRAFT predicate ───────────────────────
  // Draft, not settled: section 6 is what decides whether these predicates are
  // right. Reported here so the two can be compared.
  // Predicates written against each table's own CHECK constraint (§6 prints
  // them), not against a guess. The first draft of this used
  // `completed_at IS NULL` for the two session tables and was wrong twice:
  // a CANCELLED trial also has completed_at NULL, and training_sessions'
  // statuses are uppercase, so ABANDONED would have been swept up as "not yet
  // delivered". Both would have moved dead bookings onto the surviving trainer.
  //
  // class_sessions' `in_progress` is excluded deliberately — a class being
  // taught right now is mid-delivery, not a plan.
  const futureSpecs = [
    ['pt_sessions', 'trainer_id', 'x.session_date', "x.status = 'scheduled' AND x.session_date >= CURRENT_DATE"],
    ['class_sessions', 'instructor_id', 'x.date', "x.status = 'scheduled' AND x.date >= CURRENT_DATE"],
    ['trial_sessions', 'trainer_id', 'x.scheduled_at', "x.status = 'scheduled' AND x.scheduled_at >= now()"],
    ['training_sessions', 'trainer_id', 'x.session_date', "x.status IN ('NOT_STARTED','IN_PROGRESS') AND x.session_date >= CURRENT_DATE"],
  ];
  const future = [];
  for (const [table, col, dateCol, pred] of futureSpecs) {
    if (!(await tableExists(table))) { future.push({ table, rows: null, note: 'table absent' }); continue; }
    const { rows } = await pool.query(`${SURVIVOR_CTE}
      SELECT count(*)::int AS n
        FROM ${table} x
        JOIN trainers t ON t.id = x.${col}
        LEFT JOIN survivor s ON s.organization_id = t.organization_id
       WHERE ${pred} AND t.deleted_at IS NULL AND t.status = 'active'
         AND (s.trainer_id IS NULL OR t.id <> s.trainer_id)`);
    future.push({ table, column: col, date_column: dateCol, predicate: pred, rows: rows[0].n });
  }
  out.would_repoint_future = future;

  // ── 5. What must NOT change ─────────────────────────────────────────────
  // The counts the migration captures before and after. If any of these moves,
  // the conversion has destroyed something.
  const preserved = [];
  for (const [table, col] of [['pt_commissions', 'trainer_id'], ['pt_payouts', 'trainer_id'], ['leave_requests', 'trainer_id'], ['pt_sessions', 'trainer_id'], ['pt_payments', 'trainer_id']]) {
    if (!(await tableExists(table))) { preserved.push({ table, rows: null, note: 'table absent' }); continue; }
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${col} IS NOT NULL`);
    const { rows: arch } = await pool.query(`${SURVIVOR_CTE}
      SELECT count(*)::int AS n
        FROM ${table} x
        JOIN trainers t ON t.id = x.${col}
        LEFT JOIN survivor s ON s.organization_id = t.organization_id
       WHERE t.deleted_at IS NULL AND t.status = 'active'
         AND (s.trainer_id IS NULL OR t.id <> s.trainer_id)`);
    preserved.push({ table, total_rows: rows[0].n, rows_belonging_to_archived: arch[0].n });
  }
  out.must_not_change = preserved;

  // ── 6. The status vocabulary that actually exists ───────────────────────
  // The instruction that produced this section: verify the future-booking
  // statuses rather than assume them. Every distinct value, with how many are
  // future-dated, so an unexpected status cannot hide behind a total.
  // Two different questions, both worth answering. The CHECK constraint says
  // what is POSSIBLE — the authority, and the thing a predicate should be
  // written against. The row counts say what is PRESENT — which is what tells
  // you whether a legal-but-unexpected status is actually out there.
  out.status_constraints = (await pool.query(`
    SELECT c.conrelid::regclass::text AS tbl, pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c
     WHERE c.contype = 'c'
       AND c.conrelid::regclass::text IN ('pt_sessions','class_sessions','trial_sessions','training_sessions')
       AND pg_get_constraintdef(c.oid) ILIKE '%status%'
     ORDER BY 1`)).rows;

  const vocab = [];
  for (const [table, , dateCol] of futureSpecs.map(([t, c, d]) => [t, c, d])) {
    if (!(await tableExists(table))) continue;
    // No join here, so the `x.` qualifier the other sections need is stripped.
    const bare = dateCol.replace(/^x\./, '');
    const futureExpr = bare === 'scheduled_at' ? `${bare} >= now()` : `${bare} >= CURRENT_DATE`;
    const { rows } = await pool.query(`
      SELECT status, count(*)::int AS rows,
             count(*) FILTER (WHERE ${futureExpr})::int AS future_dated,
             count(*) FILTER (WHERE ${bare} IS NULL)::int AS null_date
        FROM ${table} GROUP BY status ORDER BY 2 DESC`);
    for (const r of rows) vocab.push({ table, ...r });
  }
  out.status_vocabulary = vocab;

  // ── 7. Future rows deliberately left alone ──────────────────────────────
  // "Untouched" should be a decision on the page, not an omission nobody
  // noticed. Two kinds: leave_requests, which belongs to a person rather than
  // to a role; and future-dated bookings whose status falls outside the
  // predicate above.
  const untouched = [];
  if (await tableExists('leave_requests')) {
    const { rows } = await pool.query(`${SURVIVOR_CTE}
      SELECT count(*)::int AS n
        FROM leave_requests l
        JOIN trainers t ON t.id = l.trainer_id
        LEFT JOIN survivor s ON s.organization_id = t.organization_id
       WHERE l.to_date >= CURRENT_DATE
         AND t.deleted_at IS NULL AND t.status = 'active'
         AND (s.trainer_id IS NULL OR t.id <> s.trainer_id)`);
    untouched.push({
      table: 'leave_requests', rows: rows[0].n,
      reason: "future or current leave belongs to the person who requested it, not to the studio's trainer role",
    });
  }
  for (const [table, col, dateCol, pred] of futureSpecs) {
    if (!(await tableExists(table))) continue;
    const futureExpr = dateCol.endsWith('scheduled_at') ? `${dateCol} >= now()` : `${dateCol} >= CURRENT_DATE`;
    const { rows } = await pool.query(`${SURVIVOR_CTE}
      SELECT count(*)::int AS n
        FROM ${table} x
        JOIN trainers t ON t.id = x.${col}
        LEFT JOIN survivor s ON s.organization_id = t.organization_id
       WHERE (${futureExpr}) AND NOT (${pred})
         AND t.deleted_at IS NULL AND t.status = 'active'
         AND (s.trainer_id IS NULL OR t.id <> s.trainer_id)`);
    if (rows[0].n > 0) {
      untouched.push({
        table, rows: rows[0].n,
        reason: `future-dated but outside the repoint predicate (${pred}) — see the status vocabulary above`,
      });
    }
  }
  out.deliberately_untouched = untouched;

  return out;
}

function render(o) {
  const line = (s = '') => console.log(s);
  const rule = (c = '─') => line(c.repeat(78));

  rule('━');
  line('ONE TRAINER PER STUDIO — DRY RUN. Nothing was changed.');
  rule('━');
  line();
  line(`Connected as: ${o.connection.role}  (bypassrls=${o.connection.bypassrls})`);
  if (!o.connection.bypassrls) {
    line('  ⚠  This role does NOT bypass RLS. A cross-studio report on the tenant');
    line('     connection returns nothing and looks like "no surplus trainers".');
    line('     Re-run with ADMIN_DATABASE_URL pointed at the owner connection.');
  }
  line();

  rule();
  line('1. STUDIOS');
  rule();
  for (const s of o.studios) {
    const flag = s.owners > 1 ? '  ⚠ more than one owner' : '';
    line(`${s.studio}${flag}`);
    line(`    owners ${s.owners} · trainer logins ${s.trainer_logins} · manager/reception ${s.mgr_recep} · clients ${s.clients}`);
    if (!s.survivor_id) {
      line('    ⚠  NO active trainer — nothing to survive. Look at this studio before proceeding.');
    } else {
      const why = s.chosen_by_owner_link ? "owner's login points at it" : 'oldest active row';
      line(`    active trainers ${s.active_trainers} (already inactive ${s.already_inactive})`);
      line(`    would survive: ${s.survivor}  — ${why}`);
    }
    line();
  }

  rule();
  line('2. WOULD BE ARCHIVED  (status → inactive; row kept, never deleted)');
  rule();
  if (!o.would_archive.length) line('  none — every studio already has at most one active trainer.');
  for (const t of o.would_archive) {
    line(`  ${t.studio} · ${t.name}  rate ${t.incentive_rate} · ${t.assigned_clients} assigned client(s) · ${t.staff_logins} staff login(s)`);
  }
  line();

  rule();
  line('3. WOULD BE REPOINTED — current responsibility');
  rule();
  for (const r of o.would_repoint_current) {
    line(`  ${String(r.rows ?? r.note).padStart(6)}  ${r.table}.${r.column || ''} — ${r.what}`);
  }
  line();

  rule();
  line('4. WOULD BE REPOINTED — future bookings (draft predicate, see §6)');
  rule();
  for (const r of o.would_repoint_future) {
    line(`  ${String(r.rows ?? r.note).padStart(6)}  ${r.table}.${r.column || ''}`);
    if (r.predicate) line(`          WHERE ${r.predicate}`);
  }
  line();

  rule();
  line('5. MUST NOT CHANGE — captured before and after the migration');
  rule();
  for (const r of o.must_not_change) {
    if (r.rows === null) { line(`     —      ${r.table}  (${r.note})`); continue; }
    line(`  ${String(r.total_rows).padStart(6)}  ${r.table}  · ${r.rows_belonging_to_archived} belong to a trainer that would be archived, and stay there`);
  }
  line();

  rule();
  line('6. STATUS VOCABULARY  ← verify the predicate here');
  rule();
  line('  What the CHECK constraints allow (the authority):');
  for (const c of o.status_constraints || []) {
    const m = c.def.match(/ARRAY\[(.*?)\]/);
    const values = (m ? m[1] : c.def).replace(/::text/g, '').replace(/'/g, '');
    line(`      ${c.tbl.padEnd(18)} ${values}`);
  }
  line();
  line('  What the data actually contains:');
  let t = null;
  for (const v of o.status_vocabulary) {
    if (v.table !== t) { t = v.table; line(`  ${t}`); }
    line(`      ${String(v.status).padEnd(16)} ${String(v.rows).padStart(6)} rows · ${v.future_dated} future-dated · ${v.null_date} null date`);
  }
  if (!o.status_vocabulary.length) line('  (no rows in any of the four tables)');
  line();

  rule();
  line('7. FUTURE RECORDS DELIBERATELY LEFT UNTOUCHED');
  rule();
  if (!o.deliberately_untouched.length) line('  none.');
  for (const u of o.deliberately_untouched) {
    line(`  ${String(u.rows).padStart(6)}  ${u.table}`);
    line(`          ${u.reason}`);
  }
  line();
  rule('━');
  line('Read-only. No migration exists yet.');
  rule('━');
}

main()
  .then((o) => {
    if (JSON_OUT) console.log(JSON.stringify(o, null, 2));
    else render(o);
    // Non-zero when something needs a human before any migration is written.
    const noTrainer = o.studios.filter((s) => !s.survivor_id).length;
    const manyOwners = o.studios.filter((s) => s.owners > 1).length;
    return pool.end().then(() => process.exit(noTrainer || manyOwners ? 1 : 0));
  })
  .catch((err) => {
    console.error('dry run failed:', err.message);
    pool.end().then(() => process.exit(2), () => process.exit(2));
  });
