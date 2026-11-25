'use strict';

// The queue service owns the lifecycle. Signals decide what is true now; this
// module decides what to do about the item that already exists:
//   open      → refresh when facts change, resolve when they stop being true
//   snoozed   → hide until the clock passes, then reopen
//   actioned  → hide for seven days, then reopen if the reasons persist
//   dismissed → reopen only on new evidence or a 15-point rise
//   resolved  → same as dismissed
//
// Every write is guarded by the status that was read. A lost race (the trainer
// approved between our read and our write) must not resurrect the item.

const repo = require('./ops.repository');
const { collectAll } = require('./signals');
const { templateDraft } = require('./templates');
const { generateDrafts } = require('./draft');
const transport = require('../messaging/transport');
const crypto = require('crypto');
const {
  chooseAction, reasonIdentity, closedReasons, shouldReopen, evidenceHash,
} = require('./priority');

const REOPEN_AFTER_DAYS = 7;
const REOPEN_SCORE_DELTA = 15;
const COOLDOWN_MS = 5 * 60 * 1000;
const SNOOZE_DAYS = new Set([1, 3, 7]);
const DISMISS_REASONS = new Set(['not_relevant', 'already_handled', 'asked_not_to_contact', 'other']);
const FAMILIES = ['churn', 'engagement', 'training', 'screening', 'leads'];
const BANDS = ['critical', 'high', 'medium', 'low'];

class OpsError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'OpsError';
    this.status = status;
    this.code = code;
  }
}

function subjectKey(subject) {
  return `${subject.type}:${subject.id}`;
}

function storedReasons(item) {
  return Array.isArray(item.reasons) ? item.reasons : [];
}

function identityOf(reasons) {
  return reasons.map(reasonIdentity).sort().join('|');
}

function itemFields(group, action) {
  return {
    priority_score: group.score,
    priority_band: group.band,
    reasons: group.reasons,
    next_due_at: group.next_due_at ?? null,
    recommended_action: action,
  };
}

function reopenTrigger(reasons, item) {
  const closed = new Map();
  for (const entry of item.closed_reasons || []) {
    if (!entry || typeof entry.code !== 'string') continue;
    if (!closed.has(entry.code)) closed.set(entry.code, new Set());
    closed.get(entry.code).add(entry.entry_hash ?? entry.evidence_hash);
  }
  for (const reason of reasons) {
    const hashes = closed.get(reason.code);
    if (!hashes || !hashes.has(evidenceHash(reason.evidence))) return 'evidence';
  }
  return 'score';
}

