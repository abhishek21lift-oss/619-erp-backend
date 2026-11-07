# Separating the Command Center from MY PT STUDIO

One platform control plane, one multi-tenant application, one protected data
plane. This document records what was mixed, what the separation actually is,
and the order things have to be switched on.

Written against `main` after the audit below; the code is in both repos on
`claude/database-access-setup-l3eud1`.

---

## 1. What was already right

The audit found more separation in place than the brief assumed, and none of it
was rebuilt.

| Already correct | Where |
|---|---|
| Platform API gated at the mount, not per-handler | `server.js` — `auth → requireSuperAdmin → requireSuperAdminMfa` on `/api/super-admin` |
| Platform routes split by domain, order-independent | `src/modules/platform/super-admin/*` + `superAdmin.routes.split.test.js` |
| Tenant scoping applied consistently in handlers | `lib/tenant-db.js` `tenantScope()`, enforced by `tenantScope.convention.test.js` |
| Cross-tenant target resolved from ONE rule | `targetOrgId()` — the `x-org-id` header and nothing else |
| RLS design, `app_tenant` role, owner connection | migrations 157/159, `db/pool.js`, `lib/tenant-context.js` |
| Impersonation audited, read-only by default | `super-admin/impersonation.js` |
| Client/staff portal split, enforced server-side | `routes/auth.js` portal check |

The tenant boundary was not the problem. The **platform** boundary was.

## 2. What was actually mixed

**The control plane was a page of the customer's application.** `/platform`
lived in the frontend's `(chrome)` route group — the studio's own shell. The
owner's console rendered inside the studio sidebar, the studio bottom nav and
the studio's notification poller, in the same bundle, on the same domain, with
the same session. The twelve console links were a role-gated group inside
`nav-config.ts`, so one navigation component decided at render time, from a role
string, which of two products the person was using.

**Platform authorization was a role string.** `req.user.role === 'super_admin'`
was the entire boundary. Anything that could write `users.role` — a support fix
in psql, a seed script, an update handler that forgets to exclude `role` from a
patch body — was one statement from handing an account every studio's data, with
nothing recording that anyone intended it.

**One session type served both planes.** A token minted at the studio door was
byte-identical to one minted for the console. There was no way for the API to
tell "the operator, running the platform" from "the operator, who happened to
sign in at /login", so any path that could obtain a super admin's cookie
obtained the platform with it.

**The namespace named a role, not a boundary.** `/api/super-admin` told every
reader that the rule was "is this user a super admin" — which is exactly the
conflation that needed removing.

## 3. The separation

```
COMMAND CENTER  (admin.myptstudio.com)         MY PT STUDIO  (myptstudio.com)
  (platform) route group, own shell              (chrome) route group, AppShell
  /platform-login  → aud: platform               /login, /member-login → aud: tenant
        │                                                │
        ▼                                                ▼
  requirePlatformOwner                            denyPlatformSession
   · role = super_admin                            · refuses aud: platform
   · live platform_owners grant                    · classifies by path
   · session aud = platform                        · unknown path ⇒ tenant
   · not impersonating                                    │
        │                                                ▼
        ▼                                          tenant RBAC + tenantScope()
  /api/platform/*  ( = /api/super-admin/*)         /api/clients, /api/payments, …
        │                                                │
        └──────────────► shared PostgreSQL ◄─────────────┘
             owner connection          app_tenant + RLS
             (ADMIN_DATABASE_URL)      (organization_id policies)
```

The one sanctioned crossing is **impersonation**: it mints a `tenant` token,
writes an audit row, and is refused by the control plane. Once
`PLATFORM_SESSION_ENFORCE` is on it is the *only* crossing, so every one of them
is recorded.

### The four facts

`middleware/platformAuth.js` requires all of these, and they fail in different
directions so no single mistake opens the door:

1. **Role** — `users.role = 'super_admin'`. What the UI already reasons about.
2. **Grant** — a live row in `platform_owners` (migration 161). No tenant-facing
   code path writes this table; it carries who granted it and when.
3. **Audience** — the session was opened at the Command Center's door. This is
   what makes the split real rather than nominal.
