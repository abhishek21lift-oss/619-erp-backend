// src/modules/command-center/restart-verification.js
//
// What "the restart worked" is allowed to mean, for rungs 4 and 5.
//
// Docker answering 204 to POST /containers/{id}/restart proves that Docker
// accepted the request. It does not prove the worker came back, that it is
// draining, or that the API that comes up is any healthier than the one that
// went down. A recovery button that reports success on the 204 is the same
// mistake `recovery.run` used to make with `waiting === 0`, one rung higher.
//
// So each rung proves its own outcome from a signal that only exists if the
// restart really happened, and reads it without any extra Docker access — the
// socket-proxy allows the two restart calls and nothing else, not even GET.
//
//   worker  BullMQ registers every worker's Redis connection under a client
//           name, and CLIENT LIST reports each connection's age. After a real
//           restart every queue is served by connections YOUNGER than the
//           restart, and none of the old ones remain. A container that did not
//           restart, or a worker that crash-loops before connecting, cannot
//           produce that.
//
//   api     The process that sent the restart is the one being killed, so it
//           cannot observe the result. It writes a `requested` audit row
//           first; the NEW process, on boot, finds that row, confirms it
//           started after the request, takes a health reading and writes the
//           `verified` row. The console polls for that row by request id.
'use strict';

const pool = require('../../db/pool');
const logger = require('../../lib/logger');
const { runAsPlatform } = require('../../lib/tenant-context');

/** When this process started. The API restart is proven against this. */
const PROCESS_STARTED_AT = new Date(Date.now() - Math.round(process.uptime() * 1000));

const WORKER_VERIFY_TIMEOUT_MS = Number(process.env.CC_WORKER_VERIFY_TIMEOUT_MS) || 60_000;
const WORKER_VERIFY_POLL_MS = Number(process.env.CC_WORKER_VERIFY_POLL_MS) || 2_000;

/**
 * How recently the worker must have been restarted before the API restart is
 * allowed. The ladder is assess → pause → drain → resume → verify → restart
 * worker → restart API; the last rung is never the first thing pressed.
 */
const LADDER_WINDOW_MS = Number(process.env.CC_LADDER_WINDOW_MS) || 30 * 60_000;

/** A `requested` row older than this with no `verified` row means it never came back. */
const API_VERIFY_DEADLINE_MS = Number(process.env.CC_API_VERIFY_DEADLINE_MS) || 5 * 60_000;

