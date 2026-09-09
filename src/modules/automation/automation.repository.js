'use strict';
// Data access for the automation engine.
//
// Every statement the engine and its worker need, in one place, because the
// layering rule this codebase enforces (architecture.layering.convention.test.js)
// is that an HTTP adapter holds no SQL — and the engine is not an adapter, but
// the same reasoning applies to it for a sharper reason. The engine decides
// whether a studio's client gets messaged. A file that both makes that decision
// and composes the SQL for it is a file where a missing tenant predicate and a
// permission check sit in the same function and can be confused for each other.
//
// ── The rule every read below follows ───────────────────────────────────────
//
// organization_id is a bound parameter on EVERY statement, including the ones
// where a primary key would appear to be enough. `WHERE id = $1` on a
// communication_logs row looks scoped and is not: ids are guessable-adjacent
// and, more to the point, the id in the worker comes off a queued job rather
// than out of an authenticated request. A job payload is not a credential.
//
// The functions here take an explicit orgId rather than a `req` for exactly
// that reason: half of them run in a worker where there is no request at all,
// and a signature that pretends otherwise would invite someone to reach for
// req.user in a context that has none.

const pool = require('../../db/pool');

// ── Permission ──────────────────────────────────────────────────────────────

/**
 * This studio's automation settings, defaulted for a studio that has none.
 *
 * The defaults are CLOSED — `automation_enabled: false` — and that is the same
 * value migration 190 gives the column, stated twice on purpose. A studio with
 * no row must behave identically to a studio that has explicitly switched
 * automation off, and inferring "no row means allowed" is precisely how a
 * feature ships enabled for everyone who never opened its settings page.
 */
async function settingsFor(orgId) {
  const { rows } = await pool.query(
    `SELECT automation_enabled, daily_send_limit
       FROM whatsapp_automation_settings
      WHERE organization_id = $1`,
    [orgId]
  );
  return rows[0] || { automation_enabled: false, daily_send_limit: 0 };
}

/**
 * May automated messages go out on this trainer's behalf?
 *
 * Both ids are bound. Matching on trainer_id alone would be enough to find the
 * row — trainer ids are unique platform-wide — and that is exactly why the org
 * is in the WHERE too: a grant is an authorisation record, so a query that
 * could match another studio's grant by id is an authorisation bypass rather
 * than a data leak. Migration 190 puts the org in the unique constraint for
 * the same reason.
 */
async function trainerIsGranted(orgId, trainerId) {
  if (!orgId || !trainerId) return false;
  const { rowCount } = await pool.query(
    `SELECT 1 FROM whatsapp_automation_trainer_grants
      WHERE organization_id = $1 AND trainer_id = $2`,
    [orgId, trainerId]
  );
  return rowCount > 0;
}

