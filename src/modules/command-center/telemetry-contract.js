// src/modules/command-center/telemetry-contract.js
//
// The shape of every card's payload, declared once.
//
// ── What this replaces ─────────────────────────────────────────────────────
//
// `data` was `unknown` on the wire and read in the client with a runtime path
// walker:
//
//     pick(d, 'memory.heap_used_ratio')
//
// which returns `undefined` for a path that no longer exists, renders as an
// em-dash, and looks exactly like a metric that is legitimately absent. So a
// renamed field did not break a build or fail a test — it quietly blanked a
// number on an operations console, which is the one place a blank must mean
// "we could not measure this" and nothing else.
//
// ── Why a key list and not a schema library ────────────────────────────────
//
// The useful property is narrow: does the payload the collector emits still
// carry the fields the console renders? A validator would also police types
// and nesting, which sounds better and costs more than it returns here — the
// collectors are the only writers, they are all in this directory, and their
// values are already graded by the collector itself before anyone reads them.
//
// What actually goes wrong is a RENAME during a refactor, and a key list
// catches that at the cheapest possible price. `required` is a floor, not a
// whitelist: a collector may add fields freely, which is what keeps this from
// becoming a second place to edit on every change.
'use strict';

/**
 * card name -> the keys the console depends on.
 *
 * A key listed here is one some surface renders. Adding a field to a collector
 * does not require touching this file; REMOVING or renaming one does, and that
 * is the entire point.
 */
const CONTRACT = {
  runtime: {
    scope: 'process',
    required: ['uptime_seconds', 'node_version', 'pid', 'memory', 'cpu_percent',
      'event_loop_lag_ms', 'active_handles', 'active_requests'],
    nested: {
      memory: ['rss_bytes', 'heap_used_bytes', 'heap_limit_bytes', 'heap_used_ratio'],
      event_loop_lag_ms: ['p50', 'p99'],
    },
  },
  http: {
    scope: 'process',
    required: ['window_ms', 'samples', 'latency_ms', 'status', 'slowest_endpoints'],
  },
  database: {
    scope: 'platform',
    required: ['latency_ms', 'pool', 'connections', 'size_bytes', 'migrations',
      'slow_queries', 'longest_running_query'],
    nested: {
      pool: ['total', 'idle', 'waiting'],
      migrations: ['applied', 'latest', 'applied_at'],
    },
  },
  redis: {
    scope: 'platform',
    required: ['latency_ms', 'ready', 'memory', 'clients', 'stats', 'server'],
  },
  queues: {
    scope: 'platform',
    required: ['summary', 'queues', 'totals', 'problems'],
    nested: { totals: ['waiting', 'active', 'failed'] },
  },
  ai: {
    scope: 'platform',
    required: ['active_model', 'last_request_at', 'routing', 'today', 'last_hour'],
  },
  security: {
    scope: 'platform',
    required: ['auth', 'posture'],
  },
  smtp: {
    scope: 'platform',
    required: ['configured', 'host', 'port', 'from', 'delivery'],
  },
};

/**
 * Check one card against its contract.
 *
 * A card that is UNAVAILABLE, DEGRADED or TIMEOUT carries no payload to check,
 * and that is correct rather than a violation — the whole point of those
 * states is that the measurement did not happen. Only a card claiming a
 * reading is held to the shape of one.
 *
 * @returns {string[]} missing keys, empty when the card conforms.
 */
function violations(card) {
  const spec = CONTRACT[card?.name];
  if (!spec) return [];
  if (card.status !== 'healthy' && card.status !== 'warning' && card.status !== 'critical') return [];
  if (!card.data || typeof card.data !== 'object') {
    return [`${card.name}: graded ${card.status} but carries no data`];
  }

  const missing = [];
  for (const key of spec.required) {
    if (!(key in card.data)) missing.push(`${card.name}.${key}`);
  }
  for (const [parent, keys] of Object.entries(spec.nested ?? {})) {
    const value = card.data[parent];
    // A null parent is a legitimate "could not read this part" — the http card
    // nulls latency_ms when the ring is empty. Only a present object is checked.
    if (value == null || typeof value !== 'object') continue;
    for (const key of keys) {
      if (!(key in value)) missing.push(`${card.name}.${parent}.${key}`);
    }
  }
  return missing;
}

/** Every violation across a whole snapshot. */
function auditSnapshot(snap) {
  return Object.values(snap?.cards ?? {}).flatMap(violations);
}

module.exports = { CONTRACT, violations, auditSnapshot };
