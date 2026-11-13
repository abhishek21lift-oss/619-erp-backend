# Trainer-Controlled Client Self Workout — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A trainer-controlled, server-backed self-workout lifecycle for members, with submission review and feedback.

**Architecture:** Extend the canonical `workout_sessions` family. A member session is created `in_progress` with a prescription snapshot and a draft JSONB; autosave writes the draft; submit materialises `workout_session_exercises`/`workout_sets` once and marks the session `completed` with `review_status = 'pending'`. Trainer review is a guarded write on the same row.

**Tech Stack:** Express 5 + node-postgres + Jest (backend), Next.js 16 App Router + React 19 + Vitest (frontend), PostgreSQL migrations.

**Spec:** `docs/superpowers/specs/2026-11-13-trainer-controlled-self-workout-design.md`

## Global Constraints

- Permission column is `pt_clients.allow_self_workout BOOLEAN NOT NULL DEFAULT FALSE`.
- Member identity is always `req.user.pt_client_id` + `req.user.organization_id`.
- Every trainer query is org-scoped; every by-id miss is a 404, never a 403.
- Migration 283 is additive, idempotent, and has no `BEGIN`/`COMMIT`.
- No new workout/session table. No change to trainer-led session semantics.
- Submitted member sessions are immutable to members; trainer set/exercise writes are refused.
- Permission is required to start and to use the legacy one-shot log; it is **not** re-checked for autosave/submit of an existing session.
- Do not deploy or run a production migration.

## Review Focus

- A trainer revokes permission while a session is open: the member can still autosave and submit it.
- Two Start taps or a retried request: exactly one open session is returned.
- Autosave/submit after submission: `409`, and no row changes.
- A session id from another client or studio: `404`, with no leak of existence.
- A PAR-Q-blocked client: `403`, and no session is created.
- A dropped connection mid-workout: the server draft and the local draft both recover the sets.
- A trainer opening a submitted member session: exercise/set edits are refused.

---

## Task 1: Migration 283

**Files:**
- Create: `src/db/migrations/283_trainer_controlled_self_workout.sql`
- Test: `src/__tests__/selfWorkout.migration.test.js`

**Interfaces:**
- Produces columns used by every later task: `pt_clients.allow_self_workout`;
  `workout_sessions.prescribed`, `.draft`, `.started_at`, `.submitted_at`,
  `.review_status`, `.reviewed_by`, `.reviewed_at`, `.review_feedback`;
  `workout_session_exercises.prescribed_index`.

- [ ] **Step 1: Write the failing migration test**

Read the SQL file and assert the contract (same style as `booking.migration.test.js`):

```js
const sql = fs.readFileSync(path.join(__dirname, '..', 'db/migrations/283_trainer_controlled_self_workout.sql'), 'utf8');
expect(sql).toMatch(/ALTER TABLE pt_clients[\s\S]*allow_self_workout BOOLEAN NOT NULL DEFAULT FALSE/i);
expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS prescribed JSONB/i);
expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS draft JSONB/i);
expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ/i);
expect(sql).toMatch(/review_status IN \('pending','approved','changes_requested'\)/i);
expect(sql).toMatch(/prescribed_index INTEGER/i);
expect(sql).not.toMatch(/\bBEGIN\b|\bCOMMIT\b/i);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/__tests__/selfWorkout.migration.test.js --runInBand`
Expected: FAIL — file not found.

- [ ] **Step 3: Write the migration**

