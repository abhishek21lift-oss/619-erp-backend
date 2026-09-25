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
| 8 | Medium | `/login` returns `token` + `refresh_token` in the JSON body to browsers too | Open |
| 9 | Medium | Google Calendar OAuth `state` is not bound to the browser that started the flow | Open |
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

## 9. Medium — OAuth CSRF on Google Calendar connect

`/api/calendar/auth-url` signs `state = {user_id}` but the callback never checks
that the *browser completing* the flow is that user. An attacker can send a
victim a Google consent link carrying the attacker's `state`; if the victim
consents, the victim's calendar tokens are stored on the attacker's account.
Bind `state` to the session (e.g. set a short-lived httpOnly nonce cookie at
`auth-url` and require it at `callback`). Also drop `_debug_redirect_uri` from
the response.

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