/** Automated messages this studio has queued or sent today. */
async function sendsToday(orgId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::INT AS n
       FROM communication_logs
      WHERE organization_id = $1
        AND automation_rule_id IS NOT NULL
        AND created_at >= date_trunc('day', NOW())`,
    [orgId]
  );
  return rows[0].n;
}

/**
 * Create or update this studio's automation settings.
 *
 * An upsert rather than a create-then-update because the row's absence and its
 * presence-with-defaults mean the same thing, and a settings page should not
 * have to know which it is looking at.
 */
async function upsertSettings(orgId, { automationEnabled, dailySendLimit, updatedBy }) {
  const { rows } = await pool.query(
    `INSERT INTO whatsapp_automation_settings
       (organization_id, automation_enabled, daily_send_limit, updated_by)
     VALUES ($1, COALESCE($2, FALSE), COALESCE($3, 200), $4)
     ON CONFLICT (organization_id) DO UPDATE
        SET automation_enabled = COALESCE($2, whatsapp_automation_settings.automation_enabled),
            daily_send_limit   = COALESCE($3, whatsapp_automation_settings.daily_send_limit),
            updated_by         = $4,
            updated_at         = NOW()
     RETURNING automation_enabled, daily_send_limit, updated_at`,
    [orgId, automationEnabled, dailySendLimit, updatedBy]
  );
  return rows[0];
}

/**
 * This studio's trainers and whether each may have messages sent on their
 * behalf.
 *
 * A LEFT JOIN rather than two queries the caller zips, so "every trainer, with
 * their grant state" is one answer that cannot disagree with itself. The join
 * predicate carries the org on BOTH sides: `trainers` is filtered to the
 * studio, and the grant is matched within the same studio, so a grant row can
 * never be attributed to a trainer it does not belong to.
 */
async function trainersWithGrants(orgId) {
  const { rows } = await pool.query(
    `SELECT t.id, t.name, t.status,
            (g.trainer_id IS NOT NULL) AS whatsapp_automation_granted,
            g.granted_at
       FROM trainers t
       LEFT JOIN whatsapp_automation_trainer_grants g
              ON g.trainer_id = t.id AND g.organization_id = t.organization_id
      WHERE t.organization_id = $1 AND t.deleted_at IS NULL
      ORDER BY t.name`,
    [orgId]
  );
  return rows;
}

/**
 * Grant a trainer permission, if that trainer is this studio's.
 *
 * The org is checked in the INSERT itself — the SELECT supplies the row only
 * when `trainers` agrees the trainer belongs to this studio — rather than in a
 * separate lookup the caller performs first. A check that lives in a different
 * statement from the write is a check with a race in it, and this particular
 * write is an authorisation record.
 */
async function grantTrainer(orgId, trainerId, grantedBy) {
  const { rows } = await pool.query(
    `INSERT INTO whatsapp_automation_trainer_grants (organization_id, trainer_id, granted_by)
     SELECT $1, t.id, $3 FROM trainers t
      WHERE t.id = $2 AND t.organization_id = $1 AND t.deleted_at IS NULL
     ON CONFLICT (organization_id, trainer_id) DO NOTHING
     RETURNING trainer_id`,
    [orgId, trainerId, grantedBy]
  );
  // No row means either "not this studio's trainer" or "already granted". The
  // caller distinguishes them by asking whether the grant now exists, which is
  // the state that actually matters.
  return rows.length > 0;
}

async function revokeTrainer(orgId, trainerId) {
  const { rowCount } = await pool.query(
    `DELETE FROM whatsapp_automation_trainer_grants
      WHERE organization_id = $1 AND trainer_id = $2`,
    [orgId, trainerId]
  );
  return rowCount > 0;
}

// ── Rules ───────────────────────────────────────────────────────────────────

/**
 * The active rules this studio has for one trigger event.
 *
 * Only the whatsapp channel. The other three values the CHECK constraint
 * allows — sms, email, push — have no engine behind them, and returning them
 * here would have the engine silently drop rules a studio can see is "active"
 * on their settings page. They are filtered at the source so the reason is one
 * predicate rather than a branch three files away.
 */
async function activeRulesFor(orgId, triggerEvent) {
  const { rows } = await pool.query(
    `SELECT id, name, template, delay_minutes, channel
       FROM automation_rules
      WHERE organization_id = $1
        AND trigger_event = $2
        AND is_active = TRUE
        AND channel = 'whatsapp'
      ORDER BY created_at`,
    [orgId, triggerEvent]
  );
  return rows;
}

/** Records that a rule fired, for the settings page's "last run" column. */
async function touchRule(orgId, ruleId) {
  await pool.query(
    `UPDATE automation_rules SET last_run_at = NOW()
      WHERE id = $1 AND organization_id = $2`,
    [ruleId, orgId]
  );
}

// ── Recipients ──────────────────────────────────────────────────────────────

/**
 * A client, with the trainer whose permission governs messaging them.
 *
 * Scoped to the studio, so a client id that arrived in an event payload for
 * the wrong organization resolves to nothing rather than to somebody else's
 * client. The engine treats null as "do not send", which is the correct answer
 * to both "no such client" and "not yours".
 *
 * `whatsapp` is preferred over `mobile`: migration 052 added it precisely
 * because the two differ for clients who use a separate WhatsApp number.
 */
async function clientRecipient(orgId, clientId) {
  const { rows } = await pool.query(
    `SELECT c.id, c.name, COALESCE(NULLIF(c.whatsapp, ''), c.mobile) AS phone, c.trainer_id
       FROM pt_clients c
      WHERE c.id = $1 AND c.organization_id = $2 AND c.deleted_at IS NULL`,
    [clientId, orgId]
  );
  return rows[0] || null;
}

// ── The message log ─────────────────────────────────────────────────────────

/**
 * Record a message as queued, refusing a duplicate business event.
 *
 * ON CONFLICT DO NOTHING against the partial unique index on
 * (organization_id, automation_dedupe_key). Returning no row means this exact
 * event already produced a message under this rule, and the caller must NOT
 * enqueue a second job — a redelivered webhook or an overlapping sweep is a
 * normal occurrence, not an error, so it is answered by writing nothing rather
 * than by raising.
 *
 * The row is written BEFORE the job is enqueued, deliberately. A row with no
 * job is a message that visibly never went out, which an operator can see and
 * re-drive; a job with no row is a message delivered to a client with no
 * record that it happened.
 */
async function insertQueued(entry) {
  const { rows } = await pool.query(
    `INSERT INTO communication_logs
       (organization_id, recipient_type, recipient_id, recipient_name, recipient_phone,
        channel, direction, template, message, status, automation_rule_id, automation_dedupe_key)
     VALUES ($1,$2,$3,$4,$5,'whatsapp','outgoing',$6,$7,'queued',$8,$9)
     ON CONFLICT (organization_id, automation_dedupe_key)
       WHERE automation_dedupe_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      entry.orgId, entry.recipientType, entry.recipientId, entry.recipientName,
      entry.recipientPhone, entry.template, entry.message, entry.ruleId, entry.dedupeKey,
    ]
  );
  return rows[0] ? rows[0].id : null;
}

