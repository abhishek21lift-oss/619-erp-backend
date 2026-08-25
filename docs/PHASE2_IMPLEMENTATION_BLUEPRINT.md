# MY PT STUDIO — PHASE 2 IMPLEMENTATION BLUEPRINT

**Status:** Awaiting approval before implementation begins.

---

## A. CURRENT CLIENT DATA ARCHITECTURE

### Table → Service → API → Frontend → AI Access

| Table | Service / Route | API | AI Access |
|---|---|---|---|
| **pt_clients** | `routes/pt-os.js`, `routes/workouts.js` | `GET /api/clients/:id` | 🟢 via `loadAuthoritativeClient`, `buildClientContext` |
| **client_fitness_profiles** | `routes/pt-os.js` | `GET /api/client-fitness-profile/:id` | 🟡 via `loadAuthoritativeClient` (fitness profile only) |
| **pt_goals** | `routes/pt-os.js` | `GET /api/goals/:id` | 🟡 via `loadAuthoritativeClient`, `buildBrief` |
| **pt_assessments** | `routes/fitness-testing.js`, `routes/ai.js` | `GET /api/fitness-testing/:id` | 🟢 via `buildBrief`, AI fitness-testing analyser (allowlisted columns) |
| **pt_lifestyle_assessments** | `routes/pt-os.js` | `GET /api/lifestyle-assessment/:id` | 🟡 via `loadAuthoritativeClient`, `buildBrief` |
| **pt_nutrition_assessments** | `routes/pt-os.js` | `GET /api/nutrition-assessment/:id` | 🟡 via `loadAuthoritativeClient` |
| **weekly_checkins** | `routes/pt-os.js` | `GET /api/weekly-checkins/:id` | 🟡 via `loadAuthoritativeClient`, `buildClientContext` |
| **pt_parq_forms** | `routes/parq.routes.js` | `GET /api/parq/:id` | 🟡 via `buildBrief`, `checkScreeningGate` |
| **pt_informed_consents** | `routes/informed-consent.routes.js` | `GET /api/consent/:id` | 🟡 via `checkScreeningGate` |
| **pt_mobility_performance_assessments** | `routes/pt-os.js` | via client profile | 🔴 not in AI context |
| **pt_posture_assessments** | `routes/pt-os.js` | via client profile | 🔴 not in AI context |
| **workout_plans** | `routes/workouts.js` | `GET /api/workout-plans/:id` | 🟡 via `loadAuthoritativeClient` (assignment only) |
| **workout_exercises** | `routes/workouts.js` | `GET /api/workout-exercises/:id` | 🔴 not directly in AI context |
| **workout_assignments** | `routes/workouts.js` | `GET /api/workout-assignments/:id` | 🟡 via `loadAuthoritativeClient` |
| **workout_sessions** | `routes/workout-log.routes.js` | `GET /api/workout-sessions/:id` | 🔴 not in AI context |
| **workout_session_exercises** | `routes/workout-log.routes.js` | via session | 🔴 not in AI context |
| **workout_sets** | `routes/workout-log.routes.js` | via session | 🔴 not in AI context |
| **strength_logs** | `routes/pt-os.js` | via progress analytics | 🟡 via `buildClientContext` (limited) |
| **training_programs** | `routes/training.routes.js` | `GET /api/training/programs/:id` | 🔴 not in AI context |
| **training_program_weeks** | `routes/training.routes.js` | via program | 🔴 not in AI context |
| **training_sessions** | `routes/training.routes.js` | via program | 🔴 not in AI context |
| **exercise_performances** | `routes/training.routes.js` | via session | 🔴 not in AI context |
| **set_performances** | `routes/training.routes.js` | via performance | 🔴 not in AI context |
| **personal_records** | `routes/training.routes.js` | `GET /api/training/records/:id` | 🟡 via `buildPrs` (old system) |
| **muscle_volume_landmarks** | `routes/training.routes.js` | via volume analysis | 🔴 not in AI context |
| **diet_templates** | `routes/diet.js` | via diet assignment | 🟡 via `loadAuthoritativeClient` |
| **diet_assignments** | `routes/diet.js` | via assignment | 🟡 via `loadAuthoritativeClient` |
| **nutrition_logs** | `routes/nutrition.js` | via nutrition log | 🔴 not in AI context |
| **ai_conversations** | `routes/ai.js` | `GET /api/ai/conversations` | 🟢 working memory |
| **ai_messages** | `routes/ai.js` | `GET /api/ai/conversations/:id` | 🟢 working memory |
| **ai_action_plans** | `routes/ai.js` | via action plans | 🟡 partial |

### Legend

- 🟢 already available to AI
- 🟡 partially available
- 🔴 missing from AI context
- ⚠️ sensitive/restricted (PAR-Q medical data, consent records)

---

## B. CURRENT CONTEXT BUILDERS

### 1. `buildClientContext(client_id, org)` — Chat route

**Location:** `src/routes/ai.js:151`

**What it builds:**
```
Name, Age, Gender
Current weight, Body fat
Goals (active only, max 3)
Last 2 assessments (weight, body fat, chest, waist, hips)
Last 4 weekly check-ins (weight, mood, sleep, notes)
```

**Query shape:** Parent-first (pt_clients gate → child queries). Tenant-scoped.

**Limitations:**
- No training history
- No exercise performance
- No PRs
- No adherence data
- No lifestyle/recovery data
- No PAR-Q/medical clearance
- No active program details
- No nutrition data
- No posture/mobility data

