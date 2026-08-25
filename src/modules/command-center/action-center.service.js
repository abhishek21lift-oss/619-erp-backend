'use strict';

/**
 * Read-only operator action queue.
 *
 * This service never executes commands. It translates already-verified Guardian
 * findings and live alerts into a single deterministic queue so the operator
 * can see what needs attention without opening multiple screens.
 */

function priorityFor(item) {
  if (item.severity === 'critical') return 0;
  if (item.severity === 'warning') return 1;
  return 2;
}

function fromFinding(finding) {
  return {
    id: `finding:${finding.id}`,
    source: 'guardian',
    severity: finding.severity,
    title: finding.title,
    description: finding.conclusion || finding.advice || 'Verified platform finding.',
    evidence: finding.evidence || null,
    recommended_commands: finding.recommend || [],
    recovery_available: Boolean(finding.recovery),
    confidence: finding.confidence ?? null,
    status: 'open',
  };
}

function fromAlert(alert) {
  return {
    id: `alert:${alert.id}`,
    source: 'alert',
    severity: alert.severity || 'warning',
    title: alert.title || alert.name || 'Platform alert',
    description: alert.message || alert.reason || 'Active platform alert.',
    evidence: alert.evidence || null,
    recommended_commands: [],
    recovery_available: false,
    confidence: null,
    status: alert.acknowledged_at ? 'acknowledged' : 'open',
  };
}

function build({ findings = [], alerts = [] } = {}) {
  const items = [
    ...findings.map(fromFinding),
    ...alerts.map(fromAlert),
  ];
  items.sort((a, b) => priorityFor(a) - priorityFor(b));
  return {
    checked_at: new Date().toISOString(),
    counts: {
      critical: items.filter((i) => i.severity === 'critical').length,
      warning: items.filter((i) => i.severity === 'warning').length,
      info: items.filter((i) => i.severity === 'info').length,
      total: items.length,
    },
    items,
  };
}

module.exports = { build };
