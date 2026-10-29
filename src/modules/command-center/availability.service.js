'use strict';
// Persisted card status: the console's memory.
//
// The live snapshot answers "what is the state right now". This answers the
// question immediately after it — "has this been flapping, or was it a
// one-off?" — which the snapshot cannot, because its history lives in the
// operator's browser and resets on reload.
//
// One row per card per sample. Sampling runs in the API process, beside alert
// evaluation, because that is the process whose runtime card is being
// measured. It deliberately stores status only: the numbers stay in the
// snapshot they belong to, and a second copy here would be a second place for
// them to drift out of date.
//
//   CC_METRIC_SAMPLE_MS      default 300000 (5 min), minimum 60s
//   CC_METRIC_RETENTION_DAYS default 14, clamped 1..90

const pool = require('../../db/pool');
const logger = require('../../lib/logger');
const { snapshot } = require('./index');
const { SEVERITY_ORDER } = require('./registry');

const SAMPLE_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.CC_METRIC_SAMPLE_MS) || 5 * 60_000,
);
const RETENTION_DAYS = Math.min(
  Math.max(Number(process.env.CC_METRIC_RETENTION_DAYS) || 14, 1),
  90,
);
const MAX_HOURS = RETENTION_DAYS * 24;
const DEFAULT_HOURS = 24;
const SWEEP_EVERY_MS = 60 * 60_000;

let lastSweep = 0;

const rank = (status) => {
  const i = SEVERITY_ORDER.indexOf(status);
  return i === -1 ? 0 : i;
};

/** Delete aged samples at most once an hour, so a 5-minute tick is not also a
 *  5-minute table sweep. A failed sweep must not lose a fresh sample. */
async function sweep() {
  if (Date.now() - lastSweep < SWEEP_EVERY_MS) return;
  try {
    await pool.query(
      `DELETE FROM command_center_status_samples
        WHERE sampled_at < NOW() - ($1 || ' days')::interval`,
      [String(RETENTION_DAYS)],
    );
    lastSweep = Date.now();
  } catch (err) {
    logger.warn({ err: err.message }, 'Command Center status retention sweep failed');
  }
}

/** One sample of every card. Called on a timer from server.js. */
async function sample() {
  const snap = await snapshot.collect();
  const cards = Object.values(snap.cards || {}).filter((c) => c && c.name && c.status);
  if (!cards.length) return { sampled: 0 };

  await pool.query(
    `INSERT INTO command_center_status_samples (card, status)
     SELECT * FROM UNNEST($1::text[], $2::text[])`,
    [cards.map((c) => c.name), cards.map((c) => c.status)],
  );
  await sweep();
  return { sampled: cards.length };
}

/**
 * Per-card status rails for one window.
 *
 * Bucketed rather than raw so a 7-day window stays a few hundred points per
 * card instead of two thousand. A bucket takes the WORST status in it: a rail
 * that hid a 30-second critical inside a green 15-minute block would be a
 * chart that makes an incident disappear. Buckets with no sample stay null so
 * a restart or a stopped sampler reads as a gap, not as health.
 */
async function history({ hours } = {}) {
  const windowHours = Math.min(
    Math.max(Number(hours) || DEFAULT_HOURS, 1),
    MAX_HOURS,
  );
  const bucketMinutes = windowHours <= 24 ? 15 : 120;
  const bucketSeconds = bucketMinutes * 60;

  const { rows } = await pool.query(
    `SELECT card, status,
            to_timestamp(floor(extract(epoch FROM sampled_at) / $1) * $1) AS bucket,
            COUNT(*)::int AS n
       FROM command_center_status_samples
      WHERE sampled_at > NOW() - ($2 || ' hours')::interval
      GROUP BY card, bucket, status
      ORDER BY card, bucket`,
    [bucketSeconds, String(windowHours)],
  );

  const byCard = new Map();
  for (const row of rows) {
    const at = new Date(row.bucket).getTime();
    if (!Number.isFinite(at)) continue;
    let card = byCard.get(row.card);
    if (!card) {
      card = { buckets: new Map(), samples: 0 };
      byCard.set(row.card, card);
    }
    card.samples += row.n;
    const current = card.buckets.get(at);
    // `undefined` for a missing bucket, `null` is a deliberately filled gap.
    if (current === undefined || rank(row.status) > rank(current)) {
      card.buckets.set(at, row.status);
    }
  }

  const step = bucketSeconds * 1000;
  const count = Math.ceil((windowHours * 3600) / bucketSeconds);
  const end = Math.floor(Date.now() / step) * step;
  const start = end - (count - 1) * step;

  const cards = [...byCard.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([card, entry]) => {
      const buckets = Array.from({ length: count }, (_, i) => {
        const at = start + i * step;
        return { at: new Date(at).toISOString(), status: entry.buckets.get(at) ?? null };
      });
      const measured = buckets.filter((b) => b.status !== null).length;
      const healthy = buckets.filter((b) => b.status === 'healthy').length;
      return {
        card,
        samples: entry.samples,
        healthy_pct: measured ? Math.round((healthy / measured) * 1000) / 10 : null,
        buckets,
      };
    });

  return { window_hours: windowHours, bucket_minutes: bucketMinutes, cards };
}

module.exports = { sample, history, SAMPLE_INTERVAL_MS, RETENTION_DAYS, MAX_HOURS };
