# Command Center audit — 2026-09-28

Scope: the platform operator's console end to end.

- **Backend:** the `PLATFORM_GUARD` chain (`middleware/platformAuth.js`,
  `middleware/tenant.js`), `modules/platform/super-admin/*` (studios, users,
  billing, subscriptions, features, impersonation, announcements, tenancy,
  support, storage, mail), `modules/command-center/*` (collectors, snapshot,
  WebSocket stream and tickets, commands and container recovery, alerts,
  Guardian, logs), and `routes/admin-reset.js` (mounted behind the same
  guard).
- **Frontend:** the `(platform)` route group, `components/platform/*`, and the
  impersonation hand-off into the studio app (`lib/http.ts`,
  `components/ImpersonationBanner.tsx`).
- **Live production (read-only):** `platform_owners`, operator MFA,
  `admin_reset_intents`, leftover isolation-probe studios.

No code was changed in this pass.

## Severity summary

| # | Severity | Finding | Status |
|---|---|---|---|
| CC-1 | **High** | A crafted `#imp=` link runs attacker script in a logged-in studio user's session when they click **Exit** on the impersonation banner | Open; **reproduced in Chromium** |
| CC-2 | **High** | `/api/admin/reset-all-data` (and two siblings) wipe **every studio's** data behind one emailed code; unused by the UI, unaudited, drops a table | Open |
| CC-3 | Medium | The Docker socket-proxy template would allow creating containers, not just restarting two, which means host root if the API is compromised | Open (template is commented out) |
| CC-4 | Medium | The enforced CSP still allows inline script; the strict nonce policy is report-only. That is what let CC-1 execute | Open |
| CC-5 | Low | `POST /users/:id/reset-password` does not refuse platform accounts (edit and delete do) | Open |
| CC-6 | Low | A live stream never re-checks the operator's grant or session after connecting | Open |
| CC-7 | Low | Announcement `link` accepts `//other-host` (protocol-relative, so off-site) | Open |
| CC-8 | Low | Platform-login TOTP codes can be replayed inside their window (carried over from #12) | Open |

---

## CC-1. High — impersonation hand-off: one-click XSS in the studio app

**Where:** `frontend/src/lib/http.ts` `consumeHandoff()`,
`frontend/src/components/ImpersonationBanner.tsx` `exit()`.

When the console sits on its own hostname, it hands an impersonation session
to the studio app in the URL fragment: `https://myptstudio.com/#imp=<base64 JSON>`.
The studio app accepts that fragment on **any page, from any link**. It checks
only that `token` and `orgId` are strings, stores the whole object in
`sessionStorage`, and from then on:

- sends `token` as `Authorization: Bearer` on every API call, so the tab runs as
  whoever the token belongs to; and
- shows the impersonation banner with the payload's `orgName` / `accountName`;
  and
- on **Exit**, runs `window.location.href = returnTo` with `returnTo` taken from
  the payload **unvalidated**.

**Attack.** Anyone who already holds a studio-side account can do this: a
trainer at any studio, or any member with an app login. Self-registration at
`/start-free` needs operator approval, so the pool is existing account holders.
It is still a cross-studio attack: a member of one studio can target another
studio's trainer. `/login` returns the access token in the body to callers with
no `Origin` header (curl).
1. The attacker takes their own access token.
2. They send a studio user a link to `https://myptstudio.com/#imp=` with
   `{ token: <attacker's token>, orgName: "<victim's studio name>",
   returnTo: "javascript:<payload>" }`.
3. The victim's app now runs as the attacker's account under a banner naming the
   victim's own studio. This is login CSRF: anything they enter lands in the
   attacker's studio.
4. When they click **Exit**, the payload runs in the studio origin with the
   victim's cookie session. It can read their clients, change their login
   email (which needs no password, audit #17) and take the account over.

**Reproduced** against a local build (logged-in trainer cookie, stub API
accepting one "attacker" token): after clicking Exit the page title became
`PWNED on 127.0.0.1:3100`. Chromium logged the strict nonce CSP refusing the
`javascript:` URL, but that policy is **report-only**. The enforced one allows
it (CC-4).

What did **not** work, which is good: a garbage token gets a 401,
impersonation is cleared *before* the banner reads `returnTo`, and the page
falls back to `/platform`. So there is no zero-click path.

**Fix (small, frontend only):**
1. In `consumeHandoff()`, accept the payload only if `token` decodes (without
   verifying) to a JWT whose payload carries an `imp` claim with
   `imp.org === orgId`. Only the platform can mint those, so an attacker's own
   session token is refused. The API still verifies the signature on every
   call.
2. Validate `returnTo` wherever it is used: only `https:` (or `http:` on
   localhost), and only the studio's own origin or the configured Command
   Center origin; otherwise `/platform`.
3. Add a unit test for both, including a `javascript:` `returnTo` and a token
   without `imp`.

## CC-2. High — platform-wide data wipe endpoints

**Where:** `backend/src/routes/admin-reset.js`, mounted at `/api/admin` behind
`PLATFORM_GUARD`.

- `POST /api/admin/reset-all-data` deletes **every** row, in **every** studio,
  from `pt_clients`, `pt_payments`, `pt_sessions`, assessments, PAR-Q forms,
  consent records, renewals, subscriptions, attendance, invoices,
  notifications and message logs. It also `DROP TABLE outstanding_dues
  CASCADE`. There is no `organization_id` anywhere.
- `POST /api/admin/reset-outstanding-dues` runs
  `UPDATE pt_clients SET balance_amount = 0` across all studios.
- `/clear-dues-and-payments` is an alias that forwards to the latter.
- The only gate beyond the platform guard is a 6-digit code emailed to the
  operator. It is generated with `Math.random()`, not `crypto.randomInt`.
- **None of these write an audit row.**
- The Command Center UI calls **none** of them (grep of the frontend: zero
  references). Production has never used them (`admin_reset_intents` is
  empty).

With backups not yet working (system audit A), one mistaken call, or one
compromised operator session plus access to its mailbox, erases every studio
permanently.

**Fix:** delete `routes/admin-reset.js` and its mount. If a per-studio reset
is ever needed, build it as a scoped, audited, typed-confirmation action in the
console. Leave the `admin_reset_intents` table for a later migration.

## CC-3. Medium — the Docker socket-proxy template grants far more than "restart"

**Where:** `backend/docker-compose.yml`, the commented `docker-socket-proxy`
block used by `modules/command-center/container-recovery.js`.

The comment says the proxy "exposes POST and nothing else" and that
`CONTAINERS=1` "would allow listing and inspecting every container". The block
then sets `POST: '1'` **and** `CONTAINERS: '1'`. With tecnativa's proxy that
permits every `POST /containers/...` call, including `containers/create`
with a privileged container and a bind mount of `/`, which is root on the host.
The `:ro` on the socket mount does not restrict API calls. The ERP client only
builds `POST /containers/{id}/restart`, but the proxy is what stands between a
compromised API process and the host, and it does not hold that line.

It is commented out, so production is not exposed unless someone enabled it
by hand.

**Fix:** before enabling, use a proxy that allow-lists paths, e.g.
`wollomatic/socket-proxy` with
`-allowPOST=^/v[0-9.]+/containers/(myptstudio-api|myptstudio-worker)/restart$`
and every other method denied. Correct the comment. Keep it off otherwise.

## CC-4. Medium — enforced CSP still allows inline script

`frontend/src/lib/security-headers.js` enforces
`script-src 'self' 'unsafe-inline' …`. The nonce-based policy built in
`src/proxy.ts` is sent as `Content-Security-Policy-Report-Only`. The code
already calls `'unsafe-inline'` "the single biggest weakness here", and CC-1
shows it: the report-only policy refused the payload and the enforced one ran
it. Promote the nonce policy to enforced once its reports are clean. The
theme bootstrap script and Next's hydration scripts both carry the nonce.

## CC-5. Low — platform accounts can be password-reset from the console

`PATCH /users/:id` and `DELETE /users/:id` refuse `role = 'super_admin'`.
`POST /users/:id/reset-password` does not, so an open console session can set
a new password on the operator account (including its own) without the
current one. Add the same refusal. An operator changes their own password
through Profile, which asks for the current one.

## CC-6. Low — stream connections outlive a revoked operator

`modules/command-center/stream.js` authenticates once, with a single-use
30-second ticket, then keeps sending snapshots until the socket closes. Revoking
the `platform_owners` grant, bumping `token_version`, or logging out does not
end an open stream. The payload is health metrics, not studio data, hence Low.
Fix: every ~60 s re-check the grant and the user's `token_version`, and cap
connection age.

Also noted: `originAllowed()` accepts a missing `Origin`. This is harmless on
its own, because a valid ticket is still required.

## CC-7. Low — announcement links can leave the site

`super-admin/announcements.js` accepts any `link` starting with `/`, which
includes `//evil.example` (a protocol-relative URL, so another host). It is
shown in every targeted studio's notification panel. Require `/` followed by a
non-`/` character.

## CC-8. Low — TOTP replay at platform login

Unchanged from system audit #12: a TOTP code is valid for its whole window and
can be reused. Store the last accepted time-step per user and reject a repeat.

---

## Verified healthy

- **One guard, every route:** `/api/platform`, `/api/super-admin` and
  `/api/admin` all mount `auth → requireSuperAdmin → requireSuperAdminMfa →
  requirePlatformOwner`. The Command Center routes are inside the same router.
  `requirePlatformOwner` checks the `platform_owners` grant (fails closed on DB
  errors), requires a `platform`-audience session, and refuses impersonation.
- **Second factor at sign-in:** the password login demands a TOTP code or a
  recovery code for an operator with MFA on. Google and passkey sign-in mint
  only `tenant`-audience sessions, which the platform guard refuses, so neither
  bypasses MFA.
- **Tenant plane refuses the operator:** super_admin requests to tenant paths
  are refused in `auth.js`; the operator enters a studio only by impersonation.
- **Impersonation:** read-only by default, full access behind a confirm
  dialog, 30-minute default and 120-minute maximum lifetime, bound to one
  studio, never a platform account or an inactive user, audited. The hand-off
  fragment is stripped from the address bar after use.
- **User management:** role changes are refused; platform accounts cannot be
  edited or deleted; deactivation, deletion and password reset revoke sessions;
  every action is audited.
- **Commands:** a fixed allow-list, not a generic executor. Destructive
  commands need the name typed back. Cooldowns are claimed atomically. Every
  run is audited with a before/after health reading. Container restarts are
  unavailable unless a proxy is configured.
- **Stream tickets:** single-use, 30-second, issued only behind the full guard.
  The socket ignores every client message except a rate-limited `refresh`.
- **Logs:** credentials in URLs, bearer tokens, JWTs and API keys are scrubbed
  before reaching the browser, on top of the logger's own path redaction.
- **Guardian:** only rule findings are sent to the model for rewording, never
  studio data.
- **Isolation self-test:** creates two probe studios and always deletes them;
  production has **0** leftovers.
- **Live production:** 1 operator account, MFA on, 1 live platform grant; the
  data-wipe endpoints have never been used.

## Suggested order

1. **CC-1** (frontend hand-off validation and tests) and **CC-2** (delete the
   wipe endpoints). Both are small, self-contained and high value.
2. **CC-4**, flipping the nonce CSP to enforced, which blunts any future XSS.
3. **CC-5**, **CC-7**, **CC-8**: one-line to few-line fixes.
4. **CC-3** before anyone enables container restarts; **CC-6** when convenient.