const ACTION = {
  workerRestart: 'command_center.worker.restart',
  apiRequested: 'command_center.container.restart.requested',
  apiVerified: 'command_center.container.restart.verified',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Worker ──────────────────────────────────────────────────────────────────

/**
 * Every queue's worker connections, as { name, age_s }.
 * Throws when Redis cannot be read — the caller treats that as "unverifiable".
 */
async function workerConnections() {
  const { getQueue, QUEUE_NAMES } = require('../../jobs/queue');
  const out = {};
  for (const name of QUEUE_NAMES) {
    const clients = await getQueue(name).getWorkers();
    out[name] = clients.map((c) => ({ name: c.name ?? null, age_s: Number(c.age) }));
  }
  return out;
}

/**
 * Grade one reading taken `elapsedMs` after the restart was sent.
 *
 * A connection is fresh when it is younger than the time since the restart
 * (plus one second for CLIENT LIST's whole-second rounding). Every queue needs
 * at least one fresh connection, and NO connection older than the restart may
 * remain — an old one means the original process is still serving.
 */
function gradeWorkerReading(reading, elapsedMs) {
  const limit = Math.ceil(elapsedMs / 1000) + 1;
  const perQueue = {};
  const missing = [];
  const stale = [];
  for (const [queue, clients] of Object.entries(reading)) {
    const fresh = clients.filter((c) => Number.isFinite(c.age_s) && c.age_s <= limit).length;
    const old = clients.filter((c) => !Number.isFinite(c.age_s) || c.age_s > limit).length;
    perQueue[queue] = { fresh, stale: old };
    if (fresh === 0) missing.push(queue);
    if (old > 0) stale.push(queue);
  }
  return { ok: missing.length === 0 && stale.length === 0, missing, stale, per_queue: perQueue };
}

/**
 * After `restart('worker')` returned 204: wait for proof, or say there is none.
 *
 * @param {object} opts
 * @param {number} opts.sentAt          Date.now() just before the restart was sent
 * @param {Function} [opts.read]        test seam; defaults to workerConnections
 * @param {Function} [opts.queueHealth] test seam; resolves to the queue card
 * @returns {Promise<{ outcome: 'recovered'|'not_recovered'|'unverifiable',
 *                     summary: string, verified: object }>}
 */
async function verifyWorkerRestart({
  sentAt,
  read = workerConnections,
  queueHealth = defaultQueueHealth,
  timeoutMs = WORKER_VERIFY_TIMEOUT_MS,
  pollMs = WORKER_VERIFY_POLL_MS,
} = {}) {
  let last = null;
  let readError = null;
  for (;;) {
    const elapsed = Date.now() - sentAt;
    try {
      last = gradeWorkerReading(await read(), elapsed);
      readError = null;
    } catch (err) {
      readError = err.message;
    }
    if (last?.ok) break;
    if (elapsed >= timeoutMs) break;
    await sleep(pollMs);
  }
  const waited = Date.now() - sentAt;

  if (!last) {
    return {
      outcome: 'unverifiable',
      summary: `The restart was accepted, but the worker connections could not be read (${readError}). `
        + 'There is no evidence the worker came back. Treat this as unresolved.',
      verified: { waited_ms: waited, read_error: readError },
    };
  }
  if (!last.ok) {
    const parts = [];
    if (last.missing.length) parts.push(`no new worker connection on ${last.missing.join(', ')}`);
    if (last.stale.length) parts.push(`connections from before the restart still on ${last.stale.join(', ')}`);
    return {
      outcome: 'not_recovered',
      summary: `Docker accepted the restart, but after ${Math.round(waited / 1000)}s: ${parts.join('; ')}. `
        + 'The worker did not come back cleanly.',
      verified: { waited_ms: waited, workers: last },
    };
  }

  // Fresh connections prove the process restarted. They do not prove it is
  // draining, so the queues are graded the same way recovery.run grades them.
  let card = null;
  try { card = await queueHealth(); } catch (err) { readError = err.message; }
  const queues = card?.data?.queues ?? null;
  if (!queues) {
    return {
      outcome: 'unverifiable',
      summary: 'The worker restarted (new connections on every queue), but the queues could not be '
        + 'read afterwards, so it is not known whether they are draining.',
      verified: { waited_ms: waited, workers: last, queue_read_error: readError },
    };
  }
  const problems = [];
  for (const q of queues) {
    if (q.reachable === false) problems.push(`${q.name}: unreachable`);
    else if (q.starved) problems.push(`${q.name}: ${q.waiting} waiting with nothing active`);
  }
  if (problems.length) {
    return {
      outcome: 'not_recovered',
      summary: `The worker restarted, but the queues are still not draining: ${problems.join('; ')}.`,
      verified: { waited_ms: waited, workers: last, residual_problems: problems },
    };
  }
  return {
    outcome: 'recovered',
    summary: `Recovered. Every queue is served by a worker connection opened after the restart `
      + `(${Math.round(waited / 1000)}s), none from before it remain, and no queue is starved.`,
    verified: { waited_ms: waited, workers: last },
  };
}

async function defaultQueueHealth() {
  const { collect } = require('./collectors/queue.collector');
  return collect();
}

// ── The ladder ──────────────────────────────────────────────────────────────

/**
 * Why the API restart may not run yet, or null when it may.
 *
 * Rung 5 requires rung 4 to have been tried inside LADDER_WINDOW_MS — any
 * outcome, because "the worker restart did not fix it" is exactly when rung 5
 * is meant. Read from the audit table, so it holds across processes and across
 * the very restart it gates.
 */
async function apiRestartLadderReason() {
  const { rows } = await runAsPlatform(() => pool.query(
    `SELECT created_at FROM activity_log
      WHERE action = $1 AND created_at > NOW() - ($2::int * INTERVAL '1 millisecond')
      ORDER BY created_at DESC LIMIT 1`,
    [ACTION.workerRestart, LADDER_WINDOW_MS],
  ));
  if (rows.length) return null;
  return `Restart the worker first. The API restart is the last rung of the ladder and is only `
    + `available within ${Math.round(LADDER_WINDOW_MS / 60_000)} minutes of a worker restart.`;
}

// ── API ─────────────────────────────────────────────────────────────────────

/**
 * The audit row the dying process writes before it asks to be restarted.
 *
 * Written directly rather than through logActivity(), which swallows a failed
 * insert by design. Here a missing row is not a lost log line: it is a restart
 * nobody can ever verify. So a failure THROWS, and the restart is not sent.
 */
async function recordApiRestartRequest(req, { healthBefore }) {
  const data = {
    request_id: req.id,
    requested_at: new Date().toISOString(),
    process_started_at: PROCESS_STARTED_AT.toISOString(),
    actor: { id: req.user?.id ?? null, name: req.user?.name ?? null, email: req.user?.email ?? null },
    health_before: healthBefore ?? null,
  };
  await runAsPlatform(() => pool.query(
    `INSERT INTO activity_log (user_id, user_name, action, entity_type, entity_id, new_data, ip_address, user_agent)
     VALUES ($1, $2, $3, 'command_center', $4, $5::jsonb, $6, $7)`,
    [req.user?.id ?? null, req.user?.name ?? null, ACTION.apiRequested, req.id,
      JSON.stringify(data), req.ip ?? null, req.headers?.['user-agent'] ?? null],
  ));
}

/**
 * Run once at boot, after the server is listening.
 *
 * Every `requested` row inside the deadline with no `verified` row, that this
 * process started AFTER, is a restart this process is the result of. Takes a
 * fresh health reading and writes the `verified` row with a real outcome.
 */
async function verifyPendingApiRestarts({
  health,
  settleMs = Number(process.env.CC_API_VERIFY_SETTLE_MS) || 5_000,
} = {}) {
  const { rows } = await runAsPlatform(() => pool.query(
    `SELECT r.entity_id AS request_id, r.user_id, r.user_name, r.ip_address, r.created_at, r.new_data
       FROM activity_log r
      WHERE r.action = $1
        AND r.created_at > NOW() - ($3::int * INTERVAL '1 millisecond')
        AND NOT EXISTS (SELECT 1 FROM activity_log v WHERE v.action = $2 AND v.entity_id = r.entity_id)
      ORDER BY r.created_at`,
    [ACTION.apiRequested, ACTION.apiVerified, API_VERIFY_DEADLINE_MS],
  ));
  const mine = rows.filter((r) => new Date(r.created_at) < PROCESS_STARTED_AT);
  if (!mine.length) return [];

  // Let the collectors see a settled process rather than the first tick.
  await sleep(settleMs);
  const reading = await health();
  const results = [];
  for (const r of mine) {
    const verdict = gradeApiHealth(reading);
    const data = {
      request_id: r.request_id,
      requested_at: new Date(r.created_at).toISOString(),
      previous_process_started_at: r.new_data?.process_started_at ?? null,
      new_process_started_at: PROCESS_STARTED_AT.toISOString(),
      downtime_ms: PROCESS_STARTED_AT - new Date(r.created_at),
      outcome: verdict.outcome,
      summary: verdict.summary,
      health_before: r.new_data?.health_before ?? null,
      health_after: reading,
    };
    // Written with the operator who pressed the button, so the pair of rows
    // reads as one action in the audit log.
    await insertVerified(r, data);
    results.push(data);
    logger.warn({ request_id: r.request_id, outcome: verdict.outcome }, 'command-center verified an API restart');
  }
  return results;
}

/**
 * Recovered means the database and Redis cards — what the API depends on to
 * serve anything — are not critical. The new process answering at all proves
 * it is up; these prove it can do its job.
 */
function gradeApiHealth(reading) {
  if (!reading || reading.status === 'unknown') {
    return {
      outcome: 'unverifiable',
      summary: 'The API restarted, but its health could not be read afterwards.',
    };
  }
  const critical = Object.entries(reading.cards ?? {})
    .filter(([, status]) => status === 'critical')
    .map(([name]) => name);
  const vital = critical.filter((c) => c === 'database' || c === 'redis' || c === 'runtime');
  if (vital.length) {
    return {
      outcome: 'not_recovered',
      summary: `The API restarted, but ${vital.join(' and ')} ${vital.length > 1 ? 'are' : 'is'} still critical.`,
    };
  }
  return {
    outcome: 'recovered',
    summary: critical.length
      ? `The API restarted and is serving; database and Redis are reachable. Still critical: ${critical.join(', ')}.`
      : 'The API restarted and is serving; database and Redis are reachable.',
  };
}

/** Docker refused: close the request so the console stops waiting for a reboot. */
async function recordApiRestartRefused(req, reason) {
  await insertVerified(
    { user_id: req.user?.id ?? null, user_name: req.user?.name ?? null, ip_address: req.ip ?? null, request_id: req.id },
    {
      request_id: req.id,
      outcome: 'not_restarted',
      summary: `The restart was not performed: ${reason}`,
      new_process_started_at: null,
      health_after: null,
    },
  );
}

async function insertVerified(requestRow, data) {
  await runAsPlatform(() => pool.query(
    `INSERT INTO activity_log (user_id, user_name, action, entity_type, entity_id, new_data, ip_address)
     SELECT $1, $2, $3, 'command_center', $4, $5::jsonb, $6
      WHERE NOT EXISTS (SELECT 1 FROM activity_log WHERE action = $3 AND entity_id = $4)`,
    [requestRow.user_id, requestRow.user_name, ACTION.apiVerified, requestRow.request_id,
      JSON.stringify(data), requestRow.ip_address],
  ));
}

/**
 * What the console polls after pressing "Restart API container".
 *
 * @returns {{ state: 'unknown'|'pending'|'verified'|'not_restarted', ... }}
 */
async function apiRestartStatus(requestId) {
  const { rows } = await runAsPlatform(() => pool.query(
    `SELECT action, created_at, new_data FROM activity_log
      WHERE entity_id = $1 AND action IN ($2, $3)`,
    [requestId, ACTION.apiRequested, ACTION.apiVerified],
  ));
  const requested = rows.find((r) => r.action === ACTION.apiRequested);
  const verified = rows.find((r) => r.action === ACTION.apiVerified);
  if (verified) return { state: 'verified', ...verified.new_data };
  if (!requested) return { state: 'unknown', request_id: requestId };

  const requestedAt = new Date(requested.created_at);
  // This process predates the request: the restart has not happened (yet).
  if (PROCESS_STARTED_AT < requestedAt && Date.now() - requestedAt > API_VERIFY_DEADLINE_MS) {
    return {
      state: 'not_restarted',
      request_id: requestId,
      requested_at: requestedAt.toISOString(),
      summary: 'The restart was requested but this API process is still the one that was running '
        + 'before it. The container did not restart.',
    };
  }
  return {
    state: 'pending',
    request_id: requestId,
    requested_at: requestedAt.toISOString(),
    process_started_at: PROCESS_STARTED_AT.toISOString(),
  };
}

module.exports = {
  PROCESS_STARTED_AT,
  ACTION,
  LADDER_WINDOW_MS,
  verifyWorkerRestart,
  gradeWorkerReading,
  workerConnections,
  apiRestartLadderReason,
  recordApiRestartRequest,
  recordApiRestartRefused,
  verifyPendingApiRestarts,
  gradeApiHealth,
  apiRestartStatus,
};
