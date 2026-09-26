'use strict';
// Everything a logged-in client can see, and nothing else.
//
// Mounted at /api/me behind auth + requireClient (see server.js). The single
// rule that makes this module safe is stated once here and obeyed everywhere
// below:
//
//   THE CLIENT ID COMES FROM req.user.pt_client_id. NEVER FROM THE REQUEST.
//
// No route in this file takes a client id, an org id or a trainer id as a
// parameter, a query value or a body field. There is nothing to tamper with,
// which is a stronger guarantee than checking that a supplied id matches —
// a check can be forgotten on the next route somebody adds, and an absent
// parameter cannot be.
//
// The org filter is belt-and-braces on top of that: pt_client_id is already
// unique platform-wide, so scoping by it alone is sufficient. The extra
// AND organization_id means a mistake in how the link was written cannot turn
// into a cross-tenant read.

const router = require('express').Router();
const pool = require('../../db/pool');
const portal = require('./client-portal.service');
const messages = require('../client-messages/client-messages.service');
const training = require('./member-training.service');
const goals = require('./member-goals.service');
const recap = require('./member-recap.service');
const { isTrainingBlocked } = require('../../lib/screeningGate');
const { randomUUID } = require('crypto');
const multer = require('multer');
const { serveFile, saveFile, deleteFile } = require('../../lib/fileStorage');
const { detectFileType, LOGO_IMAGES } = require('../../lib/fileSignatures');
const logger = require('../../lib/logger');

/** Wrap an async handler so a rejection reaches the error middleware. */
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

/**
 * The caller's own identity, from the session.
 *
 * A helper rather than four copies of `req.user.pt_client_id`, so that "which
 * client is this?" has exactly one answer in this file.
 */
function selfOf(req) {
  return { clientId: req.user.pt_client_id, orgId: req.user.organization_id || null };
}

/** `AND organization_id = $n`, or nothing when the session carries no org. */
function orgClause(orgId, params, col = 'organization_id') {
  if (!orgId) return '';
  params.push(orgId);
  return ` AND ${col} = $${params.length}`;
}

// ── GET /api/me/profile ──────────────────────────────────────────────────────
// The client's own record, and their trainer's public details.
//
// The column list is an allow-list, and deliberately narrow. `SELECT *` here
// would hand the client their own commission figures, internal notes and the
// studio's margin on them the moment somebody adds a column.
//
// trainer_photo is NULL, not t.photo_url: `trainers` has no photo column in
// any migration or in production. Selecting it made this route a 500 for
// every member, and the member dashboard — the first screen after sign-in —
// needs it, so the whole app read as broken. The field stays in the response
// so the client contract does not change; the dashboard shows initials.
//
// goal: the client's ACTIVE goal from pt_goals, which is where the trainer
// sets it today; pt_clients.goal is the older free-text field and is the
// fallback only. Reading the old field alone showed "—" to a member with an
// active goal. The same precedence the AI generators use (lib/client-facts).
//
// trainer: the assigned trainer, else the studio's own trainer. A studio has
// exactly one live trainer account (migration 208), so a client nobody got
// round to assigning still has a trainer — the studio's — and the card says so
// instead of disappearing.
router.get('/profile', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  const params = [clientId];
  const { rows } = await pool.query(
    `SELECT c.id, c.client_id AS member_code, c.name, c.email, c.mobile,
            c.gender, c.dob, c.photo_url, c.address,
            c.package_type, COALESCE(g.goal, c.goal) AS goal, c.height, c.weight,
            c.joining_date, c.pt_start_date, c.pt_end_date, c.duration_months,
            c.status,
            COALESCE(t.name, st.name) AS trainer_name, NULL::text AS trainer_photo,
            CASE WHEN t.id IS NOT NULL THEN t.specialization ELSE st.specialization END
              AS trainer_specialization,
            o.name AS studio_name, o.logo_url AS studio_logo
       FROM pt_clients c
       LEFT JOIN trainers t ON t.id = c.trainer_id AND t.organization_id = c.organization_id
       LEFT JOIN LATERAL (
         SELECT st.name, st.specialization
           FROM users su
           JOIN trainers st ON st.id = su.trainer_id AND st.organization_id = su.organization_id
          WHERE su.organization_id = c.organization_id AND su.role = 'trainer'
            AND su.deleted_at IS NULL AND st.deleted_at IS NULL
          ORDER BY su.created_at
          LIMIT 1
       ) st ON TRUE
       LEFT JOIN LATERAL (
         SELECT COALESCE(NULLIF(pg.priority_goal, ''), NULLIF(pg.goal_type, ''), pg.goal_other) AS goal
           FROM pt_goals pg
          WHERE pg.client_id = c.id AND pg.is_active
          ORDER BY pg.updated_at DESC NULLS LAST
          LIMIT 1
       ) g ON TRUE
       LEFT JOIN organizations o ON o.id = c.organization_id
      WHERE c.id = $1 AND c.deleted_at IS NULL${orgClause(orgId, params, 'c.organization_id')}`,
    params
  );
  if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Profile not found.' } });
  res.json({ data: rows[0] });
}));