```sql
-- 283_trainer_controlled_self_workout.sql
-- Additive: a trainer-controlled permission, a server-side in-progress member
-- session, a prescription snapshot, and the trainer review state.

ALTER TABLE pt_clients
  ADD COLUMN IF NOT EXISTS allow_self_workout BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE workout_sessions
  ADD COLUMN IF NOT EXISTS prescribed JSONB,
  ADD COLUMN IF NOT EXISTS draft JSONB,
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS review_status TEXT,
  ADD COLUMN IF NOT EXISTS reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS review_feedback TEXT;

ALTER TABLE workout_sessions DROP CONSTRAINT IF EXISTS workout_sessions_review_status_check;
ALTER TABLE workout_sessions ADD CONSTRAINT workout_sessions_review_status_check
  CHECK (review_status IS NULL OR review_status IN ('pending','approved','changes_requested'));

ALTER TABLE workout_sessions DROP CONSTRAINT IF EXISTS workout_sessions_review_is_member;
ALTER TABLE workout_sessions ADD CONSTRAINT workout_sessions_review_is_member
  CHECK (review_status IS NULL OR source = 'member');

UPDATE workout_sessions SET started_at = created_at WHERE started_at IS NULL;

ALTER TABLE workout_session_exercises
  ADD COLUMN IF NOT EXISTS prescribed_index INTEGER;

CREATE INDEX IF NOT EXISTS workout_sessions_pending_review_idx
  ON workout_sessions (organization_id, submitted_at DESC)
  WHERE review_status = 'pending';

COMMENT ON COLUMN pt_clients.allow_self_workout IS
  'Trainer-controlled: may this client start a workout in the member app without the trainer?';
COMMENT ON COLUMN workout_sessions.prescribed IS
  'Snapshot of the plan day the member was shown when the session started.';
COMMENT ON COLUMN workout_sessions.draft IS
  'Autosaved in-progress workout; cleared on submit. Never read after submission.';
COMMENT ON COLUMN workout_sessions.review_status IS
  'pending on member submit; approved or changes_requested after trainer review.';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/__tests__/selfWorkout.migration.test.js --runInBand`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations/283_trainer_controlled_self_workout.sql src/__tests__/selfWorkout.migration.test.js
git commit -m "feat(db): add trainer-controlled self workout permission and session review"
```

---

## Task 2: Permission read/write

**Files:**
- Modify: `src/modules/client-portal/member-training.service.js`
- Modify: `src/modules/client-portal/client-portal.routes.js`
- Modify: `src/modules/pt-os/pt-os.routes.js`
- Test: `src/__tests__/selfWorkout.permission.test.js`

**Interfaces:**
- Produces: `selfWorkoutPermission(clientId, orgId): Promise<boolean>`;
  `openSessionFor(clientId, orgId): Promise<{ id, started_at, draft } | null>`;
  `GET /api/me/workout` response gains `allow_self_workout` and `open_session`;
  `PATCH /api/pt-os/clients/:id/self-workout` body `{ allow_self_workout: boolean }`.

- [ ] **Step 1: Write the failing permission test**

Build an Express app with a trainer `req.user` and the pt-os router; mock `pool.query`:

```js
it('turns the permission on and writes old and new values to activity_log', async () => {
  mockResponder = (sql) => {
    if (/SELECT allow_self_workout FROM pt_clients/.test(sql)) return { rows: [{ allow_self_workout: false }] };
    if (/UPDATE pt_clients SET allow_self_workout/.test(sql)) return { rows: [{ id: CLIENT, allow_self_workout: true }] };
    return { rows: [] };
  };
  await request(app).patch(`/api/pt-os/clients/${CLIENT}/self-workout`)
    .send({ allow_self_workout: true }).expect(200);
  expect(mockQueries.some((q) => /UPDATE pt_clients SET allow_self_workout/.test(q.sql))).toBe(true);
  expect(mockQueries.some((q) => /client\.self_workout\.update/.test(JSON.stringify(q.params)))).toBe(true);
});

it('refuses a non-boolean', async () => {
  await request(app).patch(`/api/pt-os/clients/${CLIENT}/self-workout`).send({ allow_self_workout: 'yes' }).expect(400);
});

it('returns 404 for another studio client', async () => {
  mockResponder = () => ({ rows: [] });
  await request(app).patch(`/api/pt-os/clients/${CLIENT}/self-workout`).send({ allow_self_workout: true }).expect(404);
});
```

Also assert `GET /api/me/workout` returns `allow_self_workout: false` and `open_session: null` for a member.

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/__tests__/selfWorkout.permission.test.js --runInBand`
Expected: FAIL — 404/route missing.

- [ ] **Step 3: Implement**

- In `member-training.service.js`:
  - `selfWorkoutPermission`: `SELECT allow_self_workout FROM pt_clients WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL`; return `Boolean(rows[0]?.allow_self_workout)`.
  - `openSessionFor`: latest `source='member' AND status='in_progress'` for the client/org; return `{ id, started_at, draft }`.
