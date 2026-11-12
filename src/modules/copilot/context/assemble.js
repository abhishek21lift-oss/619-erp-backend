'use strict';
// The typed context object every Copilot capability receives.
//
// ── What it is ─────────────────────────────────────────────────────────────
//
// Not a prompt and not a SQL dump. It is a small, explicit object with three
// properties the rest of the system relies on:
//
//   provenance   where each group of facts came from
//   freshness    how old the newest record is, and whether that is stale
//   missing      what nobody has recorded, stated as missing rather than
//                defaulted to a plausible value
//
// ── What it deliberately excludes ──────────────────────────────────────────
//
// Mobile, email, address, emergency contacts, free-text notes, recorded
// conditions and injuries. Those are available to task-specific tools that
// need them, with their own authorization; a context blob that every prompt
// receives is the wrong place to put them. The screening summary is included
// because it is derived state (statuses and block codes), not clinical text.
//
// ── Reuse ──────────────────────────────────────────────────────────────────
//
// The reads are the existing canonical services: getClientProfile,
// getClientTrainingBrief and getClientAttendance. Their tenant gate runs
// before any child query, and the brief's own missing/stale calculation is
// used as-is rather than recomputed differently here.

const {
  getClientProfile,
  getClientTrainingBrief,
  getClientAttendance,
} = require('../../pt-os/client-read.service');
const { SECTIONS, sectionDate } = require('../../pt-os/training-brief');
const { ageFromDob } = require('../../../lib/age');
const { resolveSelectedClient, listVisibleClients } = require('./client-scope');

const CONTEXT_VERSION = 1;
const ATTENDANCE_WINDOW_DAYS = 28;
const ATTENDANCE_STALE_AFTER_DAYS = 14;

/** Serialise a pg DATE (JS Date at local midnight) or a string as YYYY-MM-DD. */
function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

/** A finite number, or null. Never NaN, never a string that renders as one. */
function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * How old a record is, and whether that age crosses its threshold.
 *
 * `stale: null` means the age is unknown — which is different from fresh.
 * Same distinction training-brief.js already makes.
 */
function assessFreshness(asOf, staleAfterDays, now = new Date()) {
  const date = dateOnly(asOf);
  if (!date) return { as_of: null, age_days: null, stale: null };

  const then = new Date(`${date}T00:00:00Z`);
  const today = new Date(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  const days = Math.floor((today - then) / 86400000);
  if (!Number.isFinite(days) || days < 0) {
    return { as_of: date, age_days: null, stale: null };
  }
  return { as_of: date, age_days: days, stale: days > staleAfterDays };
}

/** Presence and age for each brief section, never its clinical content. */
function sectionMetadata(brief) {
  const stale = new Set((brief?.stale || []).map((s) => s.section));
  const out = {};
  for (const key of SECTIONS) {
    const section = brief?.sections?.[key];
    out[key] = section?.present
      ? { present: true, as_of: sectionDate(key, section) ?? null, stale: stale.has(key) }
      : { present: false, as_of: null, stale: null };
  }
  return out;
}

/** Status counts inside a bounded window, plus the last attended date overall. */
function attendanceSummary(rows, now, windowDays = ATTENDANCE_WINDOW_DAYS) {
  const cutoff = new Date(now.getTime() - windowDays * 86400000)
    .toISOString()
    .slice(0, 10);

  const summary = {
    window_days: windowDays,
    present: 0,
    absent: 0,
    late: 0,
    half_day: 0,
    last_present_on: null,
  };

  for (const row of rows || []) {
    const date = dateOnly(row.date);
    if (!date) continue;

    if (row.status === 'present' && (!summary.last_present_on || date > summary.last_present_on)) {
      summary.last_present_on = date;
    }
    if (date < cutoff) continue;
    if (Object.prototype.hasOwnProperty.call(summary, row.status)) summary[row.status] += 1;
  }

  summary.freshness = assessFreshness(
    summary.last_present_on,
    ATTENDANCE_STALE_AFTER_DAYS,
    now
  );
  return summary;
}

/**
 * Assemble the context for one request.
 *
 * Returns null when a client id was supplied but is not visible under the
 * caller's tenant and policy — the route turns that into the same 404 for
 * "missing" and "another studio's".
 */
async function assembleContext(ctx, clientId, { now = new Date() } = {}) {
  const scope = {
    organizationId: ctx.tenant.organizationId,
    trainerId: ctx.identity.trainerId,
    policy: ctx.clientAccess.policy,
  };

  const envelope = {
    version: CONTEXT_VERSION,
    generated_at: now.toISOString(),
    identity: ctx.identity,
    tenant: ctx.tenant,
    permissions: ctx.permissions,
  };

  if (!clientId) {
    return {
      ...envelope,
      client_scope: {
        policy: scope.policy,
        selected_client_id: null,
        available_clients: await listVisibleClients(scope),
      },
      client: null,
    };
  }

  const selected = await resolveSelectedClient(scope, clientId);
  if (!selected) return null;

  const [profile, brief, attendance] = await Promise.all([
    getClientProfile(scope.organizationId, clientId),
    getClientTrainingBrief(scope.organizationId, clientId),
    getClientAttendance(scope.organizationId, clientId),
  ]);
  // The client was visible a moment ago; a null profile means it was removed
  // between the two reads. Fail closed rather than return a partial record.
  if (!profile) return null;

  const attendanceSummaryOut = attendanceSummary(attendance, now);

  return {
    ...envelope,
    client_scope: { policy: scope.policy, selected_client_id: clientId },
    client: {
      id: profile.id,
      name: profile.name,
      age: ageFromDob(profile.dob),
      gender: profile.gender ?? null,
      goal: profile.goal ?? null,
      height_cm: num(profile.height),
      weight_kg: num(profile.weight),
      body_fat_pct: num(profile.body_fat),
      experience_level: profile.workout_experience_level ?? null,
      status: profile.status ?? null,
      pt_start_date: dateOnly(profile.pt_start_date),
      pt_end_date: dateOnly(profile.pt_end_date),
      screening: profile.screening ?? null,
      brief: {
        sections: sectionMetadata(brief),
        missing: brief?.missing ?? [],
        stale: brief?.stale ?? [],
        completeness_pct: brief?.completeness_pct ?? null,
      },
      attendance: attendanceSummaryOut,
      provenance: [
        { table: 'pt_clients', as_of: dateOnly(profile.updated_at) },
        { table: 'attendance_logs', as_of: attendanceSummaryOut.last_present_on },
      ],
    },
  };
}

module.exports = {
  assembleContext,
  assessFreshness,
  attendanceSummary,
  ATTENDANCE_WINDOW_DAYS,
  ATTENDANCE_STALE_AFTER_DAYS,
  CONTEXT_VERSION,
};
