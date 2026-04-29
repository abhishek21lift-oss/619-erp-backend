# 619 Fitness — SaaS Gym Management Platform v3

> Glofox-class, production-ready architecture built on top of your existing 619 ERP. Designed for multi-tenant scale, mobile-first UX, and the Indian fitness market (₹/UPI/WhatsApp).

---

## 1. Executive Summary

The current ERP (v2) is solid for back-office operations: trainer/client/payment/attendance tracking. v3 evolves it into a **member-facing SaaS platform**:

| Capability | v2 (Today) | v3 (This Plan) |
|---|---|---|
| Roles | admin, trainer | **admin, trainer, member** |
| Member self-service | none | full mobile portal |
| Class booking | none | yes (group classes + waitlists) |
| PT scheduling | manual | calendar-based with conflict detection |
| Payments | manual entry | manual + Razorpay/Stripe + auto-renewal |
| Notifications | none | email + WhatsApp + in-app + push |
| Attendance | manual | QR check-in + manual + auto from bookings |
| Reports | dashboard cards | exportable PDF/CSV with filters |
| Multi-branch | single | multi-branch ready |

**Migration strategy:** additive only. Existing tables stay; we extend with new tables and a `members_portal` feature flag so v2 keeps running while v3 features roll out.

---

## 2. Module Breakdown

The system is decomposed into **12 vertical modules**. Each has its own routes, services, DB tables, and UI surface.

### 2.1 Core Modules

1. **Identity & Access** — auth, users, roles, RBAC, password reset, session management
2. **Members (Clients)** — profile, memberships, payments, attendance, body metrics
3. **Trainers** — profile, schedule, payouts, performance metrics
4. **Memberships & Plans** — plan catalog, subscriptions, freezes, renewals
5. **Payments & Billing** — manual entry, gateway integration, invoices, receipts, dues
6. **Classes & Bookings** — group classes, recurring schedule, capacity, waitlists
7. **Personal Training** — 1:1 session booking, conflict detection, cancellation policy
8. **Attendance** — QR check-in, manual override, geofencing (optional)
9. **Notifications** — multi-channel orchestrator (email/WhatsApp/SMS/push/in-app)
10. **Reports & Analytics** — revenue, retention, trainer performance, churn, exports
11. **Settings & Branding** — gym info, currency, tax, business hours, holidays
12. **Audit & Activity** — every mutation logged for compliance and debugging

### 2.2 Module Dependency Graph

```
Identity ───┬─→ Members ──┬─→ Memberships ──→ Payments ──→ Notifications
            │             │                                      ↑
            ├─→ Trainers ─┴─→ Classes ─────→ Bookings ───────────┤
            │                                       ↓            │
            │                              Attendance ───────────┤
            │                                                    │
            └─→ Reports ←──── (reads from all modules)           │
                Settings ←─── (consumed by all)                  │
                Audit ←────── (writes from all)                  │
```

---

## 3. Tech Stack (Final Recommendation)

Building on what already works in v2, with strategic additions:

