# Production read-only access request

The client-data integrity programme is verified on a synthetic fixture only.
Every production count in `PHASE4`–`PHASE8` is fixture evidence. To replace it
with fact, one read-only audit run against production is needed.

**Nothing is written. No schema change, no backfill, no migration, no column
drop.** Schema removal stays NO-GO until this audit has run and its counts are
reviewed.

---

## What is requested

| Item | Value |
|---|---|
| Access type | PostgreSQL role, `SELECT` only |
| Duration | One run, revoke after the artifacts are collected |
| Transport | TLS required (`sslmode=require` or stricter) |
| Output | Private directory outside the repository, mode 0700/0600, SHA-256 manifest |
| Credentials | Supplied through env vars only, never committed or printed |

## Role grants

Run as a database owner. Replace `<db>` and the password placeholder.

```sql
CREATE ROLE myptstudio_audit LOGIN PASSWORD '<generated-secret>';
ALTER ROLE myptstudio_audit SET default_transaction_read_only = on;

GRANT CONNECT ON DATABASE <db> TO myptstudio_audit;
GRANT USAGE ON SCHEMA public TO myptstudio_audit;

GRANT SELECT ON
  pt_clients,
  pt_assessments,
  pt_goals,
  weekly_checkins,
  pt_lifestyle_assessments,
  pt_nutrition_assessments,
  pt_parq_forms,
  pt_client_interviews,
  pt_consent_records,
  pt_informed_consents,
  pt_mobility_performance_assessments,
  strength_logs,
  pt_os_measurements,
  client_fitness_profiles
TO myptstudio_audit;
```

`information_schema` and `pg_catalog` are read by default; no grant needed.
Revoke with `DROP ROLE myptstudio_audit;` after the run.

## The command

```bash
node scripts/phase6-production-audit.js \
  --url "$PRODUCTION_READ_ONLY_DATABASE_URL" \
  --confirm-host <production-db-host> \
  --acknowledge-production \
  --out-dir /secure/audits/619-phase6
```

The wrapper refuses to run unless the host matches exactly and
`--acknowledge-production` is present. Its preflight session is
`BEGIN TRANSACTION READ ONLY ISOLATION LEVEL REPEATABLE READ`, and the analyzer
child runs with `default_transaction_read_only=on`. Plaintext transport to a
non-loopback host is refused.

Exit codes: `0` audit complete, `1` validation or audit failure, `2` usage or
security refusal.

## What the run produces

- The D1–D25 ownership reconciliation report, read-only.
- A conflict register covering every conflicting record, each with a blank
  decision field. Conflicts are never auto-overwritten.
- A backfill packet listing the exact-mapped `legacy_only` candidates. They are
  listed, not applied.
- A column-complete audit of `pt_os_measurements` and
  `client_fitness_profiles`, including per-column population counts.
- A SHA-256 manifest over every artifact.

## What happens next, and who decides

| Output | Decision owner |
|---|---|
| Conflict register | A named reviewer decides each record; no default |
| Backfill packet | Explicit authorization required; nothing is applied automatically |
| Ownerless measurement columns | Product decision per column, informed by the population counts |
| Schema removal | Stays NO-GO until the above are resolved |

## If a role cannot be issued

Two alternatives, in order of preference:

1. A logical dump of the 14 tables above, restored to an isolated instance and
   audited there. The wrapper accepts any Postgres URL.
2. A read-only replica connection with the same grants.

A dump is raw client data. It must be handled under the same rules as
production: encrypted at rest, deleted after the audit, never copied into the
repository. The backup/restore drill in `PHASE6-BACKUP-ROLLBACK-RUNBOOK.md`
shows the expected shape and timings.
