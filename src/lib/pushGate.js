// src/lib/pushGate.js
// Server-side activation gate for push notifications.
//
// Push is off unless an operator says otherwise in the deployment environment.
// A client, a broadcast request or a template edit cannot turn it on. Two
// variables, read on every check, so a process started with the wrong value is
// corrected by a restart rather than by a request:
//
//   PUSH_ENABLED=true          the master switch; anything else is off
//   PUSH_ALLOWED_ORGS=a,b,c    optional tenant allowlist for staged activation
//
// An empty allowlist means every tenant once the master switch is on. A
// non-empty allowlist means only those organizations receive push while the
// rest keep using the inbox and the other channels. Unknown or missing
// organization ids fail closed.

function isEnabled() {
  return String(process.env.PUSH_ENABLED || '').trim().toLowerCase() === 'true';
}

function allowedOrganizations() {
  return String(process.env.PUSH_ALLOWED_ORGS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

/** Is push active for this tenant? No org, or an org outside the allowlist, is false. */
function isEnabledFor(organizationId) {
  if (!isEnabled()) return false;
  const allow = allowedOrganizations();
  if (!allow.length) return true;
  return organizationId != null && allow.includes(String(organizationId));
}

module.exports = { isEnabled, allowedOrganizations, isEnabledFor };