/**
 * The queued message a job refers to, scoped to the org ON THE ROW.
 *
 * The worker passes the organization from the job payload, and this statement
 * requires it to match. That looks circular — the payload said so — and it is
 * the point: it means a job whose payload was constructed with the wrong
 * organization (a bug, a hand-requeued job, a payload edited in Redis) resolves
 * to nothing instead of loading and sending another studio's message.
 */
async function loadQueued(orgId, logId) {
  const { rows } = await pool.query(
    `SELECT id, organization_id, recipient_id, recipient_phone, message,
            status, automation_rule_id, external_id
       FROM communication_logs
      WHERE id = $1 AND organization_id = $2`,
    [logId, orgId]
  );
  return rows[0] || null;
}

/** Mark a message sent, recording which provider carried it and its id. */
async function markSent(orgId, logId, { providerId, provider }) {
  await pool.query(
    `UPDATE communication_logs
        SET status = 'sent', external_id = $3, provider = $4,
            sent_at = NOW(), failure_reason = NULL
      WHERE id = $1 AND organization_id = $2`,
    [logId, orgId, providerId, provider]
  );
}

async function markFailed(orgId, logId, { reason, provider }) {
  await pool.query(
    `UPDATE communication_logs
        SET status = 'failed', failure_reason = $3, provider = COALESCE($4, provider)
      WHERE id = $1 AND organization_id = $2`,
    [logId, orgId, reason, provider || null]
  );
}

/**
 * Apply a delivery receipt from the gateway, matched on the provider's id.
 *
 * ── Why this is org-scoped when external_id is globally unique ──────────────
 *
 * Because it comes off a webhook. The event carries a tenant_id, and binding
 * it here means a forged or misrouted event naming another studio's message id
 * updates nothing rather than rewriting that studio's delivery history. The
 * webhook's HMAC makes forgery hard; this makes it ineffective.
 *
 * ── Why the status ladder only moves forwards ──────────────────────────────
 *
 * WhatsApp does not promise receipts arrive in order, and the outbox redelivers
 * on any non-2xx. A `delivered` landing after a `read` must not pull the row
 * back to delivered, so the CASE only advances. The timestamp columns are set
 * independently of the status for the same reason: delivered_at is a fact
 * about the message even when the row has already moved past it.
 */
async function applyReceipt(orgId, externalId, kind, occurredAt) {
  const at = occurredAt || new Date().toISOString();
  const { rowCount } = await pool.query(
    `UPDATE communication_logs
        SET status = CASE
              WHEN $3 = 'read' THEN 'read'
              WHEN $3 = 'delivered' AND status <> 'read' THEN 'delivered'
              ELSE status
            END,
            delivered_at = CASE
              WHEN $3 IN ('delivered','read') THEN COALESCE(delivered_at, $4::timestamptz)
              ELSE delivered_at
            END,
            read_at = CASE WHEN $3 = 'read' THEN COALESCE(read_at, $4::timestamptz) ELSE read_at END
      WHERE external_id = $1 AND organization_id = $2`,
    [externalId, orgId, kind, at]
  );
  return rowCount;
}

/** A gateway-reported send failure, matched on the id the ERP chose. */
async function markFailedByClientId(orgId, logId, reason) {
  const { rowCount } = await pool.query(
    `UPDATE communication_logs
        SET status = 'failed', failure_reason = $3
      WHERE id = $1 AND organization_id = $2 AND status <> 'delivered' AND status <> 'read'`,
    [logId, orgId, reason]
  );
  return rowCount;
}

module.exports = {
  settingsFor,
  upsertSettings,
  trainersWithGrants,
  grantTrainer,
  revokeTrainer,
  trainerIsGranted,
  sendsToday,
  activeRulesFor,
  touchRule,
  clientRecipient,
  insertQueued,
  loadQueued,
  markSent,
  markFailed,
  applyReceipt,
  markFailedByClientId,
};
