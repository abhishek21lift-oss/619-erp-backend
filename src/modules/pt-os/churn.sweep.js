'use strict';
// src/modules/pt-os/churn.sweep.js
// The daily pass behind the at-risk digest.
//
// Without this, retention is pull-only: the scoring, the list and the
// trainer's follow-up log all exist, but nothing tells the trainer who
// crossed into high or critical overnight. The screen is only as good as the
// trainer's memory to open it.
//
// This reads the same list the screen reads — buildChurnList — so a client the
// trainer snoozed is already absent, and a second scorer is never introduced.
//
// Exactly-once is enforced by churn_digest_deliveries, not by this loop: the
// unique (organization_id, digest_date) row means one replica claims the send
// and the other skips it.
//
// The trainer is the only recipient. Nothing about a client's risk is ever
// sent to that client.

const pool = require('../../db/pool');
const logger = require('../../lib/logger');
const notifier = require('../notifications/notifications.service');
const { buildChurnList } = require('./churn.service');

const URGENT_BANDS = new Set(['high', 'critical']);
const NAMES_IN_MESSAGE = 5;

async function orgsWithClients() {
  const { rows } = await pool.query(
    `SELECT DISTINCT organization_id
       FROM pt_clients
      WHERE deleted_at IS NULL`
  );
  return rows.map((r) => r.organization_id);
}

/** Claim today's digest for this org. Null when another replica already did. */
async function claim(orgId, digestDate) {
  const { rows } = await pool.query(
    `INSERT INTO churn_digest_deliveries (organization_id, digest_date, status)
     VALUES ($1, $2::date, 'pending')
     ON CONFLICT (organization_id, digest_date) DO NOTHING
     RETURNING id`,
    [orgId, digestDate]
  );
  return rows[0]?.id || null;
}

async function settle(id, { status, clientCount, error }) {
  await pool.query(
    `UPDATE churn_digest_deliveries
        SET status = $2, client_count = $3, error = $4
      WHERE id = $1`,
    [id, status, clientCount ?? 0, error ?? null]
  );
}

/**
 * One outcome for a multi-channel send. Any channel that left the building
 * makes the digest sent: the trainer was reached, and re-sending the whole
 * digest to retry a single failed channel would be noise.
 */
function digestOutcome(results) {
  const values = Object.values(results || {});
  if (!values.length) return { status: 'failed', error: 'no_channel_attempted' };
  if (values.some((r) => r.status === 'sent' || r.status === 'delivered' || r.status === 'queued')) {
    return { status: 'sent', error: null };
  }
  const errors = values.map((r) => r.error).filter(Boolean);
  return { status: 'failed', error: errors.join('; ').slice(0, 500) || 'delivery_failed' };
}

/**
 * Only channels the recipient can actually receive on. WhatsApp is included
 * when the trainer has a mobile on the `trainers` row — it is the one channel
 * a solo trainer reads, but it costs per message, so it is never assumed.
 */
function channelsFor(recipient) {
  const channels = [];
  if (recipient.user_id) channels.push('inapp');
  if (recipient.email) channels.push('email');
  if (recipient.phone) channels.push('whatsapp');
  return channels;
}

async function runChurnDigestSweep() {
  const orgIds = await orgsWithClients();
  const summary = { orgs: orgIds.length, sent: 0, skipped: 0, failed: 0, errors: 0 };

  for (const orgId of orgIds) {
    try {
      const list = await buildChurnList(orgId);
      const urgent = list.rows.filter((r) => URGENT_BANDS.has(r.band));

      // Nothing to say is not a message. A daily "0 at-risk clients" email is
      // exactly the notification a solo trainer turns off first.
      if (!urgent.length) { summary.skipped += 1; continue; }

      // Claim before resolving anything: the loser of this race should not
      // even read the roster.
      const claimId = await claim(orgId, list.as_of);
      if (!claimId) { summary.skipped += 1; continue; }

      const recipient = await notifier.recipientFromStudioTrainer(orgId);
      if (!recipient) {
        await settle(claimId, { status: 'skipped', clientCount: urgent.length, error: 'trainer_not_found' });
        summary.skipped += 1;
        continue;
      }

      const channels = channelsFor(recipient);
      if (!channels.length) {
        await settle(claimId, { status: 'skipped', clientCount: urgent.length, error: 'no_contact_channel' });
        summary.skipped += 1;
        continue;
      }

      const results = await notifier.send('churn_digest', recipient, {
        count: urgent.length,
        client_names: urgent.slice(0, NAMES_IN_MESSAGE).map((r) => r.client_name).join(', '),
        more: Math.max(0, urgent.length - NAMES_IN_MESSAGE),
        link: '/pt-os/clients/at-risk',
      }, channels);

      const outcome = digestOutcome(results);
      await settle(claimId, { ...outcome, clientCount: urgent.length });
      if (outcome.status === 'sent') summary.sent += 1;
      else summary.failed += 1;

      logger.info(
        { orgId, count: urgent.length, channels, outcome: outcome.status },
        'churn digest attempt'
      );
    } catch (err) {
      // One studio's failure must not stop the rest of the pass.
      summary.errors += 1;
      logger.error({ err: err.message, orgId }, 'churn digest org failed');
    }
  }

  logger.info(summary, 'churn digest sweep completed');
  return summary;
}

module.exports = { runChurnDigestSweep, digestOutcome, channelsFor };
