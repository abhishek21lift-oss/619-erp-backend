# Client Self-Booking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A PT client books, reschedules and cancels sessions inside the trainer's published weekly availability, with 24 h / 2 h reminders and a read-only ICS calendar feed.

**Architecture:** Availability windows, time off and per-trainer booking settings live in three new tables (migration 245). Free slots are computed on read from those windows minus `scheduled` rows in `pt_sessions`; a partial unique index makes double-booking impossible. Client routes hang off `/api/me` (identity from token), trainer routes off `/api/pt-os`, the ICS feed off the unauthenticated `/api/public`. Reminders are a 15-minute BullMQ job on the existing automation queue.

**Tech Stack:** Node 22 / Express / PostgreSQL 17 (Supabase), Jest + Supertest (backend); Next.js 15 App Router, TypeScript, Tailwind, Vitest, Playwright (frontend). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-30-client-self-booking-design.md`

**Worktrees (already created):**
- Backend: `/home/oem/Desktop/myptstudio/619-erp-backend/.worktrees/self-booking-backend` — branch `feat/client-self-booking`
- Frontend: `/home/oem/Desktop/myptstudio/619-erp-frontend/.worktrees/self-booking-frontend` — branch `feat/client-self-booking`

## Global Constraints

- `session_date` and `start_time` are IST wall-clock values. Never convert a stored value; convert "now" into IST when comparing (`nowUTC + 330 minutes`, read with UTC getters) and mark it `shortcut:`.
- Client identity comes only from `req.user.pt_client_id`; no client, org or trainer id is read from a client request.
- Every tenant query binds `organization_id`.
- New tables: `ENABLE ROW LEVEL SECURITY`, `tenant_isolation` policy for `app_tenant` using `current_setting('app.org_id', true)`, and `GRANT SELECT, INSERT, UPDATE, DELETE` to `app_tenant` — copy migration 227 exactly.
- Migration number is `245`. Do not reuse the removed gym route paths (`/api/calendar`, `/api/bookings`, `/api/plans`).
- No new npm dependencies on either side.
- Times in API payloads are `'HH:MM'` strings; dates are `'YYYY-MM-DD'`.

## Review Focus

1. Double-tap / two devices on the same slot → exactly one `scheduled` row, the second request gets 409 `SLOT_TAKEN`.
2. Reschedule to a slot taken a moment earlier → the original booking is still there and unchanged.
3. A 07:00 IST session reminds at 07:00 IST 24 h before, not 12:30 IST or a day early (UTC vs IST conversion).
4. Trainer shrinks availability or adds time off over existing bookings → nothing is cancelled silently; conflicts are reported.
5. Client cancels after the cutoff → 409 `CANCEL_CUTOFF_PASSED` and the session stays `scheduled`.

---

### Task 1: Migration 245

**Files:**
- Create: `src/db/migrations/245_client_self_booking.sql`
- Test: `src/__tests__/booking.migration.test.js`

**Interfaces:**
- Produces: tables `trainer_availability`, `trainer_time_off`, `trainer_booking_settings`; index `pt_sessions_trainer_slot_uniq`; automation trigger `session_reminder`.

- [ ] **Step 1: Write the failing test**

Follow the static-SQL assertion style of `src/__tests__/activityLogOrgId.migration.test.js`:

```js
const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '245_client_self_booking.sql'), 'utf8');
const body = sql.replace(/--[^\n]*/g, ' ');

