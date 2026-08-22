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
//   · Everything returns the sentence to say alongside the data. A spoken
//     response cannot be scrolled past or redacted, and a bystander hears
//     whatever comes back — so no endpoint here selects a mobile number, an
//     email, an address or an amount, and no identifier is ever spoken.
//   · Any caller-supplied identifier is checked for ownership BEFORE it is
//     used to read anything, and a foreign one answers 404 rather than 403.
//     The subject is otherwise always "the authenticated user's own
//     organization", derived server-side from the session.
//   · "Today" is the STUDIO's today (src/lib/appTime.js), never the phone's
//     and never UTC. A trainer asking at 6am must get the day the studio is
//     actually operating on.
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
const { clientInOrg } = require('../lib/orgGuard');
const { logActivity } = require('../lib/activityLog');
const { z } = require('../lib/validation');
const { today: studioToday, todayShortDay: studioShortDay, appTimeZone } = require('../lib/appTime');
const { resolveMyTrainerIds } = require('../lib/trainerIdentity');
const { adminManagerOrTrainer } = require('../middleware/auth');
const { orgIdOf } = require('../lib/tenant-db');
const { checkScreeningGate } = require('../lib/screeningGate');
const { routedChat } = require('../lib/ai/router');
const { randomUUID } = require('crypto');
const {
  loadClientContext, loadHistory, buildDraft, clampDays, DEFAULT_DAYS,
} = require('../lib/workoutDraft');
const { recomputeAssignmentProgress } = require('../lib/assignmentProgress');
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

const detailSchema = {
  params: z.object({
    // Bounded and character-classed. These ids are uuid-or-text primary keys,
    // so this is not a uuid() check — but it does stop a path segment that is
    // obviously not an id from reaching a query at all.
    clientId: z.string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/, 'Invalid client id'),
  }),
};

/**
 * GET /api/voice/clients/:clientId
 *
 * → { id, name, status, active, package_type, expires_on, expired,
 *     sessions_remaining, today, spoken }
 *
 * ── Ownership is checked before anything is read ──────────────────────────
 *
 * The id comes from the caller. `clientInOrg` is the shared guard that exists
 * because this module's neighbour once shipped the opposite: handlers that
 * took a client_id from the request and read rows for it without asking whose
 * client it was (see modules/automation/automation.routes.js's header).
 *
 * A client in another studio answers **404, not 403** — deliberately the same
 * answer as an id that does not exist. A 403 would confirm the id is real
 * somewhere, which is an enumeration oracle for a surface whose ids are handed
 * out by the search endpoint.
 *
 * ── Two joins, both scoped through the verified client ─────────────────────
 *
 * `session_balance` and `workout_sessions` are keyed on pt_clients.id. Rather
 * than re-deriving the tenant on each, both are constrained to the client this
 * request has already proven the caller owns — one place to get isolation
 * right instead of three.
 */
router.get('/clients/:clientId', validate(detailSchema), async (req, res, next) => {
  try {
    const { clientId } = req.params;

    // Ownership first, before any client data is read.
    if (!await clientInOrg(req, clientId)) return notFoundClient(res);

    const params = [clientId];
    const orgClause = orgWhere(req, params, 'organization_id');

    // A trainer sees only their own roster — the same narrowing Phase 2
    // applies, so a trainer cannot read a colleague's client by pasting an id
    // the search endpoint gave somebody else.
    let trainerClause = '';
    if (req.user.role === 'trainer') {
      if (!req.user.trainer_id) return notFoundClient(res);
      params.push(req.user.trainer_id);
      trainerClause = ` AND trainer_id = $${params.length}`;
    }

    const { rows } = await pool.query(
      `SELECT id, name, status, package_type, pt_end_date
         FROM pt_clients
        WHERE id = $1
          AND deleted_at IS NULL
          ${orgClause}
          ${trainerClause}`,
      params
    );

    const client = rows[0];
    if (!client) return notFoundClient(res);

    // Both reads are best-effort. A missing session balance or an unreadable
    // workout log must not fail the whole answer — the package facts are the
    // core of it, and the two extras are reported as unknown rather than as
    // zero. `null` here means "not on file", which the sentence below says
    // differently from "none left".
    const [balance, today] = await Promise.all([
      sessionsRemainingFor(clientId).catch(() => null),
      todaysSessionFor(clientId).catch(() => null),
    ]);

    // The STUDIO's today, not UTC's. `toISOString()` here would call a
    // package that lapsed yesterday "still valid" between midnight and
    // 05:30 IST — the exact bug src/lib/appTime.js was written to end.
    const todayIso = studioToday();
    const expired = client.pt_end_date ? client.pt_end_date < todayIso : null;

    const detail = {
      // The pt_clients id — the same opaque handle Phase 2 already returns and
      // the App Intent already holds. No internal row ids from the joined
      // tables are exposed, and nothing here is ever spoken aloud.
      id: client.id,
      name: client.name,
      status: client.status,
      active: client.status === 'active',
      package_type: client.package_type,
      expires_on: client.pt_end_date,
      expired,
      sessions_remaining: balance,
      today,
    };

    logActivity(req, 'voice.clients.detail', 'pt_client', clientId,
      { channel: 'voice' });

    res.json({ ...detail, spoken: spokenForDetail(detail) });
  } catch (err) {
    logger.error({ err: err.message }, 'voice client detail failed');
    next(err);
  }
});

/** 404 for both "not yours" and "not there" — see the handler's note. */
function notFoundClient(res) {
  return res.status(404).json({
    error: { code: 'NOT_FOUND', message: 'Client not found' },
    spoken: 'I could not find that client.',
  });
}

/**
 * Sessions left on the active package, or null when none is on file.
 *
 * Null and 0 are different answers and are spoken differently: one is "no
 * package recorded", the other is "they have run out".
 */
