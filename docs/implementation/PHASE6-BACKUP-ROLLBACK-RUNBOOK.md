# Phase 6 — Backup, migration and rollback runbook

| Field | Value |
|---|---|
| Applies to | The D1–D25 legacy register (`pt_clients` fallbacks, `client_fitness_profiles`, `pt_os_measurements`) |
| Status | Procedure only. No production migration, backfill, column drop or table drop was executed. |
| Owner | Release manager, with a named reviewer for any data decision |
| Last reviewed | 2026-11-03 |

This runbook is the operational half of the Phase 6 readiness report. It
answers the question a schema-removal approval has to answer before anyone
types `ALTER TABLE`: **what do we take first, what is reversible, how do we
undo it, and what evidence proves the undo worked?**

Read `docs/DISASTER-RECOVERY.md` first. The project is on the Supabase free
plan: there is no automated daily backup and no point-in-time recovery. A
backup taken for this change is the only restore point, and it is a logical
dump, not PITR. That is a real limitation, not a footnote.

---

## 1. Non-negotiables

- No production write without an explicit, named authorization. The Phase 6
  audit wrapper and Phase 5 report are read-only and do not authorize a write.
- No column or table drop in the same release that stops reading it. Retire
  reads first, observe, then drop in a separate change.
- No backfill of a conflicting record. Only a `legacy_only` row whose owner
  field is NULL and whose value comes from exactly one legacy source can be
  proposed, and even that requires a reviewer to approve the plan hash.
- Every destructive step has a verified backup and a restore drill. "The dump
  exists" is not the same as "the dump restores".
- Every production step has a stop condition and a named person who can call
  it.

---

## 2. Roles and preconditions

| Role | Responsibility |
|---|---|
| Release manager | Owns the window, the backup, the go/no-go call and the rollback decision |
| Data reviewer | Reads the conflict register and signs each approved backfill |
| Database operator | Runs the audit and any approved SQL; never approves their own write |
| Observer | Watches the post-change checks and records evidence |

Before the window:

1. `node scripts/phase6-production-audit.js ...` has completed against the
   target and its `manifest.json` says `mode: read-only`,
   `transaction_read_only: on`, `validation.ok: true`.
2. The decision register contains one row per conflict and the candidate
   packet says `Authorization: NOT GRANTED` until the reviewer signs.
3. The ownership guard passes on the exact release commit:
   `node scripts/phase6-ownership-guard.js`.
4. The full regression suite, real-DB suites, tenant isolation, `tsc` and
   ESLint pass on that commit (see the Phase 6 report for the evidence set).
5. The backup below has been taken **after** the release commit is frozen and
   **before** any SQL runs.

---

## 3. Backup procedure

### 3.1 Take the dump

The existing backup script is the supported path. It refuses to write inside
the repository, verifies the archive with `pg_restore -l`, and redacts the
connection string.

```bash
export BACKUP_DATABASE_URL='<owner connection, not app_tenant>'
export BACKUP_DIR=/var/backups/619
export BACKUP_RETAIN_DAYS=30

node scripts/backup-database.js
```

If the R2 credentials are present, set `BACKUP_UPLOAD=1` so the dump leaves
the host. A backup on the same disk as the database is not an off-site backup.

Record the output filename and checksum in the change ticket:

```bash
sha256sum "$BACKUP_DIR"/619-erp-*.dump | tail -1
```

### 3.2 Prove it restores

Do not skip this step because the dump command exited zero. Restore into a
throwaway, empty database on a non-production host:

```bash
createdb -h 127.0.0.1 -p 5432 phase6_restore_drill

node scripts/restore-drill.js \
  "$BACKUP_DIR/619-erp-<stamp>.dump" \
  'postgres://postgres@127.0.0.1:5432/phase6_restore_drill?sslmode=disable' \
  --compare "$BACKUP_DATABASE_URL"
```

The drill refuses a managed production host and a non-empty target. With
`--compare`, every `public` table's row count must match the source, except
`platform_backup_status` (written after the dump by construction).

Record: dump size, table count, mismatches (must be zero), drill duration.
Drop the drill database afterwards.

### 3.3 What this backup cannot do

- It cannot recover changes made after the dump. The RPO is the dump time.
- It cannot restore a single row without a selective `pg_restore` and manual
  reconciliation, which is why a destructive change is a last resort.
- It does not replace PITR. If the change is high-risk, move the project to a
  plan with PITR before the window, or accept the RPO in writing.

---