it('creates the three tables and the slot index', () => {
  expect(body).toMatch(/CREATE TABLE IF NOT EXISTS trainer_availability/);
  expect(body).toMatch(/CREATE TABLE IF NOT EXISTS trainer_time_off/);
  expect(body).toMatch(/CREATE TABLE IF NOT EXISTS trainer_booking_settings/);
  expect(body).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS pt_sessions_trainer_slot_uniq\s+ON pt_sessions \(trainer_id, session_date, start_time\)\s+WHERE deleted_at IS NULL AND status = 'scheduled' AND start_time IS NOT NULL/);
});
it('adds session_reminder to the trigger CHECK without dropping data', () => {
  expect(body).toContain("'session_reminder'");
  expect(body).toMatch(/DROP CONSTRAINT IF EXISTS automation_rules_trigger_event_check/);
  expect(body).not.toMatch(/DROP TABLE|TRUNCATE|DELETE FROM/i);
});
it('is tenant-scoped like migration 227', () => {
  expect(body.match(/ENABLE ROW LEVEL SECURITY/g)).toHaveLength(3);
  expect(body).toContain("current_setting('app.org_id', true)");
  expect(body).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON trainer_availability TO app_tenant/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/__tests__/booking.migration.test.js --runInBand`
Expected: FAIL — file not found.

- [ ] **Step 3: Write the migration**

Schema exactly as the spec's Data model section. Before the unique index, block on duplicates:

```sql
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM (
    SELECT 1 FROM pt_sessions
     WHERE deleted_at IS NULL AND status = 'scheduled' AND start_time IS NOT NULL
     GROUP BY trainer_id, session_date, start_time HAVING count(*) > 1
  ) d;
  IF n > 0 THEN RAISE EXCEPTION '245: % duplicate scheduled slot(s); resolve before applying', n; END IF;
END $$;
```

Then the index, then `ALTER TABLE automation_rules DROP CONSTRAINT IF EXISTS ...` and re-add the full 14-value CHECK from migration 222 plus `'session_reminder'`.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx jest src/__tests__/booking.migration.test.js --runInBand`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations/245_client_self_booking.sql src/__tests__/booking.migration.test.js
git commit -m "feat(booking): schema for availability, time off and settings"
```

---

### Task 2: Slot computation service

**Files:**
- Create: `src/modules/pt-os/availability.service.js`
- Test: `src/__tests__/booking.availability.test.js`

**Interfaces:**
- Produces:
  - `computeSlots({ availability, timeOff, sessions, fromDate, days, settings, nowDate, nowMinutes })` → `[{ date, slots: [{ start: 'HH:MM', end: 'HH:MM' }] }]`
  - `DEFAULT_SETTINGS` = `{ slot_minutes: 60, buffer_minutes: 0, min_notice_hours: 12, horizon_days: 30, cancel_cutoff_hours: 12 }`
  - `settingsFor(orgId, trainerId)` → settings row merged over `DEFAULT_SETTINGS`
  - `freeSlots(orgId, trainerId, { days })` → `{ days, settings }`
  - `istNow()` → `{ date: 'YYYY-MM-DD', minutes: 123 }`
  - `toMinutes('HH:MM')` → number; `toTime(510)` → `'08:30'`
  - `slotIsFree(orgId, trainerId, date, startTime, { excludeSessionId })` → boolean

- [ ] **Step 1: Write the failing tests** (pure `computeSlots`, no DB)

```js
const base = { fromDate: '2026-11-02', days: 1, nowDate: '2026-11-01', nowMinutes: 0,
  availability: [{ weekday: 1, start_time: '07:00', end_time: '10:00' }],
  timeOff: [], sessions: [], settings: { slot_minutes: 60, buffer_minutes: 0, min_notice_hours: 0 } };

it('steps slots from the window start and stops at the window end', () => {
  expect(computeSlots(base)[0].slots.map(s => s.start)).toEqual(['07:00', '08:00', '09:00']);
});
it('removes slots that collide with a booked session', () => {
  const r = computeSlots({ ...base, sessions: [{ session_date: '2026-11-02', start_time: '08:00', end_time: '09:00' }] });
  expect(r[0].slots.map(s => s.start)).toEqual(['07:00', '09:00']);
});
it('applies min notice only to today', () => {
  const today = computeSlots({ ...base, fromDate: '2026-11-01', nowDate: '2026-11-01', nowMinutes: 6 * 60 + 30,
    availability: [{ weekday: 0, start_time: '07:00', end_time: '10:00' }] });
  expect(today[0].slots).toEqual([]); // 12 h notice leaves nothing after 06:30
  const future = computeSlots({ ...base, days: 2, nowDate: '2026-11-01', nowMinutes: 6 * 60 + 30,
    availability: [{ weekday: 0, start_time: '07:00', end_time: '10:00' }, { weekday: 1, start_time: '07:00', end_time: '10:00' }] });
  expect(future[1].slots.map(s => s.start)).toEqual(['07:00', '08:00', '09:00']);
});
it('skips days covered by time off and returns `days` entries', () => {
  const r = computeSlots({ ...base, days: 3, timeOff: [{ starts_on: '2026-11-02', ends_on: '2026-11-02' }] });
  expect(r).toHaveLength(3);
  expect(r[0].slots).toHaveLength(0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/__tests__/booking.availability.test.js --runInBand`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`computeSlots` is pure. Busy interval for a session is `[start, end + buffer_minutes]`. A candidate is kept when `candidateEnd <= windowEnd` and it does not overlap any busy interval and, on `nowDate` only, `start >= nowMinutes + min_notice_hours * 60`.

`freeSlots` queries the three tables, clamps `days` to `settings.horizon_days`, and calls `computeSlots`.

```js
const istNow = () => {
  const ist = new Date(Date.now() + 330 * 60 * 1000); // shortcut: IST only, add tz column when the product leaves India
  return { date: ist.toISOString().slice(0, 10), minutes: ist.getUTCHours() * 60 + ist.getUTCMinutes() };
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/__tests__/booking.availability.test.js --runInBand`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/pt-os/availability.service.js src/__tests__/booking.availability.test.js
git commit -m "feat(booking): compute free slots from availability minus sessions"
```

---

### Task 3: Trainer availability, time off and settings API

**Files:**
- Create: `src/modules/pt-os/availability.routes.js`
- Modify: `src/server.js` (add mount after line 962: `app.use('/api/pt-os', auth, requireTrainer, require('./modules/pt-os/availability.routes'));`)
- Test: `src/__tests__/booking.trainer.routes.test.js`

**Interfaces:**
- Consumes: `settingsFor` from Task 2, `resolveTrainerId(pool, orgId, requested)` from `src/lib/studioTrainer.js`.
- Produces routes (all under `/api/pt-os`):
  - `GET /availability` → `{ data: { windows, timeOff, settings } }`
  - `PUT /availability` `{ windows: [{ weekday, start_time, end_time }] }` → `{ data }`
  - `GET /time-off`, `POST /time-off` `{ starts_on, ends_on, reason? }`, `DELETE /time-off/:id`
  - `GET /booking-settings`, `PUT /booking-settings` (body: slot_minutes, buffer_minutes, min_notice_hours, horizon_days, cancel_cutoff_hours)

- [ ] **Step 1: Write the failing tests**

Use the Supertest + `jest.mock('../db/pool')` pattern of `src/__tests__/aiKnowledge.routes.test.js`. Mount the router on a bare Express app with `auth` mocked to set `req.user = { id: 'u1', role: 'trainer', organization_id: 'org-1', trainer_id: 't1' }` and `requireTrainer` as a pass-through.

Assertions:
- `PUT /availability` with `[{weekday:1,start_time:'07:00',end_time:'10:00'},{weekday:1,start_time:'09:00',end_time:'12:00'}]` → 400 `{ code: 'WINDOWS_OVERLAP' }`, and `pool.query` never called with `INSERT INTO trainer_availability`.
- `PUT /availability` with `end_time <= start_time` → 400 `WINDOWS_INVALID`.
- Valid PUT → 200, and queries include `BEGIN` … `DELETE FROM trainer_availability WHERE trainer_id = $1 AND organization_id = $2` … `COMMIT`.
- `POST /time-off` when the overlap query returns one row → 409 `TIME_OFF_CONFLICT` with the conflicting dates.
- `PUT /booking-settings` with `slot_minutes: 10` → 400 `SETTINGS_INVALID`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/__tests__/booking.trainer.routes.test.js --runInBand`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

Validation ranges: `slot_minutes` 15–240, `buffer_minutes` 0–60, `min_notice_hours` 0–168, `horizon_days` 1–90, `cancel_cutoff_hours` 0–168. Overlap check per weekday after sorting by `start_time`.

`PUT /booking-settings` upserts and, when no row existed, inserts `crypto.randomBytes(32).toString('hex')` as `ics_token`. The token is returned in `GET /booking-settings` and never regenerated by an update.

`PUT /availability` must count future booked sessions that fall outside the new windows and return them as `warnings: [{ id, session_date, start_time }]` — it does not cancel them.

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/__tests__/booking.trainer.routes.test.js --runInBand`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/pt-os/availability.routes.js src/server.js src/__tests__/booking.trainer.routes.test.js
git commit -m "feat(booking): trainer availability, time off and settings API"
```

---

### Task 4: Client booking API

**Files:**
- Create: `src/modules/client-portal/client-booking.routes.js`
- Modify: `src/server.js` (add after line 976: `app.use('/api/me', auth, requireClient, require('./modules/client-portal/client-booking.routes'));`)
- Test: `src/__tests__/booking.client.routes.test.js`

**Interfaces:**
- Consumes: `freeSlots`, `slotIsFree`, `settingsFor`, `istNow`, `toTime` from Task 2; `checkTrainingEligibility(req, clientId, { action: 'book_session' })` from `src/lib/screeningGate.js`; `settings cancel_cutoff_hours`.
- Produces routes (all under `/api/me`):
  - `GET /booking/availability` → `{ data: { days, settings: { slot_minutes, cancel_cutoff_hours, horizon_days } } }`
  - `GET /booking` → `{ data: [{ id, session_date, start_time, end_time, duration_minutes, status, can_cancel }] }`
  - `POST /booking` `{ date, start }` → 201 `{ data: session }`
  - `PATCH /booking/:id` `{ date, start }` → 200 `{ data: session }`
  - `DELETE /booking/:id` → 200 `{ data: { id, status: 'cancelled' } }`

- [ ] **Step 1: Write the failing tests**

Same Supertest pattern, `requireClient` pass-through, `req.user = { id: 'usr-client-1', role: 'member', organization_id: 'org-1', pt_client_id: 'c1' }`.

Assertions:
- POST body `{ date: '2026-11-02', start: '07:00', client_id: 'someone-else' }` → INSERT binds `client_id = 'c1'` (from token), never `someone-else`.
- Slot not in `freeSlots` → 400 `OUTSIDE_AVAILABILITY`; no INSERT.
- Pool rejects with `{ code: '23505' }` → 409 `SLOT_TAKEN`.
- DELETE on a session starting inside the cutoff → 409 `CANCEL_CUTOFF_PASSED`; no UPDATE executed.
- PATCH where the slot check fails → 409 `SLOT_TAKEN`, and the statement `UPDATE pt_sessions` is never run.
- `GET /booking` sets `can_cancel: false` for a row inside the cutoff.

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/__tests__/booking.client.routes.test.js --runInBand`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

Resolve the client's trainer with `SELECT trainer_id FROM pt_clients WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`; `null` → 409 `NO_TRAINER`. Run `checkTrainingEligibility` before every INSERT and PATCH. INSERT columns: `client_id, trainer_id, title ('PT Session'), session_date, start_time, end_time, duration_minutes, created_by (req.user.id), session_type ('1-on-1'), organization_id`. `end_time` = start + `settings.slot_minutes`.

Cutoff helper: `sessionStartsAt(date, start, istNow()) <= now + cutoff_hours * 60` → not cancellable.

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/__tests__/booking.client.routes.test.js --runInBand`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/client-portal/client-booking.routes.js src/server.js src/__tests__/booking.client.routes.test.js
git commit -m "feat(booking): client availability, book, reschedule and cancel"
```

---

### Task 5: Session reminders (24 h and 2 h)

**Files:**
- Create: `src/modules/pt-os/session-reminders.js`
- Modify: `src/modules/automation/automation.engine.js` (`TRIGGER_EVENTS` add `'session_reminder'`)
- Modify: `src/modules/automation/automation.triggers.js` (add `sessionReminderFor`)
- Modify: `src/workers/automation.worker.js` (new scheduler `pt-session-reminders`, cron `*/15 * * * *`, job name `session-reminders`)
- Test: `src/__tests__/booking.reminders.test.js`

**Interfaces:**
- Produces: `runSessionReminders()` → `{ orgs, sent, skipped }`; `triggers.sessionReminderFor(orgId, { clientId, sessionId, date, time, when, name, bucket })`.

- [ ] **Step 1: Write the failing tests**

Mock `pool`, `automation.repository` (`orgsWithAutomationOn`, `activeTriggerEventsFor`), and `automation.triggers`. Freeze time with `jest.useFakeTimers().setSystemTime(new Date('2026-11-01T01:00:00Z'))` (= 06:30 IST).

Assertions:
- An org with no `session_reminder` rule is skipped and never queried.
- A session at `2026-11-02 06:30` IST is picked for the `24h` bucket and `sessionReminderFor` is called with `bucket: '24h'` and `sessionId: 's1'`.
- The `notifications` INSERT uses `NOT EXISTS` so a second run in the same window writes one row.
- A session already `completed`/`cancelled` is not selected.

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/__tests__/booking.reminders.test.js --runInBand`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

Mirror `automation.sweep.js`: loop over `orgsWithAutomationOn()`, filter `activeTriggerEventsFor(orgId)` to `session_reminder`, then run two queries per org (one per bucket). Each query is `session_date = $date AND start_time BETWEEN $lo AND $hi AND status = 'scheduled' AND deleted_at IS NULL` with the IST window computed from `Date.now() + 330 min ± 15 min`. For each row: insert the in-app notification (`type 'session_reminder'`, `link '/member/book'`, `NOT EXISTS` on `ref_id = session id`), then emit with `eventKey: '${id}:${bucket}'` and context `{ date, time, when, name }`.

Register the scheduler exactly like `TERM_EXPIRY_JOB_ID`, with `attempts: 1` and `removeOnComplete: true`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/__tests__/booking.reminders.test.js --runInBand`
Expected: PASS. Also run `npx jest src/__tests__/automation.engine.test.js --runInBand` — it asserts `TRIGGER_EVENTS` matches the DB constraint; keep it green.

- [ ] **Step 5: Commit**

```bash
git add src/modules/pt-os/session-reminders.js src/modules/automation/automation.engine.js src/modules/automation/automation.triggers.js src/workers/automation.worker.js src/__tests__/booking.reminders.test.js
git commit -m "feat(booking): 24h and 2h session reminders"
```

---

### Task 6: ICS calendar feed

**Files:**
- Create: `src/routes/calendar-feed.js`
- Modify: `src/server.js` (line 723 area: `app.use('/api/public', require('./routes/calendar-feed'));`)
- Test: `src/__tests__/booking.ics.test.js`

**Interfaces:**
- Produces: `GET /api/public/calendar/:token.ics` → `text/calendar`.

- [ ] **Step 1: Write the failing tests**

- Unknown token (settings lookup returns 0 rows) → 404.
- Valid token, one scheduled session on `2026-11-02 07:00` → 200, `content-type` starts with `text/calendar`, body contains `BEGIN:VCALENDAR`, `DTSTART:20261102T070000` (floating local time — intentional), `SUMMARY:PT Session`, `UID:s1@myptstudio`.
- Cancelled session is absent.
- Response has `Cache-Control: no-store`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/__tests__/booking.ics.test.js --runInBand`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

Look up `trainer_booking_settings` by `ics_token`, then sessions for that org/trainer in the next 90 days with `status = 'scheduled'`. Emit `BEGIN:VCALENDAR / VERSION:2.0 / PRODID:-//MyPTStudio//EN`, one `VEVENT` per session, `END:VCALENDAR`. Escape `, ; \` and newlines in text fields. `DTSTAMP` is UTC; `DTSTART`/`DTEND` are floating `YYYYMMDDTHHMMSS`. No token echo in errors.

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/__tests__/booking.ics.test.js --runInBand`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/calendar-feed.js src/server.js src/__tests__/booking.ics.test.js
git commit -m "feat(booking): read-only ICS feed per trainer"
```

---

### Task 7: Frontend API client and types

**Files:**
- Modify: `src/lib/api/endpoints/ptOs.ts` (inside `export const pt`)
- Modify: `src/lib/api/endpoints/platform.ts` (inside `export const me`)
- Modify: `src/lib/api/types.ts`
- Test: `src/__tests__/api-shape.test.ts` (snapshot)

**Interfaces:**
- Produces: `api.pt.availability`, `api.pt.saveAvailability`, `api.pt.timeOff`, `api.pt.addTimeOff`, `api.pt.removeTimeOff`, `api.pt.bookingSettings`, `api.pt.saveBookingSettings`, `api.me.bookingAvailability`, `api.me.bookings`, `api.me.book`, `api.me.rescheduleBooking`, `api.me.cancelBooking`.
- Types: `AvailabilityWindow { weekday: number; start_time: string; end_time: string }`, `TimeOff { id: string; starts_on: string; ends_on: string; reason: string | null }`, `BookingSettings { slot_minutes: number; buffer_minutes: number; min_notice_hours: number; horizon_days: number; cancel_cutoff_hours: number; ics_token: string | null }`, `TrainerAvailability { windows: AvailabilityWindow[]; timeOff: TimeOff[]; settings: BookingSettings }`, `MeBooking { id: string; session_date: string; start_time: string; end_time: string; duration_minutes: number; status: string; can_cancel: boolean }`, `MeBookingAvailability { days: { date: string; slots: { start: string; end: string }[] }[]; settings: { slot_minutes: number; cancel_cutoff_hours: number; horizon_days: number } }`.

- [ ] **Step 1: Write the failing test** — add one assertion per new method to `api-shape.test.ts` style, e.g. `expect(api.me.book).toBeTypeOf('function')`, `expect(api.pt.saveAvailability).toBeTypeOf('function')`. Run it first.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/__tests__/api-shape.test.ts`
Expected: FAIL — `api.me.book is not a function`.

- [ ] **Step 3: Implement** the methods in the two endpoint modules and the types in `types.ts`. URLs and methods exactly as Task 3/4 produce.

- [ ] **Step 4: Update the snapshot and re-run**

Run: `npx vitest run src/__tests__/api-shape.test.ts -u && npx vitest run src/__tests__/api-shape.test.ts`
Expected: PASS, snapshot contains the new endpoints.

- [ ] **Step 5: Commit**

```bash
git add src/lib/api src/__tests__/api-shape.test.ts src/__tests__/__snapshots__
git commit -m "feat(api): booking endpoints and types"
```

---

### Task 8: Member booking screen

**Files:**
- Create: `src/app/(bare)/member/book/page.tsx`
- Modify: `src/lib/nav-config.ts` (member group, before Payments: `{ href: '/member/book', label: 'Book', icon: 'CalendarPlus', roles: ['member'] }`)
- Test: `src/__tests__/member-booking.test.tsx`

**Interfaces:**
- Consumes: `api.me.bookingAvailability`, `api.me.bookings`, `api.me.book`, `api.me.rescheduleBooking`, `api.me.cancelBooking`.

- [ ] **Step 1: Write the failing test** (Vitest + jsdom, `vi.mock('@/lib/api')`)

- Renders one button per slot from a two-slot fixture.
- Clicking `07:00` then the confirm button calls `api.me.book('2026-11-02', '07:00')`.
- A row with `can_cancel: false` renders "Contact your trainer" and no Cancel button.
- Empty `days` renders "Your trainer hasn't opened booking yet."

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/__tests__/member-booking.test.tsx`
Expected: FAIL — cannot resolve page module.

- [ ] **Step 3: Implement the page** — `'use client'`, `Guard role="member"`, `MemberShell`, `PageTitle`; day strip + slot chips; "My sessions" list with Reschedule (reuses the picker in `rescheduleId` mode) and Cancel (confirm dialog); `useToast` + `errorMessage` for 409s; refetch after each mutation.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/__tests__/member-booking.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add 'src/app/(bare)/member/book/page.tsx' src/lib/nav-config.ts src/__tests__/member-booking.test.tsx
git commit -m "feat(member): book, reschedule and cancel a session"
```

---

### Task 9: Trainer availability screen

**Files:**
- Create: `src/lib/booking/availability.ts`
- Create: `src/app/(chrome)/pt-os/availability/page.tsx`
- Modify: `src/lib/nav-config.ts` (sessions group: `{ href: '/pt-os/availability', label: 'Availability', icon: 'CalendarClock' }`)
- Test: `src/__tests__/availability-windows.test.ts`

**Interfaces:**
- Produces: `validateWindows(windows: AvailabilityWindow[]): string | null` (null = valid) and `toMinutes(t: string): number` in `src/lib/booking/availability.ts`.

- [ ] **Step 1: Write the failing test**

- Overlapping same-weekday windows → `'Monday windows overlap.'`
- `end_time <= start_time` → `'Monday window ends before it starts.'`
- Valid three-window week → `null`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/__tests__/availability-windows.test.ts`
Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Implement** the validator, then the page: seven weekday rows with add/remove window, time-off list with date range + reason, settings form (slot minutes, buffer, notice, horizon, cutoff), ICS URL read-only input with Copy and `https://calendar.google.com/calendar/render?cid=webcal%3A%2F%2F...` link, and a reminder hint linking to `/engagement/automation`. Save via `api.pt.saveAvailability` / `addTimeOff` / `saveBookingSettings`; show server 409s through `errorMessage`.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/__tests__/availability-windows.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add 'src/app/(chrome)/pt-os/availability/page.tsx' src/lib/booking/availability.ts src/lib/nav-config.ts src/__tests__/availability-windows.test.ts
git commit -m "feat(trainer): publish availability, time off and booking settings"
```

---

### Task 10: End-to-end booking flow

**Files:**
- Create: `e2e/booking.api.spec.ts`

**Interfaces:**
- Consumes: `apiToken()`, `memberApiToken()`, `apiGet`, `apiPost`, `apiPut`, `apiDelete` from `e2e/helpers/session.ts`.

- [ ] **Step 1: Write the failing spec**

```ts
test('trainer publishes a slot, member books it, trainer sees it, member cancels', async ({ request }) => {
  const trainer = await apiToken();
  const member = await memberApiToken();
  const day = nextWeekdayIso();            // helper in the spec: tomorrow .. +7, skip today
  await apiPut('/api/pt-os/availability', trainer, { windows: [{ weekday: new Date(day).getUTCDay(), start_time: '07:00', end_time: '09:00' }] });
  const avail = await apiGet<any>('/api/me/booking/availability', member);
  const slots = avail.data.days.find((d: any) => d.date === day).slots;
  expect(slots.length).toBeGreaterThan(0);
  const booked = await apiPost<any>('/api/me/booking', member, { date: day, start: slots[0].start });
  const sessions = await apiGet<any>('/api/pt-os/sessions?date=' + day, trainer);
  expect(sessions.data.some((s: any) => s.id === booked.data.id)).toBe(true);
  const code = await apiDelete('/api/me/booking/' + booked.data.id, member);
  expect(code).toBe(200);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx playwright test e2e/booking.api.spec.ts`
Expected: FAIL — page/route not implemented or availability empty.

- [ ] **Step 3: Fix only what the failure names** (no new features).

- [ ] **Step 4: Run it to verify it passes**

Run: `npx playwright test e2e/booking.api.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add e2e/booking.api.spec.ts
git commit -m "test(e2e): trainer publishes, member books and cancels"
```

---

## Final verification (both worktrees)

```bash
# backend
npx jest src/__tests__/booking --runInBand
npx jest src/__tests__/automation.engine.test.js --runInBand
npx eslint src/modules/pt-os/availability.service.js src/modules/pt-os/availability.routes.js \
  src/modules/client-portal/client-booking.routes.js src/modules/pt-os/session-reminders.js \
  src/routes/calendar-feed.js src/db/migrations/245_client_self_booking.sql

# frontend
npx vitest run
npx tsc --noEmit
npx eslint src/app/'(bare)'/member/book/page.tsx src/app/'(chrome)'/pt-os/availability/page.tsx src/lib/booking
npm run build
```

Production deploy is a separate approval step; migration 245 applies during the backend deploy.
