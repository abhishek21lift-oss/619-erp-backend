// src/modules/command-center/ai-inventory.service.js
//
// The full AI model inventory, for the AI Operations view.
//
// Too large to ride the 1s snapshot tick (FreeLLMAPI's catalog runs to
// hundreds of entries), so it is read on demand: every model the gateway's
// catalog returns, joined to the routing tier(s) that name it and to when
// ai_usage_log last saw it serve a request.
//
// Four states are kept apart, because they are four different facts:
//
//   configured    a routing tier names it            (lib/ai/models.js)
//   active        it served the most recent request  (the ai card, not here)
//   available     the gateway says it can serve now  (GET /v1/models)
//   unavailable   the gateway says it cannot, and why
//
// A configured model is never shown as available unless the catalog says so.
'use strict';

const pool = require('../../db/pool');
const gateway = require('../../lib/ai/gateway');
const { models: aiModels } = require('../../lib/ai/models');

const TIERS = ['primary', 'secondary', 'fallback'];

async function usageByModel() {
  try {
    const { rows } = await pool.query(`
      SELECT model, max(created_at) AS last_used_at, count(*)::int AS requests_30d
        FROM ai_usage_log
       WHERE created_at >= now() - interval '30 days'
       GROUP BY model`);
    return new Map(rows.map((r) => [r.model, r]));
  } catch {
    // Unreadable is not "never used": the fields go null, not 0.
    return null;
  }
}

// `?fresh=1` bypasses the gateway's 10s memo, and this route has no command
// cooldown in front of it. A held-down reload must not become four gateway
// requests per press, so a fresh read is honoured at most this often; inside
// the window the caller gets the memo, which is at most this old.
const FRESH_FLOOR_MS = 5000;
let lastFreshAt = 0;

/** @param {{ fresh?: boolean, now?: number }} [opts] */
async function modelInventory({ fresh = false, now = Date.now() } = {}) {
  const honourFresh = fresh && now - lastFreshAt >= FRESH_FLOOR_MS;
  if (honourFresh) lastFreshAt = now;
  const [p, usage] = await Promise.all([gateway.probe({ fresh: honourFresh }), usageByModel()]);
  const verdict = gateway.grade(p);

  const tiersById = new Map();
  for (const tier of TIERS) {
    const id = aiModels[tier];
    if (!id) continue;
    tiersById.set(id, [...(tiersById.get(id) ?? []), tier]);
  }

  const annotate = (m) => ({
    ...m,
    configured_tiers: tiersById.get(m.id) ?? [],
    last_used_at: usage ? (usage.get(m.id)?.last_used_at ?? null) : null,
    requests_30d: usage ? (usage.get(m.id)?.requests_30d ?? 0) : null,
  });

  const catalog = p.kind === 'freellmapi' ? p.catalog : null;
  const listed = new Set([...(catalog?.models ?? []), ...(catalog?.routers ?? [])].map((m) => m.id));

  return {
    gateway: { kind: p.kind, endpoint: p.endpoint ?? null, status: verdict.status, reason: verdict.reason },
    checked_at: p.checked_at,
    source: catalog?.source ?? null,
    exposed: catalog ? catalog.exposed : null,
    reason: catalog ? catalog.reason : verdict.reason,
    usage_readable: usage !== null,
    configured: TIERS.map((tier) => ({ tier, id: aiModels[tier] ?? null, router: gateway.isRouterModel(aiModels[tier]) })),
    models: catalog?.models ? catalog.models.map(annotate) : null,
    routers: catalog?.routers ? catalog.routers.map(annotate) : null,
    // Models this database saw serve traffic that the catalog does not list:
    // retired upstream, renamed, or served by a different gateway than this one.
    served_not_in_catalog: catalog?.models && usage
      ? [...usage.values()].filter((u) => u.model && !listed.has(u.model))
        .map((u) => ({ id: u.model, last_used_at: u.last_used_at, requests_30d: u.requests_30d }))
      : null,
  };
}

module.exports = { modelInventory };