- In `client-portal.routes.js` GET `/workout`: `const [data, allow, open] = await Promise.all([...])`; respond `{ data, allow_self_workout: allow, open_session: open }`.
- In `pt-os.routes.js`, above `/clients/:id`: `router.patch('/clients/:id/self-workout', auth, requireTrainer, ...)`:
  - validate `typeof allow_self_workout === 'boolean'`;
  - `UPDATE pt_clients SET allow_self_workout=$3, updated_at=NOW() WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL RETURNING id, allow_self_workout`;
  - read the old value first, then `logActivity(req, 'client.self_workout.update', 'pt_client', id, { allow_self_workout }, { allow_self_workout: old })`;
  - `404` when no row.

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/__tests__/selfWorkout.permission.test.js --runInBand`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/client-portal/member-training.service.js src/modules/client-portal/client-portal.routes.js src/modules/pt-os/pt-os.routes.js src/__tests__/selfWorkout.permission.test.js
git commit -m "feat(api): expose trainer-controlled self workout permission"
```

---

## Task 3: Start, resume, autosave, discard

**Files:**
- Modify: `src/modules/client-portal/member-training.service.js`
- Modify: `src/modules/client-portal/client-portal.routes.js`
- Test: `src/__tests__/selfWorkout.lifecycle.test.js`

**Interfaces:**
- Produces:
  - `startMyWorkout({ clientId, orgId, userId, plans, dayOfWeek, assignmentId }): Promise<{ session, resumed }>`
  - `autosaveMyWorkout({ clientId, orgId, sessionId, draft }): Promise<{ saved_at }>`
  - `abandonMyWorkout({ clientId, orgId, sessionId }): Promise<boolean>`
  - `POST /api/me/workout/sessions`, `PATCH /api/me/workout/sessions/:id`, `DELETE /api/me/workout/sessions/:id`.
- `session` is the `workout_sessions` row plus `draft` and `prescribed`.

- [ ] **Step 1: Write the failing lifecycle test**

```js
it('refuses to start when the permission is off', async () => {
  mockResponder = (sql) => (/FROM pt_clients/.test(sql) ? { rows: [{ allow_self_workout: false }] } : { rows: [] });
  const res = await request(app).post('/api/me/workout/sessions').send({}).expect(403);
  expect(res.body.error.code).toBe('SELF_WORKOUT_NOT_ALLOWED');
});

it('creates one open session with a prescription snapshot', async () => {
  mockResponder = (sql) => {
    if (/FROM pt_clients/.test(sql)) return { rows: [{ allow_self_workout: true }] };
    if (/FROM workout_sessions/.test(sql) && /status = 'in_progress'/.test(sql)) return { rows: [] };
    if (/INSERT INTO workout_sessions/.test(sql)) return { rows: [{ id: 'ws1', started_at: '2026-11-13T10:00:00Z', draft: {} }] };
    return { rows: [] };
  };
  const res = await request(app).post('/api/me/workout/sessions')
    .send({ plans: [{ assignment_id: 'a1', name: 'Base', current_week: 2, days: [{ day_of_week: 4, exercises: [{ name: 'Squat', sets: 3 }] }] }] })
    .expect(201);
  expect(res.body.data.session.id).toBe('ws1');
  expect(res.body.data.session.prescribed.exercises[0].name).toBe('Squat');
});
```