### 2. `loadAuthoritativeClient(client_id, org, options)` — Workout/Diet generators

**Location:** `src/routes/ai.js:323`

**What it builds:**
```
Full client record (SELECT *)
Fitness profile
Active goals (max 3)
Latest assessment (weight, body fat, BMI, chest, waist, hips)
Latest weekly check-in
Lifestyle assessment
Nutrition assessment
Active workout assignments (max 3)
Active diet assignments (max 3)
Optional: RAG chunks, Exercise library
```

**Query shape:** Parent-first (pt_clients gate → all child queries in parallel). Tenant-scoped.

**Limitations:**
- No training history / workout log
- No exercise performance data
- No PRs / personal records
- No adherence data
- No program phase/week details
- No posture/mobility data
- No medical clearance details (PAR-Q gate only)

### 3. `buildBrief(data)` — Training brief

**Location:** `src/modules/pt-os/training-brief.js`

**What it builds:**
```
Sections: readiness, body, capacity, limitations, lifestyle, goal, history
Each section has: present flag, as_of date, detailed fields
Missing sections explicitly listed
Completeness percentage
```

**Data sources:** PT-Os routes fetch all the data and pass it in. Pure function.

**Strengths:**
- Reports what is MISSING (not assumed)
- Each section has its own `as_of` date
- Most comprehensive single-client context builder

**Limitations:**
- Not used by AI routes (only by the PT-Os frontend)
- No training history / performance data
- No adherence data

### 4. `buildSnapshot(data)` — Client profile alerts

**Location:** `src/modules/pt-os/client-snapshot.js`

**What it builds:**
```
Alerts: PT term, money owed, sleep, weight movement, stale measurements, missed workout
Goal card: target, current, start, percentage, delta, remaining
PRs: best lifts (max 6)
Coach prompts: recovery, plateau, on-track, adherence, strength
```

**Strengths:**
- Alert system with severity ranking
- Goal progress tracking
- Coach prompts derived from measurements

**Limitations:**
- Not used by AI routes
- No training history
- No program details

### 5. `generateCoach({ snapshot, brief, client, chat })` — AI coaching prompts

**Location:** `src/modules/pt-os/coach-ai.js`

**What it builds:**
- Combines snapshot + brief into a facts text
- Sends to model for interpretation
- Returns insights with citations
- Fallback to derived prompts if model unavailable

**Strengths:**
- Facts-first approach (only measurements that exist)
- Missing data explicitly listed
- Every insight must cite its source
- Cached against readings (not page loads)

**Limitations:**
- No training history in the facts
- No adherence data
- No program details
- No exercise performance data

---

## C. DUPLICATED CONTEXT LOGIC

| Pattern | `buildClientContext` | `loadAuthoritativeClient` | `buildBrief` | `buildSnapshot` |
|---|---|---|---|---|
| Client identity | ✅ name, dob, gender | ✅ full record | ✅ name, dob, gender | ✅ via client |
| Goals | ✅ active goals | ✅ active goals | ✅ goal details | ✅ goal card |
| Assessments | ✅ last 2 | ✅ latest only | ✅ detailed | ✅ weight series |
| Check-ins | ✅ last 4 | ✅ latest only | ❌ | ✅ via weights |
| Lifestyle | ❌ | ✅ | ✅ detailed | ✅ sleep only |
| Nutrition | ❌ | ✅ | ❌ | ❌ |
| PAR-Q/Medical | ❌ | ❌ (gate only) | ✅ detailed | ❌ |
| Posture/Mobility | ❌ | ❌ | ✅ detailed | ❌ |
| Training history | ❌ | ❌ | ❌ | ❌ |
| Adherence | ❌ | ❌ | ❌ | ❌ (alerts only) |
| PRs | ❌ | ❌ | ❌ | ✅ best lifts |
| Program details | ❌ | assignment only | ✅ assignment | ❌ |
| Recovery | ❌ | ❌ | ❌ | ✅ lifestyle score |

**Key finding:** No single builder combines ALL client data. Each serves a different UI surface and has blind spots.

---

## D. CANONICAL CLIENT STATE DESIGN

### `buildClientState(clientId, organizationId)`

