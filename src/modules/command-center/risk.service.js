'use strict';

/**
 * Deterministic Platform Risk Engine.
 *
 * This layer converts verified Command Center signals into an explainable
 * 0–100 risk score. It never calls an LLM and never mutates the snapshot or
 * Guardian findings. Missing telemetry is reported explicitly instead of
 * silently becoming a healthy score.
 */

const WEIGHTS = Object.freeze({
  health: 25,
  security: 25,
  revenue: 20,
  subscriptions: 15,
  operations: 10,
  support: 5,
});

const LEVELS = Object.freeze([
  { min: 81, key: 'critical', label: 'CRITICAL' },
  { min: 61, key: 'high', label: 'HIGH' },
  { min: 41, key: 'elevated', label: 'ELEVATED' },
  { min: 21, key: 'watch', label: 'WATCH' },
  { min: 0, key: 'healthy', label: 'HEALTHY' },
]);

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function levelFor(score) {
  return LEVELS.find((level) => score >= level.min) || LEVELS[LEVELS.length - 1];
}

function card(snapshot, name) {
  return snapshot?.cards?.[name] || null;
}

function statusPenalty(value) {
  if (value === 'critical' || value === 'error' || value === 'failed') return 100;
  if (value === 'warning' || value === 'degraded') return 60;
  if (value === 'unknown' || value === 'unavailable') return 35;
  return 0;
}

function cardRisk(c) {
  if (!c) return { score: 0, available: false, reason: 'Telemetry unavailable.' };
  const status = String(c.status || '').toLowerCase();
  if (status === 'ok' || status === 'healthy') return { score: 0, available: true };
  if (status === 'warning' || status === 'degraded') return { score: 60, available: true };
  if (status === 'error' || status === 'failed' || status === 'critical') return { score: 100, available: true };
  return { score: statusPenalty(status), available: status !== '' };
}

function domain(name, weight, score, available, reason, evidence = []) {
  return {
    name,
    weight,
    score: Math.round(clamp(score) * 100) / 100,
    contribution: Math.round((weight * clamp(score) / 100) * 100) / 100,
    available: Boolean(available),
    reason: reason || null,
    evidence,
  };
}

function evaluate(snapshot, guardian) {
  const domains = [];

  const runtime = card(snapshot, 'runtime');
  const database = card(snapshot, 'database');
  const redis = card(snapshot, 'redis');
  const queues = card(snapshot, 'queues');
  const security = card(snapshot, 'security');
  const http = card(snapshot, 'http');
  const ai = card(snapshot, 'ai');

  const healthCards = [runtime, database, redis].filter(Boolean);
  const healthScores = healthCards.map(cardRisk);
  const healthAvailable = healthScores.length > 0;
  const healthScore = healthAvailable
    ? Math.max(...healthScores.map((x) => x.score))
    : 0;
  domains.push(domain(
    'health', WEIGHTS.health, healthScore, healthAvailable,
    healthAvailable ? null : 'Runtime/database/Redis telemetry is unavailable.',
    healthCards.map((c) => ({ source: c.name || 'health', status: c.status || 'unknown' })),
  ));

  const securityRisk = cardRisk(security);
  domains.push(domain(
    'security', WEIGHTS.security, securityRisk.score, securityRisk.available,
    securityRisk.available ? null : 'Security telemetry is unavailable.',
    security ? [{ source: 'security', status: security.status || 'unknown' }] : [],
  ));

  // Revenue/subscription/support business signals are intentionally only scored
  // when their authoritative Command Center card exists. This prevents the
  // risk engine from inventing business risk from unrelated infrastructure
  // telemetry.
  const revenueCard = card(snapshot, 'revenue') || card(snapshot, 'subscriptions');
  const revenueRisk = cardRisk(revenueCard);
  domains.push(domain(
    'revenue', WEIGHTS.revenue, revenueRisk.score, revenueRisk.available,
    revenueRisk.available ? null : 'Revenue telemetry is not part of this snapshot.',
    revenueCard ? [{ source: 'revenue', status: revenueCard.status || 'unknown' }] : [],
  ));

  const subscriptionCard = card(snapshot, 'subscriptions');
  const subscriptionRisk = cardRisk(subscriptionCard);
  domains.push(domain(
    'subscriptions', WEIGHTS.subscriptions, subscriptionRisk.score, subscriptionRisk.available,
    subscriptionRisk.available ? null : 'Subscription telemetry is not part of this snapshot.',
    subscriptionCard ? [{ source: 'subscriptions', status: subscriptionCard.status || 'unknown' }] : [],
  ));

  const operationCards = [queues, http, ai].filter(Boolean).map(cardRisk);
  const operationsAvailable = operationCards.length > 0;
  const operationsScore = operationsAvailable
    ? Math.max(...operationCards.map((x) => x.score))
    : 0;
  domains.push(domain(
    'operations', WEIGHTS.operations, operationsScore, operationsAvailable,
    operationsAvailable ? null : 'Queue/HTTP/AI operational telemetry is unavailable.',
    [queues, http, ai].filter(Boolean).map((c) => ({ source: c.name || 'operations', status: c.status || 'unknown' })),
  ));

  const supportCard = card(snapshot, 'support');
  const supportRisk = cardRisk(supportCard);
  domains.push(domain(
    'support', WEIGHTS.support, supportRisk.score, supportRisk.available,
    supportRisk.available ? null : 'Support telemetry is not part of this snapshot.',
    supportCard ? [{ source: 'support', status: supportCard.status || 'unknown' }] : [],
  ));

  // Guardian findings are corroborating evidence. They can raise the score but
  // cannot manufacture a domain that has no telemetry. Severity is converted
  // deterministically and capped so one finding cannot dominate the platform.
  const findings = Array.isArray(guardian?.findings) ? guardian.findings : [];
  const severityScore = findings.reduce((max, finding) => {
    const base = finding.severity === 'critical' ? 100 : finding.severity === 'warning' ? 60 : 20;
    return Math.max(max, base * Number(finding.confidence || 0.5));
  }, 0);

  if (severityScore > 0 && healthAvailable) {
    const health = domains.find((d) => d.name === 'health');
    health.score = Math.round(Math.max(health.score, severityScore) * 100) / 100;
    health.contribution = Math.round((health.weight * health.score / 100) * 100) / 100;
  }

  const availableWeight = domains.filter((d) => d.available).reduce((sum, d) => sum + d.weight, 0);
  const weighted = domains.reduce((sum, d) => sum + d.contribution, 0);
  const score = availableWeight > 0
    ? Math.round((weighted / availableWeight) * 100 * 100) / 100
    : 0;

  const level = levelFor(score);
  const unknownDomains = domains.filter((d) => !d.available).map((d) => d.name);

  return {
    score,
    level: level.key,
    label: level.label,
    checked_at: new Date().toISOString(),
    confidence: availableWeight / 100,
    domains,
    unknown_domains: unknownDomains,
    findings: findings.map((f) => ({
      id: f.id,
      title: f.title,
      severity: f.severity,
      confidence: f.confidence,
    })),
    methodology: 'Deterministic weighted domain risk with Guardian corroboration. AI is not used to calculate the score.',
  };
}

async function assess({ snapshot, guardian } = {}) {
  return evaluate(snapshot, guardian);
}

module.exports = {
  WEIGHTS,
  LEVELS,
  clamp,
  levelFor,
  evaluate,
  assess,
};
