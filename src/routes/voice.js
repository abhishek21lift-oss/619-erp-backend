// src/routes/voice.js
//
// The voice surface: read-only aggregates safe to speak out loud.
//
// ── Why voice gets its own router ──────────────────────────────────────────
//
// Siri answers from a locked phone. That single fact makes this different from
// every other router here, and it is the reason these endpoints are not just
// "the dashboard endpoints called by a different client":
//
//   · Everything is READ-ONLY. A voice surface that can write is a voice
//     surface that can be made to write by anyone within earshot.
//   · Everything returns ONE scalar plus the sentence to say. No lists, no
//     names, no ids — a spoken response cannot be scrolled past or redacted,
//     and a bystander hears whatever comes back.
//   · Nothing takes a caller-supplied identifier. The subject is always
//     "the authenticated user's own organization", derived server-side.
//
// ── The intent layer never touches SQL ─────────────────────────────────────
//
// Siri and the App Intent send a bearer token and a path. They do not send a
// query, a table, a filter or an organization id. The SQL below is fixed at
// author time and the only variable in it is the org id this server resolved
// from the caller's own session — so there is no shape of request, malicious
// or malformed, that can widen what is counted.

const router = require('express').Router();
const pool = require('../db/pool');
const { auth } = require('../middleware/auth');
const { requireStaff } = require('../middleware/rbac');
const { orgWhere } = require('../lib/tenant-db');
const { logActivity } = require('../lib/activityLog');
const logger = require('../lib/logger');

// Staff only, on the whole router.
//
// "How many clients do I have" is a studio-wide business figure. `member` is
// the role client activation creates for a gym client, and a client must not
// be able to ask their phone how large the studio's roster is — the same
// escalation memberEscalation.authz.test.js exists to prevent elsewhere.
router.use(auth, requireStaff);

/**
 * GET /api/voice/dashboard/client-count
 *
 * → { count, scope, spoken }
 *
 * `spoken` is the sentence the intent reads aloud. It is built here rather
 * than in Swift on purpose: the phrasing (and its pluralisation) is product
 * copy, and shipping it from the server means it can be corrected without an
 * App Store release.
 *
 * Counts ACTIVE, non-deleted clients — the same predicate the rest of the app
 * already means by "clients" (see pt-os.routes.js, which counts trainers the
 * same way). A trainer asking this expects the number they manage today, not
 * a lifetime total that includes everyone who ever lapsed.
 */
router.get('/dashboard/client-count', async (req, res, next) => {
  try {
    const params = [];
    // orgWhere() is the shared isolation helper: it appends ` AND
    // organization_id = $N` for a tenant user, and returns '' only for a
    // platform super admin operating deliberately platform-wide. A tenant
    // user with no org resolves to NULL, which matches no rows — fail closed,
    // never fail open to somebody else's roster.
    const orgClause = orgWhere(req, params, 'organization_id');

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS count
         FROM pt_clients
        WHERE deleted_at IS NULL
          AND status = 'active'
          ${orgClause}`,
      params
    );

    const count = rows[0]?.count ?? 0;

    // Fire-and-forget, like every other audit write in this codebase. A voice
    // request is a request made from a locked device that leaves no UI trace,
    // so it is exactly the kind that should be attributable afterwards.
    // Deliberately not awaited: the answer must not wait on the audit write,
    // and logActivity already swallows its own failures.
    logActivity(req, 'voice.dashboard.client_count', 'organization',
      req.user?.organization_id || null, { count, channel: 'voice' });

    res.json({
      count,
      scope: 'active',
      spoken: count === 1
        ? 'You have 1 active client.'
        : `You have ${count} active clients.`,
    });
  } catch (err) {
    logger.error({ err: err.message }, 'voice client-count failed');
    next(err);
  }
});

module.exports = router;
