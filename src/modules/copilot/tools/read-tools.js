'use strict';
// Phase 3 read-only Copilot tools.
//
// Each definition names an existing service, not a query. The SQL that backs
// these answers already powers a screen; a second copy here is how the Copilot
// starts telling a trainer something the page disagrees with. The two places a
// tool reads directly are pt_leads (no service exposes it) and the active
// plan's prescribed rows (the workout log's own resolver is used on them).
//
// Everything returned is deliberately narrower than the service result:
// contact data, free-text notes and clinical prose stay out of the model
// payload, and every handler states what it did not find rather than filling
// the gap.

const { z } = require('zod');
const pool = require('../../../db/pool');
const svc = require('../../pt-os/pt-os.service');
const clientRead = require('../../pt-os/client-read.service');
const memberGoals = require('../../client-portal/member-goals.service');
const { loadClientSources } = require('../../pt-os/authoritative-client');
const { programState, adherenceInputs } = require('../../pt-os/client-context');
const { buildTrainingHistory } = require('../../pt-os/training-history');
const { buildChurnList } = require('../../pt-os/churn.service');
const { programmeWeek, resolveWeek } = require('../../pt-os/progression');
const { today: studioToday, dbDate } = require('../../../lib/appTime');
const { ageFromDob } = require('../../../lib/age');
const { attendanceSummary, assessFreshness } = require('../context/assemble');
const { ToolError } = require('./registry');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const addDays = (ymd, n) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const spanDays = (from, to) => Math.round(
  (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000
);

const recordsOf = (type, rows) => (rows || [])
  .map((r) => (typeof r === 'string' ? r : r?.id))
  .filter(Boolean)
  .slice(0, 50)
  .map((id) => ({ type, id }));

const provenance = ({ source, records = [], as_of = null, freshness = null, missing = [] }) => ({
  source, records, as_of, freshness, missing,
});

/** Free-text trainer/coach notes are not part of a tool payload. */
function withoutNotes(value) {
  if (Array.isArray(value)) return value.map(withoutNotes);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/(^|_)notes?$/i.test(k)) continue;
      out[k] = withoutNotes(v);
    }
    return out;
  }
  return value;
}

