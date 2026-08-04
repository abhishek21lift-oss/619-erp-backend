# Backend ↔ Frontend Coverage Audit

**Date:** 2026-08-04
**Backend:** `619-erp-backend` @ `66e3061` — 573 mounted routes
**Frontend:** `619-erp-frontend` @ `542cee0` — 468 distinct API calls
**Database:** Supabase project `619-erp` (`adffjnztzrolibtuvhgc`), Postgres 17, 170 tables

Method: every `app.use()` mount in `src/server.js` was resolved to its router
(recursively through `router.use(require(...))` sub-routers) to build the full
backend route table. Every `http()` / `httpSSE()` / raw `fetch()` call in the
frontend was extracted with paren-balanced parsing so the HTTP verb is read
from the call's own options object. The two sets were matched with Express
param semantics (`/:id` matches a literal segment).

---

## 1. Frontend calls that hit no backend route

Five call sites reach an endpoint that does not exist. All five 404.

| Verb | Path | Frontend origin | Live in UI? |
|---|---|---|---|
| `DELETE` | `/api/settings/branches/:id` | `lib/api/endpoints/studio.ts` | **Yes** |
| `GET` | `/api/finance/dues` | `components/sidebar/Sidebar.tsx` | **Yes** |
| `GET` | `/api/admin/export-database` | `lib/api/endpoints/platform.ts` | No |
| `POST` | `/api/admin/backup-database` | `lib/api/endpoints/platform.ts` | No |
| `GET` | `/api/reports/members` | `lib/api/endpoints/insights.ts` | No |

### 1.1 Delete Branch is a broken button

`src/routes/settings.js` registers `GET /branches`, `POST /branches` and
`PUT /branches/:id` — but no `DELETE`. The frontend calls it from a real
handler:

```ts
// src/app/settings/branches/page.tsx:47
async function deleteBranch(id: string) {
  try {
    await api.branches.delete(id);          // → DELETE /api/settings/branches/:id → 404
    setItems(p => p.filter(b => b.id !== id));
    toast.success('Branch deleted');
  } catch (err: any) {
    toast.error(err?.message || 'Failed to delete branch');
  }
}
```

The request 404s, the catch fires, the row stays. Deleting a branch is
impossible from the UI.

**Fix:** add `DELETE /branches/:id` to `src/routes/settings.js` (soft-delete,
`adminOnly`, and reject deletion of a branch that still has clients).

### 1.2 Two dead sidebar badge counters

`src/components/sidebar/Sidebar.tsx:187-188` bypasses the API client and calls
two paths that do not exist:

```ts
fetch('/api/trainers/leave?status=pending', { credentials: 'include' })
fetch('/api/finance/dues',                  { credentials: 'include' })
```

- `/api/finance/dues` — there is **no `/api/finance` mount at all** in
  `server.js`. The real route is `GET /api/reports/dues`.
- `/api/trainers/leave` — this one is worse than a 404: it *matches*
  `GET /api/trainers/:id` with `id = 'leave'`. `trainers.id` is `text`, so the
  query returns no rows and the handler answers `404 {error:'Trainer not
  found'}`. The real route is `GET /api/leave?status=pending`.

Both are wrapped in `Promise.allSettled(...).catch(() => {})`, and the count
extraction falls through to `?? 0`. So both sidebar badges silently render
**0 forever** — no error, no console warning. Pending leave requests and
outstanding dues never surface in the nav.

**Fix:** point them at `/api/leave?status=pending` and `/api/reports/dues`,
and route them through `api.leave.list()` / `api.reports.dues()` rather than
raw `fetch` so they inherit auth refresh and the org header.

### 1.3 Three declared-but-unused client methods

`admin.exportDatabase()`, `admin.backupDatabase()` and `reports.members()` are
exported from the API client but called nowhere in the app. They point at
routes the backend never implemented. Either implement them or delete the
client methods — right now they are a trap for the next person who wires a
button to them.

---

## 2. Response-shape break: PAR-Q detail

`GET /api/pt-os/parq/forms/:id` composes its response in
`src/modules/pt-os/parq.routes.js:241`:

```js
res.json({ data: {
  ...form,
  family_history:      familyRes.rows,     // array
  medical_clearances:  clearanceRes.rows,  // array, PLURAL
  consent_records:     consentRes.rows,    // array, PLURAL
  documents:           docsRes.rows,       // array
}});
```

The frontend contract declares something different:

```ts
// src/lib/api/types.ts — ParqFormDetail
family_history:     FamilyHistoryRow[];
medical_clearance:  MedicalClearance | null;   // SINGULAR
consent:            ConsentRecord | null;      // SINGULAR
documents:          ParqDocument[];
```

`medical_clearances` and `consent_records` appear **nowhere** in the frontend
codebase. So `row.medical_clearance` and `row.consent` are always `undefined`:

- `components/pt-os/parq/mappers.ts:27-28` reads both. The mapper guards with
  `mc ? {...} : fresh.medicalClearance`, so there is no crash — it silently
  falls back to a blank clearance and blank consent.
- `app/pt-os/parq/page.tsx:224` — `if (row.medical_clearance?.id)
  setClearanceId(...)` never fires.

**Impact:** opening an existing PAR-Q screening for edit shows the medical
clearance and consent sections **empty even when rows exist in the database**.
Because `clearanceId` is never set, saving again takes the create path and
writes a *duplicate* `pt_medical_clearances` row instead of updating.
TypeScript cannot catch this — the type asserts a shape the backend never
sends.

**Fix (backend, preferred):** have the route emit what the contract promises —
`medical_clearance: clearanceRes.rows[0] ?? null` and `consent:
consentRes.rows[0] ?? null`. Both queries already `ORDER BY created_at DESC`,
so `[0]` is the current record. Keep the arrays alongside if any future screen
needs history.

---

## 3. Feature flags the backend does not enforce

`platform_features` holds 17 keys and the frontend gates navigation on 15 of
them (`src/lib/nav-config.ts`). `server.js` enforces only **9** via `gate()`:

```
ai_knowledge_base  ai_suite  attendance  communication  finance
insights  integrations  packages  programs
```

Gated in the UI, wide open on the API:

| Feature key | Frontend hides | Backend gate |
|---|---|---|
| `branches` | Settings → Branches | none — `/api/settings/branches` open |
| `exercise_library` | PT-OS → Exercise Library | none (`/api/exercises` is gated on `programs`) |
| `member_portal` | Member area | none — `/api/v1/members`, `/api/member/*` open |
| `passkeys` | Passkey settings | none — `/api/auth/webauthn/*` open |
| `progress_photos` | PT-OS → Progress Photos | none — `/api/progress/*` open |
| `screening` | PT-OS → PAR-Q, assessments | none — `/api/pt-os/parq/*` open |

Turning any of these off for a studio only hides the nav item. The endpoints
stay callable by anyone who knows the URL, and by any client that keeps a
stale bundle. If these flags are meant to be commercial plan gating, six of
them currently gate nothing.

**Fix:** add the matching `...gate('<key>')` to each mount, or drop the keys
from the registry and nav if they were only ever cosmetic.

---

## 4. Backend surface the frontend never uses (109 routes)

Of 573 routes, 109 are never called. Most are legitimate; the ones worth
acting on are grouped below.

### 4.1 Three modules that are entirely dead

Mounted only under `/api/v1`, with a parallel non-v1 implementation the
frontend actually uses:

| Dead module | Mount | What the frontend uses instead |
|---|---|---|
| `modules/sessions/sessions.routes.js` | `/api/v1/pt-sessions` (5 routes) | `/api/pt-os/sessions` |
| `modules/reports/reports.routes.js` | `/api/v1/reports` (5 routes) | `/api/reports` (`routes/reports.js`) |
| `modules/members/members.routes.js` | `/api/v1/members` (9 routes) | `/api/clients` |

`/api/v1/members` is partially alive — the frontend calls `GET
/api/v1/members/:id` and `GET /api/v1/members/:id/metrics` only. The other
seven routes (list, create, patch, delete, freeze, attendance, payments) are
unused because client management goes through `/api/clients`.

This is two parallel implementations of the same domain. `modules/reports`
and `routes/reports.js` both answer "revenue" and "dues" with different SQL
and different shapes — whichever one a future screen picks will disagree with
the other.

**Recommendation:** pick one implementation per domain and delete the other.
If `/api/v1/*` is the intended direction, migrate the frontend; if not, remove
the three modules. Leaving both is how the two `dues` numbers drift apart.

### 4.2 Six overlapping client-renewal endpoints

```
POST /api/clients/:id/renew                 (routes/clients.js)
POST /api/clients/:id/pt-renew              (routes/clients.js)
POST /api/clients/:id/renew-pt              (routes/client-actions.js)
POST /api/clients/:id/renew-subscription    (routes/client-actions.js)
POST /api/clients/:id/add-subscription      (routes/client-actions.js)
POST /api/clients/:id/extension             (routes/client-actions.js)
```