async function sessionsRemainingFor(clientId) {
  const { rows } = await pool.query(
    `SELECT remaining_sessions
       FROM session_balance
      WHERE client_id = $1
        AND status = 'active'
      ORDER BY start_date DESC
      LIMIT 1`,
    [clientId]
  );
  const v = rows[0]?.remaining_sessions;
  return typeof v === 'number' ? v : null;
}

/**
 * Today's workout, as one of three states.
 *
 * `null` means no session row exists for today — which for a trainer asking
 * "is Rahul done" reads as "not started", but is reported as its own state so
 * the sentence can say "nothing scheduled" rather than inventing a plan that
 * was never assigned.
 */
async function todaysSessionFor(clientId) {
  const { rows } = await pool.query(
    `SELECT status, program_name
       FROM workout_sessions
      WHERE client_id = $1
        AND session_date = CURRENT_DATE
      ORDER BY created_at DESC
      LIMIT 1`,
    [clientId]
  );
  if (!rows[0]) return { status: 'none', program_name: null };
  return { status: rows[0].status, program_name: rows[0].program_name || null };
}

/**
 * "Rahul Sharma is on PT Gold. His package expires on 14 September, and
 * today's workout is pending."
 *
 * Assembled server-side like every other sentence on this surface. Names no
 * ids, no amounts and no contact details — the response carries the id for the
 * intent to reuse, and the sentence never says it.
 *
 * Gender-neutral throughout: the record has a `gender` column but inferring a
 * pronoun from it would be wrong for some clients and is not worth being wrong
 * about out loud. "Their package" reads naturally and is always correct.
 */
function spokenForDetail(d) {
  const sentences = [];

  sentences.push(d.package_type
    ? `${d.name} is on ${d.package_type}.`
    : `${d.name} has no package on file.`);

  const clauses = [];

  if (d.status && d.status !== 'active') {
    clauses.push(`their account is ${d.status}`);
  } else if (d.expired === true) {
    clauses.push(`their package expired${d.expires_on ? ` on ${speakDate(d.expires_on)}` : ''}`);
  } else if (d.expires_on) {
    clauses.push(`their package expires on ${speakDate(d.expires_on)}`);
  }

  // Only when there is a real number. "0 sessions left" is worth saying;
  // "no balance on file" is not the same fact and is left unsaid rather than
  // spoken as zero.
  if (typeof d.sessions_remaining === 'number') {
    clauses.push(d.sessions_remaining === 1
      ? 'they have 1 session left'
      : `they have ${d.sessions_remaining} sessions left`);
  }

  clauses.push(todayClause(d.today));

  sentences.push(`${capitalize(clauses.join(', and '))}.`);
  return sentences.join(' ');
}

function todayClause(today) {
  switch (today?.status) {
    case 'completed':   return "today's workout is done";
    case 'in_progress': return "today's workout is pending";
    case 'none':        return 'nothing is logged for today';
    // The read failed. Say so rather than reporting a state we did not see.
    default:            return "today's workout could not be checked";
  }
}

/** "2026-09-14" → "14 September". Spoken dates drop the year when it is the
 *  current one, because a trainer asking today does not need it. */
function speakDate(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  const month = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'][d.getUTCMonth()];
  const sameYear = String(d.getUTCFullYear()) === studioToday().slice(0, 4);
  return sameYear
    ? `${d.getUTCDate()} ${month}`
    : `${d.getUTCDate()} ${month} ${d.getUTCFullYear()}`;
}