**Returns:**
```javascript
{
  // ── Identity ───────────────────────────────────────────────────────────
  identity: {
    id, name, gender, age, dob,
    goal,                          // from pt_clients.goal
    notes,                         // from pt_clients.notes
    status,                        // active/inactive/expired/frozen
    trainer_id, trainer_name,
    organization_id,
  },

  // ── Goals ──────────────────────────────────────────────────────────────
  goals: {
    active: [{                     // from pt_goals WHERE is_active=true
      goal_type, target_weight, target_body_fat,
      target_date, created_at,
    }],
    primary: null,                 // first active goal
    as_of: '2026-08-20',
  },

  // ── Assessment / Body ──────────────────────────────────────────────────
  body: {
    source: 'assessment',          // 'assessment' | 'measurement' | null
    as_of: '2026-08-15',
    measurements: {
      weight_kg, height_cm, bmi,
      body_fat_pct, lean_mass_kg, fat_mass_kg,
      chest_cm, waist_cm, hips_cm, waist_hip_ratio,
      neck_cm, arm_r_cm, arm_l_cm,
      thigh_r_cm, thigh_l_cm, calf_r_cm, calf_l_cm,
    },
    vitals: {
      bp_systolic, bp_diastolic, bp_category,
      resting_heart_rate, resting_spo2,
    },
    body_comp: {
      muscle_mass_pct, body_water_pct, bone_mass_kg,
      visceral_fat, metabolic_age, bmr,
    },
    cardio: {
      vo2_max, cardio_category, cardio_score_computed,
    },
    strength: {
      exercise, exercise_2, strength_score_computed,
    },
    endurance: {
      test_type, endurance_category, endurance_score_computed,
    },
    mobility: {
      score: mobility_score_computed,
      flexibility_category, has_asymmetry,
    },
    scores: {
      body_composition_score, health_risk_score,
      overall_fitness_score,
    },
    freshness: 'current' | 'recent' | 'stale' | 'never',
  },

  // ── Measurements History ───────────────────────────────────────────────
  measurements: {
    recent: [                      // newest first, max 10
      { weight_kg, body_fat_pct, waist_cm, chest_cm, hips_cm, measured_at, source },
    ],
    trend: 'improving' | 'declining' | 'stable' | null,
    last_weighed: '2026-08-15',
    days_since_weighed: 5,
  },

  // ── Training / Program ─────────────────────────────────────────────────
  program: {
    active: boolean,
    plan_id, plan_name,
    started_on, duration_weeks,
    current_week, total_weeks,
    days_per_week,
    progression_type, progression_amount, progression_every_weeks,
    phases: [{ name, phase_order, week_start, week_end, goal }],
    weeks: [{ week_number, name, is_deload, notes }],
    assignments: [{
      assignment_id, plan_id, plan_name,
      start_date, end_date, status,
      days_per_week,
    }],
  },

  // ── Performance ────────────────────────────────────────────────────────
  performance: {
    recentSessions: [{             // from workout_sessions (new schema)
      session_date, status, duration_seconds,
    }],
    adherence: {
      planned, completed, pct,
      weeks: [{ week_start, planned, completed }],
    },
    personalRecords: [{
      exercise_name, record_type, value, unit, reps, achieved_on,
    }],
    muscleVolume: [{
      target_muscle, sets, last_trained, days_since,
      mev_sets, mrv_sets, status,     // 'below' | 'within' | 'above'
    }],
    recentPRs: [{                   // last 5 PRs
      exercise_name, value, unit, achieved_on,
    }],
  },

  // ── Recovery / Check-ins ───────────────────────────────────────────────
  recovery: {
    latest: {
      week_start_date, mood, sleep_hours, water_glasses,
      stress_level, energy_level, soreness_level,
      client_notes,
    },
    readiness: {
      score, band, inputs, max_inputs,
      components: { sleep, stress, energy, soreness },
      trend,                         // 'improving' | 'steady' | 'declining'
    },
    days_since_checkin: number | null,
  },

  // ── Lifestyle ──────────────────────────────────────────────────────────
  lifestyle: {
    as_of: '2026-08-10',
    experience_level, years_of_experience,
    sleep_hours, sleep_quality,
    stress_level, occupation_type,
    activity_level, daily_steps,
    energy_level, recovery_quality,
    recovery_risk, lifestyle_score,
  },

  // ── Nutrition ──────────────────────────────────────────────────────────
  nutrition: {
    as_of: '2026-08-10',
    diet_preferences, food_allergies,
    foods_to_avoid, meals_per_day,
    nutrition_budget,
    medical_conditions, medical_notes,
    has_logs: boolean,              // false = nutrition intake unknown
    recentLogs: [],                 // if available
  },

  // ── Limitations / Medical ──────────────────────────────────────────────
  limitations: {
    injuries: string | null,        // from pt_clients.injuries
    health_conditions: string | null,
    posture: {                      // from pt_posture_assessments
      as_of, risk_level, issues: [],
      notes,
    } | null,
    mobility: {                     // from pt_mobility_performance_assessments
      as_of, category, score,
      findings: [{ region, pain, restriction }],
      notes,
    } | null,
    has_asymmetry: boolean | null,
  },

  // ── Medical Clearance ──────────────────────────────────────────────────
  clearance: {
    parq: {
      as_of, risk_level, risk_message,
      gate_status,                   // 'cleared' | 'blocked'
      flagged_answers, current_health: [],
      past_history: [],
      notes,
    } | null,
    consent: {
      as_of, status,                 // 'completed' | 'pending' | null
    } | null,
    warnings: [],                    // from checkScreeningGate
  },

  // ── Preferences ────────────────────────────────────────────────────────
  preferences: {
    dietary: string | null,
    equipment: string | null,        // from assignments
    training_frequency: number | null,
    meal_frequency: number | null,
  },

  // ── Trainer Context ────────────────────────────────────────────────────
  trainer: {
    assigned_trainer_id, trainer_name,
    last_session_trainer: string | null,
  },

  // ── Missing Data ───────────────────────────────────────────────────────
  missing: {
    sections: [],                    // list of missing data categories
    completeness_pct: number,        // 0-100
    critical_gaps: [],               // gaps that affect programming safety
  },

  // ── Data Freshness ─────────────────────────────────────────────────────
  freshness: {
    assessment: 'current' | 'recent' | 'stale' | 'never',
    measurements: 'current' | 'recent' | 'stale' | 'never',
    checkins: 'current' | 'recent' | 'stale' | 'never',
    lifestyle: 'current' | 'recent' | 'stale' | 'never',
    program: 'current' | 'recent' | 'stale' | 'never',
    last_activity: '2026-08-20',
  },
}
```

### Freshness Rules

| Category | current | recent | stale | never |
|---|---|---|---|---|
| Assessment | ≤14 days | ≤30 days | ≤90 days | no row |
| Measurements | ≤7 days | ≤14 days | ≤30 days | no row |
| Check-ins | ≤7 days | ≤14 days | ≤30 days | no row |
| Lifestyle | ≤30 days | ≤90 days | ≤180 days | no row |
| Program | active assignment | ended ≤14 days | ended ≤90 days | no assignment |

