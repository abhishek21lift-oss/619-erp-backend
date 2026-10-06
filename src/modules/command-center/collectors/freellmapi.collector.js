// src/modules/command-center/collectors/freellmapi.collector.js
//
// The AI gateway: is FreeLLMAPI up, which providers can it reach, which
// models can it serve, and what can be said about its keys.
//
// Everything here is read from FreeLLMAPI's own status surface by
// lib/ai/gateway.js, or from lib/ai/observations.js (what this process saw its
// own calls do). Nothing is computed from configuration alone: a configured
// model is not an available one until the catalog says so.
//
// ── What is deliberately NOT here ──────────────────────────────────────────
//
// Per-key health. FreeLLMAPI only exposes it behind its dashboard session, and
// that session can export every stored provider key. The ERP does not hold it,
// so the card says "unavailable from provider" and gives the aggregate that the
// key-free /v1/providers surface does expose. It never infers that a key is
// healthy from the fact that it exists.
//
// ── Size ───────────────────────────────────────────────────────────────────
//
// This payload rides the 1s WebSocket tick and is copied into system_alerts
// when an alert opens. FreeLLMAPI's catalog runs to hundreds of entries, so the
// card carries counts plus the CONFIGURED models; the full inventory is a
// separate read (GET /command-center/ai/models).
'use strict';

const { result, unavailable } = require('../registry');
const gateway = require('../../../lib/ai/gateway');
const observations = require('../../../lib/ai/observations');
const { models: aiModels } = require('../../../lib/ai/models');

const NAME = 'freellmapi';

const KEY_HEALTH_UNAVAILABLE =
  'Key health unavailable from provider. FreeLLMAPI exposes per-key status only to its dashboard '
  + 'session, which can also export keys, so the ERP does not hold it.';

/** The effective tier models, as every request would route right now. */
function configuredTiers() {
  return [
    { tier: 'primary', id: aiModels.primary },
    { tier: 'secondary', id: aiModels.secondary },
    { tier: 'fallback', id: aiModels.fallback },
  ];
}

/** How each configured model stands in the gateway's catalog. */
function configuredInCatalog(catalog) {
  const all = [...(catalog?.models ?? []), ...(catalog?.routers ?? [])];
  const byId = new Map(all.map((m) => [m.id, m]));
  return configuredTiers().map(({ tier, id }) => {
    const hit = id ? byId.get(id) : null;
    return {
      tier,
      id: id ?? null,
      router: gateway.isRouterModel(id),
      // null = the catalog could not be read, so presence is UNKNOWN.
      in_catalog: catalog?.models ? Boolean(hit) : null,
      available: hit ? hit.available : null,
      unavailable_reason: hit ? hit.unavailable_reason : null,
    };
  });
}

function modelSummary(p) {
  const c = p.catalog;
  if (!c) return null;
  const list = c.models;
  const byProvider = new Map();
  for (const m of list ?? []) {
    const key = m.provider ?? 'unknown';
    const row = byProvider.get(key) || { provider: key, total: 0, available: 0 };
    row.total += 1;
    if (m.available === true) row.available += 1;
    byProvider.set(key, row);
  }
  return {
    source: c.source,
    exposed: c.exposed,
    reason: c.reason ?? null,
    total: list ? list.length : null,
    available: list ? list.filter((m) => m.available === true).length : null,
    unavailable: list ? list.filter((m) => m.available === false).length : null,
    routers: (c.routers ?? []).slice(0, 20).map((r) => ({ id: r.id, available: r.available })),
    by_provider: [...byProvider.values()].sort((a, b) => b.available - a.available || a.provider.localeCompare(b.provider)),
    configured: configuredInCatalog(c),
  };
}

function providerSummary(p, modelsByProvider) {
  const pr = p.providers;
  if (!pr) return null;
  const items = (pr.items ?? []).map((x) => ({
    ...x,
    // Model counts come from the catalog, joined on the provider id; null when
    // the catalog was not readable rather than a confident zero.
    models_total: modelsByProvider ? (modelsByProvider.get(x.id)?.total ?? 0) : null,
    models_available: modelsByProvider ? (modelsByProvider.get(x.id)?.available ?? 0) : null,
  }));
  const count = (s) => items.filter((x) => x.status === s).length;
  return {
    source: pr.source,
    exposed: pr.exposed,
    reason: pr.reason ?? null,
    total: pr.items ? items.length : null,
    healthy: pr.items ? count('healthy') : null,
    rate_limited: pr.items ? count('rate_limited') : null,
    invalid: pr.items ? count('invalid') : null,
    unknown: pr.items ? count('unknown') : null,
    items: pr.items ? items : null,
  };
}

function keySummary(p) {
  const items = p.providers?.items;
  const counts = Array.isArray(items) ? items.map((x) => x.enabled_keys) : null;
  const allKnown = counts && counts.every((n) => typeof n === 'number');
  return {
    source: 'GET /v1/providers',
    // The enabled-key count per provider is exposed; their individual health is not.
    total: allKnown ? counts.reduce((a, b) => a + b, 0) : null,
    healthy: null,
    healthy_unavailable_reason: KEY_HEALTH_UNAVAILABLE,
    per_key: null,
    by_provider: Array.isArray(items)
      ? items.map((x) => ({ provider: x.id, name: x.name, enabled_keys: x.enabled_keys, provider_status: x.status, resume_at: x.resume_at }))
      : null,
  };
}

function buildData(p) {
  const models = modelSummary(p);
  const modelsByProvider = models ? new Map(models.by_provider.map((r) => [r.provider, r])) : null;
  return {
    gateway: {
      kind: p.kind,
      endpoint: p.endpoint ?? null,
      checked_at: p.checked_at,
    },
    service: p.service ?? null,
    readiness: p.readiness ?? null,
    providers: providerSummary(p, modelsByProvider),
    models,
    keys: p.kind === 'freellmapi' ? keySummary(p) : null,
    // What THIS process saw its own gateway calls do. Labelled, because the
    // worker container and any second replica keep their own.
    traffic: observations.summary(),
  };
}

async function collect() {
  const p = await gateway.probe();
  const verdict = gateway.grade(p);
  const data = buildData(p);

  if (verdict.status === 'unavailable') {
    // Shown with whatever was learned (the endpoint, the kind), so an operator
    // sees WHY the card is grey rather than an empty tile.
    return { ...unavailable(NAME, verdict.reason, Boolean(verdict.expected)), data };
  }
  return result(NAME, { status: verdict.status, reason: verdict.reason, data });
}

module.exports = { NAME, collect, buildData, configuredInCatalog, KEY_HEALTH_UNAVAILABLE };
