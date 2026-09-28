# System audit — 2026-09-28

Scope: `619-erp-backend`, `619-erp-frontend`, `619-erp-whatsapp` at their
current `main`, their CI/backup workflows, and the live Supabase project
`619-erp` (read-only: advisors and count-only queries).

This pass does two things:

1. Re-checks every finding the two 2026-09-25 passes
   ([SYSTEM-AUDIT-2026-09-25.md](SYSTEM-AUDIT-2026-09-25.md)) left open,
   against today's code and today's production.
2. Audits the code that landed **after** those passes (26–27 Sept, PRs
   #170–#185): the member app API (`/api/me`: messages, progress photos,
   goals, self-logged workouts, recap, renewal, receipts), UPI balance and
   renewal-offer payments, and member ↔ studio messaging.

No code was changed in this pass. Each open item says what to do.

## Baseline

| Repo | Tests | Lint / types | `npm audit --omit=dev` |
|---|---|---|---|
| backend | 277 suites / 3,987 passed, 270 skipped (17 suites need a live DB; CI runs them) | lint clean | 0 |
| frontend | 188 files / 2,673 passed | typecheck clean; lint 0 errors, 139 warnings (CI allows 269) | 0 |
| whatsapp | 19 files / 221 passed | lint + typecheck clean | 0 |

## Severity summary