### Fact Classification

Every value in the state should be tagged with one of:

| Tag | Meaning | Example |
|---|---|---|
| `MEASURED` | Directly recorded by trainer/client | weight_kg from assessment |
| `CALCULATED` | Deterministically computed from measured data | BMI, BMR, readiness score |
| `REPORTED` | Self-reported by client (check-in) | sleep_hours, stress_level |
| `INFERRED` | Derived by analysis from multiple sources | trend, plateau detection |
| `MISSING` | No data available | nutrition logs for this client |
| `STALE` | Data exists but is old (>30 days) | assessment from 45 days ago |

---

## E. MEMORY ARCHITECTURE

### Three Memory Types

#### 1. Semantic Client Memory

**What:** Durable facts about the client that persist across conversations.

**Examples:**
- "Prefers morning workouts (6-8 AM)"
- "Has a shoulder injury — avoid overhead pressing"
- "Responds well to progressive overload, not volume increases"
- "Vegetarian — no meat in meal plans"
- "Travels for work every other week — plan around that"
- "Confirms that squat is their strongest lift"

**Source of truth:** Only from confirmed trainer/client input or authoritative database facts.

**Storage:** `ai_client_memory` table (designed below).

#### 2. Episodic Memory

**What:** Notable events and decisions in the coaching relationship.

**Examples:**
- "Week 6: Deloaded due to high soreness + low sleep scores"
- "Week 8: PR on bench press — 80kg × 3"
- "Week 10: Client reported knee pain during squats — substituted leg press"
- "Week 12: Completed 12-week programme, exceeded weight loss target by 1.2kg"

**Source of truth:** Confirmed actions, logged sessions, trainer observations.

**Storage:** `ai_client_episodes` table (designed below).

#### 3. Working Memory

**What:** Current conversation context. Already exists.

**Storage:** `ai_conversations` + `ai_messages` (existing tables).

---

## F. MEMORY TABLE DESIGN

**DO NOT CREATE THESE TABLES YET. Design only.**

### `ai_client_memory`

```sql
-- Durable facts about a client, confirmed by trainer or derived from DB.
-- Organization-isolated, client-isolated, timestamped, source-backed.
CREATE TABLE IF NOT EXISTS ai_client_memory (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  client_id       UUID NOT NULL REFERENCES pt_clients(id),
  user_id         UUID NOT NULL REFERENCES users(id),  -- who confirmed this

  -- Classification
  category        TEXT NOT NULL,  -- 'preference' | 'constraint' | 'observation' | 'goal' | 'medical'
  subcategory     TEXT,           -- 'exercise' | 'nutrition' | 'scheduling' | 'equipment' | 'recovery'

  -- The fact
  fact            TEXT NOT NULL,  -- human-readable, e.g. "Prefers morning workouts"
  confidence      REAL NOT NULL DEFAULT 1.0,  -- 0.0-1.0

  -- Source tracking
  source_type     TEXT NOT NULL,  -- 'trainer_confirmed' | 'client_reported' | 'db_derived' | 'assessment'
  source_id       TEXT,           -- row id or reference for audit
  source_text     TEXT,           -- original text if derived from conversation

  -- Lifecycle
  status          TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'stale' | 'superseded' | 'deleted'
  expires_at      TIMESTAMPTZ,    -- optional TTL
  verified_at     TIMESTAMPTZ,    -- last time this was confirmed true

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ai_client_memory_lookup
  ON ai_client_memory (client_id, organization_id, status)
  WHERE status = 'active';
```

### `ai_client_episodes`

```sql
-- Notable events in the coaching relationship.
-- Immutable once written; status field for lifecycle.
CREATE TABLE IF NOT EXISTS ai_client_episodes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  client_id       UUID NOT NULL REFERENCES pt_clients(id),

  -- The event
  episode_type    TEXT NOT NULL,  -- 'programme_change' | 'pr_achieved' | 'injury_reported' | 'deload' | 'assessment' | 'milestone' | 'observation'
  title           TEXT NOT NULL,  -- short summary
  detail          TEXT,           -- full description
  week_number     INTEGER,        -- programme week when this happened
  session_date    DATE,           -- date if session-specific

  -- Source
  source_type     TEXT NOT NULL,  -- 'workout_log' | 'trainer_note' | 'assessment' | 'checkin' | 'ai_detected'
  source_id       TEXT,           -- row id for audit

  -- Classification
  severity        TEXT DEFAULT 'info',  -- 'info' | 'warning' | 'significant'

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ai_client_episodes_lookup
  ON ai_client_episodes (client_id, organization_id, created_at DESC);
```

### Memory Isolation Rules

1. Every memory row carries `organization_id` — cross-tenant reads are impossible.
2. Every memory row carries `client_id` — client isolation is enforced at the query level.
3. `user_id` on semantic memory tracks who confirmed the fact.
4. `source_type` + `source_id` provide full audit trail.
5. No memory is created from model output alone — only from confirmed input or DB facts.

---

## G. MEMORY LIFECYCLE

```
SOURCE
  ↓
CANDIDATE MEMORY
  ↓ (validation: is this from a trusted source?)
VALIDATED
  ↓ (confirmation: trainer confirmed, or DB fact)
CONFIRMED
  ↓ (insert into ai_client_memory with status='active')
ACTIVE
  ↓ (periodic refresh: re-verify against current DB state)
REFRESHED
  ↓ (if source no longer true: update status)
STALE / SUPERSEDED
  ↓ (after TTL or manual action)
DELETED
```