Also assert: resume returns the open session with `resumed: true`; a second start does not insert; autosave on another client's session is 404; autosave after submit is 409; discard sets `abandoned` and never deletes.

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/__tests__/selfWorkout.lifecycle.test.js --runInBand`
Expected: FAIL.

- [ ] **Step 3: Implement the service**

- `startMyWorkout`:
  1. `selfWorkoutPermission`; throw `TrainingInputError('Your trainer has not enabled self workouts.', 403, 'SELF_WORKOUT_NOT_ALLOWED')` (extend the class with a `code`).
  2. Pick the plan day from `plans` (`assignmentId` if given, else first plan; day = `dayOfWeek` if present, else day 0). Throw 400 when the plan/day has no exercises.
  3. Resume: `SELECT * FROM workout_sessions WHERE client_id=$1 AND organization_id=$2 AND source='member' AND status='in_progress' AND started_at > NOW() - INTERVAL '24 hours' ORDER BY started_at DESC LIMIT 1`. Return `{ session, resumed: true }`.
  4. Mark older open member sessions `abandoned`.
  5. `INSERT INTO workout_sessions (client_id, trainer_id, workout_assignment_id, session_date, program_name, workout_day, status, source, started_at, prescribed, draft, created_by, organization_id)` with `session_date = today()`, `prescribed = { plan_name, week, day_of_week, exercises }`, `draft = { version: 1, current: 0, exercises: [] }`.
- `autosaveMyWorkout`: `UPDATE workout_sessions SET draft=$3, updated_at=NOW() WHERE id=$1 AND client_id=$2 AND organization_id=$4 AND source='member' AND status='in_progress' RETURNING updated_at`. No row → `404` when the session is absent, `409` when it exists but is not `in_progress` (read state first).
- `abandonMyWorkout`: same guard; `UPDATE ... SET status='abandoned', draft=NULL`.
- Routes: `POST /workout/sessions` loads `portal.myWorkout(clientId, orgId)` and passes it as `plans`; `PATCH` accepts `{ draft }` (object, max 100 KB serialized); `DELETE` returns `204`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/__tests__/selfWorkout.lifecycle.test.js --runInBand`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/client-portal/member-training.service.js src/modules/client-portal/client-portal.routes.js src/__tests__/selfWorkout.lifecycle.test.js
git commit -m "feat(api): start, resume and autosave member self workouts"
```

---

## Task 4: Submit, immutability, legacy gate

**Files:**
- Modify: `src/modules/client-portal/member-training.service.js`
- Modify: `src/modules/client-portal/client-portal.routes.js`
- Test: `src/__tests__/selfWorkout.submit.test.js`

**Interfaces:**
- Produces: `submitMyWorkout({ clientId, orgId, userId, sessionId, draft }): Promise<{ created, summary }>`; `POST /api/me/workout/sessions/:id/submit` body `{ draft? }`.
- Legacy `POST /api/me/workouts` keeps its response and adds the permission gate.

- [ ] **Step 1: Write the failing submit test**

```js
it('materialises the draft once and marks the session pending review', async () => {
  // session row is in_progress; draft has one exercise with two done sets
  const res = await request(app).post('/api/me/workout/sessions/ws1/submit')
    .send({ draft: { version: 1, exercises: [{ name: 'Squat', sets: [{ weight: '60', reps: '8', done: true }] }] } })
    .expect(200);
  expect(mockQueries.some((q) => /INSERT INTO workout_session_exercises/.test(q.sql))).toBe(true);
  expect(mockQueries.some((q) => /INSERT INTO workout_sets/.test(q.sql))).toBe(true);
  expect(mockQueries.some((q) => /status = 'completed'/.test(q.sql) && /review_status = 'pending'/.test(q.sql))).toBe(true);
});

it('refuses a second submit and any autosave after submit', async () => {
  // session is completed
  await request(app).post('/api/me/workout/sessions/ws1/submit').send({ draft: {} }).expect(409);
  await request(app).patch('/api/me/workout/sessions/ws1').send({ draft: {} }).expect(409);
});

it('still submits an open session after the permission is revoked', async () => {
  // permission false, session in_progress → submit succeeds
});
```

Also assert the legacy `POST /api/me/workouts` returns `403` when permission is off, and that the trainer notification is inserted.

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/__tests__/selfWorkout.submit.test.js --runInBand`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `submitMyWorkout`:
  1. Load the session `FOR UPDATE` by id/client/org/source member. Absent → 404; not `in_progress` → 409.
  2. Use the body draft when present, else `session.draft`. Run `normaliseWorkout({ ...draft, request_id: session.client_request_id || session.id })`.
  3. Transaction: insert exercises (`prescribed_index` from the draft), insert sets with `completed = true`, compute PR flags with `computePrFlags` (same loop as `logMyWorkout`), then `UPDATE workout_sessions SET status='completed', submitted_at=NOW(), duration_minutes=..., review_status='pending', draft=NULL WHERE id=$1`.
  4. `recomputeAssignmentProgress`; notify the trainer with link `/pt-os/clients/<client>/workout-log/<session>`; `logActivity` at the route (`workout_log.member.submit`).
