const router = require('express').Router();
const { randomUUID } = require('crypto');
const pool = require('../../db/pool');
const { optionalNumber, parseStrict } = require('../../lib/zodNumbers');
const { auth, requireTrainer } = require('../../middleware/auth');
const memberGoals = require('../client-portal/member-goals.service');
const { validate } = require('../../middleware/validate');
const { z } = require('../../lib/validation');
const logger = require('../../lib/logger');
const svc = require('./pt-os.service');
const { orgIdOf, tenantScope } = require('../../lib/tenant-db');
const { resolveTrainerId, trainerForOrg } = require('../../lib/studioTrainer');
const { today: studioToday } = require('../../lib/appTime');
const { hasPtTermSql } = require('../../lib/ptTerm');
const subscription = require('../../lib/subscription');
const { buildBrief } = require('./training-brief');
const { sweepRoster } = require('./client-context');
const { buildEnrollmentPdf } = require('../../lib/ptEnrollmentPdf');
const { buildSnapshot } = require('./client-snapshot');
const { generateCoach } = require('./coach-ai');
const { generateCheckinInsight, MAX_WEEKS } = require('./checkin-ai');
const { buildRecovery } = require('./recovery');
const { routedChat } = require('../../lib/ai/router');
const { meteredChat } = require('../../lib/ai/metering');
const { requireAiQuota } = require('../../lib/aiQuota');
const { aiLimiter } = require('../../middleware/aiRateLimit');
const { logActivity } = require('../../lib/activityLog');
const { recordPtPayment } = require('../../lib/ptPayments');
const { renewClient } = require('./renewal.service');
const { genReceiptNo } = require('../../db/receipts');
const { checkTrainingEligibility, enrolmentScreeningBlock, screeningSummary } = require('../../lib/screeningGate');
const { parseClientPhoto, PhotoInputError } = require('../../lib/clientPhoto');

/**
 * Where a client found the studio.
 *
 * A closed set for the same reason PAYMENT_METHODS below is one: this column
 * exists to be grouped by — "how many clients did Instagram bring us last
 * quarter" — and "Instagram", "instagram" and "IG" are three channels to a
 * GROUP BY and one to a human. The labels are stored verbatim so a report
 * needs no lookup table.
 *
 * Kept here rather than as a CHECK constraint in migration 163: adding an
 * option should be a one-line change, not a migration that must be deployed
 * strictly before the code that writes the new value.
 */
const CLIENT_SOURCES = [
  'Walk-in', 'Instagram', 'WhatsApp', 'Referral',
  'Existing Member', 'Google', 'Website', 'Other',
];

const ptClientCreateSchema = {
  body: z.object({
    name: z.string().min(1).max(255),
    mobile: z.string().regex(/^[6-9]\d{9}$/, 'Invalid Indian mobile number').optional().nullable(),
    email: z.string().email().optional().nullable(),
    dob: z.string().optional().nullable(),
    gender: z.string().max(20).optional().nullable(),
    trainer_id: z.string().uuid().optional().nullable(),
    trainer_name: z.string().max(255).optional().nullable(),
    goal: z.string().max(100).optional().nullable(),
    // optionalNumber, not z.coerce.number(): the latter turns '' into 0, and a
    // height of 0 cm or a weight of 0 kg is handed straight to the scoring
    // libraries, which compute a BMI from it and store the result as a reading.
    // Blank must stay blank.
    height: optionalNumber({ label: 'height', min: 50, max: 250 }),
    weight: optionalNumber({ label: 'weight', min: 20, max: 350 }),
    body_fat: optionalNumber({ label: 'body_fat', min: 3, max: 70 }),
    health_conditions: z.string().max(500).optional().nullable(),
    injuries: z.string().max(500).optional().nullable(),
    frequency: z.string().max(50).optional().nullable(),
    notes: z.string().max(2000).optional().nullable(),
    monthly_pt_amount: optionalNumber({ label: 'monthly_pt_amount', min: 0, max: 10_000_000 }),
    base_amount: optionalNumber({ label: 'base_amount', min: 0, max: 10_000_000 }),
    discount: optionalNumber({ label: 'discount', min: 0, max: 10_000_000 }),
    pt_start_date: z.string().optional().nullable(),
    pt_end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(d => !isNaN(Date.parse(d)), 'Invalid date').optional().nullable(),
    pt_package_id: z.string().optional().nullable(),
    client_id: z.string().optional().nullable(),
    package_type: z.string().optional().nullable(),
    duration_months: optionalNumber({ label: 'duration_months', min: 1, max: 120, int: true }),
    base_price: optionalNumber({ label: 'base_price', min: 0, max: 10_000_000 }),
    selling_price: optionalNumber({ label: 'selling_price', min: 0, max: 10_000_000 }),
    whatsapp: z.string().regex(/^[6-9]\d{9}$/, 'Invalid Indian mobile number').optional().nullable(),
    occupation: z.string().max(100).optional().nullable(),
    emergency_contact: z.string().max(255).optional().nullable(),
    emergency_phone: z.string().regex(/^[6-9]\d{9}$/, 'Invalid Indian mobile number').optional().nullable(),
    emergency_contact_relationship: z.string().max(100).optional().nullable(),
    address: z.string().max(1000).optional().nullable(),
    // Closed set — see CLIENT_SOURCES. Empty string is accepted and stored as
    // NULL below, because "not answered" is a real state and an enum that
    // rejects '' makes the form unsubmittable when the operator skips it.
    client_source: z.enum(CLIENT_SOURCES).or(z.literal('')).optional().nullable(),
  }).refine((b) => b.discount == null || b.base_amount == null || b.discount <= b.base_amount,
    { message: 'discount cannot exceed base_amount', path: ['discount'] }),
};

const automation = require('../automation/automation.triggers');

// The studio trainer only. server.js mounts this router behind requireTrainer
// too; declaring it here as well means the guard travels with the router and
// cannot be lost if the mount is edited or the router is mounted again.
router.use(auth, requireTrainer);

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Tenant-scope predicate for by-id / aggregate pt_clients queries. Appends the
// caller's org id to `params` and returns ` AND <col> = $N` — always; there
// is no unfiltered case. Every read/write that targets a client by id must AND
// this in, otherwise one studio can read, edit, or delete another studio's
// rows (cross-tenant IDOR).
/**
 * How an enrolling payment was taken.
 *
 * A closed set rather than free text: this column is read back by finance
 * screens that group by it, and "UPI", "upi" and "Upi " are three payment
 * methods to a GROUP BY and one to a human.
 */
const PAYMENT_METHODS = ['CASH', 'UPI', 'CARD', 'BANK_TRANSFER', 'SPLIT'];

function orgWhere(req, params, col = 'organization_id') {
  const scope = tenantScope(req);
  params.push(scope.orgId);
  return ` AND ${col} = $${params.length}`;
}

// True if `clientId` is a live client of the caller's org. Used to gate reads of a client's
// child records (renewals, communication, subscriptions) whose own tables
// carry no organization_id — the tenant boundary is the parent client.
async function clientInOrg(req, clientId) {
  const params = [clientId];
  const orgClause = orgWhere(req, params);
  const { rowCount } = await pool.query(
    `SELECT 1 FROM pt_clients WHERE id = $1 AND deleted_at IS NULL${orgClause}`,
    params
  );
  return rowCount > 0;
}

