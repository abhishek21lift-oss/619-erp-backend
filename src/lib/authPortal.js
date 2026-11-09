'use strict';
// Which door an account may use. One copy, so the password, Google and any
// future password-equivalent route cannot disagree about it.
//
// The rule is enforced server-side after the credential is proven: the pages
// merely LOOKING separate is not separation, because the same POST works from
// either page or from curl.

const { ALL_ROLES, TENANT_ROLES } = require('../middleware/rbac');
const platformAuth = require('../middleware/platformAuth');

/**
 * The portal a session belongs to.
 *
 * The audience is the plane (platform vs studio), and the role splits the two
 * tenant doors. Legacy tokens with no audience are placed by role, which is
 * exactly how they behaved before audiences existed.
 */
function portalForSession(user, aud) {
  if (aud === platformAuth.AUD_PLATFORM) return 'platform';
  return user && user.role === 'member' ? 'member' : 'trainer';
}

/**
 * May this session drive this portal?
 *
 * Checked for cookie sessions after the token verifies and the user row loads,
 * so a token copied from one portal's cookie into another's is refused. It is
 * not the authorization gate — role guards still run — it stops the cookie
 * namespace from being a way around the door the token was minted at.
 */
function portalMatchesSession(portal, user, aud) {
  if (!user) return false;
  if (portal === 'platform') return user.role === 'super_admin' && aud !== platformAuth.AUD_TENANT;
  if (portal === 'member') return user.role === 'member' && aud !== platformAuth.AUD_PLATFORM;
  if (portal === 'trainer') return user.role !== 'member' && aud !== platformAuth.AUD_PLATFORM;
  return false;
}

function normalisePortal(raw) {
  if (raw === 'unified') return 'unified';
  if (raw === 'member') return 'member';
  if (raw === 'platform') return 'platform';
  return 'trainer';
}

/**
 * The cookie namespace a verified account's session belongs to.
 *
 * 'unified' is a request selector, never a session: the database row picks the
 * existing trainer or member door, and the platform door stays separate.
 */
function resolveLoginPortal(user, portal) {
  if (portal !== 'unified') return portal;
  // portalProblem() has already refused super_admin before this runs.
  return portalForSession(user, null);
}

/**
 * @returns null when the account may use this door, otherwise the exact
 * response the route should send. `portal` is present only for WRONG_PORTAL.
 */
function portalProblem(user, portal) {
  const isMemberAccount = user.role === 'member';
  const isPlatformAccount = user.role === 'super_admin';

  // An account that holds none of the three roles — or a studio role with no
  // studio — gets no session at all. The database constraints (migration 208)
  // make such a row impossible; this keeps a session from ever being minted
  // for one that slipped through, rather than relying on every guard
  // downstream to notice.
  if (!ALL_ROLES.includes(user.role)
      || (TENANT_ROLES.includes(user.role) && !user.organization_id)) {
    return {
      status: 403,
      code: 'ACCOUNT_MISCONFIGURED',
      message: 'This account cannot sign in. Contact support.',
    };
  }

  if (portal === 'unified' && isPlatformAccount) {
    return {
      status: 403,
      code: 'WRONG_PORTAL',
      portal: 'platform',
      message: 'This is the studio sign-in. Use the Command Center to sign in as the platform operator.',
    };
  }

  if (portal === 'platform' && !isPlatformAccount) {
    return {
      status: 403,
      code: 'WRONG_PORTAL',
      portal: isMemberAccount ? 'member' : 'trainer',
      message: 'This is the Command Center sign-in. Use your studio login.',
    };
  }

  // A platform operator at the studio door.
  //
  // Refused only once PLATFORM_SESSION_ENFORCE is on, and the flag is what
  // makes this shippable: today the operator signs in at /login like anyone
  // else, and turning that into a 403 on deploy would lock them out of the
  // console with an error they cannot clear. Until the flag flips they get a
  // tenant-audience session here, which already cannot reach the control
  // plane — so the boundary is real before the refusal is.
  if (portal === 'trainer' && isPlatformAccount && platformAuth.sessionEnforced()) {
    return {
      status: 403,
      code: 'WRONG_PORTAL',
      portal: 'platform',
      message: 'This is the studio sign-in. Use the Command Center to sign in as the platform operator.',
    };
  }

  if (portal === 'member' && !isMemberAccount) {
    return {
      status: 403,
      code: 'WRONG_PORTAL',
      portal: 'trainer',
      message: 'This is the member sign-in. Use Trainer Login for your studio account.',
    };
  }

  if (portal === 'trainer' && isMemberAccount) {
    return {
      status: 403,
      code: 'WRONG_PORTAL',
      portal: 'member',
      message: 'This is the studio sign-in. Use Member Login for your client account.',
    };
  }

  return null;
}

module.exports = { normalisePortal, portalProblem, portalForSession, portalMatchesSession, resolveLoginPortal };