## 4. Read-only production audit

The only supported production entry point is:

```bash
node scripts/phase6-production-audit.js \
  --url "$PRODUCTION_READ_ONLY_DATABASE_URL" \
  --confirm-host db.example.com \
  --acknowledge-production \
  --out-dir /secure/audits/619-phase6
```

What it enforces:

- `--acknowledge-production` and an exact `--confirm-host` match before a
  connection opens.
- TLS for a non-loopback host; `sslmode=disable` needs `--allow-no-tls` and a
  written reason.
- `BEGIN TRANSACTION READ ONLY ISOLATION LEVEL REPEATABLE READ` in the
  preflight, and `default_transaction_read_only=on` for the analyzer child.
- Eight expected tables must exist, so a wrong or empty database fails before
  producing a false zero-count report.
- Output outside the repository, run directory `0700`, every artifact `0600`,
  `manifest.json` and `SHA256SUMS` for evidence.

Handling the output: it contains client names and health facts
(`contains_pii: true`). Keep it on the restricted audit volume, share only the
redacted counts and the decision register, and delete it under the retention
policy after the decisions are recorded. Never commit it.

If the manifest says `schema_removal.decision: NO-GO`, stop. The counts are the
reason, and no amount of code cleanup changes them.

---

## 5. Backfill authorization (the 27 candidates)

The Phase 6 packet lists the candidates; it does not approve them.

1. Reviewer reads each row in `backfill-candidates.csv` against the client
   record and the legacy source.
2. Reviewer copies the plan, sets `"decision": "backfill"` only on approved
   rows, and records their name and the reason in the change ticket.
3. Operator runs the Phase 5 workflow **without** `--apply` first. This is a
   dry run that still re-reads every owner row and refuses a non-NULL field.
4. Operator computes the edited plan's sha256 and runs:

   ```bash
   node scripts/phase5-apply-reconciliation.js \
     --url "$DATABASE_URL" \
     --plan approved-plan.json \
     --apply \
     --confirm <sha256-of-approved-plan.json> \
     --reviewer "<reviewer name>"
   ```

5. Verify one `audit_log` row per change with
   `action = 'legacy_reconciliation_backfill'`, the plan hash and the reviewer.
6. Re-run the production audit. The candidate count must fall by exactly the
   number applied, and no conflict may change.

Stop conditions: any owner field is no longer NULL, any plan hash differs, any
candidate is not `legacy_only`, or any write touches a non-allowlisted column.
The apply script aborts the whole run on any of these.

---

## 6. Schema-removal sequence

This is an expand/contract sequence. Each stage is a separate release and a
separate go/no-go. The Phase 6 verdict is **NO-GO** for starting stage 2.

### Stage 0 — Evidence (current)

- Production audit complete, zero legacy-only facts, every conflict decided
  and recorded, candidates either applied with audit rows or explicitly
  rejected, and the ownership guard green.
- If any of those is false, stop. You are here today.

### Stage 1 — Stop reads (code only)

- Remove each legacy read from the baseline only after the code no longer
  contains it. The guard fails on a stale baseline entry, so this is enforced.
- Deploy the code. Observe for an agreed period (suggested: 14 days) with the
  legacy columns still present.
- Rollback: redeploy the previous image. No schema change, no data loss.

### Stage 2 — Drop the retired tables (separate migration)

Only for `pt_os_measurements` and `client_fitness_profiles`, and only after
Stage 1 has been observed.

- Take and verify a fresh backup (section 3).
- Create the drop migration with `IF EXISTS`, one table per statement, in a
  transaction with a lock timeout.
- Deploy in a low-traffic window with the previous image ready.
- Rollback: restore the table from the dump with `pg_restore --table`, or
  restore the full dump into a new database and reconcile. This is not a
  code-only rollback; treat it as a data incident.

### Stage 3 — Drop legacy columns (separate migration)

Only for the `pt_clients` fallback columns and duplicate columns in the
assessment tables. Column drops are not reversible by redeploying code.

- Take and verify a fresh backup.
- Generate the migration from the final guard baseline, not by hand. The
  baseline is the list of reads that were removed; the columns left in it are
  the ones that must stay.
- Add the migration with `DROP COLUMN IF EXISTS`, one column per statement.
- Deploy in a window. Watch error rates and the guard.
- Rollback: restore the affected columns from the dump, or run a forward fix
  that re-adds them as nullable and repopulates from the dump. Do not promise
  an instant down-migration; there is none.