// ─── The studio's trainer profile ───────────────────────────
// Read-only. Forms that store a trainer_id (enrolment, sessions, payments)
// pick from this list, and every such write re-checks the id against this
// same studio (lib/studioTrainer.js). There is no create/update/delete here:
// the studio's trainer profile is created with the studio and belongs to its
// one trainer account.
//
// Scoped by organization, and NULL organization_id is excluded rather than
// treated as shared: an unattributable profile shown to every studio is the
// cross-tenant leak this route was once fixed for.
router.get('/trainers', auth, wrap(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT id, name, email, mobile, specialization, incentive_rate, status, NULL::text AS photo_url
    FROM trainers
    WHERE deleted_at IS NULL AND status = 'active' AND organization_id = $1
    ORDER BY name
  `, [orgIdOf(req)]);
  res.json({ data: rows });
}));

// ─── Dashboard stats ─────────────────────────────────────────
router.get('/dashboard', auth, wrap(async (req, res) => {
  const stats = await svc.getDashboardStats(tenantScope(req));
  res.json({ data: stats });
}));

// ─── Active PT clients ───────────────────────────────────────
// GET /signals
//
// What the roster says without being asked.
//
// ── Why this endpoint exists ───────────────────────────────────────────────
//
// Every other read in this module answers a question about ONE client, when
// somebody opens them. Measured on the live database: 1 client had trained in
// the last 7 days, 16 last trained 15-30 days ago, and nothing anywhere raised
// a flag about any of them.
//
// Two reasons, both specific. client-snapshot.js's `missed_workout` fires only
// on a session that was scheduled and not completed — correct for a missed
// appointment, and blind to a client who simply stops booking. And every alert
// it does raise is computed on profile open, so finding the seven clients who
// matter meant opening thirty-four profiles.
//
// This sweeps instead, across the trainer's whole studio. Read-only, and it
// decides nothing — the signals carry evidence and a recommendation, and the
// trainer decides.
router.get('/signals', auth, wrap(async (req, res) => {
  const weeks = Number(req.query.weeks);

  const data = await sweepRoster(orgIdOf(req), {
    trainerId: null,
    windowWeeks: Number.isFinite(weeks) && weeks > 0 ? weeks : undefined,
    today: studioToday(),
  });
  res.json({ data });
}));

router.get('/clients', auth, wrap(async (req, res) => {
  // The trainer owns the studio, so the list is the studio's whole roster;
  // tenantScope() is the only narrowing. search/status/dues/limit/offset are
  // inherited from the retired GET /api/clients, whose callers still pass them.
  const rows = await svc.getActiveClients(tenantScope(req), {
    search: req.query.search,
    status: req.query.status,
    dues: req.query.dues,
    limit: req.query.limit,
    offset: req.query.offset,
    includeDeleted: req.query.include_deleted === '1',
  });
  res.json({ data: rows, total: rows.length });
}));

// ─── Inherited from the retired /api/clients mount ───────────
//
// These three were the only endpoints on that mount whose behaviour did not
// already exist here; the other four (list, get, update, delete) duplicated a
// pt-os handler over the same pt_clients table. All the SQL lives in
// pt-os.service.js, so this adapter's literal count is unchanged.
//
// `/clients/search` MUST stay above `/clients/:id`, like /duplicates and
// /birthdays above — otherwise Express matches "search" as an id.
router.get('/clients/search', auth, wrap(async (req, res) => {
  // Studio-wide within the trainer's own organization: tenantScope() is the
  // boundary, and there is no narrower staff roster to restrict to.
  const rows = await svc.searchClients({
    q: req.query.q,
    limit: req.query.limit,
    scope: tenantScope(req),
  });
  res.json(rows);
}));

/**
 * One client's check-in history and payment history.
 *
 * Both resolve the client first, org-scoped. A client that is not this
 * studio's answers 404, exactly like one that does not exist — answering 403
 * would confirm the id is real somewhere else.
 */
async function clientHistory(req, res, load) {
  const client = await svc.findClientForAccess(req.params.id, tenantScope(req));
  if (!client) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
  const rows = await load(req.params.id, { limit: req.query.limit, offset: req.query.offset });
  return res.json(rows);
}

router.get('/clients/:id/attendance', auth, wrap((req, res) =>
  clientHistory(req, res, svc.getClientAttendance)));

router.get('/clients/:id/payments', auth, wrap((req, res) =>
  clientHistory(req, res, svc.getClientPayments)));

// Feb 29 only exists every 4th year — re-applying a Feb-29 birth date to an
// arbitrary year needs to fall back to Feb 28 in the years that aren't leap
// years. Every other month/day pair is always valid in every year, so this
// is the one case that needs special-casing.
const isLeapYear = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

// Days from `todayUTC` to the next occurrence of `birthMonth`/`birthDay`
// (0 if today IS the birthday), plus the age the client turns that day.
// All math is done in UTC on date-only values (no time-of-day component) so
// it is not sensitive to server timezone.
function nextBirthday(birthMonth, birthDay, birthYear, todayUTC) {
  const y = todayUTC.getUTCFullYear();
  const dayIn = (year) => (birthMonth === 2 && birthDay === 29 && !isLeapYear(year)) ? 28 : birthDay;
  let next = Date.UTC(y, birthMonth - 1, dayIn(y));
  if (next < todayUTC.getTime()) next = Date.UTC(y + 1, birthMonth - 1, dayIn(y + 1));
  const days_until = Math.round((next - todayUTC.getTime()) / 86400000);
  const turning_age = new Date(next).getUTCFullYear() - birthYear;
  return { days_until, turning_age };
}

// ─── Client birthdays (MUST be before /clients/:id) ──────────
router.get('/clients/birthdays', auth, wrap(async (req, res) => {
  const params = [];
  // Qualified, because this query joins trainers and BOTH tables carry an
  // organization_id. Unqualified, Postgres cannot resolve which one is meant
  // and throws "column reference organization_id is ambiguous" — a 500 on
  // every single call. It threw 49 times in one day before anybody noticed,
  // because the only thing it broke was a page nobody had open.
  const orgClause = orgWhere(req, params, 'c.organization_id');
  const [{ rows: todayRows }, { rows }] = await Promise.all([
    pool.query('SELECT CURRENT_DATE AS today'),
    pool.query(`
      SELECT c.id, c.name, c.mobile, c.email, c.photo_url, c.dob, c.status,
             c.trainer_id, COALESCE(t.name, c.trainer_name) AS trainer_name
      FROM pt_clients c
      LEFT JOIN trainers t ON t.id = c.trainer_id AND t.organization_id = c.organization_id
      WHERE c.deleted_at IS NULL AND c.dob IS NOT NULL${orgClause}
      ORDER BY c.name
    `, params),
  ]);

  const todayUTC = new Date(todayRows[0].today);
  const enriched = rows.map((c) => {
    const dob = new Date(c.dob);
    const { days_until, turning_age } = nextBirthday(
      dob.getUTCMonth() + 1, dob.getUTCDate(), dob.getUTCFullYear(), todayUTC,
    );
    return { ...c, days_until_birthday: days_until, turning_age, is_today: days_until === 0 };
  }).sort((a, b) => a.days_until_birthday - b.days_until_birthday || a.name.localeCompare(b.name));

  res.json({ data: enriched, total: enriched.length, today_count: enriched.filter((c) => c.is_today).length });
}));

// ─── Single client details ──────────────────────────────────
// ─── Enrolment form as a PDF (MUST be before /clients/:id) ──────────
//
// Streamed, not stored. The document is built from live client columns, so a
// saved copy would be a stale copy of a query and the studio would eventually
// download last month's version of this month's enrolment.
router.get('/clients/:id/enrollment-pdf', auth, wrap(async (req, res) => {
  const params = [req.params.id];
  const orgClause = orgWhere(req, params, 'c.organization_id');
  const { rows } = await pool.query(
    `SELECT c.* FROM pt_clients c WHERE c.id = $1 AND c.deleted_at IS NULL${orgClause}`,
    params,
  );
  const client = rows[0];
  if (!client) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });

  const buffer = await buildEnrollmentPdf(client, req.user?.organization_name);

  // A filename the studio can find again in a downloads folder six weeks
  // later. Non-filename characters out, because a client called "Priya
  // (Mon/Wed)" would otherwise produce a path, not a name.
  const safeName = String(client.name || 'client').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Length', buffer.length);
  res.setHeader('Content-Disposition', `attachment; filename="pt-enrolment-${safeName || 'client'}.pdf"`);
  res.send(buffer);
}));

// The CURRENT PT TERM's money is defined HERE, once, and nowhere else.
//
// Three tables carry financial numbers for a PT client, and before this none
// of them was authoritative on its own:
//
//   pt_clients.final_amount     the CURRENT term's fee. Set at enrollment,
//                               overwritten by /renew. Always current-term.
//   pt_clients.paid_amount      LIFETIME paid, not this term's. /renew does
//                               `paid_amount + paidNow`, and every payment
//                               increments it, so it accumulates across terms.
//   pt_clients.balance_amount   `final_amount - paid_amount`, which mixes a
//                               current-term fee with a lifetime payment total
//                               and therefore understates the balance for any
//                               client who has ever renewed.
//   pt_client_subscriptions     a per-term SNAPSHOT, written once at
//                               enrollment/renewal and never updated again.
//                               No payment path touches it, so the moment a
//                               client pays anything after enrolling, its
//                               amount_paid/balance_amount are stale.
//
// The profile page used to read the subscription snapshot in preference to
// the client row, which is backwards: the snapshot is the one source that is
// guaranteed NOT to reflect later payments. Production showed both failure
// modes — a client whose only snapshot row was written with zeros still shows
// 0/0/0 while the client row and the payment ledger both said 80000/60000/
// 20000; and a renewed client whose lifetime paid (20000) is not their
// current term's paid (11000).
//
// So the rule is: the current term's numbers come from the LIVE client row,
// and subscription history is used ONLY to subtract terms that are already
// closed:
//
//   fee     = final_amount                       (already current-term)
//   paid    = paid_amount - SUM(prior terms)     (lifetime minus closed terms)
//   balance = GREATEST(fee - paid, 0)
//
// "Prior" means a subscription whose start_date is strictly before the
// client's current pt_start_date. A row with a NULL start_date, or one
// starting on/after the current term, is never treated as prior — so a junk
// or zero-value snapshot can only ever be ignored, never subtracted. That is
// deliberate: this must fail towards the live record, not towards history.
//
// pt_payments is NOT the source of "paid this term" even though it is the one
// complete ledger, because it carries no term attribution: `date` is the
// data-entry date (CURRENT_DATE at the time of recording), so a renewed
// client's older payments routinely carry dates inside the current term. A
// date window over that ledger would over-count. Attributing payments to
// terms needs a subscription_id on pt_payments, which is a schema change and
// a backfill this fix deliberately does not make.
router.get('/clients/:id', auth, wrap(async (req, res) => {
  const params = [req.params.id];
  const orgClause = orgWhere(req, params, 'c.organization_id');
  const { rows } = await pool.query(`
    SELECT t.*,
           GREATEST(t.current_term_fee - t.current_term_paid, 0) AS current_term_balance,
           CASE
             WHEN GREATEST(t.current_term_fee - t.current_term_paid, 0) > 0
              AND t.pt_end_date IS NOT NULL AND t.pt_end_date::TEXT != ''
              AND t.pt_end_date::DATE < CURRENT_DATE THEN 'OVERDUE'
             WHEN GREATEST(t.current_term_fee - t.current_term_paid, 0) > 0 THEN 'DUE'
             ELSE 'CLEAR'
           END AS due_status
    FROM (
      SELECT c.*,
             -- Enroll vs Renew is decided from this, never from pt_start_date
             -- (see lib/ptTerm.js).
             ${hasPtTermSql('c')} AS has_pt_term,
             CASE
               WHEN c.pt_end_date IS NOT NULL AND c.pt_end_date::TEXT != ''
               THEN c.pt_end_date::DATE - CURRENT_DATE
               ELSE NULL
             END AS days_left,
             COALESCE(pp.total_incentives, 0) AS total_earned_commission,
             COALESCE(c.final_amount, 0) AS current_term_fee,
             GREATEST(COALESCE(c.paid_amount, 0) - COALESCE(prior.paid, 0), 0) AS current_term_paid
      FROM pt_clients c
      LEFT JOIN (
        SELECT client_id, SUM(incentive_amt) AS total_incentives
        FROM pt_payments
        WHERE deleted_at IS NULL
        GROUP BY client_id
      ) pp ON pp.client_id = c.id
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(s.amount_paid), 0) AS paid
        FROM pt_client_subscriptions s
        WHERE s.client_id = c.id
          AND s.start_date IS NOT NULL
          AND c.pt_start_date IS NOT NULL
          AND s.start_date < c.pt_start_date
      ) prior ON TRUE
      WHERE c.id = $1 AND c.deleted_at IS NULL${orgClause}
    ) t
  `, params);
  if (rows.length === 0) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
  // Screening as the training gate reads it (lib/screeningGate), so the
  // profile shows the same status and the real block reason.
  res.json({ data: { ...rows[0], screening: await screeningSummary(rows[0].id) } });
}));

// ─── Create / enroll client in PT ───────────────────────────
router.post('/clients', auth, requireTrainer, validate(ptClientCreateSchema), wrap(async (req, res) => {
      try {
        const {
          client_id, name, gender, mobile, email, dob,
          trainer_name: reqTrainerName, package_type, base_amount, discount,
          pt_start_date, pt_end_date, duration_months, monthly_pt_amount,
          notes, weight,
          goal, height, body_fat, health_conditions, injuries, frequency,
          pt_package_id,
          whatsapp, occupation, emergency_contact, emergency_phone, address,
          emergency_contact_relationship, client_source,
        } = req.body;
    // Only ever a trainer profile in this studio — see lib/studioTrainer.js.
    const trainer_id = await resolveTrainerId(pool, orgIdOf(req), req.body.trainer_id);

    // Enrolling here would skip screening. A new client cannot have signed a
    // consent or answered a PAR-Q before they exist, so a package on create is
    // refused: add the client, screen them, then enrol (PATCH /clients/:id).
    // An existing client named by client_id is held to the same rule as
    // enrolment if they have never had a term.
    const wantsTerm = Boolean(pt_end_date) || Number(duration_months) > 0 || Boolean(pt_package_id);
    if (wantsTerm && !client_id) {
      return res.status(409).json({ error: {
        code: 'SCREENING_REQUIRED',
        message: 'Add the client first, complete their Informed Consent and PAR-Q, then enrol them in PT.',
        missing: ['informed_consent', 'parq'],
      } });
    }
    if (wantsTerm && client_id) {
      const tParams = [client_id];
      const tOrg = orgWhere(req, tParams, 'c.organization_id');
      const { rows: [termRow] } = await pool.query(
        `SELECT ${hasPtTermSql('c')} AS has_pt_term FROM pt_clients c
          WHERE c.id = $1 AND c.deleted_at IS NULL${tOrg}`, tParams);
      if (!termRow) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
      if (!termRow.has_pt_term) {
        const blocked = await enrolmentScreeningBlock(req, client_id);
        if (blocked) return res.status(blocked.status).json(eligibilityError(blocked));
      }
    }

    let cid = client_id;
    if (!cid) {
      // Plan client-limit enforcement (SaaS). Adding a brand-new client to the
      // roster is blocked once the studio hits its plan's client limit; existing
      // clients stay fully accessible. Unlimited plans (limit null) never block.
      const { limit, count, atLimit } = await subscription.clientLimitStatus(orgIdOf(req));
      if (atLimit) {
        return res.status(403).json({
          error: {
            code: 'PLAN_LIMIT_REACHED',
            message: `You've reached your plan's limit of ${limit} clients. Upgrade your plan to add more.`,
            limit, count,
          },
        });
      }

      // Multi-tenant isolation (Phase 1): stamp the creator's organization so
      // the new client is only ever visible within that tenant's workspace.
      const { rows: [newCli] } = await pool.query(`
        INSERT INTO pt_clients
          (name, gender, mobile, email, dob, status, joining_date,
           whatsapp, occupation, emergency_contact, emergency_phone, address,
           emergency_contact_relationship, client_source, organization_id)
        VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8,$9,$10,$11,$12,$13,$14)
        RETURNING id
      `, [
        name, gender || null, mobile || null, email || null, dob || null, pt_start_date || new Date(),
        whatsapp || null, occupation || null, emergency_contact || null, emergency_phone || null, address || null,
        emergency_contact_relationship || null, client_source || null,
        orgIdOf(req),
      ]);
      cid = newCli.id;
      // Fires only on a genuinely new client. The branch above this reuses an
      // existing one, and a welcome message to somebody who enrolled last year
      // is worse than none.
      await automation.memberCreated(req, { clientId: cid });
    }

    const finalAmt = (base_amount || 0) - (discount || 0);

    // Trainer name: use value sent directly by frontend first, then fall back to DB lookup
    let resolvedTrainerName = reqTrainerName || null;
    if (!resolvedTrainerName && trainer_id) {
      resolvedTrainerName = (await trainerForOrg(pool, orgIdOf(req), trainer_id))?.name || null;
    }

    // Resolve plan name / duration from the selected package when not sent directly
    let resolvedPackageType = package_type || null;
    let resolvedDurationMonths = duration_months || null;
    if (pt_package_id && (!resolvedPackageType || !resolvedDurationMonths)) {
      const { rows: [plan] } = await pool.query(
        'SELECT name, duration_months FROM pt_plans WHERE id = $1', [pt_package_id]
      );
      if (plan) {
        resolvedPackageType = resolvedPackageType || plan.name;
        resolvedDurationMonths = resolvedDurationMonths || plan.duration_months;
      }
    }

    // A term exists only when one is being created here: an end date was sent,
    // or a duration to compute it from. A bare add (name, phone, details) is
    // NOT an enrollment, so it gets no PT dates at all. This used to default
    // pt_start_date to today for every new client, and the profile read that
    // date as "enrolled" and offered Renew to people who had never had a term
    // (see lib/ptTerm.js). joining_date above still records the sign-up day.
    const creatingTerm = Boolean(pt_end_date) || Number(resolvedDurationMonths) > 0;
    const startDate = creatingTerm ? (pt_start_date || studioToday()) : (pt_start_date || null);
    let endDate = pt_end_date || null;
    if (!endDate && resolvedDurationMonths && resolvedDurationMonths > 0) {
      const d = new Date(startDate);
      d.setMonth(d.getMonth() + Number(resolvedDurationMonths));
      endDate = d.toISOString().slice(0, 10);
    }

    const { rows } = await pool.query(`
      UPDATE pt_clients SET
        trainer_id        = COALESCE($2,  trainer_id),
        trainer_name      = COALESCE($3,  trainer_name),
        package_type      = COALESCE($4,  package_type),
        base_amount       = COALESCE($5,  base_amount),
        discount          = COALESCE($6,  discount),
        final_amount      = COALESCE($7,  final_amount),
        balance_amount    = GREATEST(COALESCE($7, final_amount) - paid_amount, 0),
        monthly_pt_amount = COALESCE($8,  monthly_pt_amount),
        pt_start_date     = COALESCE($9,  pt_start_date),
        pt_end_date       = COALESCE($10, pt_end_date),
        duration_months   = COALESCE($11, duration_months),
        notes             = COALESCE($12, notes),
        weight            = COALESCE($13, weight),
        goal              = COALESCE($14, goal),
        height            = COALESCE($15, height),
        body_fat          = COALESCE($16, body_fat),
        health_conditions = COALESCE($17, health_conditions),
        injuries          = COALESCE($18, injuries),
        frequency         = COALESCE($19, frequency),
        -- Contact/identity fields used to be validated and then discarded on
        -- this path (only the INSERT stored them): a corrected phone number
        -- on an enrol-existing-client call 201'd into nothing.
        mobile            = COALESCE($20, mobile),
        email             = COALESCE($21, email),
        gender            = COALESCE($22, gender),
        dob               = COALESCE($23, dob),
        whatsapp          = COALESCE($24, whatsapp),
        occupation        = COALESCE($25, occupation),
        emergency_contact = COALESCE($26, emergency_contact),
        emergency_phone   = COALESCE($27, emergency_phone),
        emergency_contact_relationship = COALESCE($28, emergency_contact_relationship),
        address           = COALESCE($29, address),
        client_source     = COALESCE($30, client_source),
        -- Promote to 'active' only once the client is actually enrolled in a
        -- package (has an end date, a charged amount, or a duration). A name-only
        -- add stays 'pending' so it never shows in the active-clients list/counts.
        -- Existing enrolled clients keep 'active' since COALESCE preserves their
        -- stored package fields even when this edit doesn't touch them.
        status = CASE
          WHEN COALESCE($10, pt_end_date) IS NOT NULL
            OR COALESCE($7, final_amount) > 0
            OR COALESCE($11, duration_months) > 0
          THEN 'active'
          ELSE status
        END,
        updated_at = NOW()
      WHERE id = $1 AND deleted_at IS NULL AND organization_id = $31
      RETURNING *
    `, [
      cid,
      trainer_id, resolvedTrainerName, resolvedPackageType,
      base_amount, discount, finalAmt, monthly_pt_amount,
      startDate, endDate, resolvedDurationMonths,
      notes || null, weight != null ? Number(weight) : null,
      goal || null, height != null ? Number(height) : null,
      body_fat != null ? Number(body_fat) : null,
      health_conditions || null, injuries || null, frequency || null,
      mobile || null, email || null, gender || null, dob || null,
      whatsapp || null, occupation || null, emergency_contact || null,
      emergency_phone || null, emergency_contact_relationship || null,
      address || null, client_source || null,
      orgIdOf(req),
    ]);
    // A client_id from the body that is not a live client of THIS studio
    // updates nothing. 404, not 403: another studio's id must look exactly
    // like one that does not exist.
    if (!rows.length) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
    }

    await logActivity(req, 'client.create', 'pt_client', rows[0].id, rows[0]);
    res.status(201).json({ data: rows[0] });
  } catch (err) {
    logger.error({ err: err.message, body: req.body, user: req.user?.id }, 'PT OS create client failed');
    throw err;
  }
}));

// ─── Renewal history for a client ───────────────────────────
router.get('/clients/:id/renewals', auth, wrap(async (req, res) => {
  if (!await clientInOrg(req, req.params.id))
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
  const { rows } = await pool.query(
    `SELECT * FROM pt_client_renewals WHERE client_id = $1 ORDER BY renewed_at DESC`,
    [req.params.id]
  );
  res.json({ data: rows });
}));

// ─── Renew PT client ────────────────────────────────────────
//
// The work — one transaction, the client locked, duplicate submits refused,
// the payment on the ledger with a receipt number — is renewal.service.js
// (payments audit PAY-2). What stays here is the request contract.
const MAX_MONEY = 10_000_000; // ₹1 crore: far above any PT term, far below a typo's reach
const money = () => z.coerce.number().min(0).max(MAX_MONEY).optional().nullable();
const renewSchema = {
  body: z.object({
    pt_start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'pt_start_date must be YYYY-MM-DD')
      .refine((v) => !Number.isNaN(Date.parse(v.slice(0, 10))), 'pt_start_date is not a valid date'),
    duration_months: z.coerce.number().int().min(1).max(60),
    base_amount: money(),
    discount: money(),
    final_amount: money(),
    paid_amount: money(),
    monthly_pt_amount: money(),
    package_type: z.string().max(100).optional().nullable(),
    payment_method: z.string().transform((v) => v.toUpperCase())
      .refine((v) => PT_PAYMENT_METHODS.has(v), 'payment_method must be CASH, UPI, CARD or BANK_TRANSFER')
      .optional().nullable(),
    notes: z.string().max(1000).optional().nullable(),
  }).refine((b) => b.discount == null || b.base_amount == null || b.discount <= b.base_amount,
    { message: 'discount cannot exceed base_amount', path: ['discount'] }),
};

router.post('/clients/:id/renew', auth, requireTrainer, validate(renewSchema), wrap(async (req, res) => {
  const result = await renewClient(req, req.params.id, req.body);
  if (result.notFound) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
  }
  if (result.notEnrolled) {
    return res.status(409).json({ error: {
      code: 'NOT_ENROLLED',
      message: 'This client has no PT term to renew. Enroll them in PT first.',
    } });
  }
  if (result.duplicate) {
    return res.status(409).json({ error: { code: 'DUPLICATE_RENEWAL', message: 'This renewal was just recorded — it has not been added twice.' } });
  }
  if (result.overpaid != null) {
    return res.status(400).json({ error: {
      code: 'OVERPAID',
      message: `Amount paid (Rs. ${result.overpaid}) is more than the client owes including this term (Rs. ${result.owed}).`,
    } });
  }
  res.json({ data: result.client });
}));

// ─── Update PT client ───────────────────────────────────────
router.patch('/clients/:id', auth, requireTrainer, wrap(async (req, res) => {
  // The trainer owns the studio and may edit every field of their own
  // clients. Payment fields (final_amount, paid_amount) are handled separately
  // below — validated, with balance_amount recomputed server-side — rather
  // than through the generic allowlist loop.
  const allowed = ['package_type','base_amount','discount',
       'monthly_pt_amount','trainer_id','trainer_name','pt_start_date','pt_end_date',
       'duration_months','status','notes',
       'name','email','mobile','gender','dob','address','weight','photo_url','emergency_contact','emergency_phone',
       'emergency_contact_relationship','client_source',
       'goal','height','body_fat','health_conditions','injuries','frequency',
       'training_mode','preferred_workout_time','preferred_training_days','sessions_per_week',
       'workout_experience_level','previous_trainer_experience',
       'agreement_accepted_at','agreement_signature','agreement_text',
       'payment_method',
       // Migration 226. Recorded when the client asks the studio to stop a
       // channel; the change is stamped below and kept in activity_log.
       'whatsapp_opt_out','email_opt_out'];

  // trainer_id is a foreign key from the request: it must name a trainer
  // profile in THIS studio, or the edit is refused. Normalised in place (the
  // same way client_source is below) so the allowlist loop stores the checked
  // value and nothing else.
  if (req.body.trainer_id !== undefined) {
    req.body.trainer_id = await resolveTrainerId(pool, orgIdOf(req), req.body.trainer_id);
  }

  // A free-text payment method is a reporting column nobody can group by.
  if (req.body.payment_method !== undefined && req.body.payment_method !== null) {
    if (!PAYMENT_METHODS.includes(String(req.body.payment_method))) {
      return res.status(400).json({
        error: { code: 'VALIDATION', message: `payment_method must be one of: ${PAYMENT_METHODS.join(', ')}` },
      });
    }
  }

  // Same treatment for the acquisition channel, and for the same reason: this
  // route has no zod schema, so without this check the closed set enforced on
  // create is bypassable by editing the client afterwards. '' clears it.
  if (req.body.client_source !== undefined && req.body.client_source !== null) {
    if (req.body.client_source === '') {
      // Normalized rather than stored, so "not answered" is NULL here exactly
      // as it is on create. Two representations of unanswered would mean every
      // report needs to remember both.
      req.body.client_source = null;
    } else if (!CLIENT_SOURCES.includes(String(req.body.client_source))) {
      return res.status(400).json({
        error: { code: 'VALIDATION', message: `client_source must be one of: ${CLIENT_SOURCES.join(', ')}` },
      });
    }
  }

  // ── Shape of the edit, before anything is locked ─────────────────────
  //
  // This route has no zod schema, so a status nobody can report on, a phone
  // number the WhatsApp sender rejects, or "2026-02-30" as an end date all
  // used to be stored. The create schema's rules, applied to the edit.
  const body = req.body;
  // The same check as the photo upload: an image, by its bytes, under 1 MB.
  // '' or null removes the photo.
  if (body.photo_url !== undefined) {
    if (body.photo_url === '' || body.photo_url === null) body.photo_url = null;
    else {
      try {
        body.photo_url = parseClientPhoto(body.photo_url);
      } catch (err) {
        if (!(err instanceof PhotoInputError)) throw err;
        return res.status(400).json({ error: { code: 'INVALID_PHOTO', field: 'photo_url', message: err.message } });
      }
    }
  }
  for (const key of ['mobile', 'whatsapp', 'emergency_phone']) {
    if (body[key] === '') body[key] = null;
    if (body[key] != null && !INDIAN_MOBILE_RE.test(String(body[key]))) {
      return res.status(400).json({ error: { code: 'VALIDATION', field: key, message: `${key} must be a 10-digit Indian mobile number.` } });
    }
  }
  if (body.email === '') body.email = null;
  if (body.email != null && !EMAIL_RE.test(String(body.email))) {
    return res.status(400).json({ error: { code: 'VALIDATION', field: 'email', message: 'email is not a valid address.' } });
  }
  for (const key of ['dob', 'pt_start_date', 'pt_end_date']) {
    if (body[key] === '') body[key] = null;
    if (body[key] != null && !isCalendarDate(String(body[key]).slice(0, 10))) {
      return res.status(400).json({ error: { code: 'VALIDATION', field: key, message: `${key} must be a real date (YYYY-MM-DD).` } });
    }
  }
  for (const key of ['whatsapp_opt_out', 'email_opt_out']) {
    if (body[key] !== undefined && typeof body[key] !== 'boolean') {
      return res.status(400).json({ error: { code: 'VALIDATION', field: key, message: `${key} must be true or false.` } });
    }
  }
  if (body.status !== undefined && !CLIENT_STATUSES.includes(body.status)) {
    return res.status(400).json({ error: { code: 'VALIDATION', field: 'status', message: `status must be one of: ${CLIENT_STATUSES.join(', ')}` } });
  }
  if (body.duration_months != null && body.duration_months !== '') {
    const m = Number(body.duration_months);
    if (!Number.isInteger(m) || m < 1 || m > 60) {
      return res.status(400).json({ error: { code: 'VALIDATION', field: 'duration_months', message: 'duration_months must be a whole number of months between 1 and 60.' } });
    }
  }

  const wantsFinalAmount = req.body.final_amount !== undefined;
  const wantsPaidAmount  = req.body.paid_amount !== undefined;

  let finalAmount = null;
  let paidAmount = null;
  let previousPaid = null;

  // ── One transaction, the client row locked ────────────────────────────
  //
  // The client update, the first term in pt_client_subscriptions and the
  // ledger row in pt_payments used to be three separate statements on the
  // pool, after an unlocked read of paid_amount. Two saves of one enrolment
  // in flight together — the enroll page retries a save that timed out, and
  // the first may still be running — both read paid_amount = 0 and both
  // booked the whole amount as a payment; and a failure between the UPDATE
  // and the ledger INSERT left paid_amount raised with no payment behind it.
  //
  // Now the row is locked FOR UPDATE before anything is read (as Renew and
  // Record Payment already do), and all three writes commit or none do. A
  // repeat of the same save waits for the first, then reads the amount it
  // recorded: paid_amount is absolute, so the repeat books no second payment
  // and finds the term already written. Side effects (assignment sync, the
  // payment_received automation, the activity log) run after COMMIT.
  const tx = await pool.connect();
  let rows = null;
  let ledger = null;
  try {
    await tx.query('BEGIN');
    // Every refusal below ends the transaction before answering.
    const refuse = async (status, body) => {
      await tx.query('ROLLBACK');
      return res.status(status).json(body);
    };

    const exParams = [req.params.id];
    const exOrg = orgWhere(req, exParams);
    const { rows: existingRows } = await tx.query(
      `SELECT final_amount, paid_amount,
              (SELECT COUNT(*) FROM pt_client_renewals r WHERE r.client_id = pt_clients.id)::int AS renewals,
              ${hasPtTermSql('pt_clients')} AS has_pt_term,
              to_char(pt_start_date, 'YYYY-MM-DD') AS start_date,
              to_char(pt_end_date, 'YYYY-MM-DD') AS end_date,
              to_char(CURRENT_DATE, 'YYYY-MM-DD') AS today
         FROM pt_clients WHERE id = $1 AND deleted_at IS NULL${exOrg}
          FOR UPDATE`,
      exParams
    );
    if (existingRows.length === 0) return refuse(404, { error: { code: 'NOT_FOUND', message: 'Client not found' } });
    const existing = existingRows[0];

    // ── The term, under the lock ──────────────────────────────────────────
    //
    // A renewed client's current term is Renew's to change (its arithmetic
    // and history live there); this route changing the dates or duration
    // would rewrite a term with no renewal row behind it.
    if (existing.renewals > 0 && TERM_FIELDS.some((k) => body[k] !== undefined)) {
      return refuse(409, { error: {
        code: 'USE_RENEW',
        message: 'This client has renewed before. Change their current term with Renew PT.',
      } });
    }
    const effStart = body.pt_start_date !== undefined ? body.pt_start_date && String(body.pt_start_date).slice(0, 10) : existing.start_date;
    const effEnd = body.pt_end_date !== undefined ? body.pt_end_date && String(body.pt_end_date).slice(0, 10) : existing.end_date;
    if (effStart && effEnd && effEnd < effStart) {
      return refuse(400, { error: { code: 'VALIDATION', field: 'pt_end_date', message: 'The PT end date cannot be before the start date.' } });
    }

    // Enrolling a client who has never had a term needs their screening done:
    // a completed Informed Consent and a fully answered PAR-Q, and nothing
    // medically blocking them (lib/screeningGate enrolmentScreeningBlock).
    const establishingTerm = body.pt_end_date != null || Number(body.duration_months) > 0
      || (wantsFinalAmount && Number(body.final_amount) > 0);
    if (establishingTerm && !existing.has_pt_term) {
      const blocked = await enrolmentScreeningBlock(req, req.params.id);
      if (blocked) return refuse(blocked.status, eligibilityError(blocked));
    }

    // 'active' means a running term. Setting it on a client with no term, or
    // on one whose term has ended without renewing, is the side door around
    // enrolment and Renew this closes.
    if (body.status === 'active') {
      if (!existing.has_pt_term && !establishingTerm) {
        return refuse(409, { error: { code: 'CLIENT_NOT_ENROLLED', message: 'Enrol this client in PT to make them active.' } });
      }
      if (effEnd && effEnd < existing.today) {
        return refuse(409, { error: { code: 'TERM_EXPIRED', message: 'This client\'s PT term has ended. Renew their PT to make them active.' } });
      }
    }

    if (wantsFinalAmount || wantsPaidAmount) {
      // Validate the two fields together against whichever value isn't being
      // changed in this request — never trust the client to have already
      // enforced paid <= final; recompute and re-check server-side.
      previousPaid = Number(existing.paid_amount) || 0;

      // Payments audit PAY-1. After a renewal, paid_amount is a LIFETIME total
      // (renewal adds to it) while final_amount is the current term's price —
      // so the enrolment arithmetic below (balance = final − paid, paid <= final,
      // book paid − previous paid as the payment) is wrong for that client: it
      // refused the save outright, or, once "corrected", wiped part of the paid
      // history and booked only the difference as revenue. A renewed client's
      // term is changed from Renew and their money from Payments.
      if (existing.renewals > 0) {
        return refuse(409, { error: {
          code: 'USE_RENEW',
          message: 'This client has renewed before. Change their current term with Renew PT, and record money on the Payments tab.',
        } });
      }

      if (wantsFinalAmount) {
        // `>= 0`, not `> 0`. This rejected every save on a client priced at zero
        // — and the edit form posts the whole form, so a trainer correcting a
        // phone number re-sent final_amount and got "Final Selling Price must be
        // greater than zero" for a field they never touched. Two ways in, both
        // real: a stored 0 posts as 0, and a stored NULL renders as an empty
        // input and posts as null, which Number() also makes 0.
        //
        // A price of zero is legitimate anyway — complimentary, trial, founding
        // member — so the rule was wrong on its own terms as well as unreachable
        // to satisfy. "Must be positive" belongs to enrollment, where the amount
        // is being entered on purpose, not to a PATCH that carries it along.
        //
        // Negative and non-numeric are still refused, and paid <= final below is
        // untouched: that is the rule that actually protects the ledger.
        finalAmount = Number(req.body.final_amount);
        if (!Number.isFinite(finalAmount) || finalAmount < 0) {
          return refuse(400, { error: { code: 'VALIDATION', message: 'Final Selling Price cannot be negative.' } });
        }
      }
      if (wantsPaidAmount) {
        paidAmount = Number(req.body.paid_amount);
        if (!Number.isFinite(paidAmount) || paidAmount < 0) {
          return refuse(400, { error: { code: 'VALIDATION', message: 'Amount Paid cannot be negative.' } });
        }
        // Lowering it here would move the client's total away from the ledger:
        // money already booked would stay booked while the client showed less
        // paid. A payment recorded by mistake is deleted from Payments, which
        // reverses the balance with it.
        if (paidAmount < previousPaid) {
          return refuse(400, { error: {
            code: 'VALIDATION',
            message: `Amount Paid cannot be lowered below the Rs. ${previousPaid} already recorded — delete the payment on the Payments tab instead.`,
          } });
        }
      }
      const effectiveFinal = finalAmount ?? (Number(existing.final_amount) || 0);
      const effectivePaid  = paidAmount  ?? (Number(existing.paid_amount)  || 0);
      if (effectivePaid > effectiveFinal) {
        return refuse(400, { error: { code: 'VALIDATION', message: 'Amount Paid cannot exceed Final Selling Price.' } });
      }
    }

    const sets = [];
    const params = [req.params.id];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        params.push(req.body[key]);
        sets.push(`${key} = $${params.length}`);
      }
    }
    let finalAmountParamIdx = null;
    let paidAmountParamIdx = null;
    if (wantsFinalAmount) { params.push(finalAmount); finalAmountParamIdx = params.length; sets.push(`final_amount = $${finalAmountParamIdx}`); }
    if (wantsPaidAmount)  { params.push(paidAmount);  paidAmountParamIdx = params.length;  sets.push(`paid_amount = $${paidAmountParamIdx}`); }
    if (wantsFinalAmount || wantsPaidAmount) {
      // Recompute from whichever of the two just landed in params, falling
      // back to the column's current value for the one that didn't change.
      // The two operands need an explicit ::numeric cast: when BOTH final_amount
      // and paid_amount are being set in the same request (the normal case for
      // a brand-new enrollment), both sides of the subtraction are bare
      // parameter placeholders with nothing else to anchor their type, and
      // Postgres can't resolve "-" between two "unknown"-typed params —
      // it throws "operator is not unique: unknown - unknown" (a 500, not a
      // validation error). A column reference (the single-param fallback path)
      // happens to carry its own type and never hit this.
      sets.push(
        `balance_amount = GREATEST(` +
          `${finalAmountParamIdx ? `$${finalAmountParamIdx}::numeric` : 'final_amount'} - ` +
          `${paidAmountParamIdx ? `$${paidAmountParamIdx}::numeric` : 'paid_amount'}, 0)`
      );
    }
    // Defense in depth: PATCH only ever touches status when a caller explicitly
    // sends it, unlike POST /clients (which auto-promotes 'pending' to
    // 'active' once a package is attached). If this request IS establishing
    // enrollment — an end date, a real duration, or a real final amount — but
    // forgot to say so, promote it here too. Without this, a caller that omits
    // status (as the enroll page did) silently leaves a fully-paid,
    // fully-scheduled client stuck showing "Not Enrolled" forever.
    const looksEnrolled =
      req.body.pt_end_date != null ||
      Number(req.body.duration_months) > 0 ||
      (wantsFinalAmount && finalAmount > 0);
    if (req.body.status === undefined && looksEnrolled) sets.push(`status = 'active'`);

    if (sets.length === 0) return refuse(400, { error: { code: 'NO_FIELDS', message: 'No fields to update' } });
    // Who changed a messaging preference, and when — on the row, for the
    // profile to show; the full history is the client.update activity log.
    if (body.whatsapp_opt_out !== undefined || body.email_opt_out !== undefined) {
      params.push(req.user?.id ?? null);
      sets.push('comm_prefs_updated_at = NOW()', `comm_prefs_updated_by = $${params.length}`);
    }
    sets.push('updated_at = NOW()');

    const updOrg = orgWhere(req, params);
    ({ rows } = await tx.query(
      `UPDATE pt_clients SET ${sets.join(', ')} WHERE id = $1 AND deleted_at IS NULL${updOrg} RETURNING *`,
      params
    ));
    if (rows.length === 0) { rows = null; return refuse(404, { error: { code: 'NOT_FOUND', message: 'Client not found' } }); }

    // Term history: unlike /clients/:id/renew, this endpoint (the actual
    // enrollment action — see the enroll page) never wrote a row into
    // pt_client_subscriptions, so a client's first term never appeared on
    // the PT Subscription History page even though they were fully active —
    // only later renewals showed up there. Log the initial term the first
    // time a client crosses into "enrolled", i.e. only when they don't
    // already have subscription history (so later plain-field edits through
    // this same endpoint, e.g. the client-edit page, never add duplicates).
    if (looksEnrolled) {
      // Under the row lock, so two saves cannot both see "no term yet". The
      // partial unique index from migration 225 backs it up.
      const { rows: existingTerms } = await tx.query(
        'SELECT 1 FROM pt_client_subscriptions WHERE client_id = $1 LIMIT 1', [req.params.id]
      );
      if (existingTerms.length === 0) {
        await tx.query(`
          INSERT INTO pt_client_subscriptions
            (client_id, plan_name, start_date, end_date, duration_months,
             selling_price, amount_paid, balance_amount, trainer_name, status, source)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active','enrollment')
          ON CONFLICT DO NOTHING
        `, [
          req.params.id, rows[0].package_type,
          rows[0].pt_start_date, rows[0].pt_end_date, rows[0].duration_months,
          rows[0].final_amount, rows[0].paid_amount, rows[0].balance_amount,
          rows[0].trainer_name,
        ]);
      }
    }

    // Ledger: an increase in paid_amount is collected money — record it in
    // pt_payments so revenue reports (which sum the payment ledgers, not
    // pt_clients.paid_amount) actually see it. Without this, money collected
    // at enrolment never appeared in any revenue figure.
    if (wantsPaidAmount && previousPaid !== null && paidAmount > previousPaid) {
      const delta = paidAmount - previousPaid;
      let ledgerTrainerId = null;
      let incentiveRate = 0;
      if (rows[0].trainer_id) {
        const tr = await trainerForOrg(tx, rows[0].organization_id, rows[0].trainer_id);
        if (tr) { ledgerTrainerId = tr.id; incentiveRate = tr.incentive_rate ?? 0.5; }
      }
      // A receipt number like every other payment (payments audit PAY-6), and
      // the amount taken off the balance so a delete restores exactly that: the
      // whole delta, because paid <= final is enforced above.
      const { rows: paid } = await tx.query(
        `INSERT INTO pt_payments (client_id, trainer_id, amount, incentive_amt, payment_method, payment_ref, date, notes, organization_id, balance_applied)
         VALUES ($1,$2,$3,$4,$5,$6,CURRENT_DATE,$7,$8,$9)
         RETURNING id`,
        [req.params.id, ledgerTrainerId, delta, Math.round(delta * incentiveRate),
         String(req.body.payment_method || 'CASH').toUpperCase(), await genReceiptNo(tx),
         'Collected via client profile / enrolment', orgIdOf(req), delta]
      );

      ledger = { id: paid[0].id, amount: delta };
    }

    await tx.query('COMMIT');
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    tx.release();
  }
  // A refusal inside the transaction has already answered.
  if (!rows) return undefined;

  // A client leaving active status retires their programmes; coming back
  // restores them. Before this, nothing ever moved an assignment out of
  // 'active' — 28 of production's 53 belonged to somebody expired, pending or
  // deleted, and the Today roster had to compensate at read time (#129).
  //
  // Derived from the client row by the service, not from req.body, so it is
  // right whether the caller sent a status explicitly or the enrolment
  // promotion above set one. No-ops when nothing needs moving.
  await svc.syncClientAssignments(rows[0].id);

  if (ledger) {
    // The payment's own id, for the reasons set out at the renewal path above:
    // the composite key it replaces collapsed two same-amount payments on one
    // day into one event, and took its date from the Node process in UTC.
    await automation.paymentReceived(req, {
      clientId: req.params.id,
      amount: ledger.amount,
      eventKey: ledger.id,
    });
  }

  // The resulting state only, not a before/after diff — this endpoint is a
  // hot path (every client-profile save goes through it) and an extra SELECT
  // purely to capture prior state on every edit isn't worth the round trip
  // this record already gets from the UPDATE ... RETURNING above.
  await logActivity(req, 'client.update', 'pt_client', rows[0].id, rows[0]);
  res.json({ data: rows[0] });
}));

// ─── Client photo upload ────────────────────────────────────
router.post('/clients/:id/photo', auth, wrap(async (req, res) => {
  if (!req.body.photo) return res.status(400).json({ error: { code: 'NO_PHOTO', message: 'No photo data provided' } });
  let photo;
  try {
    photo = parseClientPhoto(req.body.photo);
  } catch (err) {
    if (!(err instanceof PhotoInputError)) throw err;
    return res.status(400).json({ error: { code: 'INVALID_PHOTO', message: err.message } });
  }
  const params = [photo, req.params.id];
  const orgClause = orgWhere(req, params);
  const { rows } = await pool.query(
    `UPDATE pt_clients SET photo_url = $1, updated_at = NOW() WHERE id = $2 AND deleted_at IS NULL${orgClause} RETURNING id`,
    params
  );
  if (rows.length === 0) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
  // The bytes never enter the trail — only the fact of the change.
  await logActivity(req, 'client.photo.update', 'pt_client', req.params.id, { photo_updated: true });
  res.json({ data: rows[0] });
}));

// ─── Save client notes ──────────────────────────────────────
router.put('/clients/:id/notes', auth, wrap(async (req, res) => {
  const { notes } = req.body;
  if (notes === undefined) return res.status(400).json({ error: { code: 'NO_NOTES', message: 'Missing notes' } });
  const params = [notes, req.params.id];
  const orgClause = orgWhere(req, params);
  const beforeParams = [req.params.id];
  const beforeOrgClause = orgWhere(req, beforeParams);
  const before = await pool.query(
    `SELECT notes FROM pt_clients WHERE id = $1 AND deleted_at IS NULL${beforeOrgClause}`,
    beforeParams
  );
  const { rows } = await pool.query(
    `UPDATE pt_clients SET notes = $1, updated_at = NOW() WHERE id = $2 AND deleted_at IS NULL${orgClause} RETURNING id, notes`,
    params
  );
  if (rows.length === 0) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
  await logActivity(req, 'client.notes.update', 'pt_client', req.params.id, { notes }, { notes: before.rows[0]?.notes ?? null });
  res.json({ data: rows[0] });
}));

// ─── Delete PT client (soft-delete) ─────────────────────────
router.delete('/clients/:id', auth, requireTrainer, wrap(async (req, res) => {
  const params = [req.params.id];
  const orgClause = orgWhere(req, params);
  const { rows } = await pool.query(`
    UPDATE pt_clients
    SET deleted_at = NOW(), updated_at = NOW(), status = 'inactive'
    WHERE id = $1 AND deleted_at IS NULL${orgClause}
    RETURNING id
  `, params);
  if (rows.length === 0) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
  // Their programmes go with them. Cancelled rather than paused: a deleted
  // client is not coming back, and nothing should roster them again.
  await svc.syncClientAssignments(rows[0].id);
  await logActivity(req, 'client.delete', 'pt_client', rows[0].id);
  res.json({ message: 'Client deleted' });
}));

// ─── Client communication history ───────────────────────────
router.get('/clients/:id/communication', auth, wrap(async (req, res) => {
  if (!await clientInOrg(req, req.params.id))
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
  const { rows } = await pool.query(`
    SELECT cl.*, c.name AS client_name
    FROM communication_logs cl
    LEFT JOIN pt_clients c ON c.id = cl.recipient_id
    WHERE cl.recipient_type = 'client' AND cl.recipient_id = $1
    ORDER BY cl.created_at DESC
    LIMIT 100
  `, [req.params.id]);
  res.json({ data: rows, total: rows.length });
}));

// ─── Subscription history ───────────────────────────────────
router.get('/clients/:id/subscriptions', auth, wrap(async (req, res) => {
  if (!await clientInOrg(req, req.params.id))
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
  const { rows } = await pool.query(`
    SELECT id, plan_name, start_date, end_date, duration_months,
           selling_price, amount_paid, balance_amount, trainer_name, status, source, created_at
    FROM pt_client_subscriptions
    WHERE client_id = $1
    ORDER BY start_date ASC NULLS LAST, created_at ASC
  `, [req.params.id]);
  res.json({ data: rows, total: rows.length });
}));

// ─── Leads (pre-enrollment pipeline) ─────────────────────────
const LEAD_STATUSES = ['new', 'contacted', 'trial_scheduled', 'converted', 'lost'];

const ptLeadCreateSchema = {
  body: z.object({
    name: z.string().min(1).max(255),
    mobile: z.string().regex(/^[6-9]\d{9}$/, 'Invalid Indian mobile number').optional().nullable(),
    email: z.string().email().optional().nullable(),
    source: z.string().max(50).optional().nullable(),
    interested_package: z.string().max(255).optional().nullable(),
    trainer_id: z.string().optional().nullable(),
    trainer_name: z.string().max(255).optional().nullable(),
    follow_up_date: z.string().optional().nullable(),
    notes: z.string().max(2000).optional().nullable(),
  }),
};

router.get('/leads', auth, wrap(async (req, res) => {
  const params = [];
  const orgClause = orgWhere(req, params);
  let statusClause = '';
  if (req.query.status && LEAD_STATUSES.includes(String(req.query.status))) {
    params.push(req.query.status);
    statusClause = ` AND status = $${params.length}`;
  }
  let searchClause = '';
  if (req.query.q) {
    params.push(`%${req.query.q}%`);
    searchClause = ` AND (name ILIKE $${params.length} OR mobile ILIKE $${params.length} OR email ILIKE $${params.length})`;
  }
  const { rows } = await pool.query(`
    SELECT * FROM pt_leads
    WHERE 1=1${orgClause}${statusClause}${searchClause}
    ORDER BY created_at DESC
  `, params);
  res.json({ data: rows, total: rows.length });
}));

router.post('/leads', auth, requireTrainer, validate(ptLeadCreateSchema), wrap(async (req, res) => {
  const { name, mobile, email, source, interested_package, trainer_name, follow_up_date, notes } = req.body;
  const trainer_id = await resolveTrainerId(pool, orgIdOf(req), req.body.trainer_id);
  const { rows } = await pool.query(`
    INSERT INTO pt_leads
      (organization_id, name, mobile, email, source, interested_package, trainer_id, trainer_name, follow_up_date, notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    RETURNING *
  `, [
    orgIdOf(req), name, mobile || null, email || null, source || 'other',
    interested_package || null, trainer_id || null, trainer_name || null,
    follow_up_date || null, notes || null,
  ]);
  // `lead_created`. The first message a studio sends an enquiry is the one
  // that has to be fast, which is exactly why it should not depend on somebody
  // remembering to send it.
  await automation.leadCreated(req, {
    leadId: rows[0].id,
    source: rows[0].source,
    interestedPackage: rows[0].interested_package,
  });

  res.status(201).json({ data: rows[0] });
}));

router.patch('/leads/:id', auth, requireTrainer, wrap(async (req, res) => {
  if (req.body.status !== undefined && !LEAD_STATUSES.includes(req.body.status)) {
    return res.status(400).json({ error: { code: 'VALIDATION', message: `status must be one of: ${LEAD_STATUSES.join(', ')}` } });
  }
  const allowed = ['name','mobile','email','source','status','interested_package','trainer_id','trainer_name','follow_up_date','notes'];
  if (req.body.trainer_id !== undefined) {
    req.body.trainer_id = await resolveTrainerId(pool, orgIdOf(req), req.body.trainer_id);
  }
  const sets = [];
  const params = [req.params.id];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      params.push(req.body[key]);
      sets.push(`${key} = $${params.length}`);
    }
  }
  if (sets.length === 0) return res.status(400).json({ error: { code: 'NO_FIELDS', message: 'No fields to update' } });
  sets.push('updated_at = NOW()');
  const orgClause = orgWhere(req, params);
  const { rows } = await pool.query(
    `UPDATE pt_leads SET ${sets.join(', ')} WHERE id = $1${orgClause} RETURNING *`,
    params
  );
  if (rows.length === 0) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Lead not found' } });

  // `trial_scheduled`. Read off the row the UPDATE returned rather than off
  // req.body, so a PATCH that changed only the notes on an already-booked lead
  // is treated the same as the one that booked it — the dedupe key is what
  // makes the difference, and it needs the row's actual status to do it.
  if (rows[0].status === 'trial_scheduled') {
    await automation.trialScheduled(req, { leadId: rows[0].id });
  }

  res.json({ data: rows[0] });
}));

router.delete('/leads/:id', auth, requireTrainer, wrap(async (req, res) => {
  const params = [req.params.id];
  const orgClause = orgWhere(req, params);
  const { rowCount } = await pool.query(`DELETE FROM pt_leads WHERE id = $1${orgClause}`, params);
  if (rowCount === 0) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Lead not found' } });
  res.json({ message: 'Lead deleted' });
}));

// Converts a lead into a bare (pending) PT client — mirrors the bare-client
// branch of POST /clients — then hands off to the existing Enroll flow for
// package/payment details, rather than duplicating that form here.
router.post('/leads/:id/convert', auth, requireTrainer, wrap(async (req, res) => {
  // One transaction, the lead row locked FOR UPDATE. It used to read the
  // lead, then insert the client, then mark the lead converted as three
  // separate statements: two converts of one lead in flight together (a
  // double tap, a retried request) both saw it unconverted and both created
  // a client. The second now waits for the first and finds it converted.
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const params = [req.params.id];
    const orgClause = orgWhere(req, params);
    const { rows: leadRows } = await tx.query(`SELECT * FROM pt_leads WHERE id = $1${orgClause} FOR UPDATE`, params);
    if (leadRows.length === 0) {
      await tx.query('ROLLBACK');
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Lead not found' } });
    }
    const lead = leadRows[0];
    if (lead.status === 'converted' && lead.converted_client_id) {
      await tx.query('ROLLBACK');
      return res.status(409).json({
        error: { code: 'ALREADY_CONVERTED', message: 'This lead has already been converted.' },
        client_id: lead.converted_client_id,
      });
    }

    // Same plan-seat check as POST /clients (bare-client branch) — converting a
    // lead creates a new pt_clients row too, so it must respect the same SaaS
    // client-limit gate rather than offering a side door around it.
    const { limit, count, atLimit } = await subscription.clientLimitStatus(orgIdOf(req));
    if (atLimit) {
      await tx.query('ROLLBACK');
      return res.status(403).json({
        error: {
          code: 'PLAN_LIMIT_REACHED',
          message: `You've reached your plan's limit of ${limit} clients. Upgrade your plan to add more.`,
          limit, count,
        },
      });
    }

    let newClientId;
    try {
      const { rows: clientRows } = await tx.query(`
        INSERT INTO pt_clients
          (name, mobile, email, status, joining_date, trainer_id, trainer_name, organization_id)
        VALUES ($1,$2,$3,'pending',CURRENT_DATE,$4,$5,$6)
        RETURNING id
      `, [lead.name, lead.mobile, lead.email, lead.trainer_id, lead.trainer_name, orgIdOf(req)]);
      newClientId = clientRows[0].id;
    } catch (err) {
      await tx.query('ROLLBACK');
      // The studio already has a client on this number (the per-studio unique
      // index, migration 149). Said in words, and the lead is left as it was.
      if (err.code === '23505') {
        return res.status(409).json({ error: {
          code: 'DUPLICATE_MOBILE',
          message: 'A client with this mobile number already exists in your studio.',
        } });
      }
      throw err;
    }

    await tx.query(
      `UPDATE pt_leads SET status = 'converted', converted_client_id = $2, converted_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [req.params.id, newClientId]
    );
    await tx.query('COMMIT');
    return res.status(201).json({ data: { client_id: newClientId } });
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    tx.release();
  }
}));