async function reconcile({ orgId, today, now = new Date() }) {
  const groups = await collectAll({ orgId, today });
  const existing = await repo.findItems(orgId);
  const byKey = new Map(existing.map((item) => [item.dedupe_key, item]));
  const seen = new Set();

  // collectAll already groups, but a caller may hand us duplicates. First one
  // wins; merging would let two collectors disagree about a subject's score.
  const unique = new Map();
  for (const group of groups) {
    if (!group?.subject?.id) continue;
    const key = subjectKey(group.subject);
    if (!unique.has(key)) unique.set(key, group);
  }

  for (const [key, group] of unique) {
    seen.add(key);
    const action = chooseAction(group.reasons, group.subject);
    const fields = itemFields(group, action);
    const item = byKey.get(key);

    if (!item) {
      const inserted = await repo.insertItem(orgId, {
        client_id: group.subject.type === 'client' ? group.subject.id : null,
        lead_id: group.subject.type === 'lead' ? group.subject.id : null,
        dedupe_key: key,
        status: 'open',
        priority_score: group.score,
        priority_band: group.band,
        reasons: group.reasons,
        next_due_at: group.next_due_at ?? null,
        recommended_action: action,
        closed_reasons: [],
        closed_score: 0,
      });
      if (inserted) {
        await repo.insertEvent(orgId, {
          itemId: inserted.id,
          eventType: 'created',
          payload: { reason_codes: group.reasons.map((reason) => reason.code) },
        });
      }
      continue;
    }

    const previous = storedReasons(item);
    const changed = identityOf(group.reasons) !== identityOf(previous)
      || group.score !== item.priority_score
      || group.band !== item.priority_band;
    const refreshNeeded = changed
      || JSON.stringify(group.reasons) !== JSON.stringify(previous)
      || JSON.stringify(action) !== JSON.stringify(item.recommended_action);

    if (item.status === 'open') {
      if (!refreshNeeded) continue;
      const updated = await repo.updateItem(orgId, item.id, 'open', fields);
      if (updated && changed) {
        await repo.insertEvent(orgId, {
          itemId: item.id,
          eventType: 'reasons_updated',
          payload: {
            from: previous.map((reason) => reason.code),
            to: group.reasons.map((reason) => reason.code),
          },
        });
      }
      continue;
    }

    if (item.status === 'snoozed') {
      const until = item.snoozed_until ? new Date(item.snoozed_until).getTime() : 0;
      if (Number.isFinite(until) && until > now.getTime()) {
        // Still hidden, but the card should describe today's facts when it
        // returns. No event: the trainer's decision has not been revisited.
        await repo.updateItem(orgId, item.id, 'snoozed', fields);
        continue;
      }
      const updated = await repo.updateItem(orgId, item.id, 'snoozed', {
        status: 'open', snoozed_until: null, ...fields,
      });
      if (updated) {
        await repo.insertEvent(orgId, {
          itemId: item.id,
          eventType: 'reopened',
          payload: { trigger: 'snooze_elapsed', from: 'snoozed' },
        });
      }
      continue;
    }

    if (item.status === 'actioned') {
      const last = item.last_actioned_at ? new Date(item.last_actioned_at).getTime() : 0;
      const elapsed = now.getTime() - last;
      if (!Number.isFinite(elapsed) || elapsed < REOPEN_AFTER_DAYS * 86400000) continue;

      const updated = await repo.reopenActionedItem(orgId, item.id, { ...fields, last_error: null });
      if (updated) {
        await repo.insertEvent(orgId, {
          itemId: item.id,
          eventType: 'reopened',
          payload: { trigger: 'seven_days', from: 'actioned' },
        });
      }
      continue;
    }

    if (item.status === 'dismissed' || item.status === 'resolved') {
      if (!shouldReopen(group.reasons, item, group.score)) continue;
      const trigger = reopenTrigger(group.reasons, item);
      const updated = await repo.reopenClosedItem(orgId, item.id, item.status, {
        ...fields,
        dismissed_reason: null,
        closed_reasons: [],
        closed_score: 0,
      });
      if (updated) {
        await repo.insertEvent(orgId, {
          itemId: item.id,
          eventType: 'reopened',
          payload: { trigger, from: item.status },
        });
      }
    }
  }

  for (const item of existing) {
    if (seen.has(item.dedupe_key)) continue;
    if (!['open', 'snoozed', 'actioned'].includes(item.status)) continue;
    const resolved = await repo.resolveMissingItem(orgId, item.id);
    if (resolved) {
      await repo.insertEvent(orgId, {
        itemId: item.id, eventType: 'resolved', payload: { auto: true },
      });
    }
  }
}

function subjectOf(row) {
  const type = row.subject_type || (row.client_id ? 'client' : 'lead');
  return {
    type,
    id: row.client_id || row.lead_id,
    name: row.subject_name ?? row.name ?? null,
    photo_url: row.photo_url ?? null,
  };
}

function channelFor(row, subject, instance) {
  const action = row.recommended_action;
  if (!action || action.kind !== 'message') return { status: 'connected', reason: null };

  const mobile = subject.type === 'client' ? row.mobile : row.lead_mobile;
  if (!mobile) return { status: 'unavailable', reason: 'no_recipient' };
  if (subject.type === 'client' && row.whatsapp_opt_out) {
    return { status: 'unavailable', reason: 'opted_out' };
  }
  if (!instance?.ok) return { status: 'unavailable', reason: 'not_connected' };
  return { status: 'connected', reason: null };
}