function capitalize(s) {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

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


/* ========================================================================== *
 * Phase 4 — "Hey Siri, show me today's workouts in MY PT STUDIO."
 * ========================================================================== */

/**
 * The endpoint takes no input.
 *
 * `.strict()` is the point: a query string is the one thing a caller controls
 * here, and rejecting unknown keys means a request like `?organization_id=…`
 * or `?trainer_id=…` fails loudly instead of being silently ignored. Silently
 * ignoring it is what makes a future reader assume it was honoured.
 */
const todaySchema = { query: z.object({}).strict() };

/** Enough for a studio's day; the response says when it clipped. */
const TODAY_LIMIT = 25;

/**
 * GET /api/voice/workouts/today
 *
 * → { date, timezone, count, booked_count, sessions[], truncated, spoken }
 *
 * ── Why this reads THREE sources and not just the appointment book ─────────
 *
 * The obvious implementation is `pt_sessions WHERE session_date = today`. It
 * is also the implementation that ships a dead feature: pt-os.service.js
 * records that pt_sessions "holds no rows at all while five assignments are
 * active", because these studios run off programmes rather than a diary. A
 * voice command that answers "no sessions today" every single day is worse
 * than no command, and the dashboard panel next door was rebuilt twice for
 * exactly this reason.
 *
 * So the same three tiers that panel settled on, in the same priority order,
 * each one more specific than the next:
 *
 *   booked     — a real slot in pt_sessions. Has a real start_time.
 *   programme  — an active plan whose exercises name today's weekday.
 *   enrolment  — the client's own preferred_training_days says today.
 *
 * A client appears once, under the most specific tier that matches — the
 * NOT EXISTS clauses below are what stop the same person being announced
 * three times.
 *
 * ── The time is never invented ────────────────────────────────────────────
 *
 * Only `booked` rows carry a scheduled time the studio actually committed to.
 * A programme row has none, and the enrolment tier has only a free-text
 * preference. Both are reported with `start_time: null` and `time_source`
 * naming where the time came from, and the spoken sentence names a clock time
 * ONLY for rows that have one. Announcing a preference as an appointment
 * would have a trainer turn up for a slot nobody agreed to.
 *
 * ── Today ─────────────────────────────────────────────────────────────────
 *
 * The studio's calendar day (Asia/Kolkata by default), from appTime.js — not
 * the phone's zone and not UTC. Siri is most used first thing in the morning,
 * which in IST is precisely the window where a UTC "today" is still yesterday.
 */
router.get('/workouts/today', validate(todaySchema), async (req, res, next) => {
  try {
    const date = studioToday();
    const shortDay = studioShortDay();

    // A trainer sees only their own diary. Every profile that IS this caller,
    // because `pt_sessions.trainer_id` may hold an id from either trainer
    // table — see lib/trainerIdentity.js.
    //
    // Fail closed: a trainer we cannot resolve to any profile gets an empty
    // list, never the whole studio's. `trainer_linked: false` says why, so the
    // sentence can explain rather than implying an empty day.
    let trainerIds = null;
    if (req.user.role === 'trainer') {
      trainerIds = await resolveMyTrainerIds(req);
      if (!trainerIds.length) {
        return res.json({
          date,
          timezone: appTimeZone(),
          count: 0,
          booked_count: 0,
          sessions: [],
          truncated: false,
          trainer_linked: false,
          spoken: 'Your account is not linked to a trainer profile yet, so I '
                + 'cannot show your schedule.',
        });
      }
    }

    const [booked, programme, enrolment] = await Promise.all([
      bookedToday(req, date, trainerIds),
      // The two derived tiers are best-effort. They are a convenience over the
      // appointment book, and a failure in either must not turn a day with
      // real booked slots into an error.
      programmeToday(req, date, trainerIds).catch((err) => {
        logger.warn({ err: err.message }, 'voice today: programme tier failed');
        return [];
      }),
      enrolmentToday(req, date, shortDay, trainerIds).catch((err) => {
        logger.warn({ err: err.message }, 'voice today: enrolment tier failed');
        return [];
      }),
    ]);

    const all = [...booked, ...programme, ...enrolment];
    const sessions = all.slice(0, TODAY_LIMIT);

    logActivity(req, 'voice.workouts.today', 'pt_session', null,
      { channel: 'voice', date, count: sessions.length });

    res.json({
      date,
      timezone: appTimeZone(),
      count: sessions.length,
      booked_count: booked.length,
      sessions,
      truncated: all.length > sessions.length,
      trainer_linked: true,
      spoken: spokenForToday(sessions, all.length),
    });
  } catch (err) {
    logger.error({ err: err.message }, 'voice today workouts failed');
    next(err);
  }
});


/**
 * Tier 1 — slots the studio actually booked.
 *
 * `plan_name` comes from the client's ACTIVE assignment via a LATERAL with
 * LIMIT 1, not a plain join: a client with two assignments would otherwise fan
 * into two rows of the same appointment, which is a defect the dashboard hit
 * against live data.
 *
 * Cancelled slots are excluded. "You have 6 sessions today" must not count a
 * session the studio cancelled — the number is the whole answer on a surface
 * with no screen to check.
 */
async function bookedToday(req, date, trainerIds) {
  const params = [date];
  const orgClause = orgWhere(req, params, 's.organization_id');

  let trainerClause = '';
  if (trainerIds) {
    params.push(trainerIds);
    trainerClause = ` AND s.trainer_id = ANY($${params.length})`;
  }

  const { rows } = await pool.query(
    `SELECT s.id, s.client_id, s.start_time::TEXT AS start_time, s.status,
            c.name AS client_name, t.name AS trainer_name, wa.plan_name
       FROM pt_sessions s
       LEFT JOIN pt_clients  c ON c.id = s.client_id
       LEFT JOIN pt_trainers t ON t.id = s.trainer_id
       LEFT JOIN LATERAL (
         SELECT wp.name AS plan_name
           FROM workout_assignments a
           JOIN workout_plans wp ON wp.id = a.workout_plan_id
          WHERE a.client_id = s.client_id AND a.status = 'active'
          ORDER BY a.start_date DESC
          LIMIT 1
       ) wa ON TRUE
      WHERE s.session_date = $1
        AND s.deleted_at IS NULL
        AND s.status <> 'cancelled'
        ${orgClause}
        ${trainerClause}
      ORDER BY COALESCE(s.start_time, '00:00'::TIME)
      LIMIT ${TODAY_LIMIT}`,
    params
  );

  return rows.map((r) => ({
    client_id: r.client_id,
    client_name: r.client_name,
    program_name: r.plan_name || null,
    start_time: normaliseTime(r.start_time),
    time_source: r.start_time ? 'booked' : null,
    status: r.status,
    trainer_name: r.trainer_name || null,
    source: 'booked',
  }));
}

/**
 * Tier 2 — an active programme whose exercises name today's weekday.
 *
 * day_of_week is ISO (1 = Monday) to match workout_exercises, and the date is
 * cast rather than compared as text. No booked slot, or tier 1 already has it.
 */
async function programmeToday(req, date, trainerIds) {
  const params = [date];
  const orgClause = orgWhere(req, params, 'c.organization_id');

  let trainerClause = '';
  if (trainerIds) {
    params.push(trainerIds);
    trainerClause = ` AND c.trainer_id = ANY($${params.length})`;
  }

  const { rows } = await pool.query(
    `SELECT c.id AS client_id, c.name AS client_name,
            c.trainer_name, wp.name AS plan_name
       FROM workout_assignments a
       JOIN workout_plans wp ON wp.id = a.workout_plan_id
       JOIN pt_clients    c  ON c.id = a.client_id
      WHERE a.status = 'active'
        AND c.deleted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM workout_exercises we
           WHERE we.workout_plan_id = wp.id
             AND we.day_of_week = EXTRACT(ISODOW FROM $1::date)::int
             AND we.week_number = 1
        )
        AND NOT EXISTS (
          SELECT 1 FROM pt_sessions s
           WHERE s.client_id = c.id AND s.session_date = $1
             AND s.deleted_at IS NULL
        )
        ${orgClause}
        ${trainerClause}
      ORDER BY c.name
      LIMIT ${TODAY_LIMIT}`,
    params
  );

  return rows.map((r) => ({
    client_id: r.client_id,
    client_name: r.client_name,
    program_name: r.plan_name || null,
    // A programme names a DAY, never a time.
    start_time: null,
    time_source: null,
    status: 'expected',
    trainer_name: r.trainer_name || null,
    source: 'programme',
  }));
}

/**
 * Tier 3 — the client's own enrolment says they train today.
 *
 * `preferred_training_days` is the literal string the enrolment form wrote —
 * "Mon, Wed, Fri" — so matching means producing the same three letters, in the
 * studio's zone, and stripping spaces before splitting so "Mon,Wed" behaves
 * the same. See appTime.todayShortDay, which exists for this comparison.
 *
 * `preferred_workout_time` is a PREFERENCE, not an appointment, and is
 * reported as such: `time_source: 'preference'` so nothing downstream can
 * mistake it for a slot the studio agreed to.
 */
async function enrolmentToday(req, date, shortDay, trainerIds) {
  const params = [date, shortDay];
  const orgClause = orgWhere(req, params, 'c.organization_id');

  let trainerClause = '';
  if (trainerIds) {
    params.push(trainerIds);
    trainerClause = ` AND c.trainer_id = ANY($${params.length})`;
  }

  const { rows } = await pool.query(
    `SELECT c.id AS client_id, c.name AS client_name,
            c.trainer_name, c.preferred_workout_time
       FROM pt_clients c
      WHERE c.deleted_at IS NULL
        AND c.status = 'active'
        AND c.preferred_training_days IS NOT NULL
        AND $2 = ANY(string_to_array(replace(c.preferred_training_days, ' ', ''), ','))
        AND NOT EXISTS (
          SELECT 1 FROM pt_sessions s
           WHERE s.client_id = c.id AND s.session_date = $1
             AND s.deleted_at IS NULL
        )
        AND NOT EXISTS (
          SELECT 1
            FROM workout_assignments a
            JOIN workout_plans wp ON wp.id = a.workout_plan_id
           WHERE a.client_id = c.id AND a.status = 'active'
             AND EXISTS (
               SELECT 1 FROM workout_exercises we
                WHERE we.workout_plan_id = wp.id
                  AND we.day_of_week = EXTRACT(ISODOW FROM $1::date)::int
                  AND we.week_number = 1
             )
        )
        ${orgClause}
        ${trainerClause}
      ORDER BY c.name
      LIMIT ${TODAY_LIMIT}`,
    params
  );

  return rows.map((r) => ({
    client_id: r.client_id,
    client_name: r.client_name,
    program_name: null,
    start_time: normaliseTime(r.preferred_workout_time),
    time_source: normaliseTime(r.preferred_workout_time) ? 'preference' : null,
    status: 'expected',
    trainer_name: r.trainer_name || null,
    source: 'enrolment',
  }));
}

/**
 * Any of the shapes these columns hold → 'HH:MM', or null.
 *
 * `pt_sessions.start_time` is a real TIME and arrives as 'HH:MM:SS'.
 * `pt_clients.preferred_workout_time` is free text holding two formats: the
 * enrolment dropdown writes '6:00 AM' and its custom field, an
 * `<input type="time">`, writes '06:00'. Anything matching neither shape
 * returns null — an unparseable string must not be spoken as a time.
 */
function normaliseTime(raw) {
  if (!raw) return null;
  const s = String(raw).trim();

  let m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s);
  if (m) {
    const h = Number(m[1]);
    return h <= 23 ? `${String(h).padStart(2, '0')}:${m[2]}` : null;
  }

  m = /^(\d{1,2}):(\d{2})\s*([AaPp])[Mm]$/.exec(s);
  if (m) {
    let h = Number(m[1]);
    if (h < 1 || h > 12) return null;
    const pm = m[3].toLowerCase() === 'p';
    if (h === 12) h = 0;
    if (pm) h += 12;
    return `${String(h).padStart(2, '0')}:${m[2]}`;
  }

  return null;
}