4. **Not impersonating** — a request carrying a tenant identity and an
   operator's provenance is refused rather than disambiguated.

### Why the audience needs a column

Access tokens live 15 minutes; refresh tokens live 7 days. If `/auth/refresh`
chose the audience itself, the distinction would be laundered away on the first
refresh. Migration 162 puts it on `refresh_tokens`, and the refresh handler
reads it back rather than re-deciding.

### Why the tenant-side check lives in `auth.js`

There are ~45 tenant mounts in `server.js`. A boundary that has to be remembered
45 times is a boundary with a hole in it. `platformSessionBlocked()` is called
once, from the middleware every authenticated request already passes through,
and classifies by path with **"unknown path ⇒ tenant surface"** — so a route
added next year is covered without anyone remembering to add it.

## 4. Security and RLS changes

| Change | Effect |
|---|---|
| `platform_owners` table (161), seeded from existing super admins | Cross-tenant power is an explicit, auditable grant. Lands inert. |
| RLS on `platform_owners`, `REVOKE ALL … FROM app_tenant` | No policy for `app_tenant` ⇒ it reads zero rows. The console reaches it over the owner connection. |
| `refresh_tokens.audience` (162) | The plane is a property of the session, not of a 15-minute token. |
| `aud` claim on every session token | A studio session cannot drive the platform; a platform session cannot act in a studio. |
| `requirePlatformOwner` on `/api/platform`, `/api/super-admin`, `/api/admin` | One guard chain, `PLATFORM_GUARD`, asserted identical at both names. |
| Grant lookup fails **closed** | An unreadable `platform_owners` refuses access rather than opening it. Denials from database errors are not cached. |
| Host isolation at the edge | `/platform` 404s on the studio domain; studio pages 404 on the console domain. |
| Guard's portal rule is asymmetric | Operator → studio allowed (support). Studio → console refused, always. |

**Tenant isolation was not weakened anywhere.** `tenantScope()`, `targetOrgId()`,
`resolveOrgId()` and the RLS plumbing are untouched. The `x-org-id` header is
still super-admin-only and still ignored for everyone else.

## 5. Rollout order

Each step is safe to stop at.

1. **Deploy both repos.** Migrations 161/162 run at boot. Nothing changes
   behaviourally: the grant is seeded from today's super admins, and the
   audience flags are off. The frontend console moves to its own route group and
   its own door, still on one hostname.
2. **Verify.** Sign in at `/platform-login`, confirm the console loads and the
   studio app still works for a tenant admin. Check `platform_owners` has a row
   per super admin.
3. **Split the hostname** (optional, recommended). DNS for
   `admin.myptstudio.com` → same host; certificate; the vhost already in
   `infra/nginx/myptstudio.conf`; then set `COMMAND_CENTER_HOST` on the frontend
   container and `NEXT_PUBLIC_APP_ORIGIN` alongside it. These three must land
   together — a hostname that resolves without the variable serves the whole
   studio app on the operator's domain.
4. **Wait for sessions to churn** — 7 days, or force a logout.
5. **Set `PLATFORM_SESSION_ENFORCE=on`.** From here the operator must use the
   Command Center's door, the studio app refuses console sessions, and
   impersonation is the only crossing.

Rolling back step 5 is one environment variable. Steps 1–3 are additive.

## 6. What this does not do

- **The data plane is unchanged.** `TENANT_RLS_ENFORCE` is still off and
  `DATABASE_URL` still points at a `BYPASSRLS` role. That cutover is
  `src/db/migrations/TENANT-RLS-PLAN.md`'s, and it is a separate, separately
  tested deployment. This work makes the *application* boundary explicit; it
  does not put the database behind it.
- **The Member Portal stays reserved.** `portalForRole` already routes `member`
  to its own portal and `mayEnterPortal` refuses it the console. Nothing was
  built out.
- **`requireSuperAdminMfa` is still opt-in** (`SUPER_ADMIN_REQUIRE_MFA`). Worth
  turning on with step 5 — the console now has one door, so MFA on it covers
  the whole control plane.