### Memory Creation Rules

| Source | Can Create Memory | Examples |
|---|---|---|
| `trainer_confirmed` | ✅ Direct | Trainer says "client prefers mornings" |
| `client_reported` | ✅ Via trainer | Client tells trainer about travel schedule |
| `db_derived` | ✅ Automatic | PR detection, adherence trend, plateau detection |
| `assessment` | ✅ Direct | Injury found in assessment, mobility restriction |
| `ai_detected` | ⚠️ Candidate only | AI notices pattern — must be confirmed before durable |

### Memory Refresh

Periodic (weekly) scan of active memories:
- Re-verify DB-derived facts against current data
- Mark stale if source no longer exists
- Update `verified_at` on each refresh

### Memory Deletion

- Trainer can delete any memory for their clients
- Super admin can delete any memory
- Soft delete (status='deleted') — kept for audit

---

## H. EXISTING PROGRESSION ENGINE

### Two Progression Systems

#### 1. Legacy: `modules/pt-os/progression.js`

**Schema:** Old workout_plans system — stores one week, derives others via arithmetic.

**Key functions:**
- `weekOf(startDate, onDate)` — which week a date falls in
- `stepsFor(week, everyWeeks)` — how many times the rule has fired
- `applyProgression(exercise, plan, week, fromWeek)` — apply rule to one exercise
- `resolveWeek(rows, plan, week)` — build prescription for any week
- `previewWeeks(exercise, plan, durationWeeks)` — show trajectory

**Progression types:** `none`, `weight`, `reps`, `rpe`

**Rule:** Pure arithmetic. No database. No model involvement.

#### 2. New: `modules/training/progression.js`

**Schema:** New training_programs system — stores every week explicitly.

**Key functions:**
- `propose(progressionType, prescription, performance, opts)` — apply a named rule
- Returns `{ changed, patch, reason }` — never mutates

**Progression types:** `NONE`, `DOUBLE_PROGRESSION`, `WEIGHT_INCREMENT`, `REP_INCREMENT`, `RPE_BASED`, `RIR_BASED`, `PERCENT_1RM`, `TIME_PROGRESSION`, `DISTANCE_PROGRESSION`, `PACE_PROGRESSION`

**Rules:**
- `doubleProgression` — work up rep range, add weight when top hit
- `weightIncrement` — add weight after completion
- `repIncrement` — add reps after completion
- `autoregulated` — adjust based on RPE/RIR vs target
- `percentOneRepMax` — weight follows estimated 1RM
- `timeProgression`, `distanceProgression`, `paceProgression` — cardio

**Every rule is conditional on the work being done.** No automatic progression on missed sessions.

### Supporting Modules

| Module | Purpose |
|---|---|
| `modules/training/records.js` | PR detection — candidates from sets/cardio, comparison against current records |
| `modules/training/volume.js` | Session summary, hard sets by muscle, load volume |
| `modules/training/units.js` | Unit conversion (kg/lb, km/mi, etc.) |
| `modules/training/prescription.js` | Prescription validation |
| `modules/progress/fitness-scoring.js` | Assessment scoring (BP, BMI, VO2max, strength, endurance, flexibility) |
| `modules/pt-os/recovery.js` | Readiness score from check-in data |
| `modules/pt-os/client-snapshot.js` | Alerts, goal tracking, PRs, coach prompts |
| `modules/pt-os/training-analytics.js` | Adherence, muscle volume, PR timeline, missed days |
| `modules/pt-os/training-brief.js` | Comprehensive client brief for programming |

### Data Flow: Workout Completed → Progression

```
TRAINER LOGS SESSION
  → workout_sessions (status='completed')
  → workout_session_exercises (per exercise)
  → workout_sets (per set: weight, reps, RPE)
  → exercise_performances (new schema)
  → set_performances (new schema)
  ↓
DETERMINISTIC ANALYSIS
  → PR detection (records.js): compare against personal_records
  → Volume tracking (volume.js): hard sets by muscle, load volume
  → Adherence (training-analytics.js): sessions done vs planned
  ↓
PROGRESSION DECISION
  → progression.propose(): apply rule to next week's prescription
  → Returns { changed: true/false, patch: {...}, reason: "..." }
  ↓
TRAINER SEES PROPOSAL
  → Can accept, modify, or reject
  → If accepted: writes to training_program_weeks
```

---

## I. PROGRAMMER AGENT ARCHITECTURE

### Position in the Stack

```
WORKOUT DATA (logged sessions, sets, PRs)
  ↓
DETERMINISTIC PROGRESSION (modules/training/progression.js)
  ↓
CLIENT STATE (buildClientState)
  ↓
PROGRAMMER AGENT (AI interpretation layer)
  ↓
PROPOSAL (structured, evidence-backed)
  ↓
VALIDATION (deterministic safety checks)
  ↓
TRAINER APPROVAL (explicit confirmation)
  ↓
EXISTING EXECUTION ENGINE (training_program_weeks)
```

### What the Programmer Agent Can Propose