// ─── Balance sheet ──────────────────────────────────────────
router.get('/balance-sheet', auth, wrap(async (req, res) => {
  const rows = await svc.getBalanceSheet(tenantScope(req));
  res.json({ data: rows, total: rows.length, total_outstanding: rows.reduce((s, r) => s + Number(r.balance_amount), 0) });
}));

// ─── Revenue report ─────────────────────────────────────────
//
// The org filter is the whole point of this handler, not a detail of it.
// Without it this is a SUM over pt_payments for every studio on the platform,
// returned to any staff account that asks — which is what it did until now.
// An aggregate leaks differently from a row read: there is no id to guess and
// nothing to enumerate, so a single missing predicate hands over the entire
// ledger in one call. Every sibling in this file scopes; see /sessions below.
router.get('/revenue', auth, wrap(async (req, res) => {
  const params = [];
  const orgClause = orgWhere(req, params);
  const { rows } = await pool.query(`
    SELECT
      DATE_TRUNC('month', date)::DATE AS month,
      COUNT(*)::INT AS transactions,
      COALESCE(SUM(amount), 0) AS revenue,
      COALESCE(SUM(incentive_amt), 0) AS incentives,
      COUNT(*) FILTER (WHERE incentive_amt > 0)::INT AS incentive_count
    FROM pt_payments
    WHERE deleted_at IS NULL
      AND date >= DATE_TRUNC('year', CURRENT_DATE)${orgClause}
    GROUP BY DATE_TRUNC('month', date)
    ORDER BY month DESC
  `, params);
  res.json({ data: rows });
}));

