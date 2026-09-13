// src/modules/command-center/coordination.js
//
// The three pieces of Command Center state that must hold across processes,
// and one place that knows how to keep them there.
//
// ── What was wrong ─────────────────────────────────────────────────────────
//
// Three guarantees were enforced by a `new Map()` in module scope:
//
//   cooldowns  commands.service.js — "this command cannot run again for 30s".
//              A second API container has its own Map, so a double-click that
//              lands on two instances runs `queue.clearFailed` twice. The
//              cooldown on the destructive rungs is the last guard after the
//              typed confirmation, and it was the one that did not survive a
//              second replica.
//
//   tickets    tickets.js — "this WebSocket credential is single-use". Minted
//              on instance A, presented to instance B: B has never heard of it
//              and refuses, so the console cannot connect at all behind a load
//              balancer. Fails closed, but fails.
//
//   streaks    alerts.service.js — "the condition must persist for two
//              observations before it opens, and clear for three before it
//              closes". Per-instance counters mean the damping window silently
//              multiplies by the number of instances, and — the real bug —
//              `streaks.delete(fingerprint)` after a manual resolve only
//              clears one instance's memory, so another can re-open the alert
//              on its very next tick.
//
// ── Why one module and not three ───────────────────────────────────────────
//
// Three ad-hoc Redis calls in three files IS the duplication the brief
// forbids, and they would each get the fallback behaviour subtly different.
// This is a thin adapter over lib/redis.js — the client, the connection and
// the configuration are all still that module's. Nothing here is a second
// Redis integration.
//
// ── Degradation is a decision, not an accident ─────────────────────────────
//
// Redis holds BullMQ on this deployment and is `noeviction`, so these keys are
// small, TTL'd and namespaced away from anything BullMQ owns. When Redis is
// absent or unreachable, each primitive falls back to the in-process behaviour
// that exists today. That is a deliberate choice per primitive:
//
//   cooldowns  fall back to local. An operator must be able to resume a queue
//              during a Redis outage; refusing the recovery button because the
//              thing being recovered is down is the wrong failure.
//   tickets    fail closed for a ticket minted in Redis, because single-use is
//              a security property. The ticket carries a prefix naming its
//              store, so a Redis-minted ticket is never redeemed from memory
//              and vice versa — the operator sees one reconnect, and the next
//              mint uses whichever store is working.
//   streaks    fall back to local. Damping is a noise control; losing it
//              costs an early alert, never a missed one.
'use strict';

const crypto = require('crypto');
const redis = require('../../lib/redis');
const logger = require('../../lib/logger');

/** Namespace. Keeps these clear of every BullMQ key on the same instance. */
const NS = 'cc';

/** Ticket prefixes: which store minted this credential. */
const TICKET_REDIS = 'r';
const TICKET_LOCAL = 'l';

// ── In-process fallbacks ────────────────────────────────────────────────────

const localCooldowns = new Map();   // key -> expiresAtMs
const localTickets = new Map();     // id  -> { value, expiresAt }
const localStreaks = new Map();     // fp  -> { bad, good }

/**
 * Ceiling on the in-memory ticket fallback.
 *
 * Not defence against an attacker — the issuing route is behind the full
 * platform guard — but against a reconnect loop minting one a second for a
 * week on a box with no Redis.
 */
const MAX_LOCAL_TICKETS = 100;

function sweepLocal(now = Date.now()) {
  for (const [k, exp] of localCooldowns) if (exp <= now) localCooldowns.delete(k);
  for (const [k, rec] of localTickets) if (rec.expiresAt <= now) localTickets.delete(k);
}

/** True when Redis is configured AND the shared client is actually connected. */
function distributed() {
  return redis.isConfigured() && redis.isReady();
}

/**
 * The FAIL-FAST client, deliberately, not the shared one.
 *
 * Every primitive below is on a request path and every one of them is written
 * to fall back when Redis errors. The shared client is configured for BullMQ —
 * offline queue on, retries uncapped — so during an outage a command is queued
 * rather than rejected and the fallback never runs; the request simply hangs.
 * See lib/redis.js getFailFastClient().
 */
function client() { return redis.getFailFastClient(); }

// ── Cooldowns ───────────────────────────────────────────────────────────────

/**
 * Claim the right to run `name` now, reserving it for `ttlMs`.
 *
 * SET key 1 PX ttl NX is the whole mechanism: Redis decides, once, for every
 * instance. Returns the remaining wait when somebody already holds it, so the
 * caller can tell the operator how long rather than just "no".
 *
 * @returns {Promise<{ ok: boolean, retry_in_ms: number, scope: 'shared'|'local' }>}
 */
async function claimCooldown(name, ttlMs) {
  if (!ttlMs) return { ok: true, retry_in_ms: 0, scope: distributed() ? 'shared' : 'local' };
  const key = `${NS}:cooldown:${name}`;

  if (distributed()) {
    try {
      const won = await client().set(key, '1', 'PX', ttlMs, 'NX');
      if (won) return { ok: true, retry_in_ms: 0, scope: 'shared' };
      const ttl = await client().pttl(key);
      return { ok: false, retry_in_ms: ttl > 0 ? ttl : ttlMs, scope: 'shared' };
    } catch (err) {
      // Fall through to local rather than refusing. See the header: an operator
      // must still be able to act while Redis is the thing that is broken.
      logger.warn({ err: err.message, command: name }, 'command cooldown fell back to process-local');
    }
  }

  const now = Date.now();
  sweepLocal(now);
  const until = localCooldowns.get(name) ?? 0;
  if (until > now) return { ok: false, retry_in_ms: until - now, scope: 'local' };
  localCooldowns.set(name, now + ttlMs);
  return { ok: true, retry_in_ms: 0, scope: 'local' };
}