// ── GET /api/me/membership ───────────────────────────────────────────────────
// What they bought and what they owe. Amounts they have a right to see —
// their own money — but nothing about what the studio keeps: trainer_commission
// is not in this list and must not be added to it.
router.get('/membership', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  const params = [clientId];
  const { rows } = await pool.query(
    `SELECT id, package_type, base_amount, discount, final_amount,
            paid_amount, balance_amount, monthly_pt_amount,
            pt_start_date, pt_end_date, duration_months, status
       FROM pt_clients
      WHERE id = $1 AND deleted_at IS NULL${orgClause(orgId, params)}`,
    params
  );
  if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Membership not found.' } });
  res.json({ data: rows[0] });
}));

// ── GET /api/me/payments ─────────────────────────────────────────────────────
// Every payment the studio has on its ledger for this client — cash, card and
// approved UPI alike. upi_order_id names the online order a row came from, so
// the payments screen can show that one once (with its receipt) rather than
// twice.
router.get('/payments', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  const params = [clientId];
  const { rows } = await pool.query(
    `SELECT p.id, p.amount, p.date, p.payment_method, p.notes, p.created_at,
            mp.payment_order_id AS upi_order_id
       FROM pt_payments p
       LEFT JOIN membership_payments mp ON mp.pt_payment_id = p.id
      WHERE p.client_id = $1 AND p.deleted_at IS NULL${orgClause(orgId, params, 'p.organization_id')}
      ORDER BY p.date DESC, p.created_at DESC
      LIMIT 200`,
    params
  );
  res.json({ data: rows });
}));

// ── GET /api/me/attendance ───────────────────────────────────────────────────
router.get('/attendance', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  const params = [clientId];
  const { rows } = await pool.query(
    `SELECT id, date, check_in_time, check_out_time, method, status
       FROM attendance_logs
      WHERE ref_id = $1 AND ref_type = 'client'${orgClause(orgId, params)}
      ORDER BY date DESC, check_in_time DESC
      LIMIT 200`,
    params
  );
  res.json({ data: rows });
}));

// ── GET /api/me/measurements ─────────────────────────────────────────────────
//
// Two columns, not SELECT *. `pt_os_measurements` is not defined in any
// migration in this repo — it is created elsewhere and read by the client
// snapshot — so the only columns anyone here can claim to know about are the
// ones already read in production (see pt-os.routes.js, the weight trend).
// A star select on a table whose full shape is unverified is how an internal
// note ends up on a client's screen.
//
// No org clause: the column set is unverified, so an organization_id filter
// might reference a column that does not exist and 500 the whole route. Scoping
// on client_id alone is already sufficient — pt_clients.id is unique
// platform-wide and comes from the session, never the request.
//
// The member's own check-in weights are included, marked source 'checkin'.
// Without them a member who reported their weight every week still saw
// "Weight: not recorded" on their dashboard, because only the trainer's
// measurements were read. weekly_checkins IS migration-defined, so it is
// scoped by organization as well.
router.get('/measurements', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  const { rows } = await pool.query(
    `SELECT weight_kg, measured_at, source, body_fat_pct, chest_cm, waist_cm, hip_cm,
            arms_cm, thighs_cm, shoulders_cm FROM (
       SELECT weight_kg, measured_at, 'trainer'::text AS source,
              body_fat_pct, chest_cm, waist_cm, hip_cm, arms_cm, thighs_cm, shoulders_cm
         FROM pt_os_measurements
        WHERE client_id = $1
          AND COALESCE(weight_kg, body_fat_pct, chest_cm, waist_cm, hip_cm,
                       arms_cm, thighs_cm, shoulders_cm) IS NOT NULL
       UNION ALL
       SELECT weight, week_start_date::timestamptz, 'checkin',
              NULL, NULL, NULL, NULL, NULL, NULL, NULL
         FROM weekly_checkins
        WHERE client_id = $1 AND organization_id = $2 AND weight IS NOT NULL
     ) m
      ORDER BY measured_at DESC
      LIMIT 200`,
    [clientId, orgId]
  );
  res.json({ data: rows });
}));