- `logMyWorkout`: check `selfWorkoutPermission` first (403 `SELF_WORKOUT_NOT_ALLOWED`); set `started_at = NOW() - duration`, `submitted_at = NOW()`, `review_status='pending'`, and snapshot `prescribed` from the plan when the route passes `plans`.
- Route: `POST /workout/sessions/:id/submit`; keep `POST /workouts` response shape.

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/__tests__/selfWorkout.submit.test.js --runInBand`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/client-portal/member-training.service.js src/modules/client-portal/client-portal.routes.js src/__tests__/selfWorkout.submit.test.js
git commit -m "feat(api): submit member self workouts into the review queue"
```

---

## Task 5: Trainer pending review, review, and edit lock

**Files:**
- Modify: `src/modules/pt-os/workout-log.routes.js`
- Modify: `src/modules/pt-os/workout-log.service.js`
- Test: `src/__tests__/selfWorkout.review.test.js`

**Interfaces:**
- Produces:
  - `GET /api/pt-os/workout-log/pending-review?client_id=` → `{ data: [{ id, client_id, client_name, session_date, submitted_at, program_name, workout_day, duration_minutes, exercises, sets, volume }] }`
  - `POST /api/pt-os/workout-log/sessions/:id/review` body `{ decision: 'approved' | 'changes_requested', feedback?: string }`
  - `ensureSessionWritable(db, { orgId, sessionId })` in `workout-log.service.js` → `{ ok: true } | { ok: false, status, code, message }`.

- [ ] **Step 1: Write the failing review test**

```js
it('lists only pending member sessions in the studio', async () => {
  const res = await request(app).get('/api/pt-os/workout-log/pending-review').expect(200);
  expect(mockQueries[0].sql).toMatch(/review_status = 'pending'/);
  expect(mockQueries[0].params).toContain(ORG);
});

it('approves with feedback and notifies the member', async () => {
  await request(app).post('/api/pt-os/workout-log/sessions/ws1/review')
    .send({ decision: 'approved', feedback: 'Good depth, add 2.5 kg next week.' }).expect(200);
  expect(mockQueries.some((q) => /review_status = 'approved'/.test(q.sql))).toBe(true);
  expect(mockQueries.some((q) => /INSERT INTO notifications/.test(q.sql))).toBe(true);
});

it('refuses a trainer set edit on a submitted member session', async () => {
  mockResponder = (sql) => (/FROM workout_sessions/.test(sql) ? { rows: [{ source: 'member', status: 'completed', submitted_at: '2026-11-13' }] } : { rows: [] });
  await request(app).post('/api/pt-os/workout-log/exercises/e1/sets').send({ set_number: 1, reps: 5 }).expect(409);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/__tests__/selfWorkout.review.test.js --runInBand`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `pending-review` route: join `pt_clients`, filter `ws.organization_id`, `ws.source='member'`, `ws.status='completed'`, `ws.review_status='pending'`; optional `client_id`; counts via subqueries.
- `review` route: validate decision + feedback (max 2000); `UPDATE workout_sessions SET review_status=$3, reviewed_by=$4, reviewed_at=NOW(), review_feedback=$5 WHERE id=$1 AND organization_id=$2 AND source='member' AND status='completed' RETURNING ...`; 404 when no row; insert a member notification; `logActivity(req, 'workout_log.member.review', ...)`.
- `ensureSessionWritable`: read `source, status, submitted_at`; if `source='member' AND (status='completed' OR submitted_at IS NOT NULL)` return `409 SUBMITTED_WORKOUT_LOCKED`. Call it at the top of exercise add/delete and set add/patch/delete handlers.
- Add `submitted_at`, `review_status`, `review_feedback` to the session detail response and prefer `prescribed` over the recomputed `planned` when the snapshot exists.

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/__tests__/selfWorkout.review.test.js --runInBand`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/pt-os/workout-log.routes.js src/modules/pt-os/workout-log.service.js src/__tests__/selfWorkout.review.test.js
git commit -m "feat(api): pending review queue and trainer review for self workouts"
```

---

## Task 6: Member history exposes review feedback

**Files:**
- Modify: `src/modules/client-portal/client-portal.service.js`
- Test: `src/__tests__/selfWorkout.memberHistory.test.js`

**Interfaces:**
- Produces: `GET /api/me/sessions` rows gain `review_status` and `review_feedback`.

- [ ] **Step 1: Write the failing test**