/** '09:00' → '9 AM'; '11:30' → '11:30 AM'. The o'clock case drops ':00'. */
function speakTime(hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm || '');
  if (!m) return null;
  const h24 = Number(m[1]);
  const mins = m[2];
  const suffix = h24 < 12 ? 'AM' : 'PM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return mins === '00' ? `${h12} ${suffix}` : `${h12}:${mins} ${suffix}`;
}

/**
 * "You have 6 PT sessions today. Rahul at 9 AM, Amit at 11 AM, and four more."
 *
 * ── Why only the first name ───────────────────────────────────────────────
 *
 * This is spoken in a room. Naming three people is what makes the answer
 * useful; naming them in full is what makes it worth overhearing. The first
 * name is enough for the trainer who already knows their own roster, and is
 * the same thing the brief's own example says.
 *
 * ── Why only three ───────────────────────────────────────────────────────
 *
 * A spoken list cannot be skimmed. Six names read aloud is not six facts
 * received; it is one long noise ending in a number the listener has already
 * lost track of. Three plus a count is the most that survives being heard.
 *
 * A name is spoken with a time only when the row HAS one — a programme day is
 * announced by name alone rather than given an hour nobody agreed to.
 */
function spokenForToday(sessions, total) {
  if (!sessions.length) return 'You have no workouts scheduled today.';

  const noun = total === 1 ? 'session' : 'sessions';
  const head = `You have ${total} PT ${noun} today.`;

  const named = sessions.slice(0, 3).map((s) => {
    const first = String(s.client_name || '').trim().split(/\s+/)[0] || 'someone';
    const at = speakTime(s.start_time);
    // Only a booked slot is stated as a clock time. A preference is spoken as
    // one — "around 6 AM" — because that is what it is.
    if (!at) return first;
    return s.time_source === 'preference'
      ? `${first} around ${at}`
      : `${first} at ${at}`;
  });

  const remaining = total - named.length;
  if (remaining > 0) named.push(`${spellCount(remaining)} more`);

  return `${head} ${joinList(named)}.`;
}