// ── My programme, my diet, my weekly check-ins ─────────────────────────────
//
// The member app used to stop at profile, payments, attendance and weight:
// a client could not see the programme their trainer wrote, the diet they
// were given, or tell their trainer how the week went. The SQL for these is
// in client-portal.service.js; each route passes it the identity from the
// session and nothing from the request.

// GET /api/me/workout — active programmes, this week's exercises by day
router.get('/workout', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  res.json({ data: await portal.myWorkout(clientId, orgId) });
}));

// GET /api/me/diet — active diet plans with daily targets and meals
router.get('/diet', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  res.json({ data: await portal.myDiet(clientId, orgId) });
}));

// PATCH /api/me/profile — the member updates their own mobile / address
router.patch('/profile', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  try {
    const saved = await portal.updateMyContact(clientId, orgId, req.body || {});
    if (!saved) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Profile not found.' } });
    res.json({ data: saved });
  } catch (err) {
    if (err instanceof portal.PortalInputError) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: err.message } });
    }
    throw err;
  }
}));

// GET /api/me/forms — the member's own latest PAR-Q and informed consent
router.get('/forms', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  res.json({ data: await portal.myForms(clientId, orgId) });
}));

// GET /api/me/forms/consent/:id/pdf — their own signed consent, as a PDF.
// The id only selects WHICH of the member's consents; ownership is enforced
// by the lookup (client + studio from the session), and a miss is a 404.
router.get('/forms/consent/:id/pdf', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  const key = await portal.myConsentPdfKey(clientId, orgId, req.params.id);
  if (!key) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Consent form not found.' } });
  res.set('Cache-Control', 'private, no-store');
  await serveFile(key, res, {});
}));

// ── Messages with the studio ─────────────────────────────────────────────────
// One thread, the member's own: the client id comes from the session, never
// the request. Opening it marks the studio's messages read.
router.get('/messages', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  const before = typeof req.query.before === 'string' && !Number.isNaN(Date.parse(req.query.before))
    ? req.query.before : null;
  res.json({ data: await messages.memberThread(clientId, orgId, { before }) });
}));

router.get('/messages/unread-count', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  res.json({ data: { unread: await messages.memberUnread(clientId, orgId) } });
}));

router.post('/messages', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  try {
    res.status(201).json({ data: await messages.memberSend(clientId, orgId, req.user.id, req.body?.body) });
  } catch (err) {
    if (err instanceof messages.MessageInputError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    }
    throw err;
  }
}));

// ── Progress photos ──────────────────────────────────────────────────────────
//
// A member's own photos: GET lists them (the trainer's and their own), POST
// adds one from their phone, DELETE removes one they uploaded themselves.
//
// Uploads are files, not data URLs in a JSON body: multipart, 8 MB at most
// (the app downscales to well under 1 MB first), and the BYTES decide the
// type — the Content-Type header is the caller's to forge. Stored as
// progress-photos/<row id>.<ext>, which is exactly the shape /uploads resolves
// to the owning row, so only this member and their studio can read it back.
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter(_req, file, cb) {
    if (!/^image\/(png|jpe?g|webp)$/i.test(file.mimetype || '')) {
      return cb(new portal.PortalInputError('Use a JPG, PNG or WebP photo.'));
    }
    cb(null, true);
  },
});

router.get('/progress-photos', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  res.json({ data: await portal.myPhotos(clientId, orgId, req.user.id) });
}));

router.post('/progress-photos', (req, res, next) => {
  photoUpload.single('photo')(req, res, (err) => {
    if (!err) return next();
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'That photo is too large (8 MB at most).' : err.message;
    res.status(400).json({ error: { code: 'UPLOAD_REJECTED', message } });
  });
}, wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  try {
    if (!req.file) throw new portal.PortalInputError('Choose a photo to upload.');
    const meta = portal.normalisePhotoMeta(req.body);
    const detected = detectFileType(req.file.buffer, LOGO_IMAGES);
    if (!detected) throw new portal.PortalInputError('That file is not a JPG, PNG or WebP photo.');
    if (await portal.photoUploadsToday(clientId, orgId, req.user.id) >= portal.PHOTO_DAILY_LIMIT) {
      return res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'That is plenty of photos for today — try again tomorrow.' } });
    }
    const id = randomUUID();
    const url = await saveFile('progress-photos', `${id}.${detected.ext}`, req.file.buffer, detected.mime,
      { organizationId: orgId, uploadedBy: req.user.id });
    res.status(201).json({ data: await portal.insertMyPhoto(clientId, orgId, req.user.id, { id, ...meta, url }) });
  } catch (err) {
    if (err instanceof portal.PortalInputError) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: err.message } });
    }
    throw err;
  }
}));