const TOOLS = [
  /* ── 1. The trainer's schedule ───────────────────────────────────────── */
  {
    name: 'get_trainer_schedule',
    label: 'Trainer Schedule',
    description: 'Booked PT sessions for the studio in a date window, ascending.',
    level: 'READ',
    clientScope: 'none',
    sensitivity: 'schedule',
    timeoutMs: 5000,
    source: 'pt-os.service.getTrainerSchedule',
    args: z.object({
      from: z.string().regex(DATE_RE).optional(),
      to: z.string().regex(DATE_RE).optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }).strict()
      .refine((v) => !v.from || !v.to || v.to >= v.from, { message: 'to must be on or after from', path: ['to'] })
      .refine((v) => !v.from || !v.to || spanDays(v.from, v.to) <= 31, {
        message: 'window must be 31 days or fewer', path: ['to'],
      }),
    async run({ ctx, args }) {
      const today = studioToday();
      const from = args.from || today;
      const to = args.to || addDays(from, 7);
      if (spanDays(from, to) > 31) {
        throw new ToolError('BAD_ARGS', 400, 'window must be 31 days or fewer');
      }
      const rows = await svc.getTrainerSchedule(ctx.tenant.organizationId, {
        from, to, limit: args.limit,
      });
      const sessions = rows.map((r) => ({
        id: r.id,
        date: dbDate(r.session_date),
        start: r.start_time ?? null,
        end: r.end_time ?? null,
        title: r.title ?? null,
        status: r.status ?? null,
        client_name: r.client_name ?? null,
        plan_name: r.plan_name ?? null,
      }));
      return {
        data: { from, to, sessions },
        provenance: provenance({
          source: 'pt-os.service.getTrainerSchedule',
          records: recordsOf('pt_sessions', sessions),
          as_of: today,
          freshness: assessFreshness(today, 0),
          missing: sessions.length ? [] : ['no sessions in the requested window'],
        }),
      };
    },
  },

  /* ── 2. Trainer workload ─────────────────────────────────────────────── */
  {
    name: 'get_trainer_workload',
    label: 'Trainer Workload',
    description: 'This month\'s completed, booked and missed sessions per trainer.',
    level: 'READ',
    clientScope: 'none',
    sensitivity: 'business',
    timeoutMs: 5000,
    source: 'pt-os.service.getTrainerWorkload',
    args: z.object({}).strict(),
    async run({ ctx }) {
      const rows = await svc.getTrainerWorkload(ctx.tenant.organizationId);
      const totals = rows.reduce((sum, r) => ({
        completed: sum.completed + (Number(r.completed) || 0),
        scheduled: sum.scheduled + (Number(r.scheduled) || 0),
        missed: sum.missed + (Number(r.missed) || 0),
      }), { completed: 0, scheduled: 0, missed: 0 });
      const today = studioToday();
      return {
        data: {
          month: today.slice(0, 7),
          totals,
          trainers: rows.map((r) => ({
            trainer_name: r.trainer_name,
            completed: Number(r.completed) || 0,
            scheduled: Number(r.scheduled) || 0,
            missed: Number(r.missed) || 0,
          })),
        },
        provenance: provenance({
          source: 'pt-os.service.getTrainerWorkload',
          as_of: today,
          freshness: assessFreshness(today, 0),
          missing: rows.length ? [] : ['no trainer activity recorded this month'],
        }),
      };
    },
  },

  /* ── 3. Client profile ───────────────────────────────────────────────── */
  {
    name: 'get_client_profile',
    label: 'Client Profile',
    description: 'Enrolment, term, package, screening and contact-on-file status for the selected client.',
    level: 'READ',
    clientScope: 'required',
    sensitivity: 'personal',
    timeoutMs: 5000,
    source: 'pt-os.client-read.service.getClientProfile',
    args: z.object({}).strict(),
    async run({ ctx, clientId }) {
      const p = await clientRead.getClientProfile(ctx.tenant.organizationId, clientId);
      if (!p) throw new ToolError('CLIENT_NOT_FOUND', 404, 'Client not found, or not visible to you.');

      const s = p.screening || {};
      const missing = [];
      if (!p.goal) missing.push('goal');
      if (p.weight == null) missing.push('weight');
      if (!p.pt_end_date) missing.push('pt_end_date');
      if (!p.mobile && !p.email) missing.push('contact');

      return {
        data: {
          id: p.id,
          name: p.name,
          status: p.status ?? null,
          gender: p.gender ?? null,
          age: ageFromDob(p.dob),
          goal: p.goal ?? null,
          package_type: p.package_type ?? null,
          weight_kg: num(p.weight),
          pt_start_date: dbDate(p.pt_start_date),
          pt_end_date: dbDate(p.pt_end_date),
          days_left: num(p.days_left),
          duration_months: num(p.duration_months),
          current_term_balance: num(p.current_term_balance),
          due_status: p.due_status ?? null,
          trainer_name: p.trainer_name ?? null,
          // Contact details stay out; the trainer is told they exist.
          contact_on_file: {
            mobile: Boolean(p.mobile),
            email: Boolean(p.email),
            address: Boolean(p.address),
            emergency_contact: Boolean(p.emergency_contact),
          },
          screening: {
            consent_status: s.consent?.status ?? null,
            parq_status: s.parq?.status ?? null,
            risk_level: s.parq?.risk_level ?? null,
            complete: s.complete ?? null,
            block_code: s.block?.code ?? null,
            block_message: s.block?.message ?? null,
            missing: Array.isArray(s.missing) ? s.missing : [],
          },
          last_updated: dbDate(p.updated_at),
        },
        provenance: provenance({
          source: 'pt-os.client-read.service.getClientProfile',
          records: [{ type: 'pt_clients', id: p.id }],
          as_of: dbDate(p.updated_at),
          freshness: assessFreshness(dbDate(p.updated_at), 180),
          missing,
        }),
      };
    },
  },

  /* ── 4. Client goals ─────────────────────────────────────────────────── */
  {
    name: 'get_client_goals',
    label: 'Client Goals',
    description: 'Member-set goals with progress, plus the trainer\'s active goal for the client.',
    level: 'READ',
    clientScope: 'required',
    sensitivity: 'personal',
    timeoutMs: 5000,
    source: 'client-portal.member-goals.service.goalsForStudio',
    args: z.object({}).strict(),
    async run({ ctx, clientId }) {
      const orgId = ctx.tenant.organizationId;
      const [goals, sources] = await Promise.all([
        memberGoals.goalsForStudio(clientId, orgId),
        loadClientSources(clientId, orgId, { clinical: false }),
      ]);
      if (!goals || !sources) {
        throw new ToolError('CLIENT_NOT_FOUND', 404, 'Client not found, or not visible to you.');
      }

      const memberGoalsOut = (goals.goals || []).map((g) => ({
        id: g.id,
        kind: g.kind,
        exercise_name: g.exercise_name ?? null,
        start_value: g.start_value ?? null,
        target_value: g.target_value ?? null,
        current_value: g.current_value ?? null,
        target_date: g.target_date ?? null,
        created_at: g.created_at ?? null,
        achieved_at: g.achieved_at ?? null,
        reached: g.reached === true,
        progress_pct: g.progress_pct ?? null,
        projection: g.projection ?? null,
        status: g.status ?? null,
      }));

      const trainerGoals = (sources.goals || []).map((g) => ({
        id: g.id,
        goal_type: g.goal_type ?? null,
        priority: g.priority_goal ?? null,
        target_weight: num(g.target_weight),
        target_body_fat: num(g.target_body_fat),
        target_date: dbDate(g.target_date),
        starting_weight: num(g.starting_weight),
        created_at: g.created_at ?? null,
      }));

      const missing = [];
      if (!memberGoalsOut.length) missing.push('no member goals recorded');
      if (!goals.studio) missing.push('no active trainer goal');

      const latest = [goals.studio?.created_at, ...(goals.goals || []).map((g) => g.created_at)]
        .filter(Boolean).map(dbDate).sort().pop() || null;

      return {
        data: {
          client_goal: sources.client?.goal ?? null,
          trainer_goal: goals.studio ?? null,
          member_goals: memberGoalsOut,
          active_trainer_goals: trainerGoals,
        },
        provenance: provenance({
          source: 'client-portal.member-goals.service.goalsForStudio',
          records: [...recordsOf('member_goals', memberGoalsOut), ...recordsOf('pt_goals', trainerGoals)],
          as_of: latest,
          freshness: assessFreshness(latest, 365),
          missing,
        }),
      };
    },
  },

  /* ── 5. Client assessments ───────────────────────────────────────────── */
  {
    name: 'get_client_assessments',
    label: 'Client Assessments',
    description: 'Readiness, body composition, capacity and limitations, with missing and stale markers.',
    level: 'READ',
    clientScope: 'required',
    sensitivity: 'clinical',
    timeoutMs: 5000,
    source: 'pt-os.client-read.service.getClientTrainingBrief',
    args: z.object({}).strict(),
    async run({ ctx, clientId }) {
      const brief = await clientRead.getClientTrainingBrief(ctx.tenant.organizationId, clientId);
      if (!brief) throw new ToolError('CLIENT_NOT_FOUND', 404, 'Client not found, or not visible to you.');

      const keys = ['readiness', 'body', 'capacity', 'limitations'];
      const sections = {};
      for (const key of keys) sections[key] = withoutNotes(brief.sections?.[key] ?? { present: false });

      const missing = (brief.missing || []).filter((k) => keys.includes(k));
      const stale = (brief.stale || []).filter((s) => keys.includes(s.section));
      const asOf = keys
        .map((k) => sections[k]?.as_of)
        .filter(Boolean)
        .sort()
        .pop() || null;

      return {
        data: {
          client: { id: brief.client?.id ?? clientId, name: brief.client?.name ?? null },
          sections,
          missing,
          stale,
          completeness_pct: Math.round(((keys.length - missing.length) / keys.length) * 100),
        },
        provenance: provenance({
          source: 'pt-os.client-read.service.getClientTrainingBrief',
          records: [{ type: 'pt_clients', id: clientId }],
          as_of: asOf,
          freshness: assessFreshness(asOf, 365),
          missing: missing.map((k) => `no ${k} assessment on file`),
        }),
      };
    },
  },

  /* ── 6. Client progress ──────────────────────────────────────────────── */
  {
    name: 'get_client_progress',
    label: 'Client Progress',
    description: 'Goal progress, personal records, alerts and derived coach prompts.',
    level: 'READ',
    clientScope: 'required',
    sensitivity: 'personal',
    timeoutMs: 5000,
    source: 'pt-os.client-read.service.getClientSnapshot',
    args: z.object({}).strict(),
    async run({ ctx, clientId }) {
      const snapshot = await clientRead.getClientSnapshot(ctx.tenant.organizationId, clientId);
      if (!snapshot) throw new ToolError('CLIENT_NOT_FOUND', 404, 'Client not found, or not visible to you.');

      const missing = [];
      if (!snapshot.baseline_done) missing.push('no baseline measurements or goal');
      if (!(snapshot.prs || []).length) missing.push('no personal records logged');

      const latestPr = (snapshot.prs || []).map((p) => p.achieved_on).filter(Boolean).sort().pop() || null;

      return {
        data: {
          // Measured facts, then the computed advice, named apart so the model
          // can say which is which.
          facts: {
            alerts: snapshot.alerts || [],
            goal: snapshot.goal || { present: false },
            prs: snapshot.prs || [],
            baseline_done: snapshot.baseline_done === true,
            recovery: snapshot.recovery ?? null,
          },
          inferred: { coach: snapshot.coach || [] },
        },
        provenance: provenance({
          source: 'pt-os.client-read.service.getClientSnapshot',
          records: [{ type: 'pt_clients', id: clientId }],
          as_of: latestPr,
          freshness: assessFreshness(latestPr, 90),
          missing,
        }),
      };
    },
  },

  /* ── 7. Workout history ──────────────────────────────────────────────── */
  {
    name: 'get_workout_history',
    label: 'Workout History',
    description: 'Logged sets, weekly volume, adherence and per-exercise trends in a bounded window.',
    level: 'READ',
    clientScope: 'required',
    sensitivity: 'personal',
    timeoutMs: 8000,
    source: 'pt-os.training-history.buildTrainingHistory',
    args: z.object({
      window_weeks: z.number().int().min(1).max(24).default(12),
    }).strict(),
    async run({ ctx, clientId, args }) {
      const orgId = ctx.tenant.organizationId;
      const weeks = args.window_weeks;
      const sources = await loadClientSources(clientId, orgId, {
        clinical: false, training: true, sets: true, windowWeeks: weeks,
      });
      if (!sources) throw new ToolError('CLIENT_NOT_FOUND', 404, 'Client not found, or not visible to you.');

      const history = buildTrainingHistory({
        sets: sources.sets || [],
        assignment: adherenceInputs(sources.assignment, sources.sessions || [], weeks),
        windowWeeks: weeks,
      });

      // Points are the per-session e1RM series; a trainer asking for an
      // overview does not need 24 dates per movement in the prompt.
      const exercises = (history.exercises || []).slice(0, 10).map(({ points: _points, ...rest }) => rest);
      const lastTrained = exercises.map((e) => e.last_performed).filter(Boolean).sort().pop() || null;
      const missing = history.has_history
        ? []
        : ['no completed sets logged in the window'];

      return {
        data: {
          window_weeks: history.window_weeks,
          has_history: history.has_history,
          totals: history.totals,
          adherence: history.adherence,
          exercises,
          weeks: history.weeks,
          skipped_exercises: history.skipped_exercises,
          plateaued: history.plateaued,
          regressing: history.regressing,
          // Derived from the measured sets above, not observations of their own.
          inferred: { fatigue: history.fatigue, confidence: history.confidence },
        },
        provenance: provenance({
          source: 'pt-os.training-history.buildTrainingHistory',
          records: [{ type: 'pt_clients', id: clientId }],
          as_of: lastTrained,
          freshness: assessFreshness(lastTrained, 14),
          missing,
        }),
      };
    },
  },

  /* ── 8. Active workout programme ─────────────────────────────────────── */
  {
    name: 'get_active_workout_program',
    label: 'Active Workout Program',
    description: 'The client\'s active plan, current week, progress and prescribed exercises.',
    level: 'READ',
    clientScope: 'required',
    sensitivity: 'personal',
    timeoutMs: 5000,
    source: 'pt-os.client-context.programState',
    args: z.object({}).strict(),
    async run({ ctx, clientId }) {
      const orgId = ctx.tenant.organizationId;
      const sources = await loadClientSources(clientId, orgId, { clinical: false, training: true });
      if (!sources) throw new ToolError('CLIENT_NOT_FOUND', 404, 'Client not found, or not visible to you.');

      const program = programState(sources.assignment, sources.sessions || []);
      if (!program.active) {
        return {
          data: { active: false },
          provenance: provenance({
            source: 'pt-os.client-context.programState',
            records: [{ type: 'pt_clients', id: clientId }],
            as_of: null,
            missing: ['no active workout program'],
          }),
        };
      }

      const today = studioToday();
      const week = programmeWeek(program.started_on, today, program.duration_weeks);
      const [planResult, exResult] = await Promise.all([
        pool.query(
          `SELECT id, name, duration_weeks, progression_type, progression_amount,
                  progression_every_weeks, periodization_model, block_phases,
                  deload_every_weeks, deload_intensity_pct
             FROM workout_plans
            WHERE id = $1 AND deleted_at IS NULL`,
          [program.plan_id]
        ),
        pool.query(
          `SELECT we.day_of_week, we.week_number, we.exercise_id, e.name AS exercise_name,
                  we.sets, we.reps, we.target_weight, we.rpe, we.sort_order
             FROM workout_exercises we
             LEFT JOIN exercises e ON e.id = we.exercise_id
            WHERE we.workout_plan_id = $1 AND we.week_number <= $2
            ORDER BY we.day_of_week, we.week_number, we.sort_order
            LIMIT 100`,
          [program.plan_id, week]
        ),
      ]);

      const plan = planResult.rows[0] || null;
      const byDay = new Map();
      for (const row of exResult.rows) {
        const day = Number(row.day_of_week);
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day).push(row);
      }

      const days = [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([day, dayRows]) => {
        const resolved = resolveWeek(dayRows, plan, week);
        return {
          day_of_week: day,
          day: DAY_NAMES[day - 1] ?? null,
          source: resolved.source,
          exercises: resolved.exercises.map((ex) => ({
            name: ex.exercise_name ?? null,
            sets: num(ex.sets),
            reps: num(ex.reps),
            target_weight: num(ex.target_weight),
            rpe: num(ex.rpe),
          })),
        };
      });

      const missing = [];
      if (!plan) missing.push('plan record not found');
      if (!days.length) missing.push('plan has no prescribed exercises');
      if (exResult.rows.length === 100) missing.push('exercise list truncated at 100 rows');

      return {
        data: { ...program, current_week: week, plan_name: plan?.name ?? program.plan_name, days },
        provenance: provenance({
          source: 'pt-os.client-context.programState',
          records: [
            { type: 'pt_clients', id: clientId },
            ...(program.plan_id ? [{ type: 'workout_plans', id: program.plan_id }] : []),
          ],
          as_of: today,
          freshness: assessFreshness(today, 0),
          missing,
        }),
      };
    },
  },

  /* ── 9. Attendance summary ───────────────────────────────────────────── */
  {
    name: 'get_attendance_summary',
    label: 'Client Attendance',
    description: 'Check-in counts and last attended date for the selected client in a bounded window.',
    level: 'READ',
    clientScope: 'required',
    sensitivity: 'personal',
    timeoutMs: 5000,
    source: 'copilot.context.assemble.attendanceSummary',
    args: z.object({
      days: z.number().int().min(7).max(90).default(28),
    }).strict(),
    async run({ ctx, clientId, args }) {
      const rows = await clientRead.getClientAttendance(ctx.tenant.organizationId, clientId);
      if (rows === null) throw new ToolError('CLIENT_NOT_FOUND', 404, 'Client not found, or not visible to you.');

      const summary = attendanceSummary(rows, new Date(), args.days);
      const missing = [];
      if (summary.present === 0) missing.push('no present check-ins in the window');
      if (!summary.last_present_on) missing.push('no attendance ever recorded');

      return {
        data: summary,
        provenance: provenance({
          source: 'copilot.context.assemble.attendanceSummary',
          records: recordsOf('attendance_logs', rows),
          as_of: summary.last_present_on,
          freshness: summary.freshness,
          missing,
        }),
      };
    },
  },

  /* ── 10. Pending follow-ups ──────────────────────────────────────────── */
  {
    name: 'get_pending_followups',
    label: 'Pending Follow-ups',
    description: 'Churn-risk clients and leads whose follow-up date has arrived.',
    level: 'READ',
    clientScope: 'none',
    sensitivity: 'personal',
    timeoutMs: 8000,
    source: 'pt-os.churn.service.buildChurnList',
    args: z.object({
      limit: z.number().int().min(1).max(50).default(15),
    }).strict(),
    async run({ ctx, args }) {
      const orgId = ctx.tenant.organizationId;
      const [list, leadResult] = await Promise.all([
        buildChurnList(orgId),
        pool.query(
          `SELECT id, name, status, source, interested_package, follow_up_date, trainer_name
             FROM pt_leads
            WHERE organization_id = $1
              AND status IN ('new', 'contacted')
              AND follow_up_date IS NOT NULL
              AND follow_up_date <= CURRENT_DATE
            ORDER BY follow_up_date ASC
            LIMIT $2`,
          [orgId, args.limit]
        ),
      ]);

      const churn = (list.rows || []).slice(0, args.limit).map((r) => ({
        client_id: r.client_id,
        client_name: r.client_name,
        score: r.score,
        band: r.band,
        reasons: r.reasons,
        next_action: r.next_action,
        last_session: r.last_session,
        days_quiet: r.days_quiet,
        term: r.term,
        balance_amount: num(r.balance_amount),
        risk_increased: r.risk_increased === true,
      }));

      const leads = leadResult.rows.map((r) => ({
        id: r.id,
        name: r.name,
        status: r.status,
        source: r.source,
        interested_package: r.interested_package ?? null,
        follow_up_date: dbDate(r.follow_up_date),
        trainer_name: r.trainer_name ?? null,
      }));

      const missing = [];
      if (!churn.length) missing.push('no clients above the churn-risk threshold');
      if (!leads.length) missing.push('no leads with a follow-up due');

      return {
        data: {
          as_of: list.as_of,
          assessed: list.assessed,
          flagged: list.flagged,
          bands: list.bands,
          churn,
          leads,
        },
        provenance: provenance({
          source: 'pt-os.churn.service.buildChurnList',
          records: [
            ...recordsOf('pt_clients', churn.map((r) => r.client_id)),
            ...recordsOf('pt_leads', leads),
          ],
          as_of: list.as_of,
          freshness: assessFreshness(list.as_of, 0),
          missing,
        }),
      };
    },
  },

  /* ── 11. Membership alerts ───────────────────────────────────────────── */
  {
    name: 'get_membership_alerts',
    label: 'Membership Alerts',
    description: 'Terms that have ended or are ending soon, and clients with an outstanding balance.',
    level: 'READ',
    clientScope: 'none',
    sensitivity: 'business',
    timeoutMs: 5000,
    source: 'pt-os.service.getBalanceSheet',
    args: z.object({
      days: z.number().int().min(1).max(90).default(14),
    }).strict(),
    async run({ ctx, args }) {
      const rows = await svc.getBalanceSheet({ orgId: ctx.tenant.organizationId });
      const alerts = [];

      for (const c of rows) {
        const daysLeft = c.days_left === null || c.days_left === undefined ? null : Number(c.days_left);
        const balance = num(c.balance_amount);
        const base = {
          client_id: c.id,
          client_name: c.name,
          status: c.status ?? null,
          package_type: c.package_type ?? null,
          pt_end_date: dbDate(c.pt_end_date),
          days_left: Number.isFinite(daysLeft) ? daysLeft : null,
          balance_amount: balance,
        };
        if (daysLeft !== null && Number.isFinite(daysLeft) && c.pt_end_date) {
          if (daysLeft < 0) alerts.push({ type: 'term_ended', ...base });
          else if (daysLeft <= args.days) alerts.push({ type: 'term_expiring', ...base });
        }
        if (balance !== null && balance > 0) alerts.push({ type: 'outstanding_balance', ...base });
      }

      // Urgency: already ended, then ending soonest, then money owed.
      const rank = { term_ended: 0, term_expiring: 1, outstanding_balance: 2 };
      alerts.sort((a, b) => (rank[a.type] - rank[b.type])
        || ((a.days_left ?? 0) - (b.days_left ?? 0))
        || ((b.balance_amount ?? 0) - (a.balance_amount ?? 0)));

      const capped = alerts.slice(0, 50);
      const missing = capped.length ? [] : ['no expiring terms or outstanding balances'];
      const today = studioToday();

      return {
        data: { as_of: today, checked: rows.length, alerts: capped },
        provenance: provenance({
          source: 'pt-os.service.getBalanceSheet',
          records: recordsOf('pt_clients', [...new Set(capped.map((a) => a.client_id))]),
          as_of: today,
          freshness: assessFreshness(today, 0),
          missing,
        }),
      };
    },
  },
];

module.exports = { TOOLS, withoutNotes };
