'use strict';
// src/modules/pt-os/churn.service.js
// Assembles the churn-risk list from three sources: the whole roster (who is
// assessed), the sweep (training signals), and the follow-up log (what the
// trainer already did). Deterministic: scores come from churn-risk.js, the
// only clock read is the studio's today.
const { today: studioToday } = require('../../lib/appTime');
const { termState } = require('./training-signals');
const { sweepRoster } = require('./client-context');
const repo = require('./churn.repository');
const { scoreClient, rankClients } = require('./churn-risk');

const HANDLED_LIMIT = 100;
const RISK_RISE = 15;

async function buildChurnList(orgId, { today = studioToday() } = {}) {
  const [roster, sweep, marks] = await Promise.all([
    repo.listRoster(orgId),
    sweepRoster(orgId, { today }),
    repo.latestFollowups(orgId),
  ]);

  const flagged = new Map((sweep.clients_detail || []).map((row) => [row.client_id, row]));
  const markByClient = new Map((marks || []).map((row) => [row.client_id, row]));

  const rows = [];
  const handled = [];
  const bands = { critical: 0, high: 0, medium: 0, low: 0 };

  for (const client of roster) {
    const flagRow = flagged.get(client.id);
    const term = termState(client, today);
    const never_started = Boolean(flagRow?.signals?.some((s) => s.id === 'never_started'));
    const scored = scoreClient({
      days_quiet: flagRow?.days_quiet ?? null,
      never_started,
      flagged: Boolean(flagRow),
      term,
      balance_amount: client.balance_amount,
    });
    // Score 0 is not a risk; it stays counted in assessed and out of the list.
    if (scored.score === 0) continue;

    bands[scored.band] += 1;
    const row = {
      client_id: client.id,
      client_name: client.name,
      ...scored,
      last_session: flagRow?.last_session ?? null,
      days_quiet: flagRow?.days_quiet ?? null,
      term,
      balance_amount: Number(client.balance_amount) || 0,
      risk_increased: false,
    };

    const mark = markByClient.get(client.id);
    if (mark && mark.hide_until >= today && row.score < mark.risk_score + RISK_RISE) {
      handled.push({ ...row, outcome: mark.outcome, hide_until: mark.hide_until });
    } else {
      if (mark && row.score >= mark.risk_score + RISK_RISE) row.risk_increased = true;
      rows.push(row);
    }
  }

  return {
    as_of: today,
    assessed: roster.length,
    flagged: rows.length + handled.length,
    bands,
    rows: rankClients(rows),
    // Capped after visibility: the 101st hidden client is still hidden.
    handled: rankClients(handled).slice(0, HANDLED_LIMIT),
  };
}

/**
 * Log what the trainer did about one client. Returns null for a client outside
 * the org and for one that no longer scores, so the route can answer 404
 * without learning whether the id exists elsewhere.
 */
async function markFollowup(orgId, clientId, { outcome, snoozeUntil, note, today = studioToday() } = {}) {
  if (!(await repo.clientInOrg(orgId, clientId))) return null;

  const list = await buildChurnList(orgId, { today });
  const found = [...list.rows, ...list.handled].find((row) => row.client_id === clientId);
  if (!found) return null;

  return repo.create({ orgId, clientId, outcome, hideUntil: snoozeUntil, riskScore: found.score, note });
}

module.exports = { buildChurnList, markFollowup };