router.delete('/progress-photos/:id', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  const url = await portal.deleteMyPhoto(clientId, orgId, req.user.id, req.params.id);
  if (url === null) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Photo not found.' } });
  // The row is gone either way; a file left behind is tidied, not surfaced.
  if (url.startsWith('/uploads/progress-photos/')) {
    deleteFile(url.slice('/uploads/'.length)).catch((err) =>
      logger.warn({ err: err.message, url }, 'client-portal: progress photo file delete failed'));
  }
  res.status(204).end();
}));

// GET /api/me/achievements — records and streaks, counted from what was logged
router.get('/achievements', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  res.json({ data: await portal.myAchievements(clientId, orgId) });
}));

// GET /api/me/sessions — the sessions the trainer logged, with what was lifted
router.get('/sessions', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  res.json({ data: await portal.mySessions(clientId, orgId) });
}));

// GET /api/me/checkins — recent weekly check-ins, and which week is "this week"
router.get('/checkins', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  res.json({ data: await portal.myCheckins(clientId, orgId) });
}));

// POST /api/me/checkins — this week's check-in (the server picks the week)
router.post('/checkins', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  try {
    const saved = await portal.upsertMyCheckin(clientId, orgId, req.user.id, req.body || {});
    if (!saved) {
      return res.status(409).json({ error: { code: 'CONFLICT', message: 'This week\'s check-in could not be saved.' } });
    }
    res.status(201).json({ data: saved });
  } catch (err) {
    if (err instanceof portal.PortalInputError) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: err.message } });
    }
    throw err;
  }
}));

// ── Guided workout, goals, monthly recap ────────────────────────────────────
//
// SQL for all three lives in their services; these routes pass the identity
// from the session and the body, and map input errors to 4xx.

/** Send a service's input error as a 4xx; anything else goes to the error middleware. */
function inputError(res, err, Kind) {
  if (!(err instanceof Kind)) return false;
  const status = err.status || 400;
  const code = status === 429 ? 'RATE_LIMITED' : status === 409 ? 'CONFLICT' : 'BAD_REQUEST';
  res.status(status).json({ error: { code, message: err.message } });
  return true;
}

// GET /api/me/workout/last?name=Squat&name=Bench — what they did last time
router.get('/workout/last', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  const raw = req.query.name;
  const names = (Array.isArray(raw) ? raw : raw ? [raw] : []).map(String).filter((n) => n.length <= 120);
  res.json({ data: await training.lastPerformance(clientId, orgId, names) });
}));

// POST /api/me/workouts — a finished workout the member did on their own
router.post('/workouts', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  // The same medical gate as the trainer's log: a member whose PAR-Q blocks
  // training cannot log training either.
  if (await isTrainingBlocked(clientId)) {
    return res.status(403).json({ error: {
      code: 'PARQ_BLOCKED',
      message: 'Your health screening needs your trainer\'s clearance before you log workouts.',
    } });
  }
  try {
    const { created, summary } = await training.logMyWorkout(clientId, orgId, req.user.id, req.body || {});
    res.status(created ? 201 : 200).json({ data: summary });
  } catch (err) {
    if (!inputError(res, err, training.TrainingInputError)) throw err;
  }
}));

// GET /api/me/goals — the member's goals with progress, and the studio's target
router.get('/goals', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  res.json({ data: await goals.myGoals(clientId, orgId) });
}));

// POST /api/me/goals — set a new goal
router.post('/goals', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  try {
    res.status(201).json({ data: await goals.createMyGoal(clientId, orgId, req.user.id, req.body || {}) });
  } catch (err) {
    if (!inputError(res, err, goals.GoalInputError)) throw err;
  }
}));

// DELETE /api/me/goals/:id — take a goal off the list
router.delete('/goals/:id', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  const removed = await goals.archiveMyGoal(clientId, orgId, req.params.id);
  if (!removed) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Goal not found.' } });
  res.status(204).end();
}));

// GET /api/me/recap?month=YYYY-MM — the month in numbers (latest active month by default)
router.get('/recap', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  try {
    res.json({ data: await recap.myRecap(clientId, orgId, req.query.month ? String(req.query.month) : null) });
  } catch (err) {
    if (!inputError(res, err, recap.RecapInputError)) throw err;
  }
}));

module.exports = router;
module.exports.selfOf = selfOf;