| Layer | Choice | Why |
|---|---|---|
| **Frontend** | Next.js 14 (App Router) + TypeScript | Already in use; SSR for SEO on landing pages, RSC for fast dashboards |
| **UI Library** | Tailwind CSS + shadcn/ui + Radix primitives | Fastest path to a clean SaaS look; copy-paste components, no dep lock-in |
| **State** | TanStack Query (server) + Zustand (UI) | Cache-first; eliminates the manual `setLoading/setError` pattern in v2 |
| **Charts** | Recharts | Already common in React stack |
| **Backend** | Node.js + Express (keep) → migrate to Fastify when scaling | Express is fine; Fastify is a 2x perf upgrade when you hit it |
| **DB** | PostgreSQL 15 (Supabase) | Already in use; row-level security ready for multi-tenancy |
| **ORM** | Drizzle ORM | Type-safe, lightweight, SQL-first — good fit for your existing raw SQL |
| **Auth** | JWT (keep) + refresh tokens + httpOnly cookies | Fix v2 weakness: tokens currently in localStorage |
| **API Style** | REST (resource-oriented) + a few RPC endpoints for reports | GraphQL is overkill here; REST is what your team knows |
| **Validation** | Zod (shared between FE/BE) | Single source of truth for shapes |
| **Background jobs** | BullMQ + Redis | Auto-renewal, reminders, report generation |
| **Email** | Resend or AWS SES | Reliable, cheap, good deliverability |
| **WhatsApp** | Meta Cloud API + Gupshup as fallback | Standard for Indian gyms |
| **SMS** | MSG91 / Twilio | India-first |
| **Payments** | Razorpay (primary) + Stripe (international) | UPI/cards/netbanking for India |
| **File Storage** | Supabase Storage | Already in your stack |
| **Push** | Firebase Cloud Messaging | Free, mature |
| **Realtime** | Supabase Realtime channels | For live class capacity, attendance |
| **Logging** | Pino + Better Stack (or Axiom) | Structured logs |
| **Errors** | Sentry | FE + BE |
| **Analytics** | PostHog (self-hostable) | Product analytics |
| **CI/CD** | GitHub Actions → Vercel (FE) + Railway/Fly (BE) | Existing deployment guide assumes Vercel-style |
| **Mobile (future)** | React Native + Expo, sharing TypeScript types | When you outgrow PWA |

---

## 4. Folder Structure

### 4.1 Monorepo Layout (recommended evolution)

```
619-erp-v2/
├── apps/
│   ├── web/                      # Next.js frontend (admin + trainer + member portal)
│   └── api/                      # Express backend
├── packages/
│   ├── db/                       # Drizzle schema + migrations (single source of truth)
│   ├── shared/                   # Zod schemas, types, constants shared FE/BE
│   ├── ui/                       # Tailwind + shadcn components
│   └── config/                   # ESLint, TS, Tailwind preset
├── docs/
│   └── ARCHITECTURE.md           # this file
└── pnpm-workspace.yaml
```

### 4.2 Backend Module Structure

```
apps/api/src/
├── modules/                      # vertical slices — each owns its routes/services/db
│   ├── auth/
│   │   ├── auth.routes.ts
│   │   ├── auth.service.ts
│   │   ├── auth.controller.ts
│   │   ├── auth.validators.ts    # Zod schemas
│   │   └── auth.test.ts
│   ├── members/
│   ├── trainers/
│   ├── memberships/
│   ├── payments/
│   ├── classes/
│   ├── bookings/
│   ├── sessions/                 # PT sessions
│   ├── attendance/
│   ├── notifications/
│   ├── reports/
│   ├── settings/
│   └── audit/
├── infra/
│   ├── db.ts                     # pg pool / drizzle
│   ├── redis.ts
│   ├── queue.ts                  # BullMQ
│   ├── mailer.ts
│   ├── whatsapp.ts
│   ├── sms.ts
│   └── storage.ts
├── middleware/
│   ├── auth.ts                   # JWT verify (existing, hardened)
│   ├── rbac.ts                   # role/permission checks
│   ├── rateLimit.ts
│   ├── tenant.ts                 # branch-scoping (multi-branch)
│   ├── validate.ts               # Zod request validator
│   └── errorHandler.ts
├── workers/                      # background jobs
│   ├── renewal.worker.ts
│   ├── reminder.worker.ts
│   └── report.worker.ts
├── server.ts                     # express app composition
└── index.ts                      # entrypoint
```

### 4.3 Frontend Structure