| # | Severity | Finding | Status |
|---|---|---|---|
| A | **Critical** | Nightly backup still fails on every run — now because the container gets no database URL | Open — needs the VPS env file |
| B | **Critical** | Production still connects as `postgres`; RLS policies are not in effect (was #15) | Open — needs the VPS env file |
| C | **High** | Email change needs no password or verification (was #17) | Open |
| D | **High** | Client health data still goes to unrecorded (`auto`) and free-tier AI models (was #16) | Open |
| E | Medium | Approving a trainer-created UPI **plan** order wipes the client's old unpaid balance | **New** — Open |
| F | Medium | A UPI balance payment approved after a desk payment silently loses the overpayment | **New** — Open |
| G | Medium | Full-access impersonation can still change email / enrol a passkey (was #18) | Open |
| H | Medium | Member class booking cannot work (was #5) | Open — product decision |
| I | Low | Refresh-token reuse is not detected (follow-up from #3) | Open |
| J | Low | Earlier low items still open: DB TLS unverified (#10), login timing enumeration, `portal: 'staff'` accepted, TOTP replay, `../` rejected in any body, `localhost` origins allowed in prod, password policy differs by path (#21), `ssh-action` pinned by tag | Open |
| K | Low | Supabase advisors unchanged; migration-208 backup table still holds copies of user rows (#24) | Open |

---

## A. Critical — the backup still has never succeeded

`Nightly database backup` has run 12 times; **all 12 failed**, including the
three runs (#10–#12, 25–27 Sept) after PR #169's fix merged. The fix did its
part — the backup image now builds on the VPS — but the run then stops with:

```
backup failed: None of BACKUP_DATABASE_URL, ADMIN_DATABASE_URL or DATABASE_URL is set.
```

The workflow sources `/opt/myptstudio/.env` (which exists — `set -e` would
have stopped on a missing file) and passes the variables with `docker run -e`.
So the API's database URL is not in that file: the running stack reads its
environment from somewhere else (an `env_file:` in the compose file under
`/opt/myptstudio`, or the backend's own `.env`).

There is still **no restore point for any studio's data** (free-plan Supabase
keeps none).

**Fix:** on the VPS, find where the backend service gets `DATABASE_URL`
(`docker compose config backend`, look at `env_file`/`environment`), then
either source that file in `backup.yml` or pass it with
`docker run --env-file <that file>`. Set `BACKUP_DATABASE_URL` to the
**session** pooler / direct owner URL. Run the workflow by hand and check for
`Verified: … tables with data` and `Uploaded to r2://…`.

## B. Critical — RLS still bypassed in production

Live `pg_stat_activity` today: `postgres` ×7, `app_tenant` ×0 (same as on the
25th). `postgres` owns the tables and bypasses RLS, so tenant isolation is
still one layer (application `organization_id` filters) instead of two.
Procedure: `src/db/migrations/TENANT-RLS-PLAN.md`.

## C. High — email change without re-authentication

Unchanged: `PUT /api/profile/me` (`src/routes/profile.js:269`) writes
`users.email` with no current password, no confirmation to the new address,
and no notice to the old one. Any hijacked session can then use
forgot-password to take the account permanently. Require the current
password (or a recent step-up), verify the new address before switching, and
email the old one.

## D. High — AI models and health data

`ai_usage_log`, last 30 days: `auto` 151 calls (last 27 Sept),
`nvidia/nemotron-3-super-120b-a12b:free` 14, a handful of Gemini calls.
`src/lib/ai/models.js` still defaults all three routes to `:free` models.
Workout/diet/progress prompts carry injuries, conditions and allergies.
Set paid models, enable OpenRouter's no-logging/no-training policy, and log the
model OpenRouter actually used instead of `auto`.

## E. Medium (new) — approving a UPI plan order erases the old balance

`src/lib/upiPayments.js` `approve()` handles three order kinds. For a
**renewal** it deliberately leaves `balance_amount` alone ("an older debt is
still owed, and paying for next month does not settle it"). For a
**membership** (plan) order — which trainers create from
*Finance → Verify payments → New request* — it does both:

```sql
pt_end_date    = <new window>,
paid_amount    = paid_amount + total,
balance_amount = GREATEST(0, balance_amount - total)
```

A client who owes ₹5,000 and pays ₹12,000 for a new 3-month plan gets the new
term **and** their ₹5,000 debt cleared; the dashboard's dues and collections
no longer reconcile with payments received. `package_type` / `final_amount`
are not updated either, and no renewal history row is written (the renewal
path writes both).

Production has 0 approved plan orders, so no data is affected yet.

**Fix:** make the membership branch match the renewal branch (new term, new
package fields and history, balance untouched), or retire trainer-created plan
orders in favour of renewal offers. Add a test that seeds a balance, approves a
plan order and asserts the balance is unchanged.

## F. Medium (new) — balance overpayment disappears

A balance order's amount is fixed when the member submits it. If the trainer
then records a desk payment for the same debt and later approves the UPI
submission, `balance_amount = GREATEST(0, balance_amount - total)` floors at
zero: the extra money lands in `paid_amount` with no credit or warning.
`createOrder` already supersedes an *unpaid* stale balance order; one awaiting
verification is (rightly) left alone, so the check has to be at approval time.

**Fix:** in `approve()`, when `kind = BALANCE` and `total > current balance`,
refuse with 409 and a message ("the balance changed to ₹X since this was
submitted") or record the excess as a credit, and show it on the verify
screen.

## G–I. Medium / Low — unchanged since 25 Sept

- **G.** `req.impersonation` is only consulted for read-only mode and billing.
  Refuse email, password, passkey and MFA changes whenever it is set.
- **H.** Bookings still key on `req.user.member_id` and `member_memberships`;
  members have neither. Rebuild on `pt_client_id` + `pt_*` packages, or hide
  booking in the member app.
- **I.** Presenting a revoked refresh token should revoke every refresh token
  of that user.

## J–K. Low

All confirmed still present in today's code; details in the 25 Sept audit.
Supabase security advisors are unchanged: 2 functions with mutable
`search_path`, 3 extensions in `public`, `platform_owners` with no policy
(intended). `archive.role_model_users_backup` still exists.

## Verified healthy (new code since 25 Sept)

- **Member API (`/api/me`)**: every route takes the client id from the session
  (`selfOf(req)`), never from the request; org filter as a second guard; ids
  in paths (`consent/:id`, `goals/:id`, `payments/:id/receipt`,
  `progress-photos/:id`) only select among the caller's own rows. Column lists
  are allow-lists (no commission or internal notes).
- **Progress photos**: multipart with an 8 MB cap, type decided by magic bytes,
  daily limit, served back only to the owning member or their studio.
- **Messaging**: studio side is trainer-only and org-scoped; member side is
  bounded (2,000 chars, 30/hour).
- **UPI**: member orders always for the caller's own record; plan price read
  from the DB and org-scoped; ad-hoc amounts are trainer-only; balance amount
  read server-side; double approval blocked by a conditional update + row
  locks; orders 404 across clients and studios.
- **SQL**: every interpolated identifier comes from a fixed allow-list and
  every interpolated `LIMIT` is an integer by construction.
- **Frontend**: the two `dangerouslySetInnerHTML` uses render locally
  generated QR SVGs; no tokens in `localStorage`.
- **CI**: backend and frontend run integration/E2E against a real Postgres;
  the backend and the gateway lint at `--max-warnings=0`; audits gate on high
  severity.

## Suggested order

1. **A** (backups) and **B** (RLS) — both are VPS `.env` work, can be done
   together, and nothing else on this list matters as much if the database is
   lost.
2. **E** and **F** — small, contained changes in `approve()` with tests, before
   studios start using online plan payments.
3. **C** and **G** together (credential changes need step-up and are blocked
   under impersonation).
4. **D** (AI model and data policy settings).
5. **H** product decision, then the low items.