| Proposal Type | Evidence Required | Safety Check |
|---|---|---|
| Exercise change | Current exercise performance, PRs, limitations | No contraindication with injuries |
| Volume adjustment | Weekly sets vs MEV/MRV landmarks | Within safe range |
| Intensity adjustment | RPE/RIR trends vs target | Not exceeding recovery capacity |
| Rep-range change | Double progression completion rate | Consistent with programme phase |
| Progression explanation | Prescription vs actual performance | N/A (interpretation only) |
| Recovery-based modification | Readiness score, check-in trends | Not overriding medical gate |
| Deload proposal | Consecutive high-RPE weeks, declining readiness | Before overreaching threshold |
| Exercise substitution | Mobility limitations, injury history, available equipment | No contraindication |

### What the Programmer Agent Must NEVER Do

1. **Directly modify the active program** — always a proposal requiring trainer approval
2. **Invent client facts** — only use data from `buildClientState` + memory
3. **Calculate progression numbers** — that's the deterministic engine's job
4. **Override medical gates** — PAR-Q block is absolute
5. **Bypass screening** — same `checkScreeningGate` as workout generation
6. **Write durable memory from unsupported claims** — only confirmed facts

---

## J. AI PROPOSAL CONTRACT

### Universal Proposal Structure

```javascript
{
  // Identity
  proposal_id: UUID,                // generated on creation
  client_id: UUID,
  organization_id: UUID,
  created_by: UUID,                 // user_id (trainer or system)
  created_at: TIMESTAMPTZ,

  // What
  type: 'exercise_change'           // 'volume_adjustment' | 'intensity_adjustment'
       | 'rep_range_change' | 'exercise_substitution'
       | 'progression_explanation' | 'recovery_modification'
       | 'deload_proposal' | 'general_recommendation',
  title: string,                    // human-readable summary
  description: string,              // detailed explanation

  // Why
  reason: string,                   // what triggered this proposal
  evidence: [{                      // every claim must cite a source
    type: 'performance' | 'assessment' | 'checkin' | 'adherence'
        | 'pr' | 'volume' | 'recovery' | 'memory' | 'rule',
    description: string,            // "Last 3 sessions completed all prescribed reps"
    source: string,                 // "workout_sets session_date=2026-08-20"
    value: any,                     // the actual number
  }],

  // Current state snapshot
  current_state: {
    exercise: string | null,
    prescription: { target_weight, target_reps_min, target_reps_max, sets, rpe },
    recent_performance: [{ session_date, weight, reps, rpe }],
    prs: [{ record_type, value, achieved_on }],
    volume_status: 'below' | 'within' | 'above',
  },

  // What changes
  proposed_change: {
    field: string,                  // 'target_weight' | 'exercise_id' | etc.
    current_value: any,
    new_value: any,
    unit: string | null,
  },

  // Confidence and safety
  confidence: 'high' | 'medium' | 'low',
  confidence_factors: [string],     // "3/3 sessions completed", "RPE consistently below target"
  safety_flags: [string],           // any concerns the agent noticed
  requires_approval: true,          // always true for programmer agent

  // Lifecycle
  status: 'pending'                 // 'pending' | 'approved' | 'rejected' | 'expired' | 'applied'
  expires_at: TIMESTAMPTZ,          // auto-expire after 7 days
  reviewed_by: UUID | null,
  reviewed_at: TIMESTAMPTZ | null,
  rejection_reason: string | null,
  applied_at: TIMESTAMPTZ | null,
}
```

### Example Proposal

```json
{
  "proposal_id": "a1b2c3d4-...",
  "client_id": "...",
  "type": "intensity_adjustment",
  "title": "Increase Bench Press to 82.5kg",
  "description": "Based on the last 3 sessions, the client has completed all prescribed reps at 80kg with RPE consistently below target. The double progression rule suggests advancing.",
  "reason": "Every set reached the 12-rep target with average RPE 7.5 (target 8-9)",
  "evidence": [
    {
      "type": "performance",
      "description": "Session 1: 80kg × 12, 12, 11 (RPE 7, 7.5, 8)",
      "source": "set_performances session_date=2026-08-20"
    },
    {
      "type": "performance",
      "description": "Session 2: 80kg × 12, 12, 12 (RPE 7, 7.5, 7.5)",
      "source": "set_performances session_date=2026-08-17"
    },
    {
      "type": "performance",
      "description": "Session 3: 80kg × 12, 12, 10 (RPE 7.5, 8, 8.5)",
      "source": "set_performances session_date=2026-08-13"
    }
  ],
  "current_state": {
    "exercise": "Bench Press",
    "prescription": { "target_weight": 80, "target_reps_min": 10, "target_reps_max": 12, "sets": 3, "rpe": 8 },
    "recent_performance": [...],
    "prs": [{ "record_type": "MAX_WEIGHT", "value": 82.5, "achieved_on": "2026-07-15" }]
  },
  "proposed_change": {
    "field": "target_weight",
    "current_value": 80,
    "new_value": 82.5,
    "unit": "kg"
  },
  "confidence": "high",
  "confidence_factors": ["3/3 sessions completed", "All sets at target reps", "Average RPE 7.5 below target 8"],
  "safety_flags": [],
  "requires_approval": true,
  "status": "pending",
  "expires_at": "2026-08-30T00:00:00Z"
}
```

---

## K. REQUIRED TOOLS

### New AI Tools (added to `lib/ai/tools.js`)

| Tool | Purpose | Data Source |
|---|---|---|
| `client_state` | Full client state for AI context | `buildClientState()` |
| `training_history` | Recent sessions, adherence, volume | workout_sessions, exercise_performances |
| `progression_status` | Current progression rule + next step | training_program_weeks, progression.js |
| `muscle_balance` | Volume per muscle vs landmarks | volume.js, muscle_volume_landmarks |
| `recovery_trend` | Readiness score over time | weekly_checkins, recovery.js |
| `client_memory` | Durable memories for this client | ai_client_memory |

