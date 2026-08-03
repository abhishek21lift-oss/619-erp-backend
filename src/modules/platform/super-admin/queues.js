'use strict';

/**
 * Queue health, for the Command Centre.
 *
 * Same reasoning as mail.js next door: work that runs out of the request path
 * fails where nobody is looking. A job that has exhausted its retries is
 * invisible — the request that queued it returned 200 long ago — so without
 * somewhere to read the failed count, a broken worker looks exactly like a
 * quiet week.
 *
 * Read-only and super-admin only (the parent router carries auth,
 * requireSuperAdmin and the MFA gate).
 *
 * Never 500s on a Redis outage. An endpoint that errors when Redis is down
 * tells you less than one that says Redis is down, and this is the endpoint
 * you reach for precisely when something is wrong.
 */

const router = require('express').Router();
const connection = require('../../../lib/queue/connection');
const { QUEUES, counts, JOB_OPTIONS } = require('../../../lib/queue');

/**
 * GET /queues/status
 *
 * Reports, per queue: waiting, active, completed, failed, delayed, paused,
 * plus the retry policy in force so the numbers can be read against it.
 */
router.get('/queues/status', async (req, res, next) => {
  try {
    if (!connection.isEnabled()) {
      return res.json({
        data: {
          ok: false,
          enabled: false,
          reason: 'REDIS_NOT_CONFIGURED',
          diagnosis: 'REDIS_URL is not set, so there is no queue. Email, WhatsApp, '
            + 'AI ingestion and renewals run inline in the API process, as they did '
            + 'before queueing existed. Nothing is being dropped.',
          queues: [],
        },
      });
    }

    const redis = await connection.ping();
    const rows = await Promise.all(Object.values(QUEUES).map((n) => counts(n)));

    // Surfaced as a single flag so a dashboard does not have to know the
    // shape: anything failed, or Redis unreachable, is worth a look.
    const failing = rows.filter((r) => Number(r.failed) > 0);

    res.json({
      data: {
        ok: redis.ok && failing.length === 0,
        enabled: true,
        redis,
        queues: rows.map((r) => ({ ...r, policy: JOB_OPTIONS[r.name] })),
        attention: failing.map((r) => ({ queue: r.name, failed: r.failed })),
      },
    });
  } catch (err) { next(err); }
});

module.exports = router;
