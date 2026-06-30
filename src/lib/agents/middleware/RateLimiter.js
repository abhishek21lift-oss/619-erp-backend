'use strict';
const { AgentError } = require('../base/AgentError');

// Simple in-memory LRU-style per-user rate limiter.
// Mirrors the pattern used in src/middleware/auth.js for the user cache.
const WINDOW_MS   = 60 * 60 * 1000;  // 1 hour
const DEFAULT_MAX = 60;               // requests per hour per user
const MAX_ENTRIES = 2000;

const _store = new Map(); // userId → { count, windowStart }

function _evict() {
  if (_store.size < MAX_ENTRIES) return;
  const now = Date.now();
  for (const [key, val] of _store) {
    if (now - val.windowStart > WINDOW_MS) _store.delete(key);
    if (_store.size < MAX_ENTRIES * 0.9) break;
  }
}

const RateLimiter = {
  /**
   * Check and increment the rate limit for a user.
   * Admins are exempt.
   * Throws AgentError.rateLimitExceeded() if over limit.
   */
  check(context, maxPerHour = DEFAULT_MAX) {
    if (context.isAdmin()) return; // admins are unlimited

    const now = Date.now();
    const key = String(context.userId);
    const entry = _store.get(key);

    if (!entry || now - entry.windowStart > WINDOW_MS) {
      _evict();
      _store.set(key, { count: 1, windowStart: now });
      return;
    }

    entry.count++;
    if (entry.count > maxPerHour) {
      throw AgentError.rateLimitExceeded();
    }
  },

  /** Current usage for a user (for debugging / admin endpoints). */
  usage(userId) {
    const entry = _store.get(String(userId));
    if (!entry) return { count: 0, windowStart: null };
    return { count: entry.count, windowStart: new Date(entry.windowStart).toISOString() };
  },
};

module.exports = { RateLimiter };