### Modified AI Routes

| Route | Change |
|---|---|
| `POST /api/ai/chat` | Enhanced with `client_state` tool |
| `POST /api/ai/workout/generate` | Enhanced with full client state |
| `POST /api/ai/diet/generate` | Enhanced with full client state |
| `POST /api/ai/progress/analyze` | Enhanced with full client state |
| **NEW** `POST /api/ai/programmer/propose` | Programmer agent endpoint |
| **NEW** `GET /api/ai/proposals/:client_id` | List pending proposals |
| **NEW** `POST /api/ai/proposals/:id/approve` | Approve a proposal |
| **NEW** `POST /api/ai/proposals/:id/reject` | Reject a proposal |
| **NEW** `POST /api/ai/memory` | Create/update memory |
| **NEW** `GET /api/ai/memory/:client_id` | List client memories |

---

## L. REQUIRED EVENTS

### New Activity Log Events

| Event | Object | When |
|---|---|---|
| `ai.proposal.created` | `ai_proposals` | Proposal generated |
| `ai.proposal.approved` | `ai_proposals` | Trainer approves |
| `ai.proposal.rejected` | `ai_proposals` | Trainer rejects |
| `ai.proposal.applied` | `ai_proposals` | Changes written to programme |
| `ai.proposal.expired` | `ai_proposals` | Auto-expired |
| `ai.memory.created` | `ai_client_memory` | New memory confirmed |
| `ai.memory.updated` | `ai_client_memory` | Memory modified |
| `ai.memory.deleted` | `ai_client_memory` | Memory soft-deleted |
| `ai.memory.stale` | `ai_client_memory` | Periodic refresh marks stale |

---

## M. API CHANGES

### New Endpoints

| Method | Path | Purpose | Auth |
|---|---|---|---|
| `POST` | `/api/ai/programmer/propose` | Generate proposals for a client | admin/manager/trainer |
| `GET` | `/api/ai/proposals/:client_id` | List proposals for a client | admin/manager/trainer |
| `GET` | `/api/ai/proposals/:id` | Get one proposal | admin/manager/trainer |
| `POST` | `/api/ai/proposals/:id/approve` | Approve → write to programme | admin/manager/trainer |
| `POST` | `/api/ai/proposals/:id/reject` | Reject with reason | admin/manager/trainer |
| `POST` | `/api/ai/memory` | Create/update semantic memory | admin/manager/trainer |
| `GET` | `/api/ai/memory/:client_id` | List client memories | admin/manager/trainer |
| `DELETE` | `/api/ai/memory/:id` | Soft-delete a memory | admin/manager/trainer |

### Modified Endpoints

| Endpoint | Change |
|---|---|
| `POST /api/ai/chat` | Enhanced tools include `client_state` |
| `POST /api/ai/workout/generate` | Uses `buildClientState` instead of `loadAuthoritativeClient` |
| `POST /api/ai/diet/generate` | Uses `buildClientState` instead of `loadAuthoritativeClient` |
| `POST /api/ai/progress/analyze` | Uses `buildClientState` for richer context |

---

## N. DATABASE CHANGES

### New Tables

| Table | Purpose |
|---|---|
| `ai_client_memory` | Durable semantic memory (see §F) |
| `ai_client_episodes` | Episodic memory (see §F) |
| `ai_proposals` | Programmer agent proposals (see §J) |

### New Columns

| Table | Column | Purpose |
|---|---|---|
| `ai_usage_log` | `proposal_id` | Link usage to a proposal |

### New Indexes

| Table | Index | Purpose |
|---|---|---|
| `ai_client_memory` | `(client_id, organization_id, status) WHERE status='active'` | Fast memory lookup |
| `ai_client_episodes` | `(client_id, organization_id, created_at DESC)` | Episode history |
| `ai_proposals` | `(client_id, organization_id, status) WHERE status='pending'` | Pending proposals |

---

## O. SECURITY / TENANT ISOLATION

### Memory Isolation

1. Every `ai_client_memory` row carries `organization_id` — enforced at INSERT by `tenantScope`.
2. Every `ai_client_memory` row carries `client_id` — cross-client reads impossible.
3. `user_id` tracks who confirmed — full accountability chain.
4. No memory is created from model output alone.

### Proposal Isolation

1. Every `ai_proposals` row carries `organization_id`.
2. Every `ai_proposals` row carries `client_id`.
3. Approval/rejection requires the same role that could edit the programme.
4. Proposals cannot be approved by the same user who created them (separation of duties).

### Programmer Agent Restrictions

1. The agent runs AFTER `checkScreeningGate` — no proposals for blocked clients.
2. The agent cannot bypass medical gates — proposals for blocked clients are auto-rejected.
3. The agent cannot modify programmes for clients it hasn't been authorized to access.
4. All proposals are audited with `activity_log`.

---

## P. TOKEN / COST IMPACT

### Current Cost per AI Request

| Route | Approx Tokens | Cost (free tier) |
|---|---|---|
| Chat | ~1,500 | $0 |
| Workout generate | ~3,000 | $0 |
| Diet generate | ~3,500 | $0 |
| Progress analyze | ~2,000 | $0 |
| Fitness testing | ~1,500 | $0 |

### Projected Cost with Client State