async function draftFor({ orgId, row, subject, studioName }) {
  const action = row.recommended_action;
  if (!action || action.kind !== 'message') return null;

  const reasons = storedReasons(row);
  const primary = reasons.find((reason) => reason.code === action.reason_code) || reasons[0];
  if (!primary) return null;

  const currentKey = reasonIdentity(primary);
  if (row.draft?.body && row.draft.reason_key === currentKey) return row.draft;

  const draft = templateDraft({ subject, primaryReason: primary, studioName });
  if (draft) {
    await repo.updateItem(orgId, row.id, row.status, { draft });
  }
  return draft;
}

async function presentItem(row, { orgId, studioName, instance }) {
  const subject = subjectOf(row);
  return {
    id: row.id,
    subject,
    status: row.status,
    priority_score: row.priority_score,
    priority_band: row.priority_band,
    reasons: storedReasons(row),
    next_due_at: row.next_due_at ?? null,
    recommended_action: row.recommended_action ?? null,
    draft: await draftFor({ orgId, row, subject, studioName }),
    channel: channelFor(row, subject, instance),
    last_contacted_at: row.last_contacted_at ?? null,
    last_actioned_at: row.last_actioned_at ?? null,
    last_error: row.last_error ?? null,
    created_at: row.created_at,
  };
}

async function loadInstance(orgId) {
  try {
    return await transport.resolveInstance(orgId);
  } catch {
    return { ok: false, reason: 'not_connected' };
  }
}

function countItems(items) {
  const by_band = Object.fromEntries(BANDS.map((band) => [band, 0]));
  const by_family = Object.fromEntries(FAMILIES.map((family) => [family, 0]));

  for (const item of items) {
    if (by_band[item.priority_band] !== undefined) by_band[item.priority_band] += 1;
    const families = new Set((item.reasons || []).map((reason) => reason.family));
    for (const family of families) {
      if (by_family[family] !== undefined) by_family[family] += 1;
    }
  }

  return { total: items.length, by_band, by_family };
}

function briefOf(row) {
  const payload = row?.payload;
  if (!payload?.text) return null;
  return {
    text: payload.text,
    source: payload.source === 'template' ? 'template' : 'ai',
    generated_at: payload.generated_at ?? row.created_at,
  };
}

async function buildQueue({ orgId, today }) {
  const [rows, studioName, briefRow, instance] = await Promise.all([
    repo.findOpenItems(orgId),
    repo.orgName(orgId),
    repo.latestBrief(orgId, today),
    loadInstance(orgId),
  ]);

  const items = await Promise.all(
    rows.map((row) => presentItem(row, { orgId, studioName, instance })),
  );
  const brief = briefOf(briefRow);
  const ai = brief
    ? { status: 'ok', message: null, last_generated_at: brief.generated_at }
    : { status: 'not_generated', message: 'No brief yet today.', last_generated_at: null };

  return { as_of: new Date().toISOString(), brief, ai, counts: countItems(items), items };
}