// ── Tickets ─────────────────────────────────────────────────────────────────

/**
 * Atomic get-and-delete.
 *
 * A Lua script rather than GETDEL so this works on any Redis from 2.6 — the
 * deployment's version is not this module's to assume, and single-use is the
 * one property that must not quietly stop holding on an older server.
 */
const TAKE_LUA = "local v = redis.call('GET', KEYS[1]); if v then redis.call('DEL', KEYS[1]) end; return v";

/**
 * Mint a single-use credential.
 *
 * The returned id carries a one-character prefix naming the store that holds
 * it, so redemption never has to guess and a ticket can never be spent once in
 * each store.
 *
 * @returns {Promise<string>} the ticket id
 */
async function putTicket(value, ttlMs) {
  // 256 bits. base64url so it survives a query string with no escaping.
  const secret = crypto.randomBytes(32).toString('base64url');
  const payload = JSON.stringify(value);

  if (distributed()) {
    try {
      await client().set(`${NS}:ticket:${secret}`, payload, 'PX', ttlMs);
      return `${TICKET_REDIS}.${secret}`;
    } catch (err) {
      logger.warn({ err: err.message }, 'stream ticket fell back to process-local');
    }
  }

  sweepLocal();
  // A ceiling on the in-memory fallback. Map preserves insertion order, so the
  // first key is the oldest — and the oldest unspent ticket is the one closest
  // to expiring anyway. The Redis path needs none of this: PX does it.
  while (localTickets.size >= MAX_LOCAL_TICKETS) {
    localTickets.delete(localTickets.keys().next().value);
  }
  localTickets.set(secret, { value: payload, expiresAt: Date.now() + ttlMs });
  return `${TICKET_LOCAL}.${secret}`;
}

/**
 * Spend a ticket. Null for unknown, already spent, expired, or malformed.
 *
 * Deliberately indistinguishable between those cases to the caller: all four
 * mean the same thing to a client that should simply ask for a new one.
 */
async function takeTicket(ticket) {
  if (typeof ticket !== 'string') return null;
  const dot = ticket.indexOf('.');
  if (dot !== 1) return null;
  const store = ticket.slice(0, 1);
  const secret = ticket.slice(2);
  if (!secret) return null;

  if (store === TICKET_REDIS) {
    // Never falls back to the local map. A Redis-minted ticket that cannot be
    // checked against Redis is a ticket whose single-use cannot be enforced,
    // and the honest answer to that is "no".
    if (!distributed()) return null;
    try {
      const raw = await client().eval(TAKE_LUA, 1, `${NS}:ticket:${secret}`);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      logger.warn({ err: err.message }, 'stream ticket redemption failed');
      return null;
    }
  }

  if (store !== TICKET_LOCAL) return null;
  const rec = localTickets.get(secret);
  if (!rec) return null;
  // Deleted on the way out whether or not it had expired, so a replay of an
  // expired ticket cannot leave a live one behind it.
  localTickets.delete(secret);
  if (rec.expiresAt <= Date.now()) return null;
  return JSON.parse(rec.value);
}

// ── Damping streaks ─────────────────────────────────────────────────────────

/**
 * Increment one counter and zero the other, indivisibly.
 *
 * Both fields have to move together: a process that bumped `bad` and then died
 * before zeroing `good` would leave a fingerprint that is simultaneously two
 * observations from opening and one from closing.
 */
const STREAK_LUA = `
local up, down = ARGV[1], ARGV[2]
redis.call('HSET', KEYS[1], down, 0)
local n = redis.call('HINCRBY', KEYS[1], up, 1)
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return n`;

/**
 * Record one observation for a fingerprint.
 *
 * @param {string} fingerprint
 * @param {'bad'|'good'} which
 * @param {number} ttlMs  how long a silent fingerprint keeps its counters
 * @returns {Promise<number>} the new count for `which`
 */
async function bumpStreak(fingerprint, which, ttlMs) {
  const other = which === 'bad' ? 'good' : 'bad';

  if (distributed()) {
    try {
      const n = await client().eval(
        STREAK_LUA, 1, `${NS}:streak:${fingerprint}`, which, other, String(ttlMs),
      );
      return Number(n);
    } catch (err) {
      logger.warn({ err: err.message, fingerprint }, 'alert streak fell back to process-local');
    }
  }

  let s = localStreaks.get(fingerprint);
  if (!s) { s = { bad: 0, good: 0 }; localStreaks.set(fingerprint, s); }
  s[other] = 0;
  s[which] += 1;
  return s[which];
}

/**
 * Forget a fingerprint's counters — after a manual resolve.
 *
 * This is the call that was broken worst by process-local state: clearing one
 * instance's memory while another still holds `bad: 2` means the alert an
 * operator just closed by hand re-opens on that instance's next tick.
 */
async function clearStreak(fingerprint) {
  if (distributed()) {
    try {
      await client().del(`${NS}:streak:${fingerprint}`);
    } catch (err) {
      logger.warn({ err: err.message, fingerprint }, 'alert streak clear failed');
    }
  }
  localStreaks.delete(fingerprint);
}

/** Diagnostics and tests: how many tickets the fallback is holding. */
function localTicketCount() { sweepLocal(); return localTickets.size; }

/** Tests only. */
function _reset() {
  localCooldowns.clear();
  localTickets.clear();
  localStreaks.clear();
}

module.exports = {
  claimCooldown,
  putTicket, takeTicket,
  bumpStreak, clearStreak,
  distributed, localTicketCount,
  NS, TICKET_REDIS, TICKET_LOCAL, TAKE_LUA, STREAK_LUA, MAX_LOCAL_TICKETS,
  _reset,
};