// ─── Sessions ───────────────────────────────────────────────
//
// Capped. `trainer_id` and `date` are both optional, so the unfiltered call is
// "every PT session this studio has ever run", and pt_sessions has no
// retention: one row per session per client, kept forever. Three rows in
// production today, and roughly ten thousand a year for a studio running
// thirty sessions a day — the kind of number that is fine right up until the
// studio you most want to keep is the one whose diary times out.
//
// The sibling in training.routes.js already had this exact clamp; this handler
// did not, which is the only reason to mention it — the shape was already
// agreed, it just was not applied here.
router.get('/sessions', auth, wrap(async (req, res) => {
  const { trainer_id, date } = req.query;
  const where = ['s.deleted_at IS NULL'];
  const params = [];
  const scope = tenantScope(req);
  params.push(scope.orgId); where.push(`s.organization_id = $${params.length}`);
  if (trainer_id) { params.push(trainer_id); where.push(`s.trainer_id = $${params.length}`); }
  if (date) { params.push(date); where.push(`s.session_date = $${params.length}`); }
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
  params.push(limit);
  const { rows } = await pool.query(`
    SELECT s.*, c.name AS client_name
    FROM pt_sessions s
    LEFT JOIN pt_clients c ON c.id = s.client_id
    WHERE ${where.join(' AND ')}
    ORDER BY s.session_date DESC, s.start_time
    LIMIT $${params.length}
  `, params);
  res.json({ data: rows });
}));