/** Small counts read better as words than as digits. */
function spellCount(n) {
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven',
    'eight', 'nine', 'ten'];
  return n <= 10 ? words[n] : String(n);
}

function joinList(items) {
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}


/* ========================================================================== *
 * Phase 5 — "Hey Siri, create a workout for Rahul."
 *
 * The first WRITE on this surface, and it is deliberately two requests.
 *
 * ── Why preparing and saving are separate endpoints ──────────────────────
 *
 * Everything before this phase answered a question. This one changes a
 * person's training programme, and it is reachable by anyone who can speak
 * near an unlocked phone. So no single voice command saves anything:
 * /prepare builds a draft and describes it, /confirm saves the draft that was
 * described. The confirmation is not a politeness — it is the only point at
 * which a human hears what is about to happen and can stop it.
 *
 * ── Why /confirm takes an ID and nothing else ────────────────────────────
 *
 * The tempting design returns the generated plan to the phone and has
 * /confirm accept it back. That is not a confirmation step; it is an
 * exercise-injection endpoint with an extra round trip, because whatever
 * comes back is whatever the caller chose to send. Every safety decision made
 * during preparation — the PAR-Q gate, the contraindication filter, the
 * library check — would become advisory.
 *
 * So the draft lives in `voice_workout_drafts` and /confirm takes one id.
 * There is no field on the confirm request that can name an exercise, so
 * there is no request that can save one that was not generated and checked
 * here.
 * ========================================================================== */

/**
 * Writing is narrower than reading.
 *
 * The router-wide `requireStaff` admits reception and front-desk accounts,
 * which is right for "how many clients do I have" and wrong for authoring
 * somebody's training programme. These two routes use the same middleware the
 * workout routes themselves use, so the permission to create a plan by voice
 * is exactly the permission to create one in the app — not a second, looser
 * rule that happens to live on a different surface.
 */
const prepareSchema = {
  body: z.object({
    client_id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
    // A voice command must not be able to ask for a 40-session plan. Clamped
    // rather than rejected: "make it ten days" is a reasonable thing to say
    // and a 6-day week is a reasonable thing to answer.
    days: z.coerce.number().int().min(1).max(52).optional(),
  }).strict(),
};

const confirmSchema = {
  body: z.object({
    // The ONLY input. Note what is absent: no exercises, no plan name, no
    // client id, no day count. Adding any of them would reopen the hole this
    // endpoint's shape exists to close.
    draft_id: z.string().uuid(),
  }).strict(),
};

/** How long a prepared draft stays confirmable. */
const DRAFT_TTL_MINUTES = 30;

/**
 * POST /api/voice/workouts/prepare
 *
 * → { draft_id, expires_at, preview, screening_warnings, excluded, spoken }
 *
 * Saves NOTHING to the workout tables. The only row it writes is the draft
 * itself, which is a record of what was proposed.
 */
router.post('/workouts/prepare', adminManagerOrTrainer, validate(prepareSchema),
  async (req, res, next) => {
    try {
      const { client_id: clientId } = req.body;
      const days = clampDays(req.body.days ?? DEFAULT_DAYS);

      // 1. Ownership, before anything about this client is read. Same check,
      //    same 404-not-403, as Phase 3 — a client id from another studio must
      //    not be confirmed to exist by the way this endpoint refuses it.
      if (!await clientInOrg(req, clientId)) return notFoundClient(res);

      // 2. A trainer may only author for their own client. Mirrors
      //    POST /api/workouts/assign, including answering 404.
      if (req.user.role === 'trainer') {
        const { rows: mine } = await pool.query(
          'SELECT 1 FROM pt_clients WHERE id = $1 AND trainer_id = $2',
          [clientId, req.user.trainer_id || '']
        );
        if (!mine[0]) return notFoundClient(res);
      }

      const orgId = orgIdOf(req);
      if (!orgId) {
        // No organization means no library to read and no studio to own the
        // result. Fail closed rather than authoring into NULL.
        return res.status(403).json({
          error: { code: 'NO_ORGANIZATION', message: 'No studio on this account' },
          spoken: 'Your account is not attached to a studio, so I cannot create a workout.',
        });
      }

      // 3. The PAR-Q / Informed Consent gate — the SAME function the app's own
      //    assign route calls, so a medical block stops a voice-authored plan
      //    exactly as it stops one authored on screen. A surface that can
      //    route around a clearance rule is a surface that removes it.
      const { blocked, warnings } = await checkScreeningGate(req, clientId);
      if (blocked) {
        logActivity(req, 'voice.workouts.prepare.blocked', 'pt_client', clientId,
          { channel: 'voice', reason: 'parq_blocked' });
        return res.status(blocked.status).json({
          ...blocked.body,
          spoken: 'I cannot create a workout for them. Their screening flags '
                + 'them as medically blocked, so they need clearance first.',
        });
      }

      // 4. Their programme and what they have actually done.
      const client = await loadClientContext(clientId, orgId);
      if (!client) return notFoundClient(res);
      const history = await loadHistory(clientId).catch(() => ({ sessions: 0, last_session: null }));

      // 5. Generate. Contraindicated exercises are removed from the candidate
      //    list BEFORE either selector sees it, so nothing can choose one.
      const built = await buildDraft({
        client, history, orgId, days,
        chat: routedChat,
      });

      if (built.error) {
        logActivity(req, 'voice.workouts.prepare.failed', 'pt_client', clientId,
          { channel: 'voice', reason: built.error, excluded: built.excluded?.length ?? 0 });
        const spoken = built.error === 'NO_SAFE_EXERCISES'
          // Worth saying plainly. An empty result here is not a glitch — it is
          // the safety filter having removed everything, which a trainer needs
          // to hear as a fact about this client rather than as a failure.
          ? 'I could not build a safe workout for them. Every exercise in the '
          + 'library conflicts with something on their medical record.'
          : 'I could not build a workout for them just now. Please try again.';
        return res.status(422).json({
          error: { code: built.error, message: 'Could not generate a workout' },
          spoken,
        });
      }

      // 6. Store the draft. This is the only write, and it creates no plan,
      //    no assignment and no exercise row.
      const expiresAt = new Date(Date.now() + DRAFT_TTL_MINUTES * 60_000);
      const { rows: draftRows } = await pool.query(
        `INSERT INTO voice_workout_drafts
           (organization_id, client_id, created_by, draft, source,
            screening_warnings, excluded, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id, expires_at`,
        [orgId, clientId, req.user.id,
         JSON.stringify({ plan: built.plan, exercises: built.exercises }),
         built.source, warnings, JSON.stringify(built.excluded), expiresAt]
      );
      const draft = draftRows[0];

      // 7. Audit: who asked, for whom, what was generated, what was withheld
      //    and why. The draft row holds the plan itself; this is the trail.
      logActivity(req, 'voice.workouts.prepare', 'voice_workout_draft', draft.id, {
        channel: 'voice',
        client_id: clientId,
        days,
        source: built.source,
        exercise_count: built.exercises.length,
        excluded_count: built.excluded.length,
        based_on_plan_id: built.plan.based_on_plan_id,
        screening_warnings: warnings.length,
      });

      res.status(201).json({
        draft_id: draft.id,
        expires_at: draft.expires_at,
        // Everything needed to show the draft on screen, and nothing about
        // the client beyond the first name already spoken.
        preview: {
          client_name: client.name,
          plan_name: built.plan.name,
          days,
          goal: built.plan.goal,
          difficulty: built.plan.difficulty,
          based_on_plan_name: built.plan.based_on_plan_name,
          source: built.source,
          exercises: built.exercises,
        },
        screening_warnings: warnings,
        // Named, not hidden. A trainer told "I left out three exercises"
        // can disagree; one told nothing cannot.
        excluded: built.excluded,
        saved: false,
        spoken: spokenForPrepare(client, built, days, warnings),
      });
    } catch (err) {
      logger.error({ err: err.message }, 'voice workout prepare failed');
      next(err);
    }
  });

