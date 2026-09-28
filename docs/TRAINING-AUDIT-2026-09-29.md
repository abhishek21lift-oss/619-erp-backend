# Training Audit — 2026-09-29

## Scope

Where the dashboard's **Today's Sessions** gets its clients and exercises, and the whole path around it:

- programme → assignment → Today roster → Start → workout log → progress
- the Workout Plans page stats

Production numbers are from read-only queries on 29 Sep.

## Where Today's Sessions comes from

The card calls `GET /api/pt-os/workout-log/today`, which runs `pt-os.service.getTodayRoster`. The full list at `/pt-os/today` uses the same endpoint, and the card simply shows its first two rows.

A client is on today's list for one of three reasons, in priority order:

1. **Booked.** A `pt_sessions` row for today that isn't cancelled. It has a real start time.
2. **Programme.** An active `workout_assignments` row whose plan has exercises on today's weekday (`day_of_week`). There is no time.
3. **Enrolled.** The client is active and `pt_clients.preferred_training_days` includes today. The time comes from `preferred_workout_time`.

**The "N exercises" on a row:**
- The count is the rows in `workout_exercises` for the chosen plan, where `day_of_week` is today's ISO weekday **and `week_number = 1`**.
- The chosen plan is the client's active assignment that has exercises today, otherwise the newest one.

**"No programme yet"** means the client has no active assignment.

**Checked against the screenshots (Tue 29 Sep):**
- **Shiva, 8:00 AM, No programme yet.**
  - Shiva is on the list because of enrolment: all 7 days, time 08:00.
  - There is no active assignment.
- **Myself, 9:00 AM, Full Body, 2 exercises.**
  - Myself is on the list because of enrolment: time 09:00.
  - The Full Body plan has 2 exercises on Tuesday in week 1.
  - The plan's days are Mon and Tue.

## Findings

### T-1 (High): 68 sessions were never finished and are still "in progress"

**Production:**
- 136 workout sessions in total, of which 65 are completed.
- **68 are `in_progress` on a past date.** 56 of those have no sets at all.
- Ajeet: 22 sessions, 7 completed, 14 stuck from earlier days.

Nothing ever closes an abandoned session. There is no end-of-day job, and Start opens a new session instead of resuming an old one.

**Effect:**
- The Workout Log's "Total sessions 22" counts the abandoned ones.
- The history is mostly empty shells.
- Starting again on another day adds another shell.

**Fix:**
- A nightly (or on-read) job closes past-date `in_progress` sessions:
  - `completed` when sets were logged;
  - a new `abandoned` status when none were.
- Totals count completed sessions only.

### T-2 (High): enrolment days and programme days disagree, and the Today list mixes the two

- **Ajeet:**
  - Enrolled for Mon, Wed and Fri.
  - His "Lower" programme only has Saturday.
  - So on Mon, Wed and Fri he appears (enrolled), Start opens the programme, and the only day it can offer is **Saturday** (screenshot 3).
  - On Saturday he appears because of the programme.
- **Shiva:** enrolled for all 7 days with no programme, so he shows as "No programme yet" every day.
- The roster treats enrolment days as "training today". Nothing reconciles them with the programme a client is actually on.

**Fix, one of:**
- when a client has an active programme, the programme's days decide, and enrolment is used only for clients without one; or
- the builder warns when a programme's days don't match the client's enrolled days.

### T-3 (Medium): the exercise count reads week 1 only

The roster (and Today's ordering) counts `week_number = 1`. The logged session resolves the client's current programme week. A plan whose later weeks were edited therefore shows week 1's count on the card and logs a different set.

On production today, every active plan has only week 1 rows, so this is latent rather than live.

**Fix:** count the client's current programme week, falling back to week 1 when that week has no rows of its own.

### T-4 (Medium): stored plan progress % is out of date

- `workout_assignments.progress_pct` is completed linked sessions ÷ (sessions/week × weeks).
- It is only recalculated when a session is completed.
- Migration 219 corrected `sessions_per_week` from the programmed days, but it did not recalculate progress.
- **Ajeet:** "Lower" is 1 day/week for 4 weeks, with 1 completed linked session, which is **25%**. The card still shows **8%**, calculated when the plan said 3/week.

**Fix:** recalculate `progress_pct` for active assignments once (and whenever `sessions_per_week` or `duration_weeks` changes).

### T-5 (Medium): most sessions aren't linked to a programme

- **82 of 136 sessions have no assignment**, mostly freestyle or from before a plan existed.
- 6 were logged while the client had an active plan, but weren't linked.
- Progress only counts linked sessions, so **Prakhar** has 1 completed session since his plan started and still shows **0%**.

**Fix:** when a session is completed without a link and the client has an active assignment covering that date, link it (the same rule Start uses).

### T-6 (Medium): programmes run past their last week, and an expired client still counts

**Past their last week:**
- Myself: 4-week plan, now in week 5.
- Akash: 4-week plan, now in week 7.
- These assignments are open-ended (from before 219), so they stay "active" and keep appearing on Today.
- The Workout Plans card caps the counter, so an overrun reads **"Week 4 / 4"** instead of showing it's over.

**Expired client still counted:**
- **Vinay** (client status `expired`) still has an active assignment.
- The Workout Plans stats count him:
  - Assigned clients 4 → 3 real;
  - Sessions/week 8 → 4 real (his plan is 4/week);
  - Avg completion is diluted.
- The Today roster already ignores him, so the two screens disagree.

**Fix:**
- Show "Finished" or "Overran by N weeks" instead of the capped counter, with a one-tap Extend or Re-assign.
- Exclude non-active clients from the plan stats.
- Offer to end the assignments of clients whose package expired.

### T-7 (Low): duplicate sessions on the same day

36 sessions sit on a client-day that has another session.

The start lock only de-duplicates within the same assignment, so a freestyle session and a programme session (or two different assignments) both open.

**Fix:** Start offers to resume any open session for that client today, whichever programme it belongs to.

### T-8 (Low): completed sessions with nothing logged

18 sessions are `completed` with no sets, and they count toward progress and streaks.

**Fix:** completing an empty session asks for confirmation, or is recorded as `abandoned`.

### T-9 (Low): a programme with no exercises is still assigned

Navneet (NK Fitness) is on "Muscle gain", which has 0 exercises. It shows every day as a rest day and progress 0%.

**Fix:** the builder and Assign warn about an empty programme, and Today labels it "Programme has no exercises".

## Workout Plans stats: how each is computed (Abhishek PT Studio)

| Tile | Shows | How it's computed | Issue |
|---|---|---|---|
| Active plans | 7 | Plans with `is_active` (including unassigned ones) | Label reads as "in use"; 3 of them have nobody on them |
| Assigned clients | 4 | Distinct clients with an active assignment | Includes expired Vinay (T-6) |
| Avg completion | 2% | Mean `progress_pct` over assignments | Stale (T-4), unlinked sessions (T-5), expired client (T-6) |
| Sessions / week | 8 | Σ assignments × plan `sessions_per_week` | Includes Vinay's 4/week (T-6) |

## Suggested fix order

1. **T-1:** close abandoned sessions, and base totals on completed sessions.
2. **T-4 and T-5:** recalculate progress and link unlinked sessions, which gives honest percentages.
3. **T-6:** show overruns, exclude expired clients from stats, and end expired clients' assignments.
4. **T-2:** decide whether the programme or enrolment decides "today" (**needs the owner's decision**).
5. **T-3, T-7, T-8, T-9.**