```
apps/web/src/
├── app/                          # Next.js App Router
│   ├── (marketing)/              # public pages
│   │   └── page.tsx
│   ├── (auth)/
│   │   ├── login/
│   │   ├── register/
│   │   └── forgot/
│   ├── (admin)/                  # admin dashboard tree
│   │   ├── dashboard/
│   │   ├── members/
│   │   ├── trainers/
│   │   ├── classes/
│   │   ├── payments/
│   │   ├── reports/
│   │   └── settings/
│   ├── (trainer)/                # trainer dashboard tree
│   │   ├── dashboard/
│   │   ├── clients/
│   │   ├── schedule/
│   │   └── earnings/
│   ├── (member)/                 # member portal
│   │   ├── dashboard/
│   │   ├── classes/              # browse + book
│   │   ├── bookings/
│   │   ├── plan/
│   │   ├── payments/
│   │   └── progress/
│   └── api/                      # Next.js route handlers (BFF if needed)
├── components/
│   ├── ui/                       # shadcn primitives
│   ├── shared/                   # cross-role components (StatCard, etc.)
│   ├── admin/
│   ├── trainer/
│   └── member/
├── lib/
│   ├── api/                      # typed API client (generated from OpenAPI)
│   ├── auth/
│   ├── hooks/
│   └── utils/
└── styles/
    └── globals.css
```

---

## 5. Database Schema (v3)

The schema is delivered in full as `supabase-schema-v3.sql`. Highlights:

### 5.1 New Tables

| Table | Purpose |
|---|---|
| `branches` | Multi-location support (single row for now; foundation for franchising) |
| `members` | Replaces & extends `clients`; backed by `users` for login |
| `member_memberships` | Subscription instances (a member can have many over time) |
| `class_templates` | Definition of a class (Yoga, HIIT, Spin) |
| `class_schedules` | Recurring rules (every Mon/Wed 7am) |
| `class_sessions` | Concrete instances (Mon Apr 29 7am Yoga) |
| `bookings` | Member ↔ class_session, with status (confirmed/waitlist/cancelled/no-show) |
| `pt_sessions` | 1:1 personal training sessions |
| `notifications` | In-app inbox |
| `notification_log` | Outbound delivery log (email/wa/sms) |
| `audit_log` | Append-only mutation history |
| `body_metrics` | Generalizes `weight_logs` (weight, body_fat, measurements) |
| `holds_freezes` | Pause memberships (medical/travel) |

### 5.2 Modified Tables

- `users`: add `member_id`, `phone`, `avatar_url`, `mfa_enabled`, `branch_id`
- `clients` → kept for backward compat; new code uses `members`. View `clients_legacy` will alias.
- `payments`: add `gateway`, `gateway_txn_id`, `gateway_status`, `invoice_no`, `branch_id`
- All tables: `branch_id` for tenant scoping, `created_by`, `updated_by`

### 5.3 Why this design

- **Members table separate from users**: a household plan or guest pass has a member with no login.
- **Sessions split from schedules**: lets you cancel single instances ("Spin on Apr 30 cancelled") without touching the rule.
- **Bookings reference sessions, not schedules**: clean foreign keys, accurate capacity counts.
- **Notification log separate from inbox**: outbound delivery is operational data; inbox is product data.

### 5.4 Indexes (critical for scale)

```sql
-- listed in full in the SQL file
CREATE INDEX ON bookings (member_id, session_id);
CREATE INDEX ON class_sessions (starts_at) WHERE status='scheduled';
CREATE INDEX ON pt_sessions (trainer_id, starts_at);
CREATE INDEX ON payments (member_id, date DESC);
CREATE INDEX ON attendance (member_id, date DESC);
```

---

## 6. API Structure

REST, resource-oriented, versioned at `/api/v1/`. JSON in/out. Auth via `Authorization: Bearer <jwt>` and refresh-token cookie.

### 6.1 Endpoint Map (selected)