```js
it('returns the trainer review on the member session', async () => {
  mockResponder = (sql) => (/FROM workout_sessions/.test(sql)
    ? { rows: [{ id: 'ws1', review_status: 'approved', review_feedback: 'Nice work' }] } : { rows: [] });
  const res = await request(app).get('/api/me/sessions').expect(200);
  expect(res.body.data[0]).toMatchObject({ review_status: 'approved', review_feedback: 'Nice work' });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx jest src/__tests__/selfWorkout.memberHistory.test.js --runInBand`.

- [ ] **Step 3: Implement** — add `ws.review_status, ws.review_feedback` to the `mySessions` select (org-scoped as before).

- [ ] **Step 4: Run to verify it passes** — same command.

- [ ] **Step 5: Commit**

```bash
git add src/modules/client-portal/client-portal.service.js src/__tests__/selfWorkout.memberHistory.test.js
git commit -m "feat(api): show trainer review on the member's session history"
```

---

## Task 7: Frontend API types and endpoints

**Files:**
- Modify: `src/lib/api/types.ts`
- Modify: `src/lib/api/endpoints/platform.ts`
- Modify: `src/lib/api/endpoints/training.ts`

**Interfaces:**
- Produces: `MeWorkoutState`, `MeWorkoutSession`, `MeWorkoutReview`; `api.me.startWorkout`, `api.me.autosaveWorkout`, `api.me.submitWorkout`, `api.me.discardWorkout`, `api.pt.setSelfWorkout`, `api.progress.workoutLog.pendingReview`, `api.progress.workoutLog.reviewSession`.

- [ ] **Step 1: Add types**

```ts
export type MeWorkoutState = {
  allow_self_workout: boolean;
  open_session: MeWorkoutSession | null;
};
export type MeWorkoutSession = {
  id: string; started_at: string; prescribed: MeWorkoutPlan['days'][number] | null;
  draft: unknown | null; assignment_id: string | null; program_name: string | null; workout_day: string | null;
};
export type MeWorkoutReview = {
  review_status: 'pending' | 'approved' | 'changes_requested' | null;
  review_feedback: string | null;
};
```

Extend `MeSession` with `MeWorkoutReview`.

- [ ] **Step 2: Add endpoints** (exact URLs from Tasks 2–5) and a `buildQs`-free JSON body.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (or only pre-existing errors; record them).

- [ ] **Step 4: Commit**

```bash
git add src/lib/api/types.ts src/lib/api/endpoints/platform.ts src/lib/api/endpoints/training.ts
git commit -m "feat(web): API client for self workout lifecycle"
```

---

## Task 8: Member page and launcher gating

**Files:**
- Modify: `src/app/(bare)/member/workout/page.tsx`
- Modify: `src/components/member/WorkoutLauncher.tsx`
- Test: `src/__tests__/self-workout-launcher.test.tsx`

**Interfaces:**
- Consumes: `MeWorkoutState`, `MeWorkoutSession`.
- Produces: `WorkoutLauncher` props `allowSelfWorkout: boolean`, `openSession: MeWorkoutSession | null`.

- [ ] **Step 1: Write the failing launcher test**

```tsx
it('shows no start action when permission is off', () => {
  render(<WorkoutLauncher plans={[plan]} sessions={[]} allowSelfWorkout={false} openSession={null} onSaved={vi.fn()} />);
  expect(screen.queryByRole('button', { name: /start today's workout/i })).not.toBeInTheDocument();
});
it('shows Resume for an open session even when permission is off', () => {
  render(<WorkoutLauncher plans={[plan]} sessions={[]} allowSelfWorkout={false} openSession={open} onSaved={vi.fn()} />);
  expect(screen.getByRole('button', { name: /resume your workout/i })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run it to verify it fails** — `npx vitest run src/__tests__/self-workout-launcher.test.tsx`.

- [ ] **Step 3: Implement**

- Page: `api.me.workout()` now returns `{ data, allow_self_workout, open_session }`; pass both down; when off and no open session, render a note: "Your trainer controls self workouts. Ask them to enable it."
- Launcher: hero order = resume (open session or local draft) → start today (only when allowed) → repeat last (only when allowed) → other days (only when allowed). Resume always allowed.
- Start calls `api.me.startWorkout({ assignment_id, day_of_week })` and opens `GuidedWorkout` with the returned session + draft.

- [ ] **Step 4: Run it to verify it passes** — same command.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(bare)/member/workout/page.tsx" src/components/member/WorkoutLauncher.tsx src/__tests__/self-workout-launcher.test.tsx
git commit -m "feat(member): gate self workout start on the trainer permission"
```

