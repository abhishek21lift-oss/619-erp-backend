'use strict';
// AI model registry — reads all model IDs from environment variables.
// No hardcoded model names anywhere in the application.

const models = {
  get primary()   { return process.env.AI_PRIMARY_MODEL   || 'openai/gpt-oss-120b:free'; },
  get secondary() { return process.env.AI_SECONDARY_MODEL || 'poolside/laguna-m.1:free'; },
  get fallback()  { return process.env.AI_FALLBACK_MODEL  || 'nvidia/nemotron-3-ultra-550b-a55b:free'; },
};

// Intent → tier routing table
const INTENT_ROUTES = {
  // Fitness — primary model (gpt-oss-120b)
  chat:         'primary',
  workout:      'primary',
  diet:         'primary',
  nutrition:    'primary',
  fitness:      'primary',
  assessment:   'primary',
  progress:     'primary',
  coaching:     'primary',
  exercise:     'primary',
  meal:         'primary',
  goal:         'primary',
  recovery:     'primary',

  // Development — secondary model (poolside/laguna-m1)
  code:         'secondary',
  debug:        'secondary',
  sql:          'secondary',
  audit:        'secondary',
  technical:    'secondary',
  architecture: 'secondary',
  refactor:     'secondary',
  database:     'secondary',

  // Business reporting — fallback model (nvidia/nemotron-3-ultra)
  business:     'fallback',
  insights:     'fallback',
  report:       'fallback',
  analytics:    'fallback',
  summary:      'fallback',

  // Agent domain intents — mapped to appropriate model tiers
  attendance:   'secondary',
  checkin:      'secondary',
  absent:       'secondary',
  client:       'secondary',
  member:       'secondary',
  trainer:      'secondary',
  session:      'secondary',
  booking:      'secondary',
  pt:           'secondary',
  finance:      'fallback',
  payment:      'fallback',
  invoice:      'fallback',
  dues:         'fallback',
  subscription: 'fallback',
  renew:        'secondary',
  whatsapp:     'secondary',
  notify:       'secondary',
  communication:'secondary',
  coach:        'primary',
  retention:    'fallback',
  revenue:      'fallback',
  trend:        'fallback',
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

module.exports = { models, resolveModel, getFallbackModel, INTENT_ROUTES };