```
# Auth
POST   /api/v1/auth/register            # member self-signup
POST   /api/v1/auth/login
POST   /api/v1/auth/refresh
POST   /api/v1/auth/logout
POST   /api/v1/auth/forgot-password
POST   /api/v1/auth/reset-password
GET    /api/v1/auth/me

# Members  (admin sees all, trainer sees assigned, member sees self)
GET    /api/v1/members?status=&trainer_id=&plan=&search=&page=
POST   /api/v1/members                  # admin only
GET    /api/v1/members/:id
PATCH  /api/v1/members/:id
DELETE /api/v1/members/:id              # soft delete
GET    /api/v1/members/:id/payments
GET    /api/v1/members/:id/attendance
GET    /api/v1/members/:id/bookings
GET    /api/v1/members/:id/metrics      # body metrics history
POST   /api/v1/members/:id/freeze       # medical/travel hold

# Trainers
GET    /api/v1/trainers
POST   /api/v1/trainers
GET    /api/v1/trainers/:id
PATCH  /api/v1/trainers/:id
GET    /api/v1/trainers/:id/payouts?month=
GET    /api/v1/trainers/:id/clients
GET    /api/v1/trainers/:id/schedule?from=&to=

# Memberships & Plans
GET    /api/v1/plans
POST   /api/v1/plans
PATCH  /api/v1/plans/:id
GET    /api/v1/memberships?member_id=&status=
POST   /api/v1/memberships              # assign plan
POST   /api/v1/memberships/:id/renew
POST   /api/v1/memberships/:id/cancel

# Payments
GET    /api/v1/payments?from=&to=&trainer_id=&method=&status=
POST   /api/v1/payments                 # manual entry
GET    /api/v1/payments/:id
DELETE /api/v1/payments/:id
POST   /api/v1/payments/checkout        # creates Razorpay/Stripe intent
POST   /api/v1/payments/webhook         # gateway → us
GET    /api/v1/invoices/:id.pdf         # streams PDF

# Classes
GET    /api/v1/classes/templates
POST   /api/v1/classes/templates
GET    /api/v1/classes/schedules
POST   /api/v1/classes/schedules
GET    /api/v1/classes/sessions?from=&to=&trainer_id=
POST   /api/v1/classes/sessions/:id/cancel

# Bookings
GET    /api/v1/bookings?member_id=&from=&to=
POST   /api/v1/bookings                 # member books a session
DELETE /api/v1/bookings/:id             # cancel (policy enforced)
POST   /api/v1/bookings/:id/check-in    # QR or manual

# Personal Training
GET    /api/v1/pt-sessions?trainer_id=&member_id=&from=&to=
POST   /api/v1/pt-sessions
PATCH  /api/v1/pt-sessions/:id
DELETE /api/v1/pt-sessions/:id
POST   /api/v1/pt-sessions/:id/complete

# Attendance
GET    /api/v1/attendance?date=&type=
POST   /api/v1/attendance/check-in      # manual
POST   /api/v1/attendance/qr            # QR token verification

# Notifications
GET    /api/v1/notifications            # in-app inbox for current user
PATCH  /api/v1/notifications/:id/read
POST   /api/v1/notifications/broadcast  # admin: target by filter

# Reports
GET    /api/v1/reports/revenue?from=&to=&group_by=month|trainer|plan
GET    /api/v1/reports/retention?cohort=
GET    /api/v1/reports/trainer-payouts?month=
GET    /api/v1/reports/dues
GET    /api/v1/reports/export?type=&format=csv|pdf

# Settings (admin)
GET    /api/v1/settings
PATCH  /api/v1/settings

# Dashboard (role-aware aggregates)
GET    /api/v1/dashboard/admin
GET    /api/v1/dashboard/trainer
GET    /api/v1/dashboard/member
```

### 6.2 Standard response envelope

```json
{ "data": ..., "meta": { "page": 1, "total": 134, "pages": 7 } }
```

Errors:

```json
{ "error": { "code": "VALIDATION", "message": "amount must be positive", "fields": { "amount": "min" } } }
```

### 6.3 Pagination, filtering, sorting

- `?page=1&limit=25` (default 25, max 100)
- `?sort=-date,name` (prefix `-` for desc)
- Filters are explicit query params; no DSL.

### 6.4 RBAC matrix (excerpt)

| Endpoint | Admin | Trainer | Member |
|---|---|---|---|
| `GET /members` | all | only assigned | self only |
| `POST /members` | ✓ | ✗ | ✗ (uses /auth/register) |
| `POST /payments` | ✓ | ✗ | ✗ (uses /payments/checkout) |
| `POST /bookings` | ✓ for any member | ✗ | self only |
| `GET /reports/*` | ✓ | own only | ✗ |

---

## 7. UI Wireframes

### 7.1 Design System

