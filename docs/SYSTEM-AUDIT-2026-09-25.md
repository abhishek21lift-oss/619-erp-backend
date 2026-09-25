# System audit — 2026-09-25

Scope: `619-erp-backend` (Express/Postgres), `619-erp-frontend` (Next.js 16),
`619-erp-whatsapp` (Fastify/Baileys gateway), their CI/deploy workflows, and the
live Supabase project `619-erp` (read-only advisors). ~385k lines.

This repo already carries many earlier audits, and most of the classic surface
(tenant filters, webhook signing, token revocation, upload access control,
platform/tenant plane separation) holds up well. The findings below are the
ones those audits missed, ordered by severity. **Fixed** items are in the same
branch as this document, each with a regression test that fails without the fix.

## Severity summary

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | **High** | Member (client login) can have any other client's health record summarised by the AI routes | Fixed |
| 2 | **High** | Member can read/overwrite other clients' nutrition logs; read their diet & workout assignments | Fixed |
| 3 | Medium | Refresh-token rotation race: one token can mint two sessions | Fixed |
| 4 | Medium | UPI order prices from **any studio's** plan id (cross-tenant read + price manipulation) | Fixed |
| 5 | Medium | Member class booking cannot work: member accounts have no `member_id`, and booking reads the empty v3 tables | Open |
| 6 | Medium | The member authz test skips exempt mounts wholesale — the blind spot behind #1/#2 | Partly fixed |
| 7 | Medium | Runtime on Node 20, which reached end-of-life in April 2026 | Fixed (all three repos) |
| 8 | Medium | `/login` returns `token` + `refresh_token` in the JSON body to browsers too | Fixed |
| 9 | Medium | Google Calendar OAuth `state` is not bound to the browser that started the flow | Fixed (backend + frontend) |
| 10 | Low | Postgres TLS uses `rejectUnauthorized: false` unless `DATABASE_SSL_CA` is set | Open |
| 11 | Low | `qs` DoS advisories via Express | Fixed (lockfile) |
| 12 | Low | Assorted: login timing enumeration, `staff` portal still in schema, sanitizer false positives, etc. | Open |
| 13 | Perf | Supabase: 134 RLS policies re-evaluate `current_setting()` per row; 168 overlapping permissive policies | Open |

---

## 1. High — AI routes leak any client's health record to a member

`/api/ai` was mounted with `gate('ai_suite')` = `auth + feature flag`, no role
check. `memberEscalation.authz.test.js` exempted the whole mount because its
*conversation* routes are keyed by `user_id`. But the same mount serves:

- `POST /api/ai/chat` with `client_id` → `buildClientContext(client_id, org)`
- `POST /api/ai/workout/generate`, `/diet/generate` → `loadAuthoritativeClient`
- `POST /api/ai/progress/analyze`, `/fitness-testing/analyze`

Each checks the client against the **studio** only. A member of studio A could
pass any other client id in studio A and receive health conditions, injuries,
medical notes, assessments and check-ins summarised back by the model (the
generators also echo `data_quality`/facts in the JSON). It also spent the
studio's AI quota.

**Fix:** both `/api/ai` mounts now use `studioGate('ai_suite')`
(`auth, requireTrainer, requireFeature`). The member app calls none of these
(verified: member pages use only `api.me.*`, `bookings`, `classes`, `upiPayments`).

## 2. High — Member IDOR on diet and workout routes

Same shape, on mounts exempted as "the library a member's plan is built from":

| Route | Impact |
|---|---|
| `GET /api/diet/tracker?client_id=` | read any client's nutrition log (7-day history) |
| `PUT /api/diet/tracker` | **overwrite** any client's nutrition log |
| `GET /api/diet/assignments?client_id=` | read any client's diet plan + macros |
| `GET /api/workouts/assignments?client_id=` | read any client's programme + progress |
| `GET /api/workouts/plans?client_id=` | read which plans a client is assigned and progress |

**Fix:** the first four are `requireTrainer`; `/workouts/plans` stays readable
to a member as a library but refuses a `client_id` from anyone but the trainer.

## 3. Medium — Refresh-token rotation race

