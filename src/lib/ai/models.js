'use strict';
// AI model registry. No hardcoded model names anywhere in the application.
//
// Each tier resolves in one order, most specific first:
//   1. an operator override set in the Control Centre (lib/ai/settings.js)
//   2. the environment variable
//   3. the built-in default
//
// Step 1 is new and is additive: the override cache starts empty and stays
// empty if the database is unreachable, so with no override set — which is
// every deploy's starting state — this resolves exactly as it always did.
// Nothing about steps 2 and 3 changed.

const settings = require('./settings');

// These IDs must exist in the live OpenRouter catalogue. The previous
// defaults (`openai/gpt-oss-120b:free`, `poolside/laguna-m.1:free`) were
// retired and returned "No endpoints found", so every request that reached
// them failed — including all business/report intents, which start on the
// fallback tier. `openrouter/auto` is the last-resort router: it is always
// available and never depends on one vendor keeping a free SKU alive.
const DEFAULTS = {
  primary:   'nvidia/nemotron-3-ultra-550b-a55b:free',
  secondary: 'openai/gpt-oss-120b',
  fallback:  'openrouter/auto',
};

const models = {
  get primary()   { return settings.override('primary')   || process.env.AI_PRIMARY_MODEL   || DEFAULTS.primary; },
  get secondary() { return settings.override('secondary') || process.env.AI_SECONDARY_MODEL || DEFAULTS.secondary; },
  get fallback()  { return settings.override('fallback')  || process.env.AI_FALLBACK_MODEL  || DEFAULTS.fallback; },
};

// Intent → tier routing table.
//
// Every intent a caller actually passes belongs here, spelled out. An intent
// that is missing does not fail — `resolveModel` falls through to `primary` —
// which is the right default but a terrible way to find out that a feature was
// never routed on purpose.
const INTENT_ROUTES = {
  // Fitness — the strongest configured model.
  chat:          'primary',
  workout:       'primary',
  diet:          'primary',
  nutrition:     'primary',
  fitness:       'primary',
  fitness_testing: 'primary',
  assessment:    'primary',
  progress:      'primary',
  coaching:      'primary',
  exercise:      'primary',
  meal:          'primary',
  goal:          'primary',
  recovery:      'primary',
  coach:         'primary',

  // Client Assistant intents (lib/ai/agent/planner.js).
  //
  // `summary` used to be filed under business reporting, which is the
  // fallback tier — openrouter/auto. analysis and lookup were never listed at
  // all, so they fell through to primary. The result: "summarise this client"
  // and "brief me" — the widest, most-read answers the assistant gives — were
  // the only ones served by a different model each time, while every narrow
  // lookup beside them got the fixed one. Same panel, same question, no way
  // to reproduce a bad answer.
  summary:       'primary',
  analysis:      'primary',
  lookup:        'primary',

  // Data lookups and operational work — the stable model.
  attendance:    'secondary',
  checkin:       'secondary',
  absent:        'secondary',
  client:        'secondary',
  member:        'secondary',
  trainer:       'secondary',
  session:       'secondary',
  booking:       'secondary',
  pt:            'secondary',
  renew:         'secondary',
  whatsapp:      'secondary',
  notify:        'secondary',
  communication: 'secondary',
  ops:           'primary',

  // Money. These were on the fallback tier — openrouter/auto — so a question
  // about dues, an invoice or a subscription was answered by whichever model
  // the router felt like that minute, and the weakest tier at that. A studio
  // acts on those numbers. They get the same fixed model as any other lookup.
  finance:       'secondary',
  payment:       'secondary',
  invoice:       'secondary',
  dues:          'secondary',
  subscription:  'secondary',

  // Business reporting — the fallback tier, deliberately.
  //
  // openrouter/auto cannot be retired out from under us the way the previous
  // free SKUs were, which took every one of these features down at once. The
  // price is a model that varies per request; that is a trade this tier makes
  // on availability, not an oversight.
  business:      'fallback',
  insights:      'fallback',
  report:        'fallback',
  analytics:     'fallback',
  retention:     'fallback',
  revenue:       'fallback',
  trend:         'fallback',
};

function resolveModel(intent) {
  const tier = INTENT_ROUTES[intent] || 'primary';
  return { model: models[tier], tier, intent };
}

function getFallbackModel(currentTier) {
  if (currentTier === 'primary' || currentTier === 'secondary') {
    return { model: models.fallback, tier: 'fallback' };
  }
  return null;
}

/**
 * Deterministic fallback order for a tier:
 *   primary   → [secondary, fallback]
 *   secondary → [fallback]
 *   fallback  → [primary, secondary]
 *
 * The fallback tier used to return an empty chain, which made it a dead end:
 * business/report intents START on fallback, so one retired or rate-limited
 * model took the whole feature down with no retry at all. A tier is a starting
 * point, not a guarantee that one vendor's SKU still exists.
 *
 * Duplicate model IDs are dropped, so a chain never calls the same model
 * twice. The production config can legitimately set
 * AI_PRIMARY_MODEL == AI_SECONDARY_MODEL; that configuration must not double
 * the latency of every failure by asking the identical model again — it just
 * shortens the chain to primary → fallback. Nothing here renames or replaces
 * a configured model; the variables are read as-is, only the ORDER of calls
 * is decided.
 */
function getFallbackChain(currentTier, attemptedModel) {
  const raw = [];
  if (currentTier === 'primary') {
    raw.push({ model: models.secondary, tier: 'secondary' });
  }
  if (currentTier === 'primary' || currentTier === 'secondary') {
    raw.push({ model: models.fallback, tier: 'fallback' });
  }
  if (currentTier === 'fallback') {
    raw.push({ model: models.primary, tier: 'primary' });
    raw.push({ model: models.secondary, tier: 'secondary' });
  }

  const seen = new Set(attemptedModel ? [attemptedModel] : []);
  const chain = [];
  for (const step of raw) {
    if (!step.model || seen.has(step.model)) continue;
    seen.add(step.model);
    chain.push(step);
  }
  return chain;
}

module.exports = { models, resolveModel, getFallbackModel, getFallbackChain, INTENT_ROUTES, DEFAULTS };