- **Brand color (suggested)**: `#FF4500` orange-red (energy) with `#0F172A` slate-900 (premium)
- **Accent**: `#10B981` emerald (success/growth)
- **Typography**: Inter (UI) + Outfit (display)
- **Radius**: 12px cards, 8px inputs
- **Spacing scale**: Tailwind default (4px base)
- **Dark mode**: yes, via CSS vars

### 7.2 Admin Dashboard (desktop)

```
┌─────────────────────────────────────────────────────────────────┐
│ [619] Search…                              [🔔3] [Branch ▾] [👤]│
├─────────────┬───────────────────────────────────────────────────┤
│             │  Good morning, Admin 👋                           │
│ Dashboard   │                                                   │
│ Members     │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────┐ │
│ Trainers    │  │Members   │ │Revenue   │ │Dues      │ │Class │ │
│ Classes     │  │ 248 ↑12  │ │₹4.2L ↑8% │ │₹38k ↓5%  │ │ 12   │ │
│ Payments    │  │Active 232│ │MTD       │ │24 members│ │today │ │
│ Reports     │  └──────────┘ └──────────┘ └──────────┘ └──────┘ │
│ Settings    │                                                   │
│             │  ┌─────────────────────────┐ ┌──────────────────┐│
│ ─────────── │  │  Revenue (6 months)     │ │ Top Trainers     ││
│ [Branch1▾]  │  │  ▁▃▅▆█▇  bar/area chart │ │ 1. Riya  ₹85k    ││
│             │  └─────────────────────────┘ │ 2. Abhi  ₹72k    ││
│             │                              │ 3. Rajat ₹61k    ││
│             │  ┌─────────────────────────┐ └──────────────────┘│
│             │  │ Recent Activity         │                     │
│             │  │ • Priya paid ₹17k       │  ┌────────────────┐ │
│             │  │ • Rohit checked in      │  │ Expiring soon  │ │
│             │  │ • New member: Karan     │  │ 8 in 7 days    │ │
│             │  │ • Yoga 7am: 12/15 booked│  │ → Review        │ │
│             │  └─────────────────────────┘  └────────────────┘ │
└─────────────┴───────────────────────────────────────────────────┘
```

### 7.3 Trainer Dashboard

Top: profile chip + this-month earnings hero card (₹X total = ₹Y base + ₹Z incentive).

Tabs: **Today's Schedule | My Clients | Earnings | Performance**

- Today's Schedule: vertical timeline with PT slots and group classes the trainer leads, color-coded by client status.
- My Clients: card grid; each card shows member photo, plan, days remaining, last attendance, "Message" button.
- Earnings: month-over-month line chart + payout history table + payslip PDF download.
- Performance: retention rate of assigned clients, average attendance, NPS from feedback.

### 7.4 Member Portal (mobile-first)

```
┌──────────────────────┐
│ Hi, Priya 👋         │
│ Active · 47 days left│
│ ┌──────────────────┐ │
│ │ Plan progress    │ │
│ │ ████████░░  72%  │ │
│ └──────────────────┘ │
│                      │
│ Today                │
│ ┌──────────────────┐ │
│ │ 7:00 AM Yoga     │ │
│ │ with Riya        │ │
│ │ [Check in QR]    │ │
│ └──────────────────┘ │
│                      │
│ Quick actions        │
│ [Book class]         │
│ [Book PT]            │
│ [Pay dues ₹0]        │
│                      │
│ Progress             │
│   weight chart       │
│                      │
│ ┌──────────────────┐ │
│ │ Home Classes     │ │
│ │ Bookings Plan    │ │
│ │ Profile          │ │
│ └──────────────────┘ │
└──────────────────────┘
```

### 7.5 Class booking flow (Member)

1. **Browse** — calendar week-view, filter by trainer/type/time-of-day
2. **Detail sheet** — class info, capacity (12/15), trainer bio, "Book"
3. **Confirm** — uses included sessions or charges drop-in fee
4. **Manage** — Bookings tab; cancel respects policy (e.g., >2h prior = free, else 1 session forfeit)
5. **Check-in** — QR code shown 30min before; scanner at gym door

