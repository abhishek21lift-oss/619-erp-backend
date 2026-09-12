'use strict';
/**
 * Canonical Insights Engine — deterministic interpretation over Metric Engine output.
 *
 * Pipeline: Canonical Data → Metric Engine → Insights Engine → AI → Action.
 *
 * This layer is deliberately LLM-free: same metrics in → same insights out, so
 * Business / Trainer / Client insights are testable, auditable and stable.
 * The AI layer (routes/ai.js) may add narrative on top but must not recompute
 * numbers — it receives `insights` alongside `raw_data` and quotes them.
 *
 * Urgency ordering mirrors the product rule: critical before warning before
 * info; within a band, larger cohort first — except expiry beats money beats
 * birthdays by band design, not by count.
 */

function money(n) {
  const v = Number(n) || 0;
  if (v >= 1e7) return `₹${(v / 1e7).toFixed(1)}Cr`;
  if (v >= 1e5) return `₹${(v / 1e5).toFixed(1)}L`;
  if (v >= 1e3) return `₹${Math.round(v / 1e3)}K`;
  return `₹${Math.round(v)}`;
}

const RANK = { critical: 0, warning: 1, info: 2 };
function sortInsights(list) {
  return list.sort((a, b) => RANK[a.urgency] - RANK[b.urgency] || b.count - a.count);
}

/**
 * Business-level insights: revenue, dues, attendance, renewal, utilisation.
 * Input is metric-engine.getOverview() output (or any subset with same shape).
 */
function buildBusinessInsights(overview) {
  const out = [];
  if (!overview) return out;
  const { revenue, dues, attendance, renewals, utilisation } = overview;

  if (renewals) {
    if (renewals.renewal_rate === null) {
      out.push({
        id: 'renewal-no-cohort', urgency: 'info', count: 0,
        title: 'No expiries in window',
        detail: 'No packages ended in this period, so renewal conversion is undefined — not 0%.',
        href: '/insights/renewal',
      });
    } else if (renewals.renewal_rate < 40) {
      out.push({
        id: 'renewal-low', urgency: 'critical', count: renewals.expired_cohort,
        title: `Renewal conversion ${renewals.renewal_rate}% — needs attention`,
        detail: `${renewals.renewed_of_cohort} of ${renewals.expired_cohort} expired packages renewed in window.`,
        href: '/insights/renewal',
        action: { label: 'View renewal pipeline', href: '/insights/renewal' },
      });
    }
    if (renewals.expiring_7d > 0) {
      out.push({
        id: 'expiring-7d', urgency: 'critical', count: renewals.expiring_7d,
        title: `${renewals.expiring_7d} packages expiring this week`,
        detail: 'Proactive outreach this week is the cheapest revenue this studio can book.',
        href: '/insights/renewal',
        action: { label: 'Message expiring clients', href: '/insights/renewal' },
      });
    }
  }

  if (dues && dues.total_outstanding > 0) {
    out.push({
      id: dues.high_risk_count > 0 ? 'dues-high' : 'dues',
      urgency: dues.high_risk_count > 0 ? 'critical' : 'warning',
      count: dues.debtor_count,
      title: `${money(dues.total_outstanding)} outstanding across ${dues.debtor_count} clients`,
      detail: dues.high_risk_count > 0 ? `${dues.high_risk_count} high-value balances need a call, not a message.` : 'Follow-up list is ready on the dues page.',
      href: '/finance/dues',
      action: { label: 'Open dues list', href: '/finance/dues' },
    });
  }

  if (attendance && attendance.totals) {
    const r = attendance.totals.attendance_rate;
    if (r !== null && r !== undefined && r < 60) {
      out.push({
        id: 'attendance-low', urgency: 'warning', count: attendance.totals.total,
        title: `Attendance rate ${r}% in window`,
        detail: `${attendance.totals.visits} visits across ${attendance.totals.total} register rows. Re-engage absentees before they lapse.`,
        href: '/insights/traffic',
      });
    }
  }

  if (utilisation && utilisation.utilisation_pct !== null && utilisation.utilisation_pct < 50) {
    out.push({
      id: 'utilisation-low', urgency: 'warning', count: utilisation.this_month_total,
      title: `Session completion ${utilisation.utilisation_pct}% this month`,
      detail: `${utilisation.this_month_completed} of ${utilisation.this_month_total} started sessions finished.`,
      href: '/insights/sessions',
    });
  }

  if (revenue && revenue.total === 0) {
    out.push({
      id: 'revenue-zero', urgency: 'warning', count: 0,
      title: 'No collections in window',
      detail: 'No payments recorded for this date range. Check the range or the collection flow.',
      href: '/insights/revenue',
    });
  }

  return sortInsights(out);
}

/**
 * Trainer-level insights from canonical trainer summary + ops rows.
 * Keeps the client-side coach-insights.ts ordering contract (critical first).
 */
function buildTrainerInsights({ trainers = [], renewals = [], dues = [] } = {}) {
  const out = [];
  const idle = trainers.filter((t) => Number(t.active_clients || 0) === 0);
  if (idle.length > 0) {
    out.push({
      id: 'trainer-idle', urgency: 'warning', count: idle.length,
      title: `${idle.length} trainers with no active clients`,
      detail: idle.slice(0, 5).map((t) => t.name).join(', '),
      href: '/reports',
    });
  }
  const lapsed = renewals.filter((r) => Number(r.days_left) < 0);
  if (lapsed.length > 0) {
    out.push({
      id: 'trainer-lapsed', urgency: 'critical', count: lapsed.length,
      title: `${lapsed.length} packages lapsed`,
      detail: 'Win-back costs less than acquisition.',
      href: '/pt-os/clients',
    });
  }
  const overdue = dues.filter((d) => d.due_status === 'overdue');
  if (overdue.length > 0) {
    const total = overdue.reduce((s, d) => s + Number(d.balance_amount || 0), 0);
    out.push({
      id: 'trainer-overdue', urgency: 'critical', count: overdue.length,
      title: `${money(total)} overdue`,
      detail: `${overdue.length} clients past the due date.`,
      href: '/pt-os/balance-sheet',
    });
  }
  return sortInsights(out);
}

/** Client-level insights: thin wrapper so all three tiers share one engine. */
function buildClientInsights({ snapshot = null } = {}) {
  if (!snapshot || !snapshot.alerts) return [];
  return snapshot.alerts.map((a) => ({
    id: a.id || a.type || 'client-alert',
    urgency: a.severity || a.urgency || 'info',
    count: 1,
    title: a.title || 'Client needs attention',
    detail: a.detail || a.message || '',
    href: a.href || '/pt-os/clients',
  }));
}

module.exports = { buildBusinessInsights, buildTrainerInsights, buildClientInsights, sortInsights };
