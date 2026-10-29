'use strict';
// The incident timeline: one ordered list of what happened, built from the two
// stores that already record it.
//
//   system_alerts  the CONDITION and its lifetime — opened, acknowledged,
//                  resolved. One row per problem, not one per observation.
//   activity_log   the operator's actions — every allow-listed command is
//                  already audited with its outcome, actor and duration.
//
// No new table and no sampling job: this is a read over history the platform
// was keeping anyway, which is why the timeline can ship before retained
// metrics do.
//
// ── The event that is easy to miss ──────────────────────────────────────────
//
// An alert opened three days ago and still firing has no event inside a 24h
// window if only `first_seen_at` is considered. That is the one incident an
// operator most needs to see, so an unresolved alert whose `last_seen_at` is
// inside the window emits `ongoing` instead of falling out of the list.

const pool = require('../../db/pool');

const DEFAULT_HOURS = 24;
const MAX_HOURS = 720;
const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 200;

const COMMAND_PREFIX = 'command_center.';

function intInRange(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/** Timestamps arrive as Date from pg and as strings from fixtures; both parse. */
const atMs = (value) => (value ? new Date(value).getTime() : NaN);

function alertEvents(row, cutoff) {
  const inside = (value) => {
    const ms = atMs(value);
    return Number.isFinite(ms) && ms >= cutoff;
  };
  const base = {
    kind: 'alert',
    severity: row.severity,
    source: row.source,
    title: row.title,
    detail: row.reason ?? null,
    actor: null,
    outcome: null,
  };
  const events = [];

  if (inside(row.first_seen_at)) {
    events.push({ ...base, id: `alert:${row.id}:opened`, at: row.first_seen_at, event: 'opened' });
  } else if (row.status !== 'resolved' && inside(row.last_seen_at)) {
    events.push({ ...base, id: `alert:${row.id}:ongoing`, at: row.last_seen_at, event: 'ongoing' });
  }

  if (inside(row.acknowledged_at)) {
    events.push({
      ...base,
      id: `alert:${row.id}:acknowledged`,
      at: row.acknowledged_at,
      event: 'acknowledged',
      actor: row.acknowledged_by_name ?? null,
    });
  }

  if (inside(row.resolved_at)) {
    events.push({
      ...base,
      id: `alert:${row.id}:resolved`,
      at: row.resolved_at,
      event: 'resolved',
      detail: row.resolution === 'auto'
        ? 'Cleared on its own.'
        : row.resolution === 'manual' ? 'Closed by hand.' : row.reason ?? null,
    });
  }

  return events;
}

function commandEvent(row) {
  const data = row.new_data && typeof row.new_data === 'object' ? row.new_data : {};
  const actor = data.actor && typeof data.actor === 'object' ? data.actor.name ?? null : null;
  const verdict = data.verdict && typeof data.verdict === 'object' ? data.verdict : null;
  const action = String(row.action || '');
  return {
    id: `command:${row.id}`,
    at: row.created_at,
    kind: 'command',
    event: 'command',
    severity: data.outcome === 'error' ? 'warning' : 'info',
    source: action.startsWith(COMMAND_PREFIX) ? action.slice(COMMAND_PREFIX.length) : action,
    title: String(row.entity_id || action || 'Command'),
    detail: data.error || (verdict && verdict.summary) || null,
    actor: actor || row.user_name || null,
    outcome: data.outcome === 'error' ? 'error' : 'ok',
  };
}

async function read({ hours, limit } = {}) {
  const windowHours = intInRange(hours, DEFAULT_HOURS, 1, MAX_HOURS);
  // A limit of 0 or less is a client bug, not "return nothing"; fall back to
  // the default rather than an empty screen.
  const limitNumber = Number(limit);
  const rowLimit = Number.isFinite(limitNumber) && limitNumber > 0
    ? Math.min(Math.trunc(limitNumber), MAX_LIMIT)
    : DEFAULT_LIMIT;
  const since = String(windowHours);
  const cutoff = Date.now() - windowHours * 3_600_000;

  // Each read is bounded to the same window and row cap, so the merge below
  // never sees more than 2× the rows it can return. Ordered newest-first in
  // SQL because the limiter should drop the OLDEST rows, not an arbitrary set.
  const [alertRows, commandRows] = await Promise.all([
    pool.query(
      `SELECT id, source, severity, title, reason, status, first_seen_at,
              last_seen_at, acknowledged_at, acknowledged_by_name, resolved_at,
              resolution
         FROM system_alerts
        WHERE deleted_at IS NULL
          AND last_seen_at > NOW() - ($1 || ' hours')::interval
        ORDER BY last_seen_at DESC
        LIMIT $2`,
      [since, rowLimit],
    ),
    pool.query(
      `SELECT id, user_name, action, entity_id, new_data, created_at
         FROM activity_log
        WHERE action LIKE '${COMMAND_PREFIX}%'
          AND created_at > NOW() - ($1 || ' hours')::interval
        ORDER BY created_at DESC
        LIMIT $2`,
      [since, rowLimit],
    ),
  ]);

  const events = [
    ...alertRows.rows.flatMap((row) => alertEvents(row, cutoff)),
    ...commandRows.rows.map(commandEvent),
  ].sort((a, b) => atMs(b.at) - atMs(a.at));

  return { events: events.slice(0, rowLimit), window_hours: windowHours };
}

module.exports = { read, DEFAULT_HOURS, MAX_HOURS, DEFAULT_LIMIT, MAX_LIMIT };