---

## Task 9: Guided workout — autosave, effort, collapse, pause, submit

**Files:**
- Modify: `src/components/member/workoutDraft.ts`
- Modify: `src/components/member/GuidedWorkout.tsx`
- Test: `src/__tests__/self-workout-guided.test.tsx`

**Interfaces:**
- Consumes: `MeWorkoutSession`, `api.me.autosaveWorkout`, `api.me.submitWorkout`, `api.me.discardWorkout`.
- Produces: draft set fields `rpe`, `rir`, `notes`; draft exercise `prescribed_index`; `WorkoutDraft.session_id`.

- [ ] **Step 1: Extend the pure draft functions and test them**

```ts
it('carries RPE, RIR and notes into the submit payload', () => {
  const d = newDraft({ ... });
  d.exercises[0].sets[0] = { weight: '60', reps: '8', done: true, rpe: '8', rir: '2', notes: 'smooth' };
  expect(toLogInput(d).exercises[0].sets[0]).toMatchObject({ rpe: 8, rir: 2, notes: 'smooth' });
});
it('collapses an exercise when every set is done', () => {
  expect(nextExerciseIndex(d)).toBe(1);
});
```

- [ ] **Step 2: Run it to verify it fails** — `npx vitest run src/__tests__/self-workout-guided.test.tsx`.

- [ ] **Step 3: Implement**

- `workoutDraft.ts`: add optional `rpe`, `rir`, `notes` to `DraftSet`; `prescribed_index` to `DraftExercise`; `session_id` to `WorkoutDraft`; map them in `newDraft`/`toLogInput`; add `nextExerciseIndex(draft)` (first exercise with an unlogged set, else last).
- `GuidedWorkout.tsx`:
  - Accept `session: MeWorkoutSession` and `initialDraft`.
  - Debounced autosave (800 ms) after every change: `api.me.autosaveWorkout(session.id, draft)`; show "Saved" / "Saving…"; on failure keep the local draft and show "Saved on this phone".
  - Per-set "Details" toggle revealing RPE (0–10), RIR (0–5) and a one-line note; values persist in the draft.
  - On the last set of an exercise, mark the exercise complete and call `nextExerciseIndex` to expand the next one; a completed exercise collapses.
  - Footer: `Pause` (close, keep session) and `Submit workout` (calls `api.me.submitWorkout(session.id, draft)`; on success show the summary; on 409 show "This workout was already submitted").
  - Close sheet: Keep for later (pause), Discard (calls `api.me.discardWorkout` then clears local), Keep training.

- [ ] **Step 4: Run it to verify it passes** — same command.

- [ ] **Step 5: Commit**

```bash
git add src/components/member/workoutDraft.ts src/components/member/GuidedWorkout.tsx src/__tests__/self-workout-guided.test.tsx
git commit -m "feat(member): autosave, effort logging and submit in the guided workout"
```

---

## Task 10: Trainer permission toggle

**Files:**
- Modify: `src/app/(chrome)/pt-os/clients/[id]/page.tsx`
- Create: `src/components/pt-os/SelfWorkoutPermissionCard.tsx`
- Test: `src/__tests__/self-workout-permission-card.test.tsx`

**Interfaces:**
- Consumes: `api.pt.setSelfWorkout(clientId, allow)`.
- Produces: a card in the Training tab with the current state and a toggle.

- [ ] **Step 1: Write the failing test**

```tsx
it('turns the permission on and reflects the new state', async () => {
  const api = { setSelfWorkout: vi.fn().mockResolvedValue({ allow_self_workout: true }) };
  render(<SelfWorkoutPermissionCard clientId="c1" initial={false} api={api} />);
  await userEvent.click(screen.getByRole('switch', { name: /allow self workout/i }));
  expect(api.setSelfWorkout).toHaveBeenCalledWith('c1', true);
  expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
});
```

- [ ] **Step 2: Run it to verify it fails** — `npx vitest run src/__tests__/self-workout-permission-card.test.tsx`.

- [ ] **Step 3: Implement**