// ─── My Schedule — the trainer's sessions ────────────────────
// The trainer owns the studio, so their schedule is the studio's sessions.
// Distinct from GET /sessions only in shape: ascending by date/time and
// bounded by ?from / ?to, which is what the schedule page renders.
//
// `trainer_linked` is kept in the response for the clients that read it; it
// is always true now that every studio account is its trainer.
router.get('/sessions/my', auth, wrap(async (req, res) => {
  const params = [];
  const where = ['s.deleted_at IS NULL'];
  const scope = tenantScope(req);
  params.push(scope.orgId); where.push(`s.organization_id = $${params.length}`);
  if (req.query.from) { params.push(req.query.from); where.push(`s.session_date >= $${params.length}`); }
  if (req.query.to)   { params.push(req.query.to);   where.push(`s.session_date <= $${params.length}`); }

  const { rows } = await pool.query(`
    SELECT s.*, c.name AS client_name, c.mobile AS client_mobile
    FROM pt_sessions s
    LEFT JOIN pt_clients c ON c.id = s.client_id AND c.organization_id = s.organization_id
    WHERE ${where.join(' AND ')}
    ORDER BY s.session_date ASC, s.start_time ASC
  `, params);
  res.json({ data: rows, total: rows.length, trainer_linked: true });
}));

