// src/modules/command-center/tickets.js
//
// Short-lived, single-use tickets that authenticate the Command Center
// WebSocket.
//
// ── Why the socket cannot just use the session cookie ────────────────────────
//
// The session cookie is issued for `myptstudio.com`. The socket has to address
// `api.myptstudio.com` directly, because the frontend container's Next.js
// rewrite — which carries every ordinary /api/* call — is an HTTP proxy and
// does not forward an `Upgrade`. Those are different hosts, so the browser
// sends no cookie on the handshake. There is no header to fall back on either:
// `new WebSocket()` gives JavaScript no way to set `Authorization`.
//
// Three ways out, and why this is the one:
//
//   1. Widen the cookie to `.myptstudio.com`. Rejected. That sends the session
//      to every present and future subdomain, forever, to make one operator
//      console live-update. The blast radius is the whole product; the benefit
//      is one screen.
//   2. Smuggle the JWT through `Sec-WebSocket-Protocol`, which is the one
//      header a browser will set. Rejected: the server must echo the chosen
//      subprotocol back in the response, so the credential ends up in a
//      response header too, and in every proxy log along the way.
//   3. Mint a ticket over the already-authenticated HTTPS channel and spend it
//      in the handshake query string. This.
//
// ── Why single-use and 30 seconds ────────────────────────────────────────────
//
// A query string is the least private place to put a credential: nginx writes
// the full request line to its access log, and so does anything else in the
// path. Single-use plus a 30s window means a ticket recovered from a log is
// already spent and already expired — it authenticates one socket, once, and
// only within half a minute of being asked for.
//
// It is deliberately NOT a JWT. A signed token cannot be un-issued, so a
// stateless ticket is valid for its whole lifetime no matter how many sockets
// present it. Keeping the state is what makes "once" enforceable.
//
// ── Where the state lives ────────────────────────────────────────────────────
//
// It used to be a Map in this module, on the argument that one API container
// serves this deployment and the ticket is redeemed by the process that issued
// it seconds later. That argument was sound and it stops being sound the first
// time a second replica exists: a ticket minted on A and presented to B is
// simply unknown, so the console cannot connect at all behind a load balancer.
// It fails closed, which is the right direction and still a broken console.
//
// The store is now modules/command-center/coordination.js, which keeps tickets
// in Redis when Redis is up and in memory when it is not. Two properties are
// preserved exactly:
//
//   SINGLE-USE. Redis redemption is an atomic get-and-delete in Lua, so two
//   sockets presenting the same ticket cannot both win. The local path deletes
//   before it validates, as it always did.
//
//   NO CROSS-STORE REPLAY. The ticket carries a one-character prefix naming
//   the store that minted it, so a Redis ticket is never redeemed from memory
//   and vice versa. A Redis-minted ticket whose Redis has gone away is refused
//   rather than looked up locally: single-use is a security property, and a
//   ticket whose uniqueness cannot be checked is not a ticket.
//
// The old worry — adding a Redis dependency to the console you open *because*
// Redis might be down — is answered by the fallback rather than by avoidance:
// with Redis unreachable, minting returns a local ticket and the console works
// exactly as it does today.
'use strict';

const coordination = require('./coordination');

/** How long a ticket stays redeemable. Long enough for one page load. */
const TTL_MS = Number(process.env.COMMAND_CENTER_TICKET_TTL_MS) || 30_000;

/**
 * A ceiling on outstanding LOCAL tickets.
 *
 * Only meaningful for the in-memory fallback: the Redis path expires its own
 * keys and needs no sweeping. This is not defence against an attacker — the
 * issuing route is behind the full platform guard — it is defence against a
 * reconnect loop minting a ticket a second for a week.
 */
const MAX_OUTSTANDING = coordination.MAX_LOCAL_TICKETS;

/**
 * Mint a ticket for an operator who has already passed the full
 * auth -> requireSuperAdmin -> requireSuperAdminMfa -> requirePlatformOwner
 * chain.
 *
 * @param {{ id: string|number, email?: string }} user
 * @returns {Promise<{ ticket: string, expires_in_ms: number }>}
 */
async function issue(user) {
  const ticket = await coordination.putTicket(
    { userId: user.id, email: user.email, issuedAt: Date.now() },
    TTL_MS,
  );
  return { ticket, expires_in_ms: TTL_MS };
}

/**
 * Spend a ticket.
 *
 * @returns {Promise<{ userId: string|number, email?: string } | null>} null when
 *   the ticket is unknown, already spent, past its window, or minted into a
 *   store this process cannot reach.
 */
async function redeem(ticket) {
  const rec = await coordination.takeTicket(ticket);
  if (!rec) return null;
  // The window is enforced by the store (PX on Redis, expiresAt locally). This
  // is the belt: a clock skew or a future change to the store must not be able
  // to hand back a credential minted an hour ago.
  if (typeof rec.issuedAt === 'number' && Date.now() - rec.issuedAt > TTL_MS) return null;
  return { userId: rec.userId, email: rec.email };
}

/** Test/diagnostic only: outstanding tickets in the in-memory fallback. */
function _size() { return coordination.localTicketCount(); }
function _clear() { coordination._reset(); }

module.exports = { issue, redeem, TTL_MS, MAX_OUTSTANDING, _size, _clear };