async function getQueue({ orgId, today, now = new Date() }) {
  await reconcile({ orgId, today, now });
  return buildQueue({ orgId, today });
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

async function refresh({ orgId, today, actor, requestId, now = new Date() }) {
  await reconcile({ orgId, today, now });

  // The cooldown is read from the audit table, not an in-process map: a second
  // instance must not spend again just because it never saw the first call.
  const lastAt = await repo.latestBriefAt(orgId);
  if (lastAt && now.getTime() - new Date(lastAt).getTime() < COOLDOWN_MS) {
    const queue = await buildQueue({ orgId, today });
    return {
      ...queue,
      ai: { status: 'cooldown', message: 'Just refreshed.', last_generated_at: lastAt },
    };
  }

  const queue = await buildQueue({ orgId, today });
  const candidates = queue.items.filter(
    (item) => item.recommended_action?.kind === 'message' && item.channel.status === 'connected',
  );
  if (!candidates.length) return queue;

  const studioName = await repo.orgName(orgId);
  const generated = await generateDrafts({
    orgId, items: candidates, studioName, actor, requestId,
  });
  if (!generated.ok) {
    return {
      ...queue,
      ai: { status: 'failed', message: generated.message, last_generated_at: null },
    };
  }

  const generatedAt = new Date(now).toISOString();
  await repo.insertEvent(orgId, {
    itemId: null,
    eventType: 'brief_generated',
    actorUserId: actor?.userId ?? null,
    actorRole: actor?.role ?? null,
    payload: {
      date: today,
      text: generated.brief,
      source: 'ai',
      model: generated.model ?? null,
      generated_at: generatedAt,
    },
  });

  for (const item of candidates) {
    const draft = generated.drafts?.get(item.id);
    if (!draft) continue;

    // Guarded by the status we read. If the trainer approved this item while
    // the model was writing, the write loses and the approval stands.
    const updated = await repo.updateItem(orgId, item.id, item.status, { draft });
    if (!updated) continue;

    await repo.insertEvent(orgId, {
      itemId: item.id,
      eventType: 'draft_generated',
      actorUserId: actor?.userId ?? null,
      actorRole: actor?.role ?? null,
      payload: {
        source: 'ai',
        model: generated.model ?? null,
        confidence: draft.confidence ?? null,
        body_sha256: sha256(draft.body),
        body_length: draft.body.length,
      },
    });
  }

  const finalQueue = await buildQueue({ orgId, today });
  return {
    ...finalQueue,
    brief: finalQueue.brief || {
      text: generated.brief, source: 'ai', generated_at: generatedAt,
    },
    ai: { status: 'ok', message: null, last_generated_at: generatedAt },
  };
}

async function getItem({ orgId, itemId }) {
  const row = await repo.findItem(orgId, itemId);
  if (!row) throw new OpsError(404, 'NOT_FOUND', 'Queue item not found');

  const [events, studioName, instance] = await Promise.all([
    repo.findEvents(orgId, itemId),
    repo.orgName(orgId),
    loadInstance(orgId),
  ]);

  return { item: await presentItem(row, { orgId, studioName, instance }), events };
}

function assertActionable(item) {
  if (!item) throw new OpsError(404, 'NOT_FOUND', 'Queue item not found');
  if (!['open', 'snoozed'].includes(item.status)) {
    throw new OpsError(409, 'NOT_APPROVABLE', 'This item is already closed');
  }
}

async function presentById(orgId, itemId) {
  const row = await repo.findItem(orgId, itemId);
  if (!row) throw new OpsError(404, 'NOT_FOUND', 'Queue item not found');
  const [studioName, instance] = await Promise.all([repo.orgName(orgId), loadInstance(orgId)]);
  return presentItem(row, { orgId, studioName, instance });
}

async function snooze({ orgId, itemId, days, actor }) {
  if (!SNOOZE_DAYS.has(days)) {
    throw new OpsError(400, 'VALIDATION', 'Snooze must be 1, 3 or 7 days');
  }

  const item = await repo.findItem(orgId, itemId);
  assertActionable(item);

  const updated = await repo.updateItem(orgId, itemId, item.status, {
    status: 'snoozed',
    snoozed_until: new Date(Date.now() + days * 86400000),
  });
  if (!updated) throw new OpsError(409, 'NOT_APPROVABLE', 'This item changed while you were deciding');

  await repo.insertEvent(orgId, {
    itemId,
    eventType: 'snoozed',
    actorUserId: actor?.userId ?? null,
    actorRole: actor?.role ?? null,
    payload: { days },
  });

  return presentById(orgId, itemId);
}

async function dismiss({ orgId, itemId, reason, actor }) {
  if (!DISMISS_REASONS.has(reason)) {
    throw new OpsError(400, 'VALIDATION', 'Unknown dismiss reason');
  }

  const item = await repo.findItem(orgId, itemId);
  assertActionable(item);

  const updated = await repo.updateItem(orgId, itemId, item.status, {
    status: 'dismissed',
    dismissed_reason: reason,
    snoozed_until: null,
    closed_reasons: closedReasons(storedReasons(item)),
    closed_score: item.priority_score,
  });
  if (!updated) throw new OpsError(409, 'NOT_APPROVABLE', 'This item changed while you were deciding');

  await repo.insertEvent(orgId, {
    itemId,
    eventType: 'dismissed',
    actorUserId: actor?.userId ?? null,
    actorRole: actor?.role ?? null,
    payload: { reason },
  });

  return presentById(orgId, itemId);
}

const MAX_BODY = 1200;

function normaliseBody(supplied, stored) {
  if (supplied !== undefined) {
    if (typeof supplied !== 'string') {
      throw new OpsError(400, 'VALIDATION', 'Message body must be a string');
    }
    const trimmed = supplied.trim();
    if (!trimmed) throw new OpsError(400, 'VALIDATION', 'Message body cannot be empty');
    if (trimmed.length > MAX_BODY) {
      throw new OpsError(400, 'VALIDATION', `Message body must be ${MAX_BODY} characters or fewer`);
    }
    return trimmed;
  }

  const fallback = typeof stored === 'string' ? stored.trim() : '';
  if (!fallback) throw new OpsError(400, 'NO_DRAFT', 'No message draft to send');
  if (fallback.length > MAX_BODY) {
    throw new OpsError(400, 'VALIDATION', `Message body must be ${MAX_BODY} characters or fewer`);
  }
  return fallback;
}

// The one path that sends a client-facing message. The order is deliberate:
// authorise the subject, prove the channel, validate the words, claim the item
// atomically, record the intent in the same transaction, and only then send.
// A crash after the claim leaves a queued log and an actioned item that a human
// can reconcile; that is safer than a send with no record, and safer than a
// retry that delivers twice.
async function approve({ orgId, itemId, body, actor, requestId }) {
  const item = await repo.findItem(orgId, itemId);
  if (!item) throw new OpsError(404, 'NOT_FOUND', 'Queue item not found');
  if (item.status === 'actioned') {
    throw new OpsError(409, 'ALREADY_ACTIONED', 'This item was already actioned');
  }
  if (!['open', 'snoozed'].includes(item.status)) {
    throw new OpsError(409, 'NOT_APPROVABLE', 'This item is closed');
  }

  const isClient = Boolean(item.client_id);
  const subject = isClient
    ? await repo.findClientForSend(orgId, item.client_id)
    : await repo.findLeadForSend(orgId, item.lead_id);
  if (!subject) throw new OpsError(404, 'NOT_FOUND', 'Client or lead not found');
  if (isClient && subject.whatsapp_opt_out) {
    throw new OpsError(409, 'OPTED_OUT', 'This client has opted out of WhatsApp');
  }
  if (!subject.mobile) throw new OpsError(409, 'NO_RECIPIENT', 'No mobile number on file');

  const instance = await transport.resolveInstance(orgId);
  if (!instance?.ok) {
    throw new OpsError(409, 'CHANNEL_UNAVAILABLE', 'WhatsApp is not connected for this studio');
  }

  const chosen = normaliseBody(body, item.draft?.body);
  const edited = Boolean(item.draft?.body) && chosen !== item.draft.body;
  const now = new Date();
  const bodySha = sha256(chosen);

  const claimed = await repo.withTransaction(async (client) => {
    const row = await repo.claimItem(orgId, itemId, {
      status: 'actioned',
      last_actioned_at: now,
      last_error: null,
      closed_reasons: closedReasons(storedReasons(item)),
      closed_score: item.priority_score,
      draft: {
        ...(item.draft || {}),
        body: chosen,
        channel: 'whatsapp',
        source: edited ? 'trainer' : (item.draft?.source ?? 'template'),
        generated_at: item.draft?.generated_at ?? now.toISOString(),
      },
    }, client);
    if (!row) throw new OpsError(409, 'ALREADY_ACTIONED', 'This item was already actioned');

    const logId = await repo.insertCommunicationLog(orgId, {
      recipientType: isClient ? 'client' : 'lead',
      recipientId: isClient ? item.client_id : item.lead_id,
      recipientName: subject.name,
      recipientPhone: subject.mobile,
      message: chosen,
    }, client);
    if (!logId) throw new OpsError(500, 'INTERNAL', 'Could not record the message');

    // The human decision is audited before the send, so a delivery failure
    // never erases the fact that the trainer approved this text.
    await repo.insertEvent(orgId, {
      itemId,
      eventType: edited ? 'edited' : 'approved',
      actorUserId: actor?.userId ?? null,
      actorRole: actor?.role ?? null,
      payload: {
        body_sha256: bodySha,
        body_length: chosen.length,
        ...(edited ? { previous_sha256: sha256(item.draft.body) } : {}),
      },
    }, client);

    return { row, logId };
  });

  let out;
  try {
    out = await transport.send({
      orgId,
      to: subject.mobile,
      text: chosen,
      clientMessageId: claimed.logId,
      requestId: requestId ?? null,
      allowSharedProvider: false,
    });
  } catch (err) {
    out = { status: 'failed', error: err?.code || 'transport_error' };
  }

  if (out?.status === 'sent') {
    await repo.markCommunicationSent(orgId, claimed.logId, {
      external_id: out.provider_id || null,
      provider: out.provider || null,
      sent_at: new Date(),
    });
    await repo.updateItem(orgId, itemId, 'actioned', { last_contacted_at: new Date() });
    await repo.insertEvent(orgId, {
      itemId,
      eventType: 'sent',
      actorUserId: actor?.userId ?? null,
      actorRole: actor?.role ?? null,
      payload: {
        communication_log_id: claimed.logId,
        channel: 'whatsapp',
        provider_id: out.provider_id || null,
        status: 'sent',
        body_sha256: bodySha,
      },
    });

    return {
      item: await presentById(orgId, itemId),
      delivery: {
        status: 'sent',
        communication_log_id: claimed.logId,
        provider_id: out.provider_id || null,
        error: null,
      },
    };
  }

  const code = out?.error || out?.status || 'send_failed';
  await repo.markCommunicationFailed(orgId, claimed.logId, { failure_reason: code });
  await repo.updateItem(orgId, itemId, 'actioned', {
    status: 'open',
    last_error: { code: 'SEND_FAILED', message: code },
  });
  await repo.insertEvent(orgId, {
    itemId,
    eventType: 'send_failed',
    actorUserId: actor?.userId ?? null,
    actorRole: actor?.role ?? null,
    payload: {
      communication_log_id: claimed.logId,
      code,
      body_sha256: bodySha,
    },
  });

  return {
    item: await presentById(orgId, itemId),
    delivery: {
      status: 'failed',
      communication_log_id: claimed.logId,
      provider_id: null,
      error: code,
    },
  };
}

async function resolveManually({ orgId, itemId, actor }) {
  const item = await repo.findItem(orgId, itemId);
  if (!item) throw new OpsError(404, 'NOT_FOUND', 'Queue item not found');
  if (!['open', 'snoozed', 'actioned'].includes(item.status)) {
    throw new OpsError(409, 'NOT_APPROVABLE', 'This item is already closed');
  }

  const updated = await repo.updateItem(orgId, itemId, item.status, {
    status: 'resolved',
    resolved_at: new Date(),
    snoozed_until: null,
  });
  if (!updated) throw new OpsError(409, 'NOT_APPROVABLE', 'This item changed while you were deciding');

  await repo.insertEvent(orgId, {
    itemId,
    eventType: 'resolved',
    actorUserId: actor?.userId ?? null,
    actorRole: actor?.role ?? null,
    payload: { manual: true },
  });

  return presentById(orgId, itemId);
}

module.exports = {
  OpsError,
  REOPEN_AFTER_DAYS,
  REOPEN_SCORE_DELTA,
  COOLDOWN_MS,
  reconcile,
  buildQueue,
  getQueue,
  refresh,
  getItem,
  approve,
  snooze,
  dismiss,
  resolveManually,
};