- `SelfWorkoutPermissionCard`: a `role="switch"` button, `aria-checked`, optimistic update with rollback + toast on failure, copy explaining that revoking does not cancel an active session.
- Client profile: render it in the Training tab with `client.allow_self_workout` (the GET `/clients/:id` already returns `t.*`).

- [ ] **Step 4: Run it to verify it passes** — same command.

- [ ] **Step 5: Commit**

```bash
git add src/components/pt-os/SelfWorkoutPermissionCard.tsx "src/app/(chrome)/pt-os/clients/[id]/page.tsx" src/__tests__/self-workout-permission-card.test.tsx
git commit -m "feat(pt-os): trainer toggle for client self workouts"
```

---

## Task 11: Trainer pending review and feedback UI

**Files:**
- Modify: `src/app/(chrome)/pt-os/clients/[id]/workout-log/page.tsx`
- Modify: `src/app/(chrome)/pt-os/clients/[id]/workout-log/[sessionId]/page.tsx`
- Create: `src/components/pt-os/workout-log/ReviewPanel.tsx`
- Test: `src/__tests__/self-workout-review-panel.test.tsx`

**Interfaces:**
- Consumes: `api.progress.workoutLog.pendingReview`, `reviewSession`, `sessionDetail`.
- Produces: a Pending review section and a review panel with planned vs actual, completed/missed, approve/changes + feedback.

- [ ] **Step 1: Write the failing review panel test**

```tsx
it('shows planned vs actual and submits feedback', async () => {
  render(<ReviewPanel detail={detail} onReviewed={vi.fn()} />);
  expect(screen.getByText('Planned')).toBeInTheDocument();
  expect(screen.getByText('Actual')).toBeInTheDocument();
  expect(screen.getByText('Missed')).toBeInTheDocument();
  await userEvent.type(screen.getByLabelText(/feedback/i), 'Good depth');
  await userEvent.click(screen.getByRole('button', { name: /approve/i }));
  expect(api.reviewSession).toHaveBeenCalledWith('ws1', { decision: 'approved', feedback: 'Good depth' });
});
```

- [ ] **Step 2: Run it to verify it fails** — `npx vitest run src/__tests__/self-workout-review-panel.test.tsx`.

- [ ] **Step 3: Implement**

- Workout log page: load pending reviews; render a `Pending review` section above the history with client, date, duration, sets and a `Review` link to `/pt-os/clients/<id>/workout-log/<sessionId>?review=1`.
- Session detail page: when `review_status='pending'`, render `ReviewPanel` at the top (planned snapshot vs actual rows, missed exercises/sets, actual weight/reps/RPE/RIR/notes, duration) and make the existing editing controls read-only for the submitted member session.
- `ReviewPanel`: approve / changes-requested buttons + feedback textarea; calls the API, toasts, refreshes.

- [ ] **Step 4: Run it to verify it passes** — same command.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(chrome)/pt-os/clients/[id]/workout-log/page.tsx" "src/app/(chrome)/pt-os/clients/[id]/workout-log/[sessionId]/page.tsx" src/components/pt-os/workout-log/ReviewPanel.tsx src/__tests__/self-workout-review-panel.test.tsx
git commit -m "feat(pt-os): review submitted self workouts with planned vs actual"
```

---

## Task 12: Verification and PRs

- [ ] **Backend targeted tests:** `npx jest src/__tests__/selfWorkout.*.test.js src/__tests__/memberPremium.rules.test.js --runInBand`
- [ ] **Backend lint:** `npx eslint src/modules/client-portal src/modules/pt-os src/__tests__/selfWorkout.*.test.js`
- [ ] **Frontend targeted tests:** `npx vitest run src/__tests__/self-workout-*.test.tsx src/__tests__/training-tracking.test.tsx`
- [ ] **Frontend typecheck:** `npx tsc --noEmit`
- [ ] **Frontend lint (changed files):** `npx eslint src/components/member src/components/pt-os/workout-log src/app/(bare)/member/workout "src/app/(chrome)/pt-os/clients/[id]"`
- [ ] **Frontend build:** `npm run build` (production build; report any pre-existing failures).
- [ ] **Commit/push:** backend and frontend branches `feat/trainer-controlled-self-workout`; open one PR per repo against `main`.
- [ ] **Do not deploy.**