`POST /auth/refresh` looked the token up with `SELECT … FOR UPDATE` on an
autocommitted `pool.query`, so the lock was released immediately, then revoked
it with an unconditional `UPDATE`. Two requests with the same token (a replayed
stolen token racing the real client, or two tabs) both got a fresh pair.

**Fix:** the rotation `UPDATE … AND revoked_at IS NULL` is now the claim; only a
`rowCount` of 1 proceeds. Test uses a barrier to force the interleaving.

Follow-up worth doing: reuse detection — a revoked token presented again should
revoke the whole family (all of that user's refresh tokens).

## 4. Medium — UPI order uses another studio's plan

`POST /api/payments/upi/create` resolved `plan_id` with no `organization_id`
filter. A member could price their order from another studio's cheapest plan
and read its name/price/duration. Human verification of the UTR mitigates the
money side, but it is a tenant-boundary break. **Fix:** strict org match, the
same as `GET /api/plans`.

## 5. Medium — Member class booking is broken end to end

Member accounts are created by `routes/client-login.js` with `pt_client_id`
but **no `member_id`**. `bookings.routes.js` substitutes `req.user.member_id`
for members, so `POST /api/bookings` always returns *400 member_id required*
and `GET` returns `[]`. Even with an id, `bookings.service.book()` requires an
active row in `member_memberships` — the abandoned v3 table (empty, per
`MEMBERS-TENANT-GAP.md`) — so it would answer *402 NO_MEMBERSHIP*.

The member Classes page (`/member/classes`) therefore cannot book. Needs a
product decision: re-key bookings on `pt_client_id` + the `pt_*` package model,
or hide booking in the member app until then.

## 6. Medium — Authz test blind spot

`memberEscalation.authz.test.js` `continue`s past every `MEMBER_REACHABLE`
mount and probes only bare `GET`s for 2xx. Routes that need a `client_id`
answer 400 without one, and POST/PUT are never probed — so #1 and #2 were
invisible. Added `memberSameStudioClientIds.authz.test.js`, which drives those
routes *with* a foreign same-studio `client_id` as member (403) and trainer
(allowed), and removed the over-wide `/api/ai` exemption.

Recommended next step: for every exempt mount, probe each route (all methods)
with `client_id`/`clientId` set to a foreign id and assert non-2xx.

Remaining member-reachable writes worth a look: `POST /api/profile/portfolio`
(members can upload portfolio media, consuming studio storage quota).

## 7. Medium — Node 20 is end-of-life

All three Dockerfiles use `node:20-*` and CI pins `node-version: '20'`. Node 20
left maintenance on 2026-04-30 — no more security releases.

**Fixed:** Dockerfiles, CI (including the Android APK job) and `engines`
(`>=22.12`) moved to Node 22 LTS in all three repos. Verified on Node 22.22:
all three test suites, the frontend production build, the gateway `tsc` build,
and the backend's native modules (`onnxruntime-node`) rebuilding and loading.
The images themselves were not built here (no Docker daemon); the first
deploy is the image-level check.

## 8. Medium — Tokens in the login response body

`/login` and `/refresh` (for non-cookie callers) return `token` and
`refresh_token` in JSON. The web app authenticates via httpOnly cookies, so the
body copy only exists for mobile — but browsers receive it too, where any XSS
(the enforced CSP still allows `'unsafe-inline'`) can read a 7-day refresh
token. Return body tokens only when the client asks (e.g. an explicit
`X-Client: mobile` header or `portal`/`client` field), and keep cookies-only for
the browser.

**Fixed:** `/login` and `/refresh` leave the tokens out of the body whenever
the request carries an `Origin` header. Browsers attach `Origin` to every POST
and page script cannot remove it; the web app and the Android WebView (same
origin) run on the cookies alone. Callers with no `Origin` — ops scripts, the
E2E API suite, any native client — keep the body tokens they use today, so no
opt-in header had to be rolled out.

## 9. Medium — OAuth CSRF on Google Calendar connect

`/api/calendar/auth-url` signs `state = {user_id}` but the callback never checks
that the *browser completing* the flow is that user. An attacker can send a
victim a Google consent link carrying the attacker's `state`; if the victim
consents, the victim's calendar tokens are stored on the attacker's account.
Bind `state` to the session (e.g. set a short-lived httpOnly nonce cookie at
`auth-url` and require it at `callback`). Also drop `_debug_redirect_uri` from
the response.

**Fixed:** bound through the session, not a nonce cookie, because the callback
may be served on a different host (`api.`) from the one that minted the state,
where such a cookie would never arrive. `GET /callback` now stores nothing and
forwards `code` + `state` to `/settings/integrations?calendar=confirm`; the page
POSTs them to the new `POST /api/calendar/complete` behind `auth`, which
exchanges the code only when `state.user_id` is the signed-in caller. A
forwarded consent link lands in the victim's session, doesn't match, and is
refused before the exchange. `_debug_redirect_uri` is gone. No Google Console
change is needed; the redirect URI is unchanged.

## 10. Low — Database TLS without certificate verification

`db/pool.js` falls back to `ssl: { rejectUnauthorized: false }` when
`DATABASE_SSL_CA` is unset — encrypted but MITM-able. Supabase publishes its CA;
set `DATABASE_SSL_CA` in production and consider failing boot without it when
`NODE_ENV=production`.

## 11. Low — `qs` advisories

`npm audit` (backend): GHSA-x5fp-wj9c-mxmx, GHSA-4mjr-xmp4-gh2g via
`express → qs@6.15.3`. `npm audit fix` moved Express to 4.22.3 / `qs@6.16.0`,
lockfile only. CI's `--audit-level=high` would not have caught these.

## 12. Low — smaller items

- **Login user enumeration by timing:** unknown email returns before any bcrypt
  work. Compare against a dummy hash on that path.
- **`/login` ignores `deleted_at`** (checks only `is_active`); the session is
  then refused by `auth.js`, but tokens are still minted. `forgot-password` /
  `reset-password` also don't exclude deleted or inactive users.
- **Login response `pt_client_id` was always `undefined`** (not selected).
  Fixed.
- **`authSchemas.login` still accepts `portal: 'staff'`**, a role removed by
  migration 208.
- **Super-admin TOTP** codes can be replayed within their window (no last-used
  step stored).
- **`sanitizeBody` rejects any body containing `../`** (e.g. a note or URL) with
  400, and silently truncates strings over 8,000 chars. Its doc comment says it
  trims; it doesn't.
- **`originCheck` allows `localhost` origins in production.** Low impact
  (cookies are `SameSite=Strict`, CORS blocks reads) but should match CORS.
- **Exercise slug uniqueness is global**, so a studio can learn that another
  studio has a custom exercise with a given name (it gets `-2`).
- **Static check-in QR codes never expire** and can't be revoked short of
  rotating the HMAC secret.
- **Auth user cache is per-process (30 s)**; deactivation propagates within 30 s
  per instance. Fine for one container; note it when scaling out.
- **`appleboy/ssh-action@v1.2.0`** is pinned by tag, not commit SHA, in every
  deploy/backup/rollback workflow that holds the VPS SSH key.

## 13. Database (live Supabase advisors, read-only)

Security: clean apart from 2 functions with mutable `search_path`
(`exercises_capture_version`, `exercises_sync_legacy_columns`), extensions
(`pg_trgm`, `vector`, `unaccent`) in `public`, and `platform_owners` with RLS on
but no policy (intended: owner-only table).

Performance:
- **134 `auth_rls_initplan`** — policies call `current_setting('app.org_id')`
  per row. Wrap as `(select current_setting(...))` so Postgres evaluates once.
- **168 `multiple_permissive_policies`** — overlapping permissive policies are
  each evaluated; consolidate.
- 29 unindexed foreign keys, 2 duplicate indexes (`module_records`,
  `weekly_checkins`), 279 unused indexes (review before dropping).
- `role_model_users_backup` / `role_model_settings_backup` (migration 208
  backups, no primary key) still exist — drop once 208 is confirmed good; they
  hold copies of user rows.

## Verified healthy

- Tenant isolation model (`req.user.organization_id` only; no header override),
  plane separation for `super_admin`, impersonation read-only enforcement.
- Razorpay and WhatsApp webhooks: HMAC over the raw body, timing-safe compare,
  timestamp window, idempotent claim.
- WhatsApp gateway: key auth before rate limit, per-org header validation,
  non-root container, CI-gated deploy.
- Upload serving: registered categories only, org ownership check per object.
- Password reset / change revokes all refresh tokens and bumps `token_version`.

## Test results

| Repo | Tests | Lint / types | `npm audit --omit=dev` |
|---|---|---|---|
| backend | 268 suites / 3,855 passed, 201 skipped (need a live DB) — after fixes | lint clean (`--max-warnings=0`) | 2 moderate → fixed |
| whatsapp | 19 files / 221 passed | typecheck clean | 0 |
| frontend | 180 files / 2,630 passed | typecheck + lint clean | 0 |

---

# Second pass — 2026-09-25 (later the same day)

The first pass was mostly backend request security. This pass covered what it
did not reach: the platform control plane, billing, public token flows,
automation, the WhatsApp gateway, infra and backups, and the **live**
database (read-only, count-only queries through the Supabase connector).

## Severity summary (second pass)

| # | Severity | Finding | Status |
|---|---|---|---|
| 14 | **Critical** | Nightly backup has **never** run: every run failed with `node: command not found`; free-plan Supabase has no backups of its own | Fix in PR #169 — needs one manual run to confirm |
| 15 | **Critical** | Production connects as `postgres` (BYPASSRLS, table owner): the 336 RLS policies are not in effect | Open — needs the server's `.env` |
| 16 | **High** | Client health data was sent to free-tier AI models; most calls are logged only as `auto` | Open |
| 17 | **High** | Changing the login email needs no password, no verification, and notifies nobody | Open |
| 18 | Medium | Full-access impersonation can change the owner's email or enrol a passkey — access that outlives the audited session | Open |
| 19 | Medium | Backups are unencrypted and share the app's R2 credentials; no restore drill | Open |
| 20 | Medium | Frontend E2E checks against backend `main` only, so paired PRs cannot both go green | Open (process) |
| 21 | Low | Password policy differs by path (activation strict, reset/change only 8 chars) | Open |
| 22 | Low | WhatsApp: ban-risk acceptance not recorded server-side; no opt-out or quiet hours for automated messages | Open |
| 23 | Low | nginx: `admin.myptstudio.com` is on the :80 block but has no :443 block (wrong certificate) | Open |
| 24 | Low | `archive.role_model_users_backup` / `_settings_backup` still hold copies of user rows | Open |

## 14. Critical — backups have never run

`.github/workflows/backup.yml` SSHes to the VPS and ran `node
scripts/backup-database.js` on the host. The host has no `node` and no
`pg_dump` (the app runs in Docker), so all 9 scheduled runs failed at
`node: command not found`. The project is on Supabase's free plan, which has
no backups — so there has been **no restore point** for any studio's data.

Two more bugs would have made the dump incomplete even with node present: the
script dumped `DATABASE_URL` (the RLS-confined `app_tenant` role once
enforcement is on) and the documented URL is Supabase's transaction pooler
(:6543), which cannot hold pg_dump's snapshot.

**Fix (PR #169):** a `postgres:17` + node image (`infra/backup/Dockerfile`),
the workflow runs it, and the script dumps `BACKUP_DATABASE_URL` →
`ADMIN_DATABASE_URL` → `DATABASE_URL`, moving a :6543 pooler URL to session
mode (:5432). Unverified end to end — **run the workflow once by hand after
merging** and check for `Verified: … tables with data` and `Uploaded to r2://…`.

## 15. Critical — RLS is not in effect in production

RLS is enabled on all 153 public tables with 336 policies, but at the time of
checking the live connections were `postgres` ×7 and `app_tenant` ×0.
`postgres` has `BYPASSRLS` and owns the tables, so every policy is skipped and
tenant isolation rests solely on the `organization_id` filters in application
code — which the tests cover well, but which is one layer, not two.

To confirm: on the VPS, check `TENANT_RLS_ENFORCE` and the user in
`DATABASE_URL` in `/opt/myptstudio/.env`. The cutover is already designed in
`src/db/migrations/TENANT-RLS-PLAN.md` (`DATABASE_URL` → `app_tenant`,
`ADMIN_DATABASE_URL` → owner). A pool that happened to be idle would also show
zero `app_tenant` connections, so treat this as strong evidence, not proof.

## 16. High — health data to free-tier AI models

`src/lib/ai/models.js` defaults all three routes to OpenRouter `:free` models,
and `platform_ai_settings` has no override. `ai_usage_log`, last 30 days:
`nvidia/nemotron-3-super-120b-a12b:free` 40 calls (to 2026-09-13), `auto` 149,
`gemini-3.5-flash-lite` 4. Workout/diet/progress prompts carry injuries,
medical conditions and allergies. Free endpoints may log or train on prompts,
and have no SLA. `auto` also means the model that actually processed the data
is not recorded.

**Fix:** set paid models (env or `platform_ai_settings`), enable OpenRouter's
"no prompt logging / no training" data policy for the key, and record the
resolved model OpenRouter returns instead of the requested alias.

## 17. High — email change without re-authentication

`PUT /api/profile/me` updates `users.email` with no current password, no
confirmation to the new address and no notice to the old one. Any session —
stolen, XSS'd, or impersonated — can switch the address and then use
forgot-password to own the account permanently. Require the current password
(or a recent step-up), verify the new address before switching, and email the
old one.

## 18. Medium — impersonation can outlive itself

Full-access impersonation (`mode: 'full'`) runs as the owner, so it can change
the owner's email (above) and enrol a passkey (`/api/auth/webauthn/register/*`),
leaving a credential that logs in after the audited session ends. Refuse
credential changes (email, password, passkeys, MFA) whenever `req.impersonation`
is set.

## 19. Medium — backup confidentiality and restore

Dumps upload unencrypted with the app's own R2 key, so a compromised app can
read or delete every backup. Encrypt before upload (age/GPG), use a separate
write-only key and bucket, set R2 object lock or a lifecycle rule, and restore
into a scratch database periodically.

## 20. Medium — cross-repo PRs cannot both go green

The frontend E2E job checks out backend `main` (`BACKEND_REF` unset), so a
frontend change that needs a new backend route fails its contract check until
the backend merges first — and if the backend change also needs the frontend,
one side is always briefly broken in production. Hit on #247/#168 today. Let
the job use a backend branch of the same name when one exists.

## 21–24. Low

- **Password policy** — `validatePassword` (activation/invitation) requires
  upper, lower, digit and symbol; `/reset-password` and profile change-password
  require only 8 characters. Use one policy everywhere.
- **WhatsApp** — the UI shows the ban-risk disclosure, but acceptance is not
  stored (who, when). Automated sends have no per-client opt-out and no quiet
  hours; the gateway's own throttles (20/min, 1,000/day, jitter) are sound.
- **nginx** — `admin.myptstudio.com` redirects to HTTPS but no :443 block
  serves it, so it lands on the `myptstudio.com` certificate.
- **Archive tables** — drop `archive.role_model_*_backup` once migration 208
  is confirmed; they duplicate user rows outside the live table's controls.

## Verified healthy (second pass)

- Impersonation: audited, read-only by default, scoped to one studio, cannot
  target platform accounts, and refused on the control plane.
- Billing: coupon validity and redemption limits checked; redemption under a
  row lock; discount capped at the price.
- Invitation / activation tokens: 32 random bytes, stored hashed, expiry and
  single-use enforced.
- Frontend: `safeReturnTo` blocks open redirects (scheme-relative, backslash,
  control characters, cross-portal); chat Markdown uses react-markdown's
  default URL filtering with `rel="noopener noreferrer"`.
- Live DB: RLS enabled on all 153 tables; 7 studios, 7 trainers, 1 platform
  operator, 35 clients, **0 client logins** — so the member-role leaks fixed in
  PR #166 had no account able to exploit them.