/**
 * POST /api/voice/workouts/confirm
 *
 * → { saved: true, workout_plan_id, assignment_id, spoken }
 *
 * The only endpoint on this surface that persists a workout.
 */
router.post('/workouts/confirm', adminManagerOrTrainer, validate(confirmSchema),
  async (req, res, next) => {
    const db = await pool.connect();
    try {
      const { draft_id: draftId } = req.body;
      const orgId = orgIdOf(req);

      await db.query('BEGIN');

      // Claim the draft. This single statement is the whole single-use
      // guarantee: the row moves out of 'pending' in the same transaction
      // that inserts the plan, so two confirmations racing each other produce
      // one plan and one 409 — the loser's UPDATE matches nothing and it
      // never reaches the INSERT.
      //
      // The WHERE clause is also the authorization: the draft must be this
      // studio's AND this user's. A draft id leaked to a colleague, or
      // guessed, matches nothing.
      const { rows: claimed } = await db.query(
        `UPDATE voice_workout_drafts
            SET status = 'confirmed', confirmed_at = NOW()
          WHERE id = $1
            AND status = 'pending'
            AND expires_at > NOW()
            AND organization_id = $2
            AND created_by = $3
        RETURNING id, client_id, draft, source`,
        [draftId, orgId, req.user.id]
      );

      if (!claimed[0]) {
        await db.query('ROLLBACK');
        // One response for "no such draft", "not yours", "already saved" and
        // "expired". Distinguishing them would let a caller probe which draft
        // ids exist, and none of the four is separately actionable by voice.
        logActivity(req, 'voice.workouts.confirm.rejected', 'voice_workout_draft', draftId,
          { channel: 'voice' });
        return res.status(409).json({
          error: { code: 'DRAFT_NOT_CONFIRMABLE', message: 'No draft to confirm' },
          saved: false,
          spoken: 'I do not have that workout to save any more. Please ask me '
                + 'to prepare it again.',
        });
      }

      const row = claimed[0];
      const parsed = typeof row.draft === 'string' ? JSON.parse(row.draft) : row.draft;
      const { plan, exercises } = parsed;

      // The client's name is read LIVE rather than taken from the draft: the
      // sentence names a person out loud, and a name corrected between
      // preparing and saving should be the corrected one. Falls back to the
      // plan name's own prefix if the row has gone — the save still happened
      // and still has to be reported.
      const { rows: whoRows } = await db.query(
        'SELECT name FROM pt_clients WHERE id = $1',
        [row.client_id]
      );
      const clientName = whoRows[0]?.name || null;

      // Re-run the safety gate against LIVE data, not the reading taken at
      // preparation. A PAR-Q filed in the last half hour must stop this save;
      // a draft is a proposal, never a clearance that has already been given.
      const { blocked } = await checkScreeningGate(req, row.client_id);
      if (blocked) {
        await db.query('ROLLBACK');
        logActivity(req, 'voice.workouts.confirm.blocked', 'voice_workout_draft', draftId,
          { channel: 'voice', client_id: row.client_id, reason: 'parq_blocked' });
        return res.status(blocked.status).json({
          ...blocked.body,
          saved: false,
          spoken: 'I did not save it. Their screening now flags them as '
                + 'medically blocked.',
        });
      }

      // Re-validate every exercise against the live library. An exercise
      // archived, made private or deleted since preparation must not be
      // written into a plan on the strength of a thirty-minute-old read.
      const ids = [...new Set(exercises.map((e) => e.exercise_id))];
      const { rows: live } = await db.query(
        `SELECT id FROM exercises
          WHERE id = ANY($1)
            AND is_active = TRUE
            AND deleted_at IS NULL
            AND archived_at IS NULL
            AND visibility IN ('public','organization')
            AND (organization_id IS NULL OR organization_id = $2)`,
        [ids, orgId]
      );
      const liveIds = new Set(live.map((r) => r.id));
      const valid = exercises.filter((e) => liveIds.has(e.exercise_id));

      if (!valid.length) {
        await db.query('ROLLBACK');
        logActivity(req, 'voice.workouts.confirm.invalid', 'voice_workout_draft', draftId,
          { channel: 'voice', client_id: row.client_id });
        return res.status(422).json({
          error: { code: 'EXERCISES_UNAVAILABLE', message: 'Draft exercises are no longer valid' },
          saved: false,
          spoken: 'I could not save it — those exercises are no longer '
                + 'available. Please ask me to prepare it again.',
        });
      }

      const planId = randomUUID();
      await db.query(
        `INSERT INTO workout_plans
           (id, name, description, goal, difficulty, duration_weeks,
            sessions_per_week, is_template, created_by, organization_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,FALSE,$8,$9)`,
        [planId, plan.name,
         `Prepared by voice for this client (${row.source}).`,
         plan.goal, plan.difficulty, plan.duration_weeks, plan.sessions_per_week,
         req.user.id, orgId]
      );

      for (const ex of valid) {
        await db.query(
          `INSERT INTO workout_exercises
             (id, workout_plan_id, exercise_id, day_of_week, sort_order,
              sets, reps, rest_seconds)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [randomUUID(), planId, ex.exercise_id, ex.day_of_week, ex.sort_order,
           ex.sets, ex.reps, ex.rest_seconds]
        );
      }

      // "A workout FOR Rahul" is attached to Rahul. A plan created and left
      // unassigned would answer the command with something the client never
      // receives.
      const assignmentId = randomUUID();
      await db.query(
        `INSERT INTO workout_assignments
           (id, workout_plan_id, client_id, trainer_id, start_date, status,
            notes, organization_id)
         VALUES ($1,$2,$3,$4,CURRENT_DATE,'active',$5,$6)
         ON CONFLICT (workout_plan_id, client_id, status) DO NOTHING`,
        [assignmentId, planId, row.client_id, req.user.trainer_id || null,
         'Created by voice', orgId]
      );

      await db.query(
        'UPDATE voice_workout_drafts SET workout_plan_id = $1 WHERE id = $2',
        [planId, draftId]
      );

      await db.query('COMMIT');

      logActivity(req, 'voice.workouts.confirm', 'workout_plan', planId, {
        channel: 'voice',
        draft_id: draftId,
        client_id: row.client_id,
        source: row.source,
        exercise_count: valid.length,
        // Named explicitly: an exercise that vanished between preparing and
        // saving changed the plan the trainer agreed to.
        dropped_since_prepare: exercises.length - valid.length,
      });

      res.status(201).json({
        saved: true,
        workout_plan_id: planId,
        // The NAME as well as the id. An id identifies the plan to software;
        // the name is what a Shortcut can show and a person can recognise,
        // and returning only the id makes every caller fetch it back.
        workout_plan_name: plan.name,
        assignment_id: assignmentId,
        client_name: clientName,
        exercise_count: valid.length,
        spoken: spokenForConfirm(clientName, plan),
      });
    } catch (err) {
      await db.query('ROLLBACK').catch(() => {});
      logger.error({ err: err.message }, 'voice workout confirm failed');
      next(err);
    } finally {
      db.release();
    }
  });

/**
 * "Done. Rahul's workout has been saved."
 *
 * Short on purpose. The long sentence was the QUESTION — what was prepared,
 * what was withheld, whether the paperwork is short. By the time this is
 * spoken the user has already heard all of it and said yes; repeating any of
 * it buries the one thing they now need, which is that it worked.
 */
function spokenForConfirm(clientName, plan) {
  const first = String(clientName || '').trim().split(/\s+/)[0];
  return first
    ? `Done. ${first}'s workout has been saved.`
    // No name on file any more — say what happened rather than an empty
    // possessive ("'s workout has been saved").
    : `Done. ${plan.name} has been saved.`;
}

/**
 * "I prepared a 4-day workout for Rahul based on his current programme.
 *  Shall I save it?"
 *
 * The question is the last clause on purpose: it is what the listener must
 * answer, and a sentence that buries it behind caveats gets a "yes" to
 * something nobody heard.
 *
 * "Based on his current programme" is said ONLY when there is one. Claiming a
 * basis that does not exist is the kind of small false confidence that makes
 * a trainer stop checking.
 */
function spokenForPrepare(client, built, days, warnings) {
  const first = String(client.name || '').trim().split(/\s+/)[0] || 'them';
  const parts = [`I prepared a ${days}-day workout for ${first}`];

  if (built.plan.based_on_plan_name) {
    parts.push(`based on their current programme, ${built.plan.based_on_plan_name}`);
  }

  const sentences = [`${parts.join(' ')}.`];

  // Said before the question, not after: a trainer deciding whether to save
  // needs to know something was withheld while they are still deciding.
  if (built.excluded.length) {
    const n = built.excluded.length;
    sentences.push(n === 1
      ? 'I left out one exercise that conflicts with their medical record.'
      : `I left out ${n} exercises that conflict with their medical record.`);
  }

  if (warnings.length) {
    sentences.push('Their screening paperwork is incomplete.');
  }

  sentences.push('Shall I save it?');
  return sentences.join(' ');
}


/* ========================================================================== *
 * Phase 6 — "Hey Siri, mark Rahul's workout as completed."
 *
 * The second write, and a much smaller one than Phase 5's: it changes a
 * status that already exists rather than creating anything. That is why it
 * does not need the prepare/confirm dance — there is nothing to preview,
 * because the whole effect fits in the sentence Siri says back.
 *
 * What it needs instead is IDEMPOTENCE. Siri repeats itself when it mishears,
 * a phrase can fire twice from a stuck button, and a request that double-
 * applies is one that cannot be trusted. So completing an already-completed
 * session is a 200 that says "that was already marked done" — not an error,
 * and not a second write.
 * ========================================================================== */

const completeSchema = {
  body: z.object({
    client_id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
    // Optional, and bounded to a real calendar date. Present so "mark
    // yesterday's workout done" can be added later without changing the
    // contract; absent means today, in the STUDIO's zone.
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }).strict(),
};

/**
 * POST /api/voice/workouts/complete
 *
 * → { completed, already_completed, session_id, client_name, date, spoken }
 *
 * Verifies, in this order: the caller may write, the client is theirs, a
 * session exists on that date, and it is not already done. Only then does it
 * write — and the write itself is conditional, so two requests racing produce
 * one completion.
 */
router.post('/workouts/complete', adminManagerOrTrainer, validate(completeSchema),
  async (req, res, next) => {
    try {
      const { client_id: clientId } = req.body;
      const date = req.body.date || studioToday();

      // 1. Ownership first, as everywhere else on this surface. 404, never
      //    403 — a foreign client id must not be confirmed to exist.
      if (!await clientInOrg(req, clientId)) return notFoundClient(res);

      // 2. A trainer may only complete their own client's session.
      if (req.user.role === 'trainer') {
        const { rows: mine } = await pool.query(
          'SELECT 1 FROM pt_clients WHERE id = $1 AND trainer_id = $2',
          [clientId, req.user.trainer_id || '']
        );
        if (!mine[0]) return notFoundClient(res);
      }

      const { rows: whoRows } = await pool.query(
        'SELECT name FROM pt_clients WHERE id = $1', [clientId]
      );
      const clientName = whoRows[0]?.name || null;
      // `null` rather than a placeholder pronoun: every sentence below reads
      // "<name>'s workout", and a fallback of "They" produces "They's".
      const first = String(clientName || '').trim().split(/\s+/)[0] || null;
      const whose = first ? `${first}'s workout` : 'The workout';

      // 3. The session must exist. This endpoint marks a workout done; it does
      //    not invent one. A client with no session logged for the date has
      //    not trained — saying "done" would write a completion for a workout
      //    that never happened, which is exactly the record a trainer later
      //    relies on.
      const findParams = [clientId, date];
      const findOrg = orgWhere(req, findParams, 'organization_id');
      const { rows: sessions } = await pool.query(
        `SELECT id, status, workout_assignment_id, program_name
           FROM workout_sessions
          WHERE client_id = $1
            AND session_date = $2
            ${findOrg}
          ORDER BY created_at DESC
          LIMIT 1`,
        findParams
      );

      const session = sessions[0];
      if (!session) {
        logActivity(req, 'voice.workouts.complete.missing', 'pt_client', clientId,
          { channel: 'voice', date });
        return res.status(404).json({
          error: { code: 'NO_SESSION', message: 'No workout logged for that date' },
          completed: false,
          spoken: first
            ? `I could not find a workout for ${first} on that day, so there `
              + 'was nothing to mark completed.'
            : 'I could not find a workout on that day, so there was nothing '
              + 'to mark completed.',
        });
      }

      // 4. Already done. Reported as success, because it IS the state the
      //    caller asked for — and reported as a DIFFERENT sentence, because
      //    "done" when nothing changed teaches a trainer that the command
      //    works when it may not have.
      if (session.status === 'completed') {
        logActivity(req, 'voice.workouts.complete.duplicate', 'workout_session', session.id,
          { channel: 'voice', client_id: clientId, date });
        return res.json({
          completed: true,
          already_completed: true,
          session_id: session.id,
          client_name: clientName,
          date,
          spoken: `${whose} was already marked completed.`,
        });
      }

      // 5. The write, guarded on the status it expects to find. Two requests
      //    racing produce one completion: the second matches no row, falls
      //    through to the duplicate branch's meaning, and writes nothing.
      const updParams = [session.id];
      const updOrg = orgWhere(req, updParams, 'organization_id');
      const { rows: updated } = await pool.query(
        `UPDATE workout_sessions
            SET status = 'completed', updated_at = NOW()
          WHERE id = $1
            AND status <> 'completed'
            ${updOrg}
        RETURNING id, workout_assignment_id`,
        updParams
      );

      if (!updated[0]) {
        // Someone else completed it between the read and the write. The state
        // the caller wanted is the state that exists, so this is not a failure
        // — but it is not a second completion either.
        logActivity(req, 'voice.workouts.complete.duplicate', 'workout_session', session.id,
          { channel: 'voice', client_id: clientId, date, raced: true });
        return res.json({
          completed: true,
          already_completed: true,
          session_id: session.id,
          client_name: clientName,
          date,
          spoken: `${whose} was already marked completed.`,
        });
      }

      // 6. The SAME progress recomputation the app runs when a session's
      //    status changes on screen (workout-log.routes.js PATCH). Skipping it
      //    would leave the client's assignment showing yesterday's percentage
      //    — the completion would be real and invisible.
      await recomputeAssignmentProgress(updated[0].workout_assignment_id)
        .catch((err) => logger.warn({ err: err.message }, 'voice complete: progress recompute failed'));

      logActivity(req, 'voice.workouts.complete', 'workout_session', session.id, {
        channel: 'voice',
        client_id: clientId,
        date,
        program_name: session.program_name || null,
        workout_assignment_id: updated[0].workout_assignment_id || null,
      });

      res.json({
        completed: true,
        already_completed: false,
        session_id: session.id,
        client_name: clientName,
        date,
        spoken: `Done. ${whose} is marked completed.`,
      });
    } catch (err) {
      logger.error({ err: err.message }, 'voice workout complete failed');
      next(err);
    }
  });

module.exports = router;
