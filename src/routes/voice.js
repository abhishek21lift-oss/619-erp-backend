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
const { validate } = require('../middleware/validate');
const { orgWhere } = require('../lib/tenant-db');
const { logActivity } = require('../lib/activityLog');
const { z } = require('../lib/validation');
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

/** Max rows a spoken answer can usefully carry. See the handler's note. */
const SEARCH_LIMIT = 5;

const searchSchema = {
  query: z.object({
    // Bounded on both ends. A single character matches most of a roster and
    // makes the endpoint an enumeration tool; 60 is far past any real name and
    // stops a pathological ILIKE pattern being sent at all.
    q: z.string()
      .transform((v) => v.trim())
      .refine((v) => v.length >= 2, 'Search term must be at least 2 characters')
      .refine((v) => v.length <= 60, 'Search term is too long'),
  }),
};

/**
 * GET /api/voice/clients/search?q=Rahul
 *
 * → { query, count, results: [{ id, client_id, name, status, package_type,
 *     expires_on, expired }], spoken }
 *
 * ── What it deliberately does not return ──────────────────────────────────
 *
 * No mobile, no email, no address, no amounts. Phase 1's rule still holds:
 * whatever comes back may be spoken aloud with other people in the room, and
 * a phone number read out near a stranger cannot be un-said. A name, the
 * package and when it expires is what "find Rahul" actually needs; a contact
 * card is a different request, made while looking at a screen.
 *
 * ── Why it returns several matches rather than guessing ───────────────────
 *
 * Two clients called Rahul is the ordinary case, not the edge one. Picking
 * the "best" match server-side would have Siri state one person's expiry date
 * with total confidence when it may be the other's, and the user has no way
 * to see that it chose. So the count is returned, the intent says how many
 * there are, and it reads out the one match only when there is exactly one.
 */
router.get('/clients/search', validate(searchSchema), async (req, res, next) => {
  try {
    // A trainer sees only their own roster — narrower than the org filter and
    // applied in addition to it, never instead of it. Admins and managers get
    // the whole studio, which is the existing rule everywhere else (see
    // routes/search.js and routes/clients.js).
    const trainerId = req.user.role === 'trainer' ? (req.user.trainer_id || null) : null;
    if (req.user.role === 'trainer' && !trainerId) {
      // A trainer account with no trainer record must not fall through to the
      // whole studio. Fail closed, and say the honest thing rather than
      // reporting an error the user cannot act on.
      return res.json({
        query: req.query.q,
        count: 0,
        results: [],
        spoken: `I could not find anyone matching ${req.query.q}.`,
      });
    }

    const params = [`%${req.query.q}%`];
    const orgClause = orgWhere(req, params, 'organization_id');

    let trainerClause = '';
    if (trainerId) {
      params.push(trainerId);
      trainerClause = ` AND trainer_id = $${params.length}`;
    }

    params.push(SEARCH_LIMIT);

    // Fixed SQL. The only variables are the bounded search term, the org id
    // resolved from the session, and the trainer id resolved from the role —
    // none of which the caller can widen. Matching name and client_id only:
    // mobile and email are searchable in the web UI, but a voice surface that
    // matches on a phone number is one that can be used to check whether a
    // given number is on the roster.
    const { rows } = await pool.query(
      `SELECT id, client_id, name, status, package_type, pt_end_date
         FROM pt_clients
        WHERE deleted_at IS NULL
          AND (name ILIKE $1 OR client_id ILIKE $1)
          ${orgClause}
          ${trainerClause}
        ORDER BY (status = 'active') DESC, name
        LIMIT $${params.length}`,
      params
    );

    const today = new Date().toISOString().slice(0, 10);
    const results = rows.map((r) => ({
      id: r.id,
      client_id: r.client_id,
      name: r.name,
      status: r.status,
      package_type: r.package_type,
      expires_on: r.pt_end_date,
      // Only a real date can be expired. A client with no pt_end_date on file
      // is unknown, not lapsed, and must not be announced as lapsed.
      expired: r.pt_end_date ? r.pt_end_date < today : null,
    }));

    // Names are being read aloud, so the audit row records that a search
    // happened and what was typed — not the roster it returned.
    logActivity(req, 'voice.clients.search', 'organization',
      req.user?.organization_id || null,
      { query: req.query.q, count: results.length, channel: 'voice' });

    res.json({
      query: req.query.q,
      count: results.length,
      results,
      spoken: spokenFor(req.query.q, results),
    });
  } catch (err) {
    logger.error({ err: err.message }, 'voice client search failed');
    next(err);
  }
});

/**
 * The sentence Siri reads.
 *
 * Built server-side for the same reason as Phase 1's: the phrasing is product
 * copy and should be correctable without an App Store release. Three cases,
 * because they need three different sentences — "none" is not an error,
 * "several" must not pretend to have picked one, and an expired client is the
 * one fact a trainer most needs volunteered rather than asked for.
 */
function spokenFor(query, results) {
  if (results.length === 0) return `I could not find anyone matching ${query}.`;

  if (results.length === 1) {
    const c = results[0];
    const parts = [c.name];

    if (c.status && c.status !== 'active') {
      parts.push(`is ${c.status}`);
    } else if (c.expired === true) {
      // Said first and plainly: a lapsed package is the reason a trainer is
      // usually looking someone up in the first place.
      parts.push(`has an expired package${c.expires_on ? `, which ended on ${c.expires_on}` : ''}`);
    } else if (c.expires_on) {
      parts.push(`is active until ${c.expires_on}`);
    } else {
      parts.push('is active');
    }

    return `${parts.join(' ')}.`;
  }

  // Several. State the count and the names, and stop — choosing one for the
  // user is the thing this must not do.
  const names = results.map((r) => r.name);
  const list = names.length <= 3
    ? names.join(', ')
    : `${names.slice(0, 3).join(', ')} and others`;
  return `I found ${results.length} people matching ${query}: ${list}.`;
}

module.exports = router;
