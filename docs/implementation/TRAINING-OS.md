# Training OS — what it was, and why there is now one workout module

This file used to be the runbook for a cutover from the `workout_*` tables to a
new training domain. That cutover is finished, in the opposite direction to the
one it planned. Read this before touching anything workout-shaped, so the
argument does not get re-litigated from the old plan.

---

## 1. The shape of the problem

Two complete stacks authored and recorded a workout:

| | legacy | Training OS |
|---|---|---|
| prescribe | `workout_plans` → `workout_exercises` | `training_programs` → `phases` → `weeks` → `workout_templates` → `workout_template_exercises` |
| assign | `workout_assignments` | `training_assignments` |
| log | `workout_sessions` → `workout_session_exercises` → `workout_sets` | `training_sessions` → `exercise_performances` → `set_performances` / `cardio_performances` |
| API | `/api/workouts` | `/api/training` |
| builder | `components/pt-os/builder/` | `components/pt-os/training/` |

Migrations 164–166 built the right-hand column; 167 copied the log into it. The
plan was that the app would move over and the left-hand column would be dropped.

## 2. What production said

The app never moved over, and the evidence was one-sided in both halves.

**Sessions (settled by migration 193).** `workout_sessions` held 123 rows, 83 in
the last 30 days. `training_sessions` held 48, every one of them carrying
`metadata->>'migrated_from'` — copies made by 167, not a single row created by
its own API. `set_performances` was 100 for 100 `client_token LIKE 'legacy:%'`.

**Prescriptions (settled by migration 195).** `workout_plans` held 60 rows and
409 exercises, newest the same day as the newest session. `training_programs`
held **zero**. `workout_templates` held **one**, whose four prescriptions were
the builder's untouched defaults — including a treadmill run stored as
`WEIGHT_REPS 3×10`, which is precisely the bug migration 164 was written to
abolish.

And the fact that settled it independently of any row count: once 193 archived
`training_assignments`, nothing downstream could assign or log a workout
template. The Training OS builder's output had nowhere to go.

## 3. Where things are now

**One chain, library to logged set:**

```
exercises
  → workout_plans → workout_exercises          (prescribe)
  → workout_assignments                        (assign)
  → workout_sessions → workout_session_exercises → workout_sets   (log)
  → /api/pt-os/workout-log/{progress,volume-summary,analytics}     (report)
```

- **API:** `/api/workouts` (plans, assignment), `/api/exercises` (library),
  `/api/pt-os/workout-log/*` (logging, analytics, landmarks).
  `/api/training` is gone.
- **UI:** `/pt-os/workout-plans` (index, labelled "Workouts"),
  `/pt-os/workout-plans/[id]`, `/pt-os/workout-plans/[id]/builder`,
  `/pt-os/workout-plans/[id]/builder/add-exercises`, `/pt-os/workout-log`,
  `/pt-os/today`, `/pt-os/exercise-library`.
- **Retired, with redirects in `next.config.js`:** `/pt-os/training/templates`,
  `/pt-os/training/templates/[id]`, and the client-scoped builder twin at
  `/pt-os/clients/[id]/training/builder[/add-exercises]`.
- **`modules/training/`** holds only `authz.js`, and that file was never about
  training: `orgWhere` / `trainerWhere` / `canAccessClient` are the shared fix
  for the trainer fall-through, pinned by `trainerFallthrough.authz.test.js`.

**Archived, not dropped.** Eleven tables live in the `archive` schema with every
row and constraint intact — six moved by 193, five by 195. Nothing in the
application reads that schema. Each migration has a `.ROLLBACK.md` beside it.

```sql
-- what is still there
SELECT table_name FROM information_schema.tables WHERE table_schema = 'archive';
```

## 4. What the legacy schema cannot express

Worth writing down, because it is the real argument the Training OS was built
on, and it survives the Training OS being retired. `workout_exercises` has
`sets INTEGER NOT NULL DEFAULT 3` and `reps INTEGER NOT NULL DEFAULT 12`, so
every prescription must claim sets and reps. There is no `prescription_type`,
no section (warm-up vs main vs cool-down), and no cardio columns — distance,
duration, incline, pace and heart rate have nowhere to go.

It does already carry `week_number`, `progression_type`/`progression_amount`/
`progression_every_weeks`, `version`/`parent_plan_id`, `superset_group`,
`target_weight`, `tempo`, `rpe`, `warmup_sets` and a `config` JSONB.

**If cardio prescription is wanted, widen `workout_exercises`.** Make the
sets/reps columns nullable behind a `prescription_type`, and add the cardio
columns. That is a migration against the table 409 live rows already sit in.
It is not a reason to stand up a second prescription domain — that is what was
tried, and this file is the result.

## 5. Guardrails

These fail loudly if the consolidation is undone by accident:

- `sessionModel.canonical.test.js` — no runtime file may query any of the 11
  archived tables; `/api/training` may not be re-mounted; the deleted training
  modules may not reappear; 193's and 195's refusal guards are counted, so
  downgrading one to a notice fails here.
- `architecture.domains.convention.test.js` — every table in the schema has
  exactly one owning domain. Its `ARCHIVED` set is the list of tables that left
  `public`; add to it when a migration archives another.
- `trainerFallthrough.authz.test.js` — `modules/training/authz.js` behaviour.
- Frontend `workout-plan-flow.test.tsx` / `workout-programme-create.test.tsx` —
  one add-exercises route, and the client-scoped builder must not come back.

## 6. Still open

- **32 sessions sit in `IN_PROGRESS` and are actually abandoned** — now in
  `archive.training_sessions`, so they no longer pollute any live query. Only
  worth touching if that archive is ever read.
- **The AI workout generator does not persist.**
  `POST /api/ai/workout/generate` streams a plan back as JSON and writes
  nothing, so a trainer reads the generated programme and retypes it into the
  builder. Three surfaces call it — `/ai/workout-generator`,
  `ClientAiGenerateCard`, and `AiCoachPanel type="workout"` — all through the
  one implementation, so this is a missing write path, not a duplicate one.
- **`workout_exercises.week_number` is 1 on all 409 rows.** Weeks beyond the
  first are resolved arithmetically by `modules/pt-os/progression.js` rather
  than stored, so a deload week still cannot be authored.

## 7. Connecting Supabase locally

A cloud Claude Code session cannot complete the MCP OAuth flow; set it up once
on your own machine.

```bash
claude mcp add --scope project --transport http supabase \
  "https://mcp.supabase.com/mcp?features=docs%2Caccount%2Cdatabase%2Cdebugging%2Cdevelopment%2Cfunctions%2Cbranching"
claude          # approve the server, then /mcp to authenticate
```

Project ref: `adffjnztzrolibtuvhgc`.

## 8. Things that will bite you

- **A page module may only export the page.** Next fails the build on any extra
  export — helpers go in `lib/` or `components/`.
- **Convention tests are ratchets and they are load-bearing.** `palette.test.ts`,
  `scale.test.ts`, `pull-refresh-optout.test.ts`, `tenantScope.convention.test.js`.
- **`use(params)` suspends.** Page tests need a `Suspense` boundary *inside an
  awaited `act`*, or nothing renders and the failure looks like a broken mock.
- **DB-backed backend tests** run against `RLS_TEST_DATABASE_URL` inside a
  transaction that is always rolled back. Without the URL, 11 suites skip.
- **Migrations must not open their own transaction.** `migrate.js` wraps each
  file together with the `_migrations` insert that records it; enforced by
  `migrations.transactionControl.test.js`.