### Stage 4 — Remove the baseline

- When the guard has no legacy entries and the audit has zero legacy-only
  facts for a full observation period, delete the baseline entries and the
  legacy read code. The guard file becomes a smaller, honest list.
- Keep the Phase 6 report and the audit manifest as the historical evidence.

---

## 7. Reversibility matrix

| Object | Current state | Code rollback | Data rollback | Notes |
|---|---|---|---|---|
| `pt_clients.weight/height` | Written only by the Fitness Testing cache sync | Redeploy previous image | Restore from dump | The cache is derivable from `pt_assessments`; a lost cache can be rebuilt from the newest owned test. |
| `pt_clients.goal` | Read fallback, no writer on the client update path | Redeploy previous image | Restore from dump | Do not drop until the audit shows no client depends on the text. |
| `pt_clients.health_conditions/injuries/occupation` | Read fallback, moved-field writes refused with 422 | Redeploy previous image | Restore from dump | Free text cannot be mapped mechanically; each row needs a reviewer if it is the only copy. |
| `client_fitness_profiles` | No writer; read fallback in AI/diet/generator | Redeploy previous image | `pg_restore --table` or full restore | Retention is the only reason it is still read. |
| `pt_os_measurements` | No writer and no migration definition; read fallback | Redeploy previous image | `pg_restore --table` or full restore | The column set is unverified; read only the columns already read in production. |
| `pt_lifestyle_assessments.motivation_to_exercise` | Stop-write, read by the reconciliation report | Redeploy previous image | Restore from dump | D25 owner is `pt_goals.motivation_level`; 27 candidates remain unapplied. |
| Duplicate lifestyle/nutrition columns | Stop-write, readable fallback | Redeploy previous image | Restore from dump | The matrix §D8–D16 is the authority for which column owns each fact. |

---

## 8. Rollback procedure

### 8.1 Code-only rollback (no schema change)

1. Stop the rollout.
2. Run the existing `Rollback Backend` workflow with the last known-good SHA
   and type `ROLLBACK`.
3. Confirm the health endpoint and the ownership guard on the deployed commit.
4. Re-run the read-only audit against the same target and compare the counts
   with the pre-change manifest. Counts that moved without a write are a
   signal, not noise.

### 8.2 Data rollback (a destructive change ran)

1. Declare a data incident. Stop writes if the application can be paused.
2. Preserve the current database (take a dump before restoring over anything).
3. Restore the verified pre-change dump into a **new** database.
4. Compare row counts and the D1–D25 aggregates between the new database and
   the pre-change manifest.
5. Point the application at the restored database only after the comparison
   matches, or perform a selective restore into the live database with a
   second reviewer watching.
6. Re-run the audit and record the new manifest. Do not declare recovery from
   a successful `pg_restore` exit code alone.

### 8.3 Selective restore of one retired table

```bash
pg_restore --no-owner --no-privileges \
  --table=client_fitness_profiles \
  -d "$RESTORE_DATABASE_URL" \
  "$BACKUP_DIR/619-erp-<stamp>.dump"
```

Then reconcile: the restored table is a snapshot, not a merge. Any row written
after the dump is absent, and any row changed after the dump is stale.

---

## 9. Post-change verification

Run all of these and attach the output to the change ticket:

```bash
node scripts/phase6-ownership-guard.js
node scripts/phase6-production-audit.js --url "$READ_ONLY_URL" \
  --confirm-host <host> --acknowledge-production --out-dir /secure/audits/post-change

# Real-DB and isolation suites (see the Phase 6 report for the exact commands)
PHASE4_SHAPE_DATABASE_URL=... npx jest productionShape.phase4 phase5Reconciliation phase6ProductionAudit --runInBand
RLS_TEST_DATABASE_URL=... npx jest rls.isolation.integration clientPortal.realDb --runInBand
```

The change is complete only when the post-change manifest's counts match the
expected delta: candidates applied, conflicts unchanged, no new legacy-only
rows. "The tests passed" is not the acceptance criterion for a data change.

---

## 10. Approval record

Copy this block into the change ticket and fill it before the window:

```text
Release commit:
Audit manifest sha256:
Backup file + sha256:
Restore drill result (tables / mismatches / duration):
Decision register reviewed by:
Candidates approved (plan sha256):
Candidates rejected (reason):
Schema stage (0/1/2/3/4):
Window start / end:
Rollback authority:
Stop conditions acknowledged: yes/no
```

No approval record, no destructive change.
