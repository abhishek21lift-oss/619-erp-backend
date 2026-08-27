# Disaster recovery

**Read the first section before relying on anything here.** The headline
finding is not a procedure gap — it is that, at the time of writing, this
platform has **no automated database backup of any kind**.

---

## 1. Current posture, verified

| | |
|---|---|
| **Database provider** | Supabase — project `619-erp` (`adffjnztzrolibtuvhgc`), region `ap-south-1` |
| **Engine** | PostgreSQL 17.6.1.105 (`ga` channel), ~185 tables in `public` |
| **Organisation plan** | **Free** (`abhishek21lift-oss's Org`, `zelxmktqtqwvwibkczoz`) |
| **Automated daily backups** | **None.** Supabase backs up Pro/Team/Enterprise projects only |
| **Point-in-Time Recovery** | **Not available.** PITR is a paid add-on above the free plan |
| **Backup retention** | **n/a — nothing is being retained** |
| **Effective RPO today** | **Total loss.** There is no restore point |
| **Effective RTO today** | **Unbounded.** There is nothing to restore from |

Verified two ways rather than assumed:

- The Supabase Management API reports the organisation's `plan` as `free`.
- Supabase's own documentation
  ([platform/backups](https://supabase.com/docs/guides/platform/backups)):
  *"We automatically back up all Pro, Team, and Enterprise Plan projects on a
  daily basis… We recommend that free tier plan projects regularly export
  their data using the Supabase CLI `db dump` command and maintain off-site
  backups."*

And the repository provided no substitute: a search for `pg_dump`,
`pg_restore` or any backup tooling across `scripts/`, `infra/`, `.github/`,
`Dockerfile` and `docker-compose.yml` returned nothing before this change.

### What that means concretely

Six live studios' production data — clients, payments, invoices, attendance,
assessments, signed consents, the exercise library — currently exists in
exactly one place. A dropped table, a bad migration, a mistaken
`DELETE`, a compromised credential (see
`SECURITY-INCIDENT-superadmin-credential.md`), or Supabase losing the project
takes all of it, permanently.

Two related free-plan behaviours worth knowing:

- **Free projects pause after inactivity.** The organisation's second project,
  `Attendance` (`qtxvrivxoxibcvbtqwfk`), is already `INACTIVE` for this reason.
  A paused project is recoverable, but it is an outage.
- **Deleting a project destroys its backups too**, irreversibly, on every plan.

### The real fix

**Move the organisation to the Pro plan and enable PITR.** That buys daily
backups with 7-day retention and, with the PITR add-on, recovery to a point
measured in minutes. Everything below is a stopgap that narrows the exposure;
it does not close it, and it should not be treated as making the free plan
adequate for production.

---

## 2. The stopgap: `scripts/backup-database.js`

A logical `pg_dump` you schedule yourself. Added by this remediation because
having *something* restorable beats having nothing while the plan question is
decided.

```bash
# Nightly, on a host that can reach the database.
DATABASE_URL='<production connection string>' \
BACKUP_DIR=/var/backups/619 \
BACKUP_UPLOAD=1 \
BACKUP_RETAIN_DAYS=30 \
  node scripts/backup-database.js
```

What it does, and why each part is there:

- **`pg_dump -Fc`** — custom format: compressed, and `pg_restore` can extract a
  single table from it, which is what a partial recovery actually needs.
- **`--no-owner --no-privileges`** — Supabase's roles do not exist on the
  machine you restore onto. Without these, a restore fails for reasons that
  have nothing to do with your data.
- **Refuses to write inside the repository.** A dump is a complete copy of
  every studio's data; one `git add -A` in a working tree that has been public
  is how it gets published. The script exits rather than warns.
- **Verifies before reporting success.** It checks the file size, reads the
  archive's table of contents back with `pg_restore -l`, and fails if fewer
  than 50 tables carry data. A truncated dump that nobody opens until the day
  they need it is worse than no dump, because it is trusted.
- **Optional R2 upload** using the app's existing `R2_*` credentials, into a
  separate `db-backups` bucket by default — file storage is served to users,
  and a database dump should not be one misconfigured policy away from public.
- **Never prints a credential.** The connection string is redacted in output.

### Scheduling it

Either a cron entry on the VPS that already runs the API:

```cron
# 02:30 daily. Environment comes from the file, not from this line.
30 2 * * * . /etc/619-backup.env && /usr/bin/node /opt/myptstudio/619-erp-backend/scripts/backup-database.js >> /var/log/619-backup.log 2>&1
```

or a systemd timer, or a scheduled GitHub Action using repository secrets.
Wherever it runs, **`DATABASE_URL` and the `R2_*` values come from the
environment, never from a file in the repository.**

Non-zero exit on any failure, so cron mail or the timer's status surfaces it.
A backup job that fails silently for six weeks is the failure mode this is
guarding against, so check that the failure is actually visible to a person.

### Verified end to end

Not asserted — exercised, on a throwaway Postgres 16 with the full schema and
all 168 migrations:

- The in-repo `BACKUP_DIR` guard fires and refuses.
- A real dump is produced and self-verifies: 0.7 MiB, 156 tables with data.
- The dump **restores into a fresh database**, and row counts match the source
  exactly across `pt_clients`, `pt_payouts`, `leave_requests`, `organizations`
  and `exercises`.

---

## 3. Restore procedure

### Full restore into a new database

```bash
createdb -h <host> -U <user> 619_restore
pg_restore --no-owner --no-privileges \
  -d 'postgres://<user>@<host>/619_restore' \
  /var/backups/619/619-erp-<timestamp>.dump
```

Restore into a **new** database first, always. Restoring over the live one
turns a recoverable incident into two.

### Single table (the common case)

```bash
# What is in the archive:
pg_restore -l backup.dump | grep 'TABLE DATA'

# Just that table, into a scratch database, then reconcile by hand:
pg_restore --no-owner --data-only -t pt_payments \
  -d 'postgres://…/619_scratch' backup.dump
```

### After any restore

1. `SELECT count(*) FROM _migrations;` — confirm the schema version matches
   the code you are about to run against it.
2. Spot-check row counts per organisation, not just in total. A restore that
   brings back five studios out of six looks healthy in aggregate.
3. `SELECT count(*) FROM users WHERE role='super_admin';` and confirm MFA and
   password state — daily backups deliberately do not carry custom-role
   passwords, and a restored super-admin may need
   `scripts/rotate-super-admin-password.js` run against it.

---

## 4. Code and infrastructure recovery

Separate from data, and in better shape.

- **Backend/frontend rollback:** `.github/workflows/rollback.yml` in each repo
  redeploys a specific known-good SHA without waiting for CI. The box records
  the serving SHA in `/opt/myptstudio/.backend-deployed-sha` at deploy time.
- **Schema is forward-only.** There is no down-migration tooling. Rolling code
  back does **not** roll the database back. The additive migrations this repo
  writes (`ADD COLUMN IF NOT EXISTS`, `CREATE INDEX`, `ENABLE RLS`) are
  readable by older code, so this is usually survivable — but a migration that
  drops or renames something is not recoverable by rollback and needs a
  hand-written forward fix. `rollback.yml` states this in its own header and
  requires typing `ROLLBACK` to confirm.
- **Uploaded files** (consent PDFs, PAR-Q documents, avatars) live in
  Cloudflare R2, not in the database, and are not covered by a `pg_dump`.
  `storage_objects` holds the metadata. R2 has its own versioning and
  lifecycle settings — **check them**; this document cannot verify them from
  here, and a database restore paired with missing files is a half recovery.

---

## 5. What is still missing

Honestly, so nobody reads this document and concludes the problem is solved:

| Gap | Why it matters |
|---|---|
| **No PITR** | The stopgap's RPO is up to 24 hours. A bad afternoon still loses an afternoon of check-ins, payments and assessments. Only a paid plan fixes this. |
| **Nothing schedules the script yet** | It is committed, verified, and **not running anywhere**. Until it is scheduled on a real host, the posture in §1 is unchanged. |
| **No restore drill on real data** | Proven against a seeded throwaway database, not against a production-sized dump. An untested restore is a hypothesis. |
| **R2 backup/versioning unverified** | Uploaded files are outside the dump; their retention has not been confirmed. |
| **No monitoring of backup success** | A job that stops running needs to page someone. Right now nothing would notice. |