| Route | New Tokens | Delta | Notes |
|---|---|---|---|
| Chat | +200-500 | +13-33% | Client state added to context |
| Workout generate | +300-600 | +10-20% | Richer client data |
| Diet generate | +300-600 | +9-17% | Richer client data |
| Progress analyze | +500-800 | +25-40% | Most data-rich request |
| Programmer propose | +1,500-2,500 | new | Full state + performance data |

### Optimization Strategy

1. **Task-specific context:** Not every request gets the full state. Chat gets a summary; programmer gets full detail.
2. **Deterministic aggregation:** Pre-compute what the model doesn't need to interpret (adherence %, volume per muscle, PR timeline).
3. **Token budget per intent:** Cap the context size per route to prevent runaway costs.
4. **Memory pruning:** Old episodes are summarized, not sent verbatim.

---

## Q. TEST STRATEGY

### Unit Tests

| Module | Tests |
|---|---|
| `buildClientState` | All sections, missing data handling, freshness rules |
| Memory CRUD | Create, read, update, delete, soft-delete |
| Memory lifecycle | Candidate → validated → confirmed → active → stale → deleted |
| Proposal generation | Every proposal type, evidence requirements, safety checks |
| Proposal approval | Write to programme, audit trail |
| Proposal rejection | Reason recording, no programme change |
| Proposal expiry | Auto-expire after TTL |

### Integration Tests

| Flow | Tests |
|---|---|
| Programmer agent end-to-end | Propose → validate → approve → apply |
| Memory + chat | Memory loaded into chat context |
| Memory + workout generate | Memory influences exercise selection |
| Memory + diet generate | Memory influences meal planning |
| Proposal + programme | Approved proposal writes correct rows |
| Tenant isolation | Cross-tenant memory/proposal reads fail |

### Regression Tests

| Existing Test | Impact |
|---|---|
| `ai.generators.test.js` | Must still pass with enhanced context |
| `ai.chat.safety.test.js` | Must still pass with memory injection |
| `ai.rate-limit.test.js` | New intents must be rate-limited |
| `tenantScope.convention.test.js` | New tables must be tenant-scoped |
| `training.domain.test.js` | Progression engine unchanged |

---

## R. IMPLEMENTATION ORDER

### Phase 2A: Canonical Client State (Week 1-2)

1. **Create `lib/ai/clientState.js`** — the `buildClientState()` function
2. **Write comprehensive tests** — all sections, missing data, freshness
3. **Integrate into existing routes** — replace `buildClientContext` and `loadAuthoritativeClient` with `buildClientState` (backward-compatible wrapper)
4. **Verify all existing tests pass**

**Deliverable:** One function that returns the complete client state. All existing AI routes use it.

### Phase 2B: Memory Infrastructure (Week 2-3)

1. **Create migration** — `ai_client_memory` + `ai_client_episodes` tables
2. **Create `lib/ai/memory.js`** — CRUD operations, lifecycle management
3. **Create memory routes** — `/api/ai/memory/*`
4. **Write tests** — CRUD, lifecycle, isolation
5. **Integrate into chat route** — memory loaded into context

**Deliverable:** Memory system that trainers can use and AI can read.

### Phase 2C: Memory Indexing (Week 3-4)

1. **Auto-extract memories** from confirmed actions (PRs, programme changes, assessments)
2. **Memory refresh job** — periodic scan for stale memories
3. **Memory-aware coaching** — `generateCoach` uses memory
4. **Write tests** — auto-extraction, refresh, coaching integration

**Deliverable:** Memory that populates automatically from confirmed data.

### Phase 2D: Programmer Agent (Week 4-6)

1. **Create `modules/training/programmer-agent.js`** — proposal generation logic
2. **Create `ai_proposals` table** — migration
3. **Create proposal routes** — CRUD + approve/reject
4. **Create proposal validation** — deterministic safety checks
5. **Integrate with progression engine** — proposals use `progression.propose()`
6. **Write tests** — every proposal type, validation, approval flow

**Deliverable:** Programmer agent that generates evidence-backed proposals.

### Phase 2E: Trainer Intelligence UI (Week 6-8)

1. **Client Intelligence Summary** — what's happening, what changed, what needs attention
2. **Proposal cards** — approve/reject with evidence
3. **Memory management** — view/edit/delete memories
4. **Freshness indicators** — show data age on every card
5. **Missing data prompts** — "This client has no nutrition logs"

**Deliverable:** Trainer sees a complete, current, actionable view of every client.

---

## NON-NEGOTIABLE RULES — ENFORCEMENT CHECKLIST

| Rule | Enforcement Point |
|---|---|
| Deterministic system owns measurements | `buildClientState` returns raw values; AI interprets |
| AI never invents client facts | Memory creation requires `source_type` + `source_id` |
| AI never changes scores | Scores computed in `fitness-scoring.js`, never in prompts |
| AI never directly modifies programs | Proposals require trainer approval |
| AI never bypasses screening | `checkScreeningGate` runs before programmer agent |
| AI never writes durable memory from unsupported claims | Memory creation validates source |
| AI never bypasses tenant isolation | `organization_id` enforced at INSERT and SELECT |
| AI never directly writes database state | Proposals are the only write path |
| Memory is organization-isolated | `organization_id` on every row |
| Memory is client-isolated | `client_id` on every row |
| Memory is permission-checked | Role-based access on routes |
| Memory is source-backed | `source_type` + `source_id` required |
| Memory is timestamped | `created_at` + `updated_at` on every row |
| Memory is confidence-aware | `confidence` field (0.0-1.0) |
| Memory is refreshable | Periodic scan marks stale |
| Memory is deletable | Soft delete with audit |
| Memory is auditable | `activity_log` on every mutation |