// Adds `minutes` to a 'HH:MM' or 'HH:MM:SS' time string, returning 'HH:MM:SS'.
// Used to derive end_time from start_time + duration server-side rather
// than trusting a client-computed value (or leaving it null, which is
// what happened before this fix).
function addMinutesToTime(timeStr, minutes) {
  const [h, m, s] = timeStr.split(':').map(Number);
  const total = h * 60 + m + minutes;
  const hh = Math.floor((total % 1440) / 60);
  const mm = total % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(s || 0).padStart(2, '0')}`;
}

// Adds `days` to a 'YYYY-MM-DD' date string, returning 'YYYY-MM-DD'.
/**
 * A training-eligibility refusal in this router's error shape. The codes are
 * lib/screeningGate's, identical on every route that starts training.
 */
function eligibilityError(blocked) {
  const { code, error, missing } = blocked.body;
  return { error: { code, message: error, ...(missing ? { missing } : {}) } };
}

/** The client statuses this app reads. 'inactive' is what deletion writes. */
const CLIENT_STATUSES = ['pending', 'active', 'frozen', 'expired', 'inactive'];
/** Fields that define a client's current term. */
const TERM_FIELDS = ['pt_start_date', 'pt_end_date', 'duration_months', 'package_type', 'base_amount', 'discount', 'monthly_pt_amount'];
const INDIAN_MOBILE_RE = /^[6-9]\d{9}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** PT session states, and where each may move. */
const SESSION_STATUSES = ['scheduled', 'completed', 'cancelled', 'no_show'];
/**
 * A completed session is final: it is what attendance, session balance and
 * trainer reports count, so it is not re-opened or cancelled after the fact.
 * A cancelled or no-show session may be put back on the schedule.
 */
const SESSION_TRANSITIONS = {
  scheduled: ['completed', 'cancelled', 'no_show'],
  cancelled: ['scheduled'],
  no_show: ['scheduled'],
  completed: [],
};
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

/** A real calendar date in YYYY-MM-DD (2026-02-30 is not one). */
function isCalendarDate(v) {
  if (typeof v !== 'string' || !DATE_ONLY_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

function addDaysToDate(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

router.post('/sessions', auth, wrap(async (req, res) => {
  const { client_id, client, title, date, start_time, end_time, notes,
    duration_minutes, session_type, recurring } = req.body;
  // pt_sessions.trainer_id has no foreign key (migration 018 dropped it), so
  // nothing but this check keeps another studio's trainer id out of it.
  const trainer_id = await resolveTrainerId(pool, orgIdOf(req), req.body.trainer_id);
  let cid = client_id;
  if (!cid && client) {
    const nameParams = [client];
    const nameOrg = orgWhere(req, nameParams);
    const { rows } = await pool.query(`SELECT id FROM pt_clients WHERE name = $1 AND deleted_at IS NULL${nameOrg} LIMIT 1`, nameParams);
    if (rows.length > 0) cid = rows[0].id;
  }
  // When client_id is supplied directly, verify it belongs to the caller's org
  // so a session can't be booked against another studio's client.
  if (cid && !await clientInOrg(req, cid))
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });

  if (!isCalendarDate(date)) {
    return res.status(400).json({ error: { code: 'VALIDATION', message: 'date must be a real date (YYYY-MM-DD).' } });
  }
  if (start_time != null && start_time !== '' && !TIME_RE.test(String(start_time))) {
    return res.status(400).json({ error: { code: 'VALIDATION', message: 'start_time must be HH:MM.' } });
  }
  if (duration_minutes != null && duration_minutes !== '') {
    const d = Number(duration_minutes);
    if (!Number.isInteger(d) || d < 5 || d > 600) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'duration_minutes must be a whole number between 5 and 600.' } });
    }
  }

  // A PT session is training: the client must be enrolled with a running
  // term, and the medical stops apply. Checked live, never from the form.
  let screeningWarnings = [];
  if (cid) {
    const { blocked, warnings } = await checkTrainingEligibility(req, cid, { action: 'book_session' });
    if (blocked) return res.status(blocked.status).json(eligibilityError(blocked));
    screeningWarnings = warnings;
  }

  const duration = parseInt(duration_minutes, 10) || 60;
  const computedEndTime = end_time || (start_time ? addMinutesToTime(start_time, duration) : null);

  // Recurring: book this session plus 3 more at the same weekly slot,
  // sharing one recurrence_id so they can be identified as a group later.
  const occurrences = recurring ? 4 : 1;
  const recurrenceId = recurring ? randomUUID() : null;
  const created = [];
  for (let i = 0; i < occurrences; i++) {
    const occDate = i === 0 ? date : addDaysToDate(date, 7 * i);
    const { rows } = await pool.query(
      `INSERT INTO pt_sessions (client_id, trainer_id, title, session_date, start_time, end_time,
         notes, created_by, duration_minutes, session_type, recurrence_id, organization_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [cid, trainer_id, title || 'PT Session', occDate, start_time, computedEndTime, notes, req.user.id,
       duration, session_type || '1-on-1', recurrenceId, orgIdOf(req)]
    );
    created.push(rows[0]);
  }
  res.status(201).json({ data: occurrences === 1 ? created[0] : created, screening_warnings: screeningWarnings });
}));

