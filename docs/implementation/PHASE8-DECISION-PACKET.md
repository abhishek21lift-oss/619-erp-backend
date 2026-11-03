# Phase 8 — decision packet

The code is shipped. Five decisions remain, and each one is blocked on the
same input: a read-only run against real production data. This packet is what
a reviewer needs on the day, with every step rehearsed end to end against the
restored backup.

**Rehearsal** (2026-11-03, `phase6_restore_drill`, a restore of the same dump
the backup workflow produces):

```
node scripts/phase6-production-audit.js \
  --url 'postgres://…/phase6_restore_drill?sslmode=disable' \
  --confirm-host 127.0.0.1 --acknowledge-production \
  --out-dir /tmp/opencode/phase6-rehearsal

Legacy-only: 981 · Conflicting: 628 · Records: 1609
Column audit: 432 rows, 3348 cells, 1512 facts
  531 match · 549 conflict · 432 legacy-only · 0 ownerless
Backfill candidates: 27 (not applied)
Schema removal: NO-GO
```

Every number below is from that rehearsal. They prove the pipeline works and
the commands are correct; they are **not** production counts and must not be
used as evidence about real clients.

---

## 1. Production read-only access

- Request: `docs/implementation/PHASE6-PRODUCTION-ACCESS-REQUEST.md`
- Ready-to-run grants: `scripts/phase6-access-grants.sql` (14 tables, SELECT
  only, `BYPASSRLS`, transaction read-only, revoke statement included)
- Blocked on: a named DBA or owner to approve the role.

**Rehearsal finding.** The first version of the grant was plain `SELECT`. Run
as that role, the audit completed and printed `0 legacy-only, 0 conflicting,
0 records` — because 163 tables have row-level security enabled, and a role
without `BYPASSRLS` sees an empty database. The schema gate then printed
`ELIGIBLE_FOR_REVIEW`. That is the worst possible failure: a clean-looking
report that would license deleting columns that still hold production data.
The grant now includes `BYPASSRLS`, and `phase6-production-audit.js` refuses to
run when RLS would hide rows, naming the affected tables.

Nothing else in this packet can start until this exists.

## 2. The 628 conflicts

The register is a CSV with one row per conflicting record and a blank
`decision` column. Blank is not consent; conflicts are never auto-overwritten.

Batch structure in the rehearsal:

| Check | Field | Conflicts |
|---|---|---:|
| D3 | Height / weight / BMI | 52 |
| D4 | Goal | 52 |
| D5 | Health conditions | 52 |
| D6 | Injuries | 52 |
| D7 | Workout experience | 52 |
| D8 | Occupation | 52 |
| D9 | Screen time | 52 |
| D11 | Smoking | 52 |
| D12 | Alcohol | 52 |
| D17 | Training days | 52 |
| D22 | Workout experience in programming | 52 |
| D24 | `pt_clients.occupation` | 52 |
| D20 | Consent attestations | 2 |
| D19 | 1RM | 1 |
| D21 | Medical clearance | 1 |

Twelve fields carry 52 conflicts each. That is a **field-level policy decision
with per-record exceptions**, not 628 independent decisions. A reviewer states,
per field, which side wins by default; the CSV is then filtered for the
exceptions. If the distribution holds in production, this is one sitting, not
a project.

Produce the register: `node scripts/phase6-decisions.js --report <report.json>
--plan <plan.json> --out-dir <dir>`.

## 3. The 27 backfill candidates

All 27 are the same field: `pt_goals.motivation_level`, where the owner row
exists, the column is NULL, and exactly one legacy source supplies a value.
One decision covers all of them.

Dry run, rehearsed:

```
node scripts/phase5-apply-reconciliation.js --plan <plan.json> --url <db>
# DRY RUN (no writes)
# Approved candidates: 0
# Pending review (not applied): 27
# Would change / changed: 0
```

To apply, a reviewer edits the plan (`"decision": "backfill"` per approved
row) and runs with `--apply --confirm <sha256> --reviewer <name>`. The script
re-reads every owner field inside the transaction and aborts the whole run if
it is no longer NULL, so a conflict that appeared after review cannot be
overwritten.

## 4. The seven ownerless measurement columns

`pt_os_measurements` has seven columns with no canonical owner. They are
retained, read-only, undecided. Fixture population is 0 for all seven, so no
decision is urgent — but a populated column is a schema-removal blocker.

| Column | Reader today | Fixture populated | Decision |
|---|---|---:|---|
| `assignment_id` | none | 0 | |
| `shoulders_cm` | member measurement view | 0 | |
| `photo_front_url` | none | 0 | |
| `photo_side_url` | none | 0 | |
| `photo_back_url` | none | 0 | |
| `notes` | none | 0 | |
| `measured_by` | none | 0 | |

`shoulders_cm` is the only one with a live reader. Dropping it is a visible
product change even when no row holds a value, because the field exists in the
member view.

Production counts come from `phase7-summary.json` in the audit run.

## 5. The schema-removal gate

The gate is not a judgement call. It prints its own reasons and flips only
when each one clears:

- [ ] 981 legacy-only records still hold data absent from the owner
- [ ] 628 conflicting records need a named reviewer decision
- [ ] 27 Phase 5 backfill candidates remain unapplied
- [ ] 432 populated legacy column cells exist only in a retired table
- [ ] 549 populated legacy column cells conflict with the canonical owner

Re-run the audit after each decision round; the gate recomputes. Schema
removal is **NO-GO** until the output says otherwise and a human signs it.

## 6. Point-in-time recovery

There is a nightly logical dump (`backup.yml`, 02:30 UTC, off-site upload),
so the current RPO is **up to 24 hours** and the RTO is the restore drill's
12.8 s for 1.1 MiB. There is no PITR: the Supabase organisation is on the free
plan, which offers neither automated backups nor PITR.

That is a purchasing decision, not an engineering one:

- **Pro plan** — enables PITR measured in minutes, and removes the single-copy
  exposure described in `DISASTER-RECOVERY.md`.
- **Stay on free** — accept a 24-hour RPO, keep the nightly dump, and run the
  restore rehearsal on a schedule so the dump is proven rather than assumed.

Either way, the nightly dump remains the last line of defence and should stay
scheduled.

---

## Order of work

1. Approve access → run the audit → replace every number in this packet.
2. Decide the 12 field policies → resolve the exceptions.
3. Approve or reject `pt_goals.motivation_level` → apply or discard.
4. Count the seven ownerless columns → decide per column.
5. Re-run the gate → record the schema verdict.
6. Decide PITR.

Steps 2–6 each produce a line in the Phase 8 report; none of them require a
code change.
