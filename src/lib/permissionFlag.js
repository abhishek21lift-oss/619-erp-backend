'use strict';
/**
 * How hard the role-permission matrix is enforced.
 *
 * Three states, because two are not enough for a control that is being switched
 * on for the first time against studios already using the product:
 *
 *   'on'      (default) refuse the request. What the toggles have always
 *             claimed to do.
 *   'report'  allow the request, log what WOULD have been refused. The rollout
 *             mode: an owner can see which of their staff would lose which
 *             screen before anybody actually does.
 *   'off'     the gate does nothing.
 *
 * ── Why the default is 'on' and not 'report' ────────────────────────────────
 *
 * Because the alternative is shipping the fix without the fix. The matrix is a
 * security control that a studio owner has already configured believing it
 * worked; leaving it inert by default preserves exactly the state this change
 * exists to end. Every other security control in this codebase defaults on and
 * is disabled by an explicit string — TENANT_RLS_ENFORCE, PLATFORM_SESSION_ENFORCE,
 * SUPER_ADMIN_REQUIRE_MFA — and this follows them.
 *
 * It will change behaviour on the deploy that carries it. With the shipped
 * defaults a trainer loses /api/expenses, /api/invoices and /api/reports, and a
 * receptionist loses /api/pt-os — which is what perm_trainer_finance:false and
 * perm_reception_pt_module:false have said all along. Denials are logged with
 * the role, feature and path so the first support call is answerable, and
 * PERMISSION_ENFORCE=report turns the whole thing into observation for a
 * release if a studio needs the runway.
 *
 * ── Why the parse is strict ─────────────────────────────────────────────────
 *
 * Unset means 'on'. Anything set but unrecognised ALSO means 'on', rather than
 * being coerced to off by a truthiness check: a typo in a deployment variable
 * must not silently disable an authorisation gate. lib/tenantRlsFlag.js exists
 * because three copies of one such expression disagreed; this is one copy, read
 * at call time so tests can set the variable and observe the result.
 */
const MODES = ['on', 'off', 'report'];

function permissionMode(env = process.env) {
  const raw = env.PERMISSION_ENFORCE;
  if (raw === undefined || raw === '') return 'on';
  return MODES.includes(raw) ? raw : 'on';
}

/** True when an unrecognised value was supplied — server.js warns about it. */
function permissionModeIsValid(env = process.env) {
  const raw = env.PERMISSION_ENFORCE;
  return raw === undefined || raw === '' || MODES.includes(raw);
}

module.exports = { permissionMode, permissionModeIsValid, PERMISSION_MODES: MODES };