// PATCH /sessions/:id
router.patch('/sessions/:id', auth, wrap(async (req, res) => {
  const { id } = req.params;
  const b = req.body;
  const scope = tenantScope(req);
  const guard = ' AND organization_id = $2';
  const { rows: existingRows } = await pool.query(
    `SELECT start_time, duration_minutes, status, client_id FROM pt_sessions WHERE id = $1 AND deleted_at IS NULL${guard}`,
    [id, scope.orgId]
  );
  if (!existingRows[0]) return res.status(404).json({ error: 'Session not found' });
  const current = existingRows[0];

  // Status is a closed set with fixed moves (SESSION_TRANSITIONS above), and
  // marking a session completed is training, so the client's eligibility is
  // checked live at that moment — not when the session was booked.
  if (b.status !== undefined && b.status !== current.status) {
    if (!SESSION_STATUSES.includes(b.status)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: `status must be one of: ${SESSION_STATUSES.join(', ')}` } });
    }
    const from = current.status || 'scheduled';
    if (!(SESSION_TRANSITIONS[from] || []).includes(b.status)) {
      return res.status(409).json({ error: {
        code: 'INVALID_SESSION_TRANSITION',
        message: from === 'completed'
          ? 'This session is already completed and cannot be changed.'
          : `A ${from.replace('_', '-')} session cannot be marked ${b.status.replace('_', '-')}.`,
      } });
    }
    if (b.status === 'completed' && current.client_id) {
      const { blocked } = await checkTrainingEligibility(req, current.client_id, { action: 'complete_session' });
      if (blocked) return res.status(blocked.status).json(eligibilityError(blocked));
    }
  }
  if (b.session_date !== undefined && !isCalendarDate(b.session_date)) {
    return res.status(400).json({ error: { code: 'VALIDATION', message: 'session_date must be a real date (YYYY-MM-DD).' } });
  }
  if (b.start_time !== undefined && b.start_time !== null && !TIME_RE.test(String(b.start_time))) {
    return res.status(400).json({ error: { code: 'VALIDATION', message: 'start_time must be HH:MM.' } });
  }
  if (b.duration_minutes !== undefined) {
    const d = Number(b.duration_minutes);
    if (!Number.isInteger(d) || d < 5 || d > 600) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'duration_minutes must be a whole number between 5 and 600.' } });
    }
  }

  const allowed = ['status', 'notes', 'session_date', 'start_time', 'duration_minutes', 'session_type'];
  const sets = [];
  const params = [id];
  for (const key of allowed) {
    if (b[key] !== undefined) { params.push(b[key]); sets.push(`${key} = $${params.length}`); }
  }
  if (!sets.length) return res.status(400).json({ error: 'No fields to update' });

  if (b.start_time !== undefined || b.duration_minutes !== undefined) {
    const mergedStart = b.start_time ?? existingRows[0].start_time;
    const mergedDuration = b.duration_minutes ?? existingRows[0].duration_minutes;
    if (mergedStart) {
      params.push(addMinutesToTime(mergedStart, mergedDuration));
      sets.push(`end_time = $${params.length}`);
    }
  }
  sets.push('updated_at = NOW()');
  params.push(scope.orgId);
  const { rows } = await pool.query(
    `UPDATE pt_sessions SET ${sets.join(', ')} WHERE id = $1 AND deleted_at IS NULL AND organization_id = $${params.length} RETURNING *`,
    params
  );
  if (!rows[0]) return res.status(404).json({ error: 'Session not found' });
  res.json({ data: rows[0] });
}));

// ─── Payments ───────────────────────────────────────────────
router.get('/payments', auth, wrap(async (req, res) => {
  const { client_id, trainer_id } = req.query;
  const where = ['p.deleted_at IS NULL'];
  const params = [];
  if (client_id) { params.push(client_id); where.push(`p.client_id = $${params.length}`); }
  if (trainer_id) { params.push(trainer_id); where.push(`p.trainer_id = $${params.length}`); }
  const pOrg = orgWhere(req, params, 'p.organization_id');
  if (pOrg) where.push(pOrg.replace(/^ AND /, ''));
  const { rows } = await pool.query(`
    SELECT p.*, c.name AS client_name, t.name AS trainer_name
    FROM pt_payments p
    LEFT JOIN pt_clients c ON c.id = p.client_id AND c.organization_id = p.organization_id
    LEFT JOIN trainers t ON t.id = p.trainer_id AND t.organization_id = p.organization_id
    WHERE ${where.join(' AND ')}
    ORDER BY p.date DESC
  `, params);
  res.json({ data: rows });
}));

const PT_PAYMENT_METHODS = new Set(['CASH', 'UPI', 'CARD', 'BANK_TRANSFER']);

router.post('/payments', auth, wrap(async (req, res) => {
  const { client_id, trainer_id, amount, incentive_amt, payment_method, payment_ref, date, notes } = req.body;

  // `Number(amount) || 0` recorded a ₹0 payment for a blank, a whitespace
  // string, or anything unparseable — a ledger row that moves no balance,
  // counts toward every report that counts rows, and says a member paid when
  // they did not. Nothing after this point would have noticed: the INSERT and
  // the balance update are both happy with zero.
  //
  // A waiver is not a ₹0 payment. It belongs in the discount path, where it can
  // be reported as a waiver.
  const parsedAmount = parseStrict(amount);
  if (!parsedAmount.ok) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION',
        message: parsedAmount.reason === 'absent' ? 'amount is required' : 'amount must be a number',
      },
    });
  }
  if (parsedAmount.value <= 0) {
    return res.status(400).json({ error: { code: 'VALIDATION', message: 'amount must be greater than 0' } });
  }
  const numAmount = parsedAmount.value;

  // The column is free text, so an unrecognised method was storable and then
  // rendered as a blank chip on every screen that maps it to an icon.
  if (payment_method != null && !PT_PAYMENT_METHODS.has(String(payment_method))) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION',
        message: `payment_method must be one of ${[...PT_PAYMENT_METHODS].join(', ')}`,
      },
    });
  }

  // The write — client lock, ledger row, balance, receipt number, activity
  // log, and payment_received after COMMIT — is lib/ptPayments.js, shared with
  // Finance → Record Payment (POST /api/payments) so the two paths cannot
  // drift again. It used to be a second copy here that had drifted: no
  // receipt number unless the form typed a reference, no activity log, and a
  // trainer only when the form named one.
  //
  // What stays here is this endpoint's contract: a client is optional (a
  // payment can be recorded with none, and then nothing is locked and no
  // balance moves), the incentive is whatever the form entered, and the
  // form's own reference is kept as the receipt number when it gives one.
  const result = await recordPtPayment(req, {
    orgId: orgIdOf(req),
    clientId: client_id || null,
    amount: numAmount,
    method: payment_method ?? null,
    date: date || new Date(),
    notes: notes ?? null,
    paymentRef: payment_ref || null,
    trainerId: trainer_id || null,
    incentive: { amount: incentive_amt ?? 0 },
  });
  if (result.notFound) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
  }

  res.status(201).json({ data: result.payment });
}));

// ─── Operations Summary (today's sessions, renewals, dues) ──────────────────
router.get('/dashboard/ops', auth, wrap(async (req, res) => {
  // The studio's whole day: the programme panel is derived from the same
  // canonical Today rule /pt-os/today uses, scoped to the trainer's studio.
  const data = await svc.getOpsSummary(tenantScope(req));
  res.json({ data });
}));

// GET /clients/:id/training-brief
//
// Everything needed to write this client a programme, in one payload.
//
// The information already exists — PAR-Q, fitness testing, posture, mobility,
// lifestyle, goals — spread across six screens a trainer would have to open
// one at a time before designing anything. Nobody does that, so programmes get
// written from memory and the assessment data goes unread.
//
// Seven reads in parallel rather than seven round trips from the client: this
// is opened at the moment somebody has decided to build a plan, and a spinner
// per section is a reason to skip the whole thing.
//
// Each source takes the LATEST row. A brief is a picture of the client now,
// not a history — the history lives on its own screens.
router.get('/clients/:id/training-brief', auth, wrap(async (req, res) => {
  const clientId = req.params.id;
  const params = [clientId];
  const orgClause = orgWhere(req, params, 'c.organization_id');

  const { rows: clientRows } = await pool.query(
    `SELECT c.id, c.name, c.gender, c.dob, c.goal, c.injuries, c.notes, c.organization_id
       FROM pt_clients c WHERE c.id = $1 AND c.deleted_at IS NULL ${orgClause}`,
    params,
  );
  const client = clientRows[0];
  if (!client) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });

  const one = (sql) => pool.query(sql, [clientId]).then((r) => r.rows[0] ?? null);

  const [parq, assessment, posture, mobility, lifestyle, goal, assignment, sessions] = await Promise.all([
    one(`SELECT * FROM pt_parq_forms WHERE client_id = $1 AND deleted_at IS NULL
          ORDER BY assessment_date DESC NULLS LAST, created_at DESC LIMIT 1`),
    one(`SELECT * FROM pt_assessments WHERE client_id = $1
          ORDER BY assessment_date DESC NULLS LAST, created_at DESC LIMIT 1`),
    one(`SELECT * FROM pt_posture_assessments WHERE client_id = $1
          ORDER BY assessment_date DESC NULLS LAST, created_at DESC LIMIT 1`),
    one(`SELECT * FROM pt_mobility_performance_assessments WHERE client_id = $1
          ORDER BY assessment_date DESC NULLS LAST, created_at DESC LIMIT 1`),
    one(`SELECT * FROM pt_lifestyle_assessments WHERE client_id = $1
          ORDER BY assessment_date DESC NULLS LAST, created_at DESC LIMIT 1`),
    one(`SELECT * FROM pt_goals WHERE client_id = $1 AND is_active = true
          ORDER BY created_at DESC LIMIT 1`),
    one(`SELECT wa.start_date, wa.progress_pct, wp.id AS plan_id, wp.name AS plan_name,
                wp.duration_weeks,
                (SELECT COUNT(DISTINCT we.day_of_week) FROM workout_exercises we
                  WHERE we.workout_plan_id = wp.id AND we.week_number = 1)::int AS planned_days_count
           FROM workout_assignments wa
           JOIN workout_plans wp ON wp.id = wa.workout_plan_id
          WHERE wa.client_id = $1 AND wa.status = 'active'
          ORDER BY wa.start_date DESC LIMIT 1`),
    // Four weeks of the log, so "do they turn up" is answered from what was
    // performed rather than from the plan's own progress field.
    pool.query(
      `SELECT status FROM workout_sessions
        WHERE client_id = $1 AND session_date >= CURRENT_DATE - INTERVAL '28 days'`,
      [clientId],
    ).then((r) => r.rows),
  ]);

  res.json({
    data: buildBrief({
      client, parq, assessment, posture, mobility, lifestyle, goal, assignment, recentSessions: sessions,
    }),
  });
}));