### 7.6 Empty states & micro-interactions

- All lists have intentional empty states with an illustrated icon + 1 line copy + 1 CTA. (v2 already does this on payments — extend everywhere.)
- Skeleton loaders, not spinners, on dashboards.
- Optimistic UI for booking/cancel/check-in.

---

## 8. Sample Code

Delivered as actual files in this repo (see "Files Created" at the end). Highlights:

- `supabase-schema-v3.sql` — full v3 schema
- `backend/src/modules/members/*` — production-ready CRUD example
- `backend/src/modules/bookings/*` — class booking with capacity + waitlist
- `backend/src/modules/notifications/*` — multi-channel notifier
- `backend/src/middleware/rbac.js` — role/permission middleware
- `frontend/src/app/(member)/dashboard/page.tsx` — modern member dashboard

---

## 9. Improvements Beyond Glofox

Glofox is great but has gaps. v3 differentiators:

1. **WhatsApp-first**, not email-first. India runs on WhatsApp. Booking confirmations, reminders, payment links — all WA.
2. **UPI-native checkout** with Razorpay; auto-renewal via UPI mandate (e-NACH).
3. **Trainer marketplace** (future): members can browse trainers by specialization and request a session — converts hesitant members.
4. **Body composition AI** — upload front/side photos; track changes over time. Uses an open vision model server-side.
5. **Workout journal** with PR (personal record) tracking and exercise library with video demos.
6. **Referral program** built-in with auto-credit on successful conversion.
7. **No-show prediction** — simple model on booking history flags likely no-shows so trainers can intervene.
8. **Branch P&L** — for multi-location, real income vs cost (rent/salary/utilities) per branch, not just revenue.
9. **Member-NPS auto-survey** after every 5th visit; routes detractors to a manager call.
10. **Open API + Zapier app** so gym owners can wire to their own tools.
11. **Offline-first PWA** for the member app — book/check-in works on flaky cell.
12. **Audit log everywhere** (most SaaS have this only for admin actions; we log member-facing too — invaluable for disputes).

---

## 10. Migration Plan from v2 → v3

| Phase | Duration | Scope |
|---|---|---|
| 0 | 1 wk | Apply v3 schema migration (additive, zero downtime) |
| 1 | 2 wk | Member role + member portal MVP (login, view membership, payment history) |
| 2 | 2 wk | Class templates + schedules + sessions + bookings |
| 3 | 1 wk | QR attendance + auto-booking from PT |
| 4 | 2 wk | Razorpay integration + auto-renewal worker |
| 5 | 1 wk | Notifications service (email + WhatsApp) |
| 6 | 2 wk | Reports module + PDF export |
| 7 | 1 wk | UI redesign rollout (Tailwind/shadcn theme) |
| 8 | ongoing | Beyond-Glofox features |

Total to feature-parity with Glofox: **~12 weeks** with 1 mid-level full-stack engineer + part-time designer.

---

## 11. Operational Concerns

- **Backups**: Supabase PITR enabled; daily logical dump to S3.
- **Secrets**: Vercel env vars + Doppler for backend.
- **Observability**: Sentry (errors), PostHog (product), Better Stack (logs/uptime).
- **Compliance**: data residency (Mumbai region for India), GDPR-style export/delete endpoints, signed audit log.
- **Rate limiting**: per-IP and per-user; stricter on `/auth/*`.
- **Security**: bcrypt cost 12, JWT 15min + refresh 7d in httpOnly cookie, CORS allowlist, helmet, CSP.

---

## Files Created in This Plan

1. `ARCHITECTURE.md` (this file)
2. `supabase-schema-v3.sql` — full v3 schema with seed
3. `backend/src/modules/` — scaffold for new modules
4. `backend/src/middleware/rbac.js` — permission middleware
5. `frontend/src/app/(member)/dashboard/page.tsx` — sample member dashboard
6. `frontend/src/components/ui/` — sample Tailwind/shadcn components
7. `wireframes.html` — interactive UI mock you can open in a browser
