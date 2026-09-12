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

/**
 * A lead, in the same shape as a client, for the two lead-shaped events.
 *
 * `lead_created` and `followup_due` are about people who are NOT clients yet —
 * pt_leads is deliberately independent of pt_clients until conversion
 * (migration 119), so resolving a lead through clientRecipient would return
 * nothing and the two events would silently never fire. communication_logs has
 * carried `recipient_type = 'lead'` since migration 012 for exactly this.
 *
 * A lead has no `whatsapp` column — only `mobile` — so there is nothing to
 * prefer between; the one number is the number.
 *
 * `trainer_id` is returned for the same reason it is on the client: the
 * permission that governs an automated message is the permission of the
 * trainer the person is assigned to. On pt_leads it is a bare TEXT column with
 * no foreign key, so a lead can carry a trainer id this studio does not own —
 * which changes nothing, because trainerIsGranted binds the org too and a
 * foreign trainer simply has no grant here.
 */
async function leadRecipient(orgId, leadId) {
  const { rows } = await pool.query(
    `SELECT l.id, l.name, NULLIF(l.mobile, '') AS phone, l.trainer_id
       FROM pt_leads l
      WHERE l.id = $1 AND l.organization_id = $2`,
    [leadId, orgId]
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

// ── The daily limit, enforced rather than consulted ─────────────────────────
//
// `sendsToday()` above answers a question. It cannot enforce anything, and the
// engine used to use it as though it could:
//
//     const used = await repo.sendsToday(orgId);      // ← reads 199
//     if (used >= limit) return DAILY_LIMIT_REACHED;  // ← 199 < 200, proceed
//     await repo.insertQueued(...)                    // ← writes row 200
//
// Two automation events arriving at once both read 199, both decide they are
// under the limit, and both insert: 201 messages against a limit of 200. The
// window is small and it is not rare — a sweep morning queues every studio's
// birthdays, expiries and absences within the same second, and the API serves
// concurrent requests by design. The limit is a safety limit on how many
// messages a studio's own WhatsApp number can emit in a day before Meta treats
// it as spam, so exceeding it is not a counting error, it is the risk the
// setting exists to bound.
//
// ── Why an advisory lock and not a cleverer statement ───────────────────────
//
// The obvious repair is one statement — INSERT ... SELECT WHERE (SELECT
// count(*)) < limit — and it does not work. The count is a read, it takes no
// lock, and under READ COMMITTED two concurrent transactions evaluate it
// against the same snapshot and both proceed. Nothing about writing it as one
// statement makes the check-then-act atomic.
//
// A counter table with `UPDATE ... WHERE used < limit` would be atomic, and it
// would introduce a second source of truth that can drift from
// communication_logs — the number enforced and the number the studio sees on
// its own log page would be maintained by different code. So instead the count
// stays exactly where it was, and the check-and-insert is serialised per
// studio by a transaction-scoped advisory lock.
//
// ── Why this cannot let one studio consume another's quota ──────────────────
//
// The lock key is derived from the org id, so studios do not normally contend.
// hashtext() is 32-bit, so two org ids CAN collide onto one key — and the
// consequence of a collision is only that those two studios briefly serialise
// against each other. It is not a correctness problem: the COUNT and the
// INSERT inside the lock are both bound to `entry.orgId`, so a studio holding
// the lock can only ever count and insert its own rows. A collision costs a
// few milliseconds of waiting, never a row.
//
// pg_advisory_xact_lock releases on COMMIT or ROLLBACK — there is no unlock to
// forget and no way for a crashed request to hold it.

/**
 * A fixed namespace for this lock, so it cannot collide with any other
 * advisory lock this application takes for a different purpose.
 */
const DAILY_LIMIT_LOCK_NS = 619001;

/**
 * Count today's automated messages and queue one more, atomically, refusing
 * both a duplicate event and a message over the studio's daily limit.
 *
 * Replaces the `sendsToday()` + compare + `insertQueued()` sequence with a
 * single serialised operation. Returns which of the three things happened, so
 * the engine keeps reporting the same outcomes it always did.
 *
 * @returns {Promise<{outcome: 'queued'|'duplicate_event'|'daily_limit_reached',
 *                    logId: string|null, usedToday: number}>}
 */
async function insertQueuedWithinLimit(entry, dailyLimit) {
  const limit = Number(dailyLimit);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Serialise this studio's check-and-insert. Taken FIRST, before the count,
    // or the count would be read outside the mutual exclusion it exists to be
    // protected by.
    await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
      DAILY_LIMIT_LOCK_NS,
      String(entry.orgId),
    ]);

    const { rows: counted } = await client.query(
      `SELECT COUNT(*)::INT AS n
         FROM communication_logs
        WHERE organization_id = $1
          AND automation_rule_id IS NOT NULL
          AND created_at >= date_trunc('day', NOW())`,
      [entry.orgId]
    );
    const usedToday = counted[0].n;

    // `!Number.isFinite(limit)` covers a studio with no settings row, whose
    // defaulted limit is 0 — closed, like every other default in this file.
    if (!Number.isFinite(limit) || usedToday >= limit) {
      await client.query('COMMIT');
      return { outcome: 'daily_limit_reached', logId: null, usedToday };
    }

    const { rows } = await client.query(
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

    await client.query('COMMIT');

    // No row means the dedupe index refused it — the same event already
    // produced this message. Deliberately NOT counted against the limit, and
    // deliberately still distinguished from a queued row: the engine reports
    // DUPLICATE_EVENT, exactly as it did before this function existed.
    return rows[0]
      ? { outcome: 'queued', logId: rows[0].id, usedToday }
      : { outcome: 'duplicate_event', logId: null, usedToday };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
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

// ── The status ladder ───────────────────────────────────────────────────────
//
//   queued → sent → delivered → read
//
// It only ever moves forwards, and that is enforced in SQL rather than in the
// callers, because the two things that move it run CONCURRENTLY and neither
// can see the other:
//
//   · the worker, which calls markSent() when the gateway's HTTP response
//     comes back, and
//   · the webhook, which calls applyReceipt() when the gateway posts a
//     delivery or read receipt.
//
// WhatsApp acknowledges a message to the sending socket and reports its
// delivery over two different paths, and nothing orders them. A receipt can
// therefore be applied while the worker's send call is still in flight — the
// row reaches 'delivered', and then markSent() lands and writes 'sent' over
// it. The message really was delivered; the log says it was merely sent, the
// studio's delivery report under-counts, and no error is raised anywhere.
//
// `TERMINAL_STATUSES` is the set markSent and markFailed may not overwrite.
// applyReceipt has its own CASE for the same reason — it has to distinguish
// delivered from read, which this does not.
const TERMINAL_STATUSES = "('delivered','read')";

/**
 * Mark a message sent, recording which provider carried it and its id.
 *
 * ── Why the CASE rather than `SET status = 'sent'` ──────────────────────────
 *
 * See the ladder above: a receipt may already have moved this row past 'sent',
 * and a plain assignment would pull it back. The CASE makes the transition
 * monotonic in the one place every caller goes through, so no caller has to
 * remember — and, being a single UPDATE, it takes the row lock for the whole
 * read-modify-write. A concurrent applyReceipt on the same row waits for it
 * and then re-reads; there is no window between the check and the write.
 *
 * ── Why the facts are still recorded on a row it will not move ──────────────
 *
 * external_id, provider and sent_at are written even when the status stays
 * 'delivered'. They are facts about the send, not about the ladder, and the
 * row needs them: external_id is what a later receipt matches on, so refusing
 * to record it would strand every receipt that follows.
 *
 * COALESCE on sent_at, not NOW(): a retried job must not restate when the
 * message went out. The first send is the send.
 */
async function markSent(orgId, logId, { providerId, provider }) {
  const { rowCount } = await pool.query(
    `UPDATE communication_logs
        SET status = CASE WHEN status IN ${TERMINAL_STATUSES} THEN status ELSE 'sent' END,
            external_id = COALESCE($3, external_id),
            provider = COALESCE($4, provider),
            sent_at = COALESCE(sent_at, NOW()),
            failure_reason = NULL
      WHERE id = $1 AND organization_id = $2`,
    [logId, orgId, providerId, provider]
  );
  return rowCount;
}

/**
 * Record a delivery failure.
 *
 * Guarded by the same ladder, and for a sharper reason than markSent's: a
 * message the client has demonstrably received must never end up logged as
 * failed. That happens on the retry path — the gateway's send-once refuses a
 * second attempt with DUPLICATE_MESSAGE, which arrives here as a failure,
 * while the first attempt's message was delivered and its receipt already
 * applied. markFailedByClientId has carried this guard since it was written;
 * this is the same rule on the other entry point.
 */
async function markFailed(orgId, logId, { reason, provider }) {
  const { rowCount } = await pool.query(
    `UPDATE communication_logs
        SET status = 'failed', failure_reason = $3, provider = COALESCE($4, provider)
      WHERE id = $1 AND organization_id = $2
        AND status NOT IN ${TERMINAL_STATUSES}`,
    [logId, orgId, reason, provider || null]
  );
  return rowCount;
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
async function applyReceipt(orgId, externalId, kind, occurredAt, { client = pool } = {}) {
  const at = occurredAt || new Date().toISOString();
  const { rowCount } = await client.query(
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
async function markFailedByClientId(orgId, logId, reason, { client = pool } = {}) {
  const { rowCount } = await client.query(
    `UPDATE communication_logs
        SET status = 'failed', failure_reason = $3
      WHERE id = $1 AND organization_id = $2 AND status <> 'delivered' AND status <> 'read'`,
    [logId, orgId, reason]
  );
  return rowCount;
}

/**
 * Queued automation rows that may have lost their BullMQ job.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 *
 * The engine writes the row, then enqueues the job. That order is deliberate
 * and stays — a job with no row is a message a client receives that this
 * system has no record of, which is strictly worse than the reverse. But the
 * reverse is not free: if the enqueue returns null (Redis down) or the process
 * dies in between, the row sits at 'queued' forever. Its dedupe key then makes
 * the situation permanent, because the next identical business event is
 * correctly refused as a duplicate of a message that never went out.
 *
 * ── Why this returns CANDIDATES and not orphans ─────────────────────────────
 *
 * Being old and still queued does not mean the job is missing. A rule with a
 * three-day delay leaves its row queued for three days by design. Only Redis
 * knows whether the job exists, so the caller asks it — this narrows the set
 * to something worth asking about.
 *
 * ── The two time bounds, which are both safety properties ───────────────────
 *
 * `olderThanSec` (lower bound) keeps the sweep away from rows the engine is
 * still mid-flight on: a row inserted a millisecond ago has not failed to be
 * enqueued, it simply has not been enqueued yet. Re-driving those would race
 * the engine for no benefit.
 *
 * `maxAgeSec` (upper bound) is the one that matters. The gateway's send-once
 * ledger is what guarantees a re-drive cannot deliver a second copy, and that
 * ledger has a TTL (WA_SEND_DEDUPE_TTL_SEC). Past it the gateway can no longer
 * recognise the message as one it has already sent, so a row older than the
 * ledger's memory is left alone for a human to decide about rather than
 * re-driven on a guarantee that has expired. Belt and braces — a row that
 * genuinely never reached the gateway has nothing to duplicate — but the cost
 * of being wrong here is a real client receiving the same message twice.
 *
 * ── Why the rule is joined ──────────────────────────────────────────────────
 *
 * To recover the REMAINING delay. Re-enqueueing a "three days before expiry"
 * reminder with no delay would deliver it the moment the sweep noticed, which
 * is the exact failure enqueueWhatsapp refuses to risk when it declines to
 * send inline. The join carries the org on both sides, so a rule id can only
 * ever be resolved against a rule this studio owns.
 */
async function orphanCandidates(orgId, { olderThanSec, maxAgeSec, limit = 200 }) {
  const { rows } = await pool.query(
    `SELECT c.id,
            GREATEST(
              0,
              FLOOR(EXTRACT(EPOCH FROM (
                c.created_at + make_interval(mins => COALESCE(r.delay_minutes, 0)) - NOW()
              )) * 1000)
            )::BIGINT AS remaining_delay_ms
       FROM communication_logs c
       LEFT JOIN automation_rules r
              ON r.id = c.automation_rule_id
             AND r.organization_id = c.organization_id
      WHERE c.organization_id = $1
        AND c.status = 'queued'
        AND c.automation_rule_id IS NOT NULL
        AND c.created_at <= NOW() - make_interval(secs => $2)
        AND c.created_at >= NOW() - make_interval(secs => $3)
      ORDER BY c.created_at
      LIMIT $4`,
    [orgId, olderThanSec, maxAgeSec, limit]
  );
  // BIGINT arrives as a string from node-postgres. Coerced here rather than at
  // the call site so nobody passes "60000" to BullMQ's delay and gets a job
  // scheduled by string concatenation.
  return rows.map((r) => ({ id: r.id, remainingDelayMs: Number(r.remaining_delay_ms) }));
}

/**
 * Failure reasons that a RECONNECT actually fixes.
 *
 * Everything transport.js reports for an unusable instance, and nothing else.
 * `whatsapp_%` covers the `whatsapp_<state>` family it composes from the
 * instance row (whatsapp_logged_out, whatsapp_disconnected,
 * whatsapp_never_connected), and the three literals are the gateway's own
 * codes plus the local pre-check's.
 *
 * Deliberately NOT included:
 *
 *   gateway_not_configured   a missing WA_GATEWAY_URL/KEY. Scanning a QR does
 *                            not fix a deployment that has no gateway.
 *   duplicate_in_flight      another attempt at this exact message is already
 *                            running. Re-driving it is the one thing that
 *                            could produce two messages to a real person.
 *   no_organization,
 *   no_recipient,
 *   empty_message,
 *   no_client_message_id     caller bugs. A reconnect changes nothing about
 *                            them, and retrying forever would hide them.
 *
 * The rule is narrow on purpose: this re-sends messages to real people, so it
 * only covers failures whose stated cause is "the studio's WhatsApp was not
 * usable", which is exactly the condition a reconnect ends.
 */
const RECONNECT_FIXABLE = `(
  failure_reason LIKE 'whatsapp\\_%'
  OR failure_reason IN ('not_connected', 'instance_not_connected', 'instance_not_found')
)`;

/**
 * Automation messages that failed because this studio's WhatsApp was down.
 *
 * `maxAgeSec` is the whole safety argument. These are messages to real
 * clients, and a welcome note delivered three days after someone joined is
 * worse than one never sent — it is confusing rather than merely missing. So
 * the window is bounded and short by default, and anything older stays failed
 * with its reason intact for an operator to read.
 *
 * Rows are returned oldest-first so a studio that was offline for a while gets
 * its messages back in the order they were meant to go out.
 */
async function reconnectCandidates(orgId, { maxAgeSec, limit = 200 }) {
  const { rows } = await pool.query(
    `SELECT c.id,
            GREATEST(
              0,
              FLOOR(EXTRACT(EPOCH FROM (
                c.created_at + make_interval(mins => COALESCE(r.delay_minutes, 0)) - NOW()
              )) * 1000)
            )::BIGINT AS remaining_delay_ms
       FROM communication_logs c
       LEFT JOIN automation_rules r
              ON r.id = c.automation_rule_id
             AND r.organization_id = c.organization_id
      WHERE c.organization_id = $1
        AND c.channel = 'whatsapp'
        AND c.status = 'failed'
        AND c.automation_rule_id IS NOT NULL
        AND c.created_at >= NOW() - make_interval(secs => $2)
        AND ${RECONNECT_FIXABLE}
      ORDER BY c.created_at
      LIMIT $3`,
    [orgId, maxAgeSec, limit]
  );
  return rows.map((r) => ({ id: r.id, remainingDelayMs: Number(r.remaining_delay_ms) }));
}

/**
 * Move one failed row back to 'queued' so the worker will act on it.
 *
 * Conditional on it STILL being failed for a reconnect-fixable reason, and the
 * rowCount is the caller's permission to enqueue. That is what makes two
 * concurrent reconnect events — a retried webhook, or two instances flapping —
 * produce one requeue: the second UPDATE matches nothing and its caller
 * enqueues nothing.
 *
 * failure_reason is cleared because the row is no longer failed; the attempt
 * that follows will write its own outcome.
 */
async function requeueFailed(orgId, logId) {
  const { rowCount } = await pool.query(
    `UPDATE communication_logs
        SET status = 'queued', failure_reason = NULL
      WHERE id = $1 AND organization_id = $2
        AND status = 'failed'
        AND ${RECONNECT_FIXABLE}`,
    [logId, orgId]
  );
  return rowCount;
}

// ── The scheduled sweeps ────────────────────────────────────────────────────
//
// Six of the twelve trigger events are not produced by anything a user does.
// Nobody presses a button to make a membership expire or a birthday arrive;
// the event is a date passing. Those are found by a daily sweep, and these are
// its queries.
//
// ── Why every one of them takes an orgId ────────────────────────────────────
//
// A sweep is the one place in this system where a global scan is the obvious
// implementation and the wrong one. "Every client whose membership expires in
// 7 days" across all studios, joined to each studio's rules, is a single
// efficient query and one mistyped join condition away from messaging another
// studio's clients with this studio's template. So the sweep runs per studio
// and every statement below binds organization_id — the same rule the rest of
// this file follows, for a sharper reason.
//
// The only statement that deliberately spans studios is orgsWithAutomationOn,
// which returns ids and nothing else, and exists precisely so that the loop
// above it is explicit rather than implied by a join.
//
// ── Why the date columns and not `status` ───────────────────────────────────
//
// pt_clients.status is a hand-maintained string ('active','expired','pending')
// and 23 of production's 34 live clients do not have it in agreement with
// their pt_end_date. A membership expiring is a fact about a date, so the date
// is what these ask about. Where "is this person still a client" genuinely
// matters — the re-engagement nudges, which must not chase people who left —
// the test is `pt_end_date IS NULL OR pt_end_date >= CURRENT_DATE`, which is
// the same fact rather than someone's memory of it.
//
// ── Why every date comes back as text ───────────────────────────────────────
//
// `to_char(..., 'YYYY-MM-DD')` rather than the DATE itself, because every one
// of these dates ends up inside an idempotency key. node-postgres parses a
// DATE into a JS Date at LOCAL midnight, and `.toISOString()` on that in any
// timezone ahead of UTC yields the previous day — so a container running
// TZ=Asia/Kolkata would key yesterday's date onto today's event and the dedupe
// index would stop refusing the duplicate. Formatting in Postgres means the
// date in the key is the same date the WHERE clause matched on, by
// construction rather than by the deployment happening to run in UTC.
//
// ── Why they all filter on a phone number ───────────────────────────────────
//
// The engine checks this too, and would refuse the send. Doing it here as well
// means a studio with 400 numberless clients does not produce 400 rows for the
// engine to reject one at a time.

/**
 * The studios that have switched automation on.
 *
 * Deliberately not org-scoped — it IS the list of orgs, and returning ids only
 * means nothing tenant-bearing crosses a studio boundary here. Everything the
 * sweep does afterwards is scoped to one of these ids.
 */
async function orgsWithAutomationOn() {
  const { rows } = await pool.query(
    `SELECT organization_id
       FROM whatsapp_automation_settings
      WHERE automation_enabled = TRUE
        AND organization_id IS NOT NULL`
  );
  return rows.map((r) => r.organization_id);
}

/**
 * Which events this studio actually has an active rule for.
 *
 * The sweep asks this first and then runs only the matching queries. Without
 * it, a studio with one birthday rule would still be scanned for expiring
 * memberships, missed attendance and overdue follow-ups every single day, and
 * the engine would discard every row for want of a rule. The work a studio has
 * not asked for should not be done, not done and thrown away.
 */
async function activeTriggerEventsFor(orgId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT trigger_event
       FROM automation_rules
      WHERE organization_id = $1
        AND is_active = TRUE
        AND channel = 'whatsapp'`,
    [orgId]
  );
  return rows.map((r) => r.trigger_event);
}

/**
 * Clients whose membership ends in exactly `days` days.
 *
 * Exactly, not "within", because the caller runs this once per reminder bucket
 * (7, 3, 1) and a range would put every client in every bucket they are still
 * inside — three messages on the same day for someone one day out.
 *
 * The consequence is that a sweep which does not run on a given day loses that
 * day's bucket. That is the same trade the membership reminder in
 * renewal.worker.js has always made, and the alternative — remembering which
 * buckets each client has already been sent — is what the dedupe key already
 * does one layer up, at the point where it can also see the rule.
 */
async function membershipExpiringIn(orgId, days) {
  const { rows } = await pool.query(
    `SELECT c.id, c.name,
            to_char(c.pt_end_date, 'YYYY-MM-DD') AS end_date,
            (c.pt_end_date - CURRENT_DATE) AS days_remaining
       FROM pt_clients c
      WHERE c.organization_id = $1
        AND c.deleted_at IS NULL
        AND c.pt_end_date IS NOT NULL
        AND (c.pt_end_date - CURRENT_DATE) = $2
        AND COALESCE(NULLIF(c.whatsapp, ''), c.mobile) IS NOT NULL
      ORDER BY c.id`,
    [orgId, days]
  );
  return rows;
}

/**
 * Clients whose membership ended yesterday.
 *
 * Yesterday rather than "any time in the past", so the query cannot wake up one
 * morning and message every lapsed client a studio has ever had — which is
 * exactly what would happen the first day this ships if it asked for
 * `pt_end_date < CURRENT_DATE`. The dedupe key would stop the SECOND such
 * message; nothing would stop the first.
 */
async function membershipExpiredYesterday(orgId) {
  const { rows } = await pool.query(
    `SELECT c.id, c.name, to_char(c.pt_end_date, 'YYYY-MM-DD') AS end_date
       FROM pt_clients c
      WHERE c.organization_id = $1
        AND c.deleted_at IS NULL
        AND c.pt_end_date = (CURRENT_DATE - 1)
        AND COALESCE(NULLIF(c.whatsapp, ''), c.mobile) IS NOT NULL
      ORDER BY c.id`,
    [orgId]
  );
  return rows;
}

/**
 * Current clients whose birthday is today.
 *
 * Current — `pt_end_date IS NULL OR >= CURRENT_DATE` — because a birthday
 * message to someone who stopped training two years ago is not a courtesy, it
 * is a studio that has not noticed they left. A studio that wants to reach
 * lapsed clients has campaigns for that, where it can see who it is messaging.
 *
 * 29 February is matched on 29 February only. Postgres has no opinion about
 * when a leap-day birthday falls in a common year and neither should this: the
 * alternative is picking 28 February or 1 March on the client's behalf and
 * being wrong for half of them.
 */
async function birthdaysToday(orgId) {
  const { rows } = await pool.query(
    `SELECT c.id, c.name, to_char(CURRENT_DATE, 'YYYY-MM-DD') AS today
       FROM pt_clients c
      WHERE c.organization_id = $1
        AND c.deleted_at IS NULL
        AND c.dob IS NOT NULL
        AND EXTRACT(MONTH FROM c.dob) = EXTRACT(MONTH FROM CURRENT_DATE)
        AND EXTRACT(DAY   FROM c.dob) = EXTRACT(DAY   FROM CURRENT_DATE)
        AND (c.pt_end_date IS NULL OR c.pt_end_date >= CURRENT_DATE)
        AND COALESCE(NULLIF(c.whatsapp, ''), c.mobile) IS NOT NULL
      ORDER BY c.id`,
    [orgId]
  );
  return rows;
}

/**
 * Current clients whose joining anniversary is today.
 *
 * `joining_date < CURRENT_DATE` excludes the joining day itself: a client who
 * enrolled this morning has already had `member_created` fire, and "happy 0
 * year anniversary" on the same day is the sort of thing that makes a studio
 * turn automation off entirely.
 */
async function anniversariesToday(orgId) {
  const { rows } = await pool.query(
    `SELECT c.id, c.name,
            to_char(CURRENT_DATE, 'YYYY-MM-DD') AS today,
            EXTRACT(YEAR FROM AGE(CURRENT_DATE, c.joining_date))::INT AS years
       FROM pt_clients c
      WHERE c.organization_id = $1
        AND c.deleted_at IS NULL
        AND c.joining_date IS NOT NULL
        AND c.joining_date < CURRENT_DATE
        AND EXTRACT(MONTH FROM c.joining_date) = EXTRACT(MONTH FROM CURRENT_DATE)
        AND EXTRACT(DAY   FROM c.joining_date) = EXTRACT(DAY   FROM CURRENT_DATE)
        AND (c.pt_end_date IS NULL OR c.pt_end_date >= CURRENT_DATE)
        AND COALESCE(NULLIF(c.whatsapp, ''), c.mobile) IS NOT NULL
      ORDER BY c.id`,
    [orgId]
  );
  return rows;
}

/**
 * Current clients who have not checked in for at least `days` days.
 *
 * ── Why only clients who have EVER checked in ───────────────────────────────
 *
 * A client with no attendance row at all has no last visit to miss — they may
 * have enrolled yesterday, or the studio may not use check-in at all, and "we
 * have not seen you since ∅" is not a message anybody should receive.
 * Production has 34 clients and 12 attendance rows, so getting this wrong
 * would nudge almost the entire roster on the first morning.
 *
 * What enforces it is the HAVING, not the join: with no rows, MAX(a.date) is
 * NULL, `CURRENT_DATE - NULL` is NULL, and NULL >= 14 is not true. The inner
 * join says the same thing a second time and is kept for legibility — mutating
 * it to a LEFT JOIN alone changes no behaviour and no test, which is worth
 * knowing before someone "fixes" the HAVING with a COALESCE and quietly turns
 * every never-attended client into a fortnight-long absentee.
 *
 * ── Why `>= days` and not `= days` ──────────────────────────────────────────
 *
 * The opposite of membershipExpiringIn, and for the opposite reason. There are
 * no buckets here — one absence produces one message — so the window is open
 * ended and the dedupe key is the last visit date, which does not change until
 * the client comes back. A sweep that misses a day therefore still sends the
 * message the next day, rather than losing it, and a client who stays away for
 * a year is messaged once rather than 350 times.
 *
 * ── Why the attendance rows are not org-filtered ────────────────────────────
 *
 * `c` is already bound to the studio and `a.ref_id` is a pt_clients primary
 * key, so every row this joins belongs to a client this studio owns — the
 * tenant boundary is the client, and it is enforced. Adding
 * `a.organization_id = $1` on top would look stricter and behave worse: a
 * legacy attendance row with a null organization_id would drop out of the MAX,
 * and a client who trained yesterday would be told nobody has seen them.
 */
async function attendanceMissedFor(orgId, days) {
  const { rows } = await pool.query(
    `SELECT c.id, c.name,
            to_char(MAX(a.date), 'YYYY-MM-DD') AS last_visit,
            (CURRENT_DATE - MAX(a.date)) AS days_since
       FROM pt_clients c
       JOIN attendance_logs a
         ON a.ref_id = c.id AND a.ref_type = 'client'
      WHERE c.organization_id = $1
        AND c.deleted_at IS NULL
        AND (c.pt_end_date IS NULL OR c.pt_end_date >= CURRENT_DATE)
        AND COALESCE(NULLIF(c.whatsapp, ''), c.mobile) IS NOT NULL
      GROUP BY c.id, c.name
     HAVING (CURRENT_DATE - MAX(a.date)) >= $2
      ORDER BY c.id`,
    [orgId, days]
  );
  return rows;
}

/**
 * Leads whose follow-up date has arrived or passed.
 *
 * `<= CURRENT_DATE` rather than `=`, so a lead whose follow-up fell on a day
 * the sweep did not run is still chased. The dedupe key is the follow-up date
 * itself, which means the nudge repeats only when a human moves the date —
 * which is precisely when the studio has decided to chase again.
 *
 * Converted and lost leads are excluded: a converted lead is a client now and
 * has client events of its own, and chasing a lost one is the definition of
 * the automation a studio complains about.
 */
async function followupsDue(orgId) {
  const { rows } = await pool.query(
    `SELECT l.id, l.name, l.status, l.interested_package,
            to_char(l.follow_up_date, 'YYYY-MM-DD') AS follow_up_date
       FROM pt_leads l
      WHERE l.organization_id = $1
        AND l.follow_up_date IS NOT NULL
        AND l.follow_up_date <= CURRENT_DATE
        AND l.status NOT IN ('converted', 'lost')
        AND l.converted_client_id IS NULL
        AND NULLIF(l.mobile, '') IS NOT NULL
      ORDER BY l.id`,
    [orgId]
  );
  return rows;
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
  leadRecipient,
  insertQueued,
  insertQueuedWithinLimit,
  loadQueued,
  markSent,
  markFailed,
  applyReceipt,
  markFailedByClientId,
  orphanCandidates,
  reconnectCandidates,
  requeueFailed,
  orgsWithAutomationOn,
  activeTriggerEventsFor,
  membershipExpiringIn,
  membershipExpiredYesterday,
  birthdaysToday,
  anniversariesToday,
  attendanceMissedFor,
  followupsDue,
};
