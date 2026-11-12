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
const formChecks = require('../form-checks/form-check.service');
const goals = require('./member-goals.service');
const recap = require('./member-recap.service');
const renewal = require('./member-renewal.service');
const requests = require('./member-requests.service');
const privacy = require('./member-privacy.service');
const memberCoach = require('./member-coach.service');
const { trainerOfClient, TRAINER_SPECIALISATION_SQL } = require('../../lib/memberTrainer');
const { generatePaymentReceiptPdf } = require('../../lib/paymentReceiptPdf');
const { isTrainingBlocked } = require('../../lib/screeningGate');
const { randomUUID } = require('crypto');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { serveFile, saveFile, saveFileFromPath, deleteFile } = require('../../lib/fileStorage');
const { detectFileType, LOGO_IMAGES, FORM_VIDEOS } = require('../../lib/fileSignatures');
const { logActivity } = require('../../lib/activityLog');
const { today } = require('../../lib/appTime');
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
// trainer_name, trainer_photo and trainer_specialization all describe ONE
// trainer account, resolved by lib/memberTrainer — the same rule the coach
// page and the message thread use. The name used to come from `trainers`
// while the photo came from `users`, and the specialisation from the legacy
// trainers column that 7 of 8 studios never filled; the trainer edits
// users.name and their My Profile specialisations, so those are what show.
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
    `SELECT c.id, c.client_id AS member_code, c.name, c.email, c.mobile, c.whatsapp,
            c.gender, c.dob, c.photo_url, c.address,
            c.package_type, COALESCE(g.goal, c.goal) AS goal, c.height, c.weight,
            c.joining_date, c.pt_start_date, c.pt_end_date, c.duration_months,
            c.status,
            tu.name AS trainer_name,
            up.avatar_url AS trainer_photo,
            ${TRAINER_SPECIALISATION_SQL} AS trainer_specialization,
            o.name AS studio_name, o.logo_url AS studio_logo,
            o.phone AS studio_phone, o.address AS studio_address, o.hours AS studio_hours
       FROM pt_clients c
       LEFT JOIN LATERAL (${trainerOfClient('c')}) tu ON TRUE
       LEFT JOIN user_profiles up ON up.user_id = tu.id
       LEFT JOIN trainers tt ON tt.id = tu.trainer_id AND tt.deleted_at IS NULL
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

// ── GET /api/me/coach ────────────────────────────────────────────────────────
// The trainer's own profile — photo, credentials, story — as they wrote it on
// My Profile. The allow-list lives in member-coach.service.js.
router.get('/coach', wrap(async (req, res) => {
  const coach = await memberCoach.coachFor(pool, selfOf(req));
  if (!coach) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No trainer found.' } });
  res.json({ data: coach });
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
       LEFT JOIN pt_payment_activations mp ON mp.pt_payment_id = p.id
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
// The three sources and the reasoning behind scoping each one live in
// client-portal.service.js, so the export reads exactly what this route returns.
router.get('/measurements', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  res.json({ data: await portal.myMeasurements(clientId, orgId) });
}));

// ── My programme, my diet, my weekly check-ins ─────────────────────────────
//
// The member app used to stop at profile, payments, attendance and weight:
// a client could not see the programme their trainer wrote, the diet they
// were given, or tell their trainer how the week went. The SQL for these is
// in client-portal.service.js; each route passes it the identity from the
// session and nothing from the request.

// GET /api/me/workout — active programmes, this week's exercises by day, and
// whether the trainer has allowed the member to train on their own.
router.get('/workout', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  const [data, allowSelfWorkout, openSession] = await Promise.all([
    portal.myWorkout(clientId, orgId),
    training.selfWorkoutPermission(clientId, orgId),
    training.openSessionFor(clientId, orgId),
  ]);
  res.json({ data, allow_self_workout: allowSelfWorkout, open_session: openSession });
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
    const { changed, ...data } = saved;
    if (changed) {
      await logActivity(req, 'client.contact.update', 'pt_client', clientId, {
        fields: ['mobile', 'whatsapp', 'address'].filter((field) => field in (req.body || {})),
      });
    }
    res.json({ data });
  } catch (err) {
    if (err instanceof portal.PortalInputError) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: err.message } });
    }
    throw err;
  }
}));

// POST /api/me/photo — the member sets their own profile photo (a cropped,
// downscaled data URL); DELETE removes it. Validation is the service's.
router.post('/photo', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  try {
    const saved = await portal.setMyPhoto(clientId, orgId, req.body?.photo);
    if (!saved) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Profile not found.' } });
    await logActivity(req, 'client.photo.update', 'pt_client', clientId, { photo_updated: true });
    res.json({ data: saved });
  } catch (err) {
    if (err instanceof portal.PortalInputError) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: err.message } });
    }
    throw err;
  }
}));

router.delete('/photo', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  const saved = await portal.setMyPhoto(clientId, orgId, null);
  if (!saved) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Profile not found.' } });
  await logActivity(req, 'client.photo.update', 'pt_client', clientId, { photo_removed: true });
  res.json({ data: saved });
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

// ── Form checks ──────────────────────────────────────────────────────────────
//
// A member records a lift and sends it to their trainer, who replies with
// comments pinned to seconds in the clip. The member can see every check they
// sent, its review state, and the trainer's comments — the whole point of
// sending the video.
//
// Same rules as progress photos: the client id comes from the session, the
// bytes decide the file type, and the row id is the storage key so /uploads
// can confirm this member owns it. Videos are large, so the daily cap is five.
const FORM_CHECK_DAILY_LIMIT = 5;

// A 60 MB video held in a Buffer occupies 60 MB of heap for the life of the
// request, and a few concurrent uploads were enough to push the process over
// its heap limit. Multer writes the part to a temp file instead; the first
// bytes are sniffed from disk, the file is streamed to R2 (or moved into
// uploads/), and the temp file is removed in a finally.
const FORM_CHECK_TMP = path.join(os.tmpdir(), 'mpts-form-checks');

const formCheckUpload = multer({
  storage: multer.diskStorage({
    destination(_req, _file, cb) {
      fs.mkdir(FORM_CHECK_TMP, { recursive: true }, (err) => cb(err, FORM_CHECK_TMP));
    },
    filename(_req, _file, cb) {
      cb(null, `${Date.now()}-${randomUUID()}`);
    },
  }),
  limits: { fileSize: 60 * 1024 * 1024, files: 1 },
  fileFilter(_req, file, cb) {
    if (!/^video\/(mp4|quicktime)$/i.test(file.mimetype || '')) {
      return cb(new portal.PortalInputError('Use an MP4 or MOV video.'));
    }
    cb(null, true);
  },
});

router.get('/form-checks', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  res.json({ data: await formChecks.listForClient(clientId, orgId) });
}));

router.post('/form-checks', (req, res, next) => {
  formCheckUpload.single('video')(req, res, (err) => {
    if (!err) return next();
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? 'That video is too large (60 MB at most). Trim it and try again.'
      : err.message;
    res.status(400).json({ error: { code: 'UPLOAD_REJECTED', message } });
  });
}, wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  const tempPath = req.file?.path;
  try {
    if (!req.file) throw new portal.PortalInputError('Choose a video to upload.');

    const exercise = String(req.body?.exercise ?? '').trim();
    if (!exercise) throw new portal.PortalInputError('Name the lift in the video.');
    if (exercise.length > 120) throw new portal.PortalInputError('Keep the lift name to 120 characters.');

    const note = String(req.body?.note ?? '').trim();
    if (note.length > 500) throw new portal.PortalInputError('Keep the note to 500 characters.');

    // 12 bytes are all any signature in fileSignatures.js looks at; 64 is
    // plenty and one read.
    const head = Buffer.alloc(64);
    const fd = await fs.promises.open(tempPath, 'r');
    try { await fd.read(head, 0, head.length, 0); } finally { await fd.close(); }
    const detected = detectFileType(head, FORM_VIDEOS);
    if (!detected) throw new portal.PortalInputError('That file is not an MP4 or MOV video.');

    if (await formChecks.uploadsToday(clientId, orgId) >= FORM_CHECK_DAILY_LIMIT) {
      return res.status(429).json({
        error: { code: 'RATE_LIMITED', message: 'That is plenty of videos for today — try again tomorrow.' },
      });
    }

    const id = randomUUID();
    const url = await saveFileFromPath('form-checks', `${id}.${detected.ext}`, tempPath, detected.mime,
      { organizationId: orgId, uploadedBy: req.user.id });

    const row = await formChecks.createForClient({
      id, orgId, clientId, exercise, note, videoUrl: url,
    });
    res.status(201).json({ data: row });
  } catch (err) {
    if (err instanceof portal.PortalInputError) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: err.message } });
    }
    throw err;
  } finally {
    // On the disk path saveFileFromPath() moved the file already; force:true
    // makes that a no-op. Every refusal path (bad bytes, rate limit, DB error)
    // leaves nothing behind.
    if (tempPath) await fs.promises.rm(tempPath, { force: true }).catch(() => {});
  }
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

// GET /api/me/session-balance — PT session packages the member still holds
router.get('/session-balance', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  res.json({ data: await training.mySessionBalance(clientId, orgId) });
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
  const code = err.code || (status === 429 ? 'RATE_LIMITED' : status === 409 ? 'CONFLICT' : status === 404 ? 'NOT_FOUND' : 'BAD_REQUEST');
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

// ── Self workout sessions ────────────────────────────────────────────────────
//
// Start/resume, autosave and discard. The permission is checked on START only:
// revoking it must never strand a session the member already began, so
// autosave and submit keep working on an open session. Ownership and tenancy
// come from the session identity, never the request.

// POST /api/me/workout/sessions — start today's workout, or resume the open one
router.post('/workout/sessions', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  if (await isTrainingBlocked(clientId)) {
    return res.status(403).json({ error: {
      code: 'PARQ_BLOCKED',
      message: 'Your health screening needs your trainer\'s clearance before you log workouts.',
    } });
  }
  try {
    const plans = await portal.myWorkout(clientId, orgId);
    const { session, resumed } = await training.startMyWorkout({
      clientId,
      orgId,
      userId: req.user.id,
      plans,
      dayOfWeek: req.body?.day_of_week ?? null,
      assignmentId: req.body?.assignment_id ?? null,
    });
    res.status(resumed ? 200 : 201).json({ data: { session, resumed } });
  } catch (err) {
    if (!inputError(res, err, training.TrainingInputError)) throw err;
  }
}));

// PATCH /api/me/workout/sessions/:id — autosave the in-progress workout
router.patch('/workout/sessions/:id', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  try {
    const saved = await training.autosaveMyWorkout({
      clientId, orgId, sessionId: req.params.id, draft: req.body?.draft,
    });
    res.json({ data: saved });
  } catch (err) {
    if (!inputError(res, err, training.TrainingInputError)) throw err;
  }
}));

// DELETE /api/me/workout/sessions/:id — discard, never delete
router.delete('/workout/sessions/:id', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  try {
    await training.abandonMyWorkout({ clientId, orgId, sessionId: req.params.id });
    res.status(204).end();
  } catch (err) {
    if (!inputError(res, err, training.TrainingInputError)) throw err;
  }
}));

// POST /api/me/workout/sessions/:id/submit — finalise, and queue for review
router.post('/workout/sessions/:id/submit', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  try {
    const result = await training.submitMyWorkout({
      clientId, orgId, sessionId: req.params.id, draft: req.body?.draft,
    });
    await logActivity(req, 'workout_log.member.submit', 'workout_session', req.params.id, {
      sets: result.summary.sets,
      exercises: result.summary.exercises,
      volume_kg: result.summary.volume_kg,
    });
    res.json({ data: result });
  } catch (err) {
    if (!inputError(res, err, training.TrainingInputError)) throw err;
  }
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
    // The plan day is snapshotted beside what the member did, so the trainer
    // can review planned vs actual even after the plan changes.
    const plans = await portal.myWorkout(clientId, orgId);
    const { created, summary } = await training.logMyWorkout(clientId, orgId, req.user.id, req.body || {}, plans);
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

// ── Renewal and receipts ─────────────────────────────────────────────────────

// GET /api/me/renewal — where the plan stands, and the trainer's offer if any
router.get('/renewal', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  const data = await renewal.myRenewal(clientId, orgId);
  if (!data) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Membership not found.' } });
  res.json({ data });
}));

// POST /api/me/renewal/request — ask the trainer for a renewal offer
router.post('/renewal/request', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  try {
    res.json({ data: await renewal.requestRenewal(clientId, orgId, req.body?.note) });
  } catch (err) {
    if (!inputError(res, err, renewal.RenewalError)) throw err;
  }
}));

// GET /api/me/payments/:id/receipt — PDF receipt for one payment of theirs
router.get('/payments/:id/receipt', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  const payment = await renewal.myPaymentForReceipt(clientId, orgId, req.params.id);
  if (!payment) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Payment not found.' } });
  const pdf = await generatePaymentReceiptPdf(payment);
  // Names a person and what they paid: never cache it anywhere shared.
  res.set('Cache-Control', 'private, no-store');
  res.type('application/pdf');
  res.set('Content-Disposition', `inline; filename="receipt-${payment.payment_ref || String(payment.id).slice(0, 8)}.pdf"`);
  res.send(pdf);
}));

// ── Pause and deletion requests ─────────────────────────────────────────────
// Both only notify the trainer. Nothing about the plan or the account changes
// until a person acts on it, so there is no state to read back beyond "is a
// request still waiting?".

// GET /api/me/pause — whether a pause request is still waiting
router.get('/pause', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  res.json({ data: await requests.myPause(clientId, orgId) });
}));

// POST /api/me/pause/request — ask the trainer to pause the plan
router.post('/pause/request', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  try {
    res.json({ data: await requests.requestPause(clientId, orgId, req.body || {}) });
  } catch (err) {
    if (!inputError(res, err, requests.RequestError)) throw err;
  }
}));

// GET /api/me/deletion — whether a deletion request is still waiting
router.get('/deletion', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  res.json({ data: await requests.myDeletion(clientId, orgId) });
}));

// POST /api/me/deletion/request — ask the studio to delete the account
router.post('/deletion/request', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  try {
    res.json({ data: await requests.requestDeletion(clientId, orgId) });
  } catch (err) {
    if (!inputError(res, err, requests.RequestError)) throw err;
  }
}));

// GET /api/me/export — everything the studio holds about the member
router.get('/export', wrap(async (req, res) => {
  const { clientId, orgId } = selfOf(req);
  const data = await privacy.exportEverything(clientId, orgId, req.user.id);
  res.set('Cache-Control', 'private, no-store');
  res.set('Content-Disposition', `attachment; filename="my-pt-studio-data-${today()}.json"`);
  res.json({ data });
}));

module.exports = router;
module.exports.selfOf = selfOf;