// GET /clients/:id/snapshot
//
// What a trainer would otherwise have to remember about this client: whether
// the term is about to lapse, whether anyone has weighed them lately, whether
// last week's session happened, where they are against their goal.
//
// Every one of these was already derivable from data on the profile screen,
// and none of it was said out loud — so it lived in somebody's head, and the
// things that fall out of a head are the ones that cost a renewal.
router.get('/clients/:id/snapshot', auth, wrap(async (req, res) => {
  const clientId = req.params.id;
  const params = [clientId];
  const orgClause = orgWhere(req, params, 'c.organization_id');

  const { rows: clientRows } = await pool.query(
    `SELECT c.id, c.name, c.pt_end_date, c.balance_amount, c.organization_id
       FROM pt_clients c WHERE c.id = $1 AND c.deleted_at IS NULL ${orgClause}`,
    params,
  );
  const client = clientRows[0];
  if (!client) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });

  const many = (sql) => pool.query(sql, [clientId]).then((r) => r.rows);
  const one = (sql) => many(sql).then((rows) => rows[0] ?? null);

  const [lifestyle, measurements, assessments, goal, prRows, lastSession, checkins] = await Promise.all([
    one(`SELECT sleep_category, sleep_duration_hours, recovery_score, recovery_risk
           FROM pt_lifestyle_assessments WHERE client_id = $1
          ORDER BY assessment_date DESC NULLS LAST, created_at DESC LIMIT 1`),
    many(`SELECT weight_kg, measured_at FROM pt_os_measurements
           WHERE client_id = $1 AND weight_kg IS NOT NULL
           ORDER BY measured_at DESC LIMIT 12`),
    many(`SELECT weight, assessment_date FROM pt_assessments
           WHERE client_id = $1 AND weight IS NOT NULL
           ORDER BY assessment_date DESC NULLS LAST, created_at DESC LIMIT 12`),
    one(`SELECT goal_type, priority_goal, target_weight, starting_weight, target_date
           FROM pt_goals WHERE client_id = $1 AND is_active = true
          ORDER BY created_at DESC LIMIT 1`),
    // PR flags are written at log time against everything before them, so this
    // only reads them — recomputing here would disagree with the log.
    many(`SELECT wse.exercise_name, s.weight_kg, s.reps, ws.session_date
            FROM workout_sets s
            JOIN workout_session_exercises wse ON wse.id = s.session_exercise_id
            JOIN workout_sessions ws ON ws.id = wse.session_id
           WHERE ws.client_id = $1
             AND (s.is_pr_weight OR s.is_pr_reps OR s.is_pr_volume)
           ORDER BY ws.session_date DESC LIMIT 60`),
    one(`SELECT session_date, status FROM workout_sessions
          WHERE client_id = $1 AND session_date <= CURRENT_DATE
          ORDER BY session_date DESC LIMIT 1`),
    // Recovery rides along on the snapshot rather than getting its own call:
    // the profile opens both at once, and two round trips for one screen is
    // one more than it needs.
    many(`SELECT week_start_date, mood, sleep_hours, water_glasses,
                 stress_level, energy_level, soreness_level
            FROM weekly_checkins WHERE client_id = $1
           ORDER BY week_start_date DESC LIMIT 12`),
  ]);

  res.json({
    data: {
      ...buildSnapshot({
        client, lifestyle, measurements, assessments, goal, prRows, lastSession,
      }),
      recovery: buildRecovery(checkins),
    },
  });
}));

// POST /clients/:id/coach
//
// Coaching prompts written by a model, from readings this database can prove.
//
// POST, not GET, and on demand rather than on page load: a profile is opened
// dozens of times a day, mostly to check one thing, and an LLM call on every
// open is somebody's money and two seconds of spinner for an answer that has
// not changed since this morning.
//
// The facts are assembled first — the same snapshot and brief the profile
// already renders, both of which only ever report measurements that exist —
// and the model is asked to interpret them, not to supply them. If it is
// unconfigured, times out, or answers with something uncited, the derived
// prompts stand in: a coach card that vanishes when the API does teaches a
// trainer not to rely on it.
router.post('/clients/:id/coach', auth, aiLimiter, requireAiQuota(), wrap(async (req, res) => {
  const clientId = req.params.id;
  const params = [clientId];
  const orgClause = orgWhere(req, params, 'c.organization_id');

  const { rows: clientRows } = await pool.query(
    `SELECT c.id, c.name, c.gender, c.dob, c.goal, c.injuries, c.notes,
            c.pt_end_date, c.balance_amount, c.organization_id
       FROM pt_clients c WHERE c.id = $1 AND c.deleted_at IS NULL ${orgClause}`,
    params,
  );
  const client = clientRows[0];
  if (!client) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });

  const many = (sql) => pool.query(sql, [clientId]).then((r) => r.rows);
  const one = (sql) => many(sql).then((rows) => rows[0] ?? null);

  const [lifestyle, measurements, assessments, goal, prRows, lastSession, parq, posture, mobility] =
    await Promise.all([
      one(`SELECT * FROM pt_lifestyle_assessments WHERE client_id = $1
            ORDER BY assessment_date DESC NULLS LAST, created_at DESC LIMIT 1`),
      many(`SELECT weight_kg, measured_at FROM pt_os_measurements
             WHERE client_id = $1 AND weight_kg IS NOT NULL ORDER BY measured_at DESC LIMIT 12`),
      many(`SELECT * FROM pt_assessments WHERE client_id = $1
             ORDER BY assessment_date DESC NULLS LAST, created_at DESC LIMIT 12`),
      one(`SELECT * FROM pt_goals WHERE client_id = $1 AND is_active = true
            ORDER BY created_at DESC LIMIT 1`),
      many(`SELECT wse.exercise_name, s.weight_kg, s.reps, ws.session_date
              FROM workout_sets s
              JOIN workout_session_exercises wse ON wse.id = s.session_exercise_id
              JOIN workout_sessions ws ON ws.id = wse.session_id
             WHERE ws.client_id = $1 AND (s.is_pr_weight OR s.is_pr_reps OR s.is_pr_volume)
             ORDER BY ws.session_date DESC LIMIT 60`),
      one(`SELECT session_date, status FROM workout_sessions
            WHERE client_id = $1 AND session_date <= CURRENT_DATE
            ORDER BY session_date DESC LIMIT 1`),
      one(`SELECT * FROM pt_parq_forms WHERE client_id = $1 AND deleted_at IS NULL
            ORDER BY assessment_date DESC NULLS LAST, created_at DESC LIMIT 1`),
      one(`SELECT * FROM pt_posture_assessments WHERE client_id = $1
            ORDER BY assessment_date DESC NULLS LAST, created_at DESC LIMIT 1`),
      one(`SELECT * FROM pt_mobility_performance_assessments WHERE client_id = $1
            ORDER BY assessment_date DESC NULLS LAST, created_at DESC LIMIT 1`),
    ]);

  const snapshot = buildSnapshot({
    client, lifestyle, measurements, assessments, goal, prRows, lastSession,
  });
  const brief = buildBrief({
    client, parq, assessment: assessments[0] ?? null, posture, mobility, lifestyle, goal,
    assignment: null, recentSessions: [],
  });

  const out = await generateCoach({
    snapshot,
    brief,
    client: brief.client,
    chat: meteredChat(req, 'coach', routedChat),
    // The rule-based prompts are true whatever the model does, so they are
    // what the card falls back to rather than an empty state.
    fallback: snapshot.coach,
  });

  res.json({ data: out });
}));

// ─── Transformations ───────────────────────────────────────
//
// Each active client's first and latest recorded weight, from
// pt_os_measurements. Read-only and tenant-scoped through the client join —
// see getTransformations for why the predicate cannot live on the measurement
// row itself.
router.get('/transformations', auth, wrap(async (req, res) => {
  res.json({ data: await svc.getTransformations(tenantScope(req)) });
}));

// ─── Weekly check-in insight ───────────────────────────────
//
// What moved across this client's recent check-ins. POST and on demand for the
// same reason /coach is: the answer changes when the client logs a check-in,
// not when the page is opened, and an LLM call per page open is somebody's
// money for an answer that has not changed since this morning.
//
// The reads live in pt-os.service — including the tenant predicate and the
// "not yours" miss that becomes the 404 below — because SQL in an HTTP adapter
// is the debt architecture.layering.convention.test.js is ratcheting down, and
// a route written today has no business adding to it.
router.post('/clients/:id/checkin-insight', auth, aiLimiter, requireAiQuota(), wrap(async (req, res) => {
  const checkins = await svc.getCheckinInsightInputs(req.params.id, tenantScope(req), MAX_WEEKS);
  if (checkins === null) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
  }
  const data = await generateCheckinInsight({ checkins, chat: meteredChat(req, 'checkin', routedChat) });
  return res.json({ data });
}));

// ─── The member's own goals ────────────────────────────────
//
// Targets the member set for themselves in the member app (weight, a lift, a
// session count), with the progress and projection the member sees. Nothing
// on this side read them before; the trainer learnt of a goal only when it
// was reached. The read lives in member-goals.service.
router.get('/clients/:id/member-goals', auth, wrap(async (req, res) => {
  const data = await memberGoals.goalsForStudio(req.params.id, tenantScope(req).orgId);
  if (data === null) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
  }
  return res.json({ data });
}));

// ─── Activity log ──────────────────────────────────────────
//
// The studio-facing view of activity_log — who changed what, when. The
// platform's own Audit Centre (mounted under /api/super-admin) reads the
// same table across every organization for the platform operator; this is
// the narrower, tenant-scoped read of it for the studio's trainer, who has
// no reason to see (and must never be able to request) another studio's
// rows. Always filtered to the caller's own organization.
router.get('/activity-log', auth, requireTrainer, wrap(async (req, res) => {
  const scope = tenantScope(req);
  const where = ['a.organization_id = $1'];
  const params = [scope.orgId];
  if (req.query.action) { params.push(req.query.action); where.push(`a.action = $${params.length}`); }
  if (req.query.entity_type) { params.push(req.query.entity_type); where.push(`a.entity_type = $${params.length}`); }
  if (req.query.entity_id) { params.push(req.query.entity_id); where.push(`a.entity_id = $${params.length}`); }

  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const whereSql = `WHERE ${where.join(' AND ')}`;

  const [rowsRes, countRes] = await Promise.all([
    pool.query(
      // id tiebreak: same-transaction rows share created_at, so timestamp
      // order alone is nondeterministic — and nondeterministic order with
      // offset pagination is duplicates one way, skipped rows the other.
      `SELECT a.id, a.user_id, a.user_name, a.action, a.entity_type, a.entity_id,
              a.old_data, a.new_data, a.created_at
         FROM activity_log a
        ${whereSql}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    ),
    pool.query(`SELECT COUNT(*)::int AS total FROM activity_log a ${whereSql}`, params),
  ]);

  res.json({
    data: rowsRes.rows,
    paging: { limit, offset, total: countRes.rows[0].total, count: rowsRes.rows.length },
  });
}));

module.exports = router;