None are called. The frontend renews exclusively through
`POST /api/pt-os/clients/:id/renew`. Note `pt-renew` and `renew-pt` are two
different handlers in two different files for the same operation.

### 4.3 Built but never surfaced

Working endpoints with no UI:

- `GET /api/attendance/stats`, `/api/attendance/gaps`,
  `/api/attendance/today-summary`, `POST /api/attendance/bulk`
- `GET /api/clients/:id/attendance`, `GET /api/clients/:id/payments`
- `GET /api/reports/trainers`
- `GET /api/settings/studio`
- `GET /api/payments/upi/:id/receipt`
- `GET /api/super-admin/billing/invoices/:id/pdf`,
  `GET /api/super-admin/billing/invoices/export`,
  `GET /api/super-admin/audit/export`
- `GET /api/super-admin/mail/status`, `POST /api/super-admin/mail/test`
- `POST /api/pt-os/payouts`, `POST /api/pt-os/payouts/:id/approve`,
  `POST /api/pt-os/trainers`, `PUT /api/pt-os/clients/:id/notes`
- `POST /api/offers/:id/redeem`, `POST /api/feedback`
- `POST /api/plans`, `PUT /api/plans/:id`, `DELETE /api/plans/:id`
- `DELETE /api/profile/devices/:id`, `DELETE /api/profile/sessions/:id`

The super-admin export/PDF endpoints are the notable ones — invoice PDF and
CSV export exist server-side but there is no button anywhere.

### 4.4 Correctly unused (no action)

45 `/api/v1/auth/*` and `/api/v1/bookings/*` routes are deliberate
dual-mounted aliases of the `/api/*` routes the frontend already calls;
3 `/uploads/*` static handlers; `POST /api/webhooks/razorpay`,
`GET /api/calendar/callback`, `GET /api/invitations/track/:trackId.gif`
(external callers); `GET /api/public/*`; `POST /api/debug/email-queue`;
and the four `POST /api/admin/*` reset operations (deliberately not wired to
any button).

---

## 5. Contract drift that is currently harmless

Optional fields declared in `src/lib/api/types.ts` that the backend never
emits. Nothing reads them today, so these are latent rather than broken:

| Type | Field | Reality |
|---|---|---|
| `MedicalClearance` | `form_id?` | column is `parq_form_id` |
| `ConsentRecord` | `form_id?` | column is `parq_form_id` |
| `ParqDocument` | `form_id?` | column is `parq_form_id` |
| `ParqDocument` | `uploaded_at?` | column is `created_at` |

Rename these in the frontend types to match the schema before something starts
reading them.

**Not a defect:** `ParqCurrentHealth`, `ParqPastHistory` and `ParqTrainerNotes`
declare ~48 fields that appear nowhere in the backend. These are stored as
`jsonb` and validated as `z.record(z.string(), z.unknown())`
(`parq.routes.js:160-163`), so the backend is a deliberate pass-through. Worth
knowing that no server-side validation exists on those blobs.

---

## 6. Database findings

`pt_parq_forms`, `pt_medical_clearances`, `pt_consent_records` and
`pt_parq_documents` all confirmed: the FK column is `parq_form_id` in every
case (see §5).

**Security — RLS disabled on two tables.** Supabase advisors report
`public.staff` and `public.staff_targets` have Row Level Security **off**,
while all 168 other public tables have it on. Both are fully readable and
writable by the `anon` and `authenticated` roles used by Supabase client
libraries. Both are currently empty (0 rows), so nothing has leaked yet.

Enabling RLS with no policies blocks all access, so this needs policies
written alongside — the other tables' `organization_id`-scoped policies are
the pattern to copy:

```sql
ALTER TABLE public.staff        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_targets ENABLE ROW LEVEL SECURITY;
-- plus tenant policies matching the organization_id pattern used elsewhere
```

---

## Priority

1. **PAR-Q `medical_clearance` / `consent` shape** (§2) — silent data loss plus
   duplicate-row writes on every re-save.
2. **RLS on `staff` / `staff_targets`** (§6) — open tables; cheap to fix while
   they are still empty.
3. **Sidebar badge paths** (§1.2) — two nav counters permanently zero.
4. **`DELETE /api/settings/branches/:id`** (§1.1) — visibly broken button.
5. **Six unenforced feature gates** (§3) — plan gating that gates only the UI.
6. **Duplicate members/reports/sessions implementations** (§4.1) — drift risk.
7. Dead client methods (§1.3), renewal endpoint sprawl (§4.2), type drift (§5).
