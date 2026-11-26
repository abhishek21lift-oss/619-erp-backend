'use strict';

// Leads are the other half of a trainer's day: someone enquired and nobody has
// replied. `lead_due` honours the date the trainer set; `lead_stale` is the
// absence of one after three days, and only for the two statuses where a
// follow-up is the expected next step.

const pool = require('../../../db/pool');
const { dayDiff, formatDay } = require('./dates');

const OPEN_STATUSES = new Set(['new', 'contacted', 'trial_scheduled']);
const STALE_AFTER_DAYS = 3;

function ymd(value) {
  if (typeof value !== 'string') return null;
  const candidate = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : null;
}

function reasonsFromLeads(rows, today) {
  const out = [];
  for (const row of rows || []) {
    if (!row || !row.id || !OPEN_STATUSES.has(row.status)) continue;

    const subject = { type: 'lead', id: row.id, name: row.name, photo_url: null };
    const followUp = ymd(row.follow_up_date);

    if (followUp) {
      if (followUp > today) continue;
      out.push({
        subject,
        reason: {
          code: 'lead_due',
          label: followUp === today ? 'Follow-up due today' : `Follow-up was due ${formatDay(followUp)}`,
          evidence: { follow_up_date: followUp },
          due_at: followUp,
        },
      });
      continue;
    }

    if (row.status !== 'new' && row.status !== 'contacted') continue;

    const created = ymd(row.created_at);
    if (!created) continue;
    const days = dayDiff(created, today);
    if (days === null || days <= STALE_AFTER_DAYS) continue;

    out.push({
      subject,
      reason: {
        code: 'lead_stale',
        label: `Enquiry from ${formatDay(created)} has no follow-up`,
        evidence: { created_at: created },
        due_at: null,
      },
    });
  }
  return out;
}

async function collect({ orgId, today }) {
  const { rows } = await pool.query(
    `SELECT id, name, mobile, status,
            follow_up_date::TEXT AS follow_up_date,
            created_at::TEXT AS created_at
       FROM pt_leads
      WHERE organization_id = $1
        AND status IN ('new','contacted','trial_scheduled')
      ORDER BY follow_up_date NULLS LAST, created_at ASC`,
    [orgId],
  );
  return reasonsFromLeads(rows, today);
}

module.exports = { collect, reasonsFromLeads };
