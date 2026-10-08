// src/modules/pt-os/informed-consent.routes.js
// Personal Training Informed Consent module.
// Mounted at /api/pt-os, so final paths are /api/pt-os/informed-consent/...
//
// Follows the same conventions as parq.routes.js: a shared wrap() for
// async error handling, auth + requireTrainer
// on every write (this app is staff-operated — consent is signed in
// person on a staff device during onboarding, there is no separate
// PT-client login), and logActivity() for the audit trail.
const router = require('express').Router();
const multer = require('multer');
const pool = require('../../db/pool');
const { detectFileType, DOCUMENTS } = require('../../lib/fileSignatures');
const logger = require('../../lib/logger');
const { auth, requireTrainer } = require('../../middleware/auth');
const { validate } = require('../../middleware/validate');
const { z } = require('../../lib/validation');
const { logActivity } = require('../../lib/activityLog');
const { generateInformedConsentPdf } = require('../../lib/informedConsentPdf');
const { saveFile } = require('../../lib/fileStorage');
const { tenantScope, orgIdOf } = require('../../lib/tenant-db');
const { consentVersions, completeConsent } = require('./informed-consent.repository');
const { invalidFileType } = require('../../middleware/errorHandler');
const { signatureDataUrl, describeAgent } = require('../../lib/signing');

// The studio trainer only. server.js mounts this router behind requireTrainer
// too; declaring it here as well means the guard travels with the router and
// cannot be lost if the mount is edited or the router is mounted again.
router.use(auth, requireTrainer);

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Section 6/7/8 acknowledgements (Agreement step) — all 3 must be true
// before a signature can be captured. The Section 2/4 risk-acknowledgement
// items were dropped along with the Risks & Responsibilities wizard step.
const ACK_KEYS = [
  'understands_confidentiality', 'voluntary_participation', 'final_declaration',
];


// ─── Schemas ────────────────────────────────────────────────

const createSchema = {
  body: z.object({
    client_id: z.string(),
    // All optional — server auto-fills from the live pt_clients row when
    // omitted (Section: "Client Information ... Auto-fill from client
    // profile"). Callers may still override (e.g. a corrected DOB).
    full_name: z.string().max(255).optional().nullable(),
    gender: z.string().max(20).optional().nullable(),
    dob: z.string().optional().nullable(),
    mobile: z.string().max(20).optional().nullable(),
    email: z.string().email().max(255).optional().nullable(),
    emergency_contact: z.string().max(255).optional().nullable(),
    emergency_phone: z.string().max(20).optional().nullable(),
    address: z.string().max(1000).optional().nullable(),
    occupation: z.string().max(255).optional().nullable(),
  }),
};

const updateSchema = {
  body: z.object({
    full_name: z.string().max(255).optional(),
    gender: z.string().max(20).optional().nullable(),
    dob: z.string().optional().nullable(),
    mobile: z.string().max(20).optional().nullable(),
    email: z.string().email().max(255).optional().nullable(),
    emergency_contact: z.string().max(255).optional().nullable(),
    emergency_phone: z.string().max(20).optional().nullable(),
    address: z.string().max(1000).optional().nullable(),
    occupation: z.string().max(255).optional().nullable(),
    acknowledgements: z.record(z.string(), z.boolean()).optional(),
    physician_advised_against: z.boolean().optional().nullable(),
    physician_name: z.string().max(255).optional().nullable(),
    hospital: z.string().max(255).optional().nullable(),
    medical_condition: z.string().max(1000).optional().nullable(),
    // Exercise Programme Consent — a distinct sub-section with its own
    // text/checkbox/date/signature (see migration 067).
    exercise_consent_text: z.string().max(8000).optional().nullable(),
    exercise_consent_checked: z.boolean().optional(),
    // The day it was signed: recent, and not ahead of today. Any string at
    // all used to be accepted, so a consent could be back- or future-dated.
    exercise_consent_date: z.string().optional().nullable().refine(
      (v) => !v || (!Number.isNaN(Date.parse(v))
        && Date.parse(v) <= Date.now() + 86400000
        && Date.parse(v) >= Date.now() - 8 * 86400000),
      { message: 'Consent date must be within the last 7 days and not in the future' }
    ),
    exercise_consent_signature: signatureDataUrl.optional().nullable(),
  }),
};

const signSchema = {
  body: z.object({
    signer: z.enum(['client', 'trainer', 'witness']),
    signature: signatureDataUrl,
    witness_name: z.string().max(255).optional().nullable(),
  }).refine((b) => b.signer !== 'witness' || (b.witness_name && b.witness_name.trim()), {
    // A witness signature with no name identifies nobody.
    message: 'A witness signature needs the witness name', path: ['witness_name'],
  }),
};

const SNAPSHOT_FIELDS = [
  'full_name', 'gender', 'dob', 'mobile', 'email',
  'emergency_contact', 'emergency_phone', 'address', 'occupation',
];

// ─── Helpers ────────────────────────────────────────────────

// Tenant scope: only snapshot a client in the caller's own org, otherwise a
// consent create with a foreign client_id would copy that client's PII into a
// new record owned by the caller's org (cross-tenant PII exfiltration). A
// deleted client is not a client: no new consent is opened for one.
async function fetchClientSnapshot(clientId, req) {
  const scope = tenantScope(req);
  const params = [clientId];
  let orgClause = '';
  params.push(scope.orgId); orgClause = ' AND organization_id = $2';
  const { rows } = await pool.query(
    `SELECT name AS full_name, gender, dob, mobile, email, address, occupation,
            emergency_contact, emergency_phone, trainer_id
       FROM pt_clients WHERE id = $1 AND deleted_at IS NULL${orgClause}`,
    params
  );
  return rows[0] || null;
}

// Signed text must be the text that was signed. A draft is signed in two
// calls (client, then trainer), and a PATCH between them could rewrite the
// name, the acknowledgements or the medical answers under a signature
// already given — the completed PDF would then show the client "signing"
// words they never saw. So a content change to a draft that already carries
// a signature clears every signature on it, and signing starts again.
// Compared by value, not by presence in the body: the wizard re-sends the
// whole form on every save, and an unchanged re-save must not unsign it.
//
// The exercise programme consent text and its tick are signed content too;
// its signature and date are not (they are filled from the step-3 signature
// on the final save, which must not unsign the document it completes).
const SIGNED_CONTENT_FIELDS = [
  ...SNAPSHOT_FIELDS, 'acknowledgements', 'physician_advised_against',
  'physician_name', 'hospital', 'medical_condition',
  'exercise_consent_text', 'exercise_consent_checked',
];

function sameValue(a, b) {
  const norm = (v) => {
    if (v === undefined || v === null || v === '') return null;
    if (v instanceof Date) {
      const pad = (x) => String(x).padStart(2, '0');
      return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
    }
    if (typeof v === 'object') {
      return JSON.stringify(Object.keys(v).sort().reduce((o, k) => { o[k] = v[k]; return o; }, {}));
    }
    return String(v);
  };
  return norm(a) === norm(b);
}

function changesSignedContent(existing, body) {
  return SIGNED_CONTENT_FIELDS.some((k) => body[k] !== undefined && !sameValue(existing[k], body[k]));
}

// ─── Informed Consents ──────────────────────────────────────

// GET /informed-consent?client_id= — active record first, then history.
router.get('/informed-consent', auth, wrap(async (req, res) => {
  const { client_id } = req.query;
  const where = [];
  const params = [];
  const scope = tenantScope(req);
  params.push(scope.orgId); where.push(`organization_id = $${params.length}`);
  if (client_id) { params.push(client_id); where.push(`client_id = $${params.length}`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT * FROM pt_informed_consents ${whereSql} ORDER BY created_at DESC`, params
  );
  res.json({ data: rows });
}));

// GET /informed-consent/:id
router.get('/informed-consent/:id', auth, wrap(async (req, res) => {
  const scope = tenantScope(req);
  const guard = ' AND organization_id = $2';
  const { rows } = await pool.query(
    `SELECT * FROM pt_informed_consents WHERE id = $1${guard}`,
    [req.params.id, scope.orgId]
  );
  if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND' } });
  res.json({ data: rows[0] });
}));

// GET /informed-consent/:id/activity — reuses the generic activity_log
// table (see src/lib/activityLog.js); scoped by entity rather than by
// user, unlike GET /profile/activity.
router.get('/informed-consent/:id/activity', auth, wrap(async (req, res) => {
  // Gate on the parent consent's org — activity_log has no org column.
  const scope = tenantScope(req);
  const guard = ' AND organization_id = $2';
  const { rows: owner } = await pool.query(
    `SELECT id FROM pt_informed_consents WHERE id = $1${guard}`,
    [req.params.id, scope.orgId]
  );
  if (!owner[0]) return res.status(404).json({ error: { code: 'NOT_FOUND' } });

  const { rows } = await pool.query(
    `SELECT id, user_id, user_name, action, new_data, ip_address, created_at
       FROM activity_log
      WHERE entity_type = 'pt_informed_consents' AND entity_id = $1
      ORDER BY created_at DESC`,
    [req.params.id]
  );
  res.json({ data: rows });
}));

// POST /informed-consent — creates a new draft, auto-filling the client
// snapshot from pt_clients for any field not explicitly provided.
router.post('/informed-consent', auth, requireTrainer, validate(createSchema), wrap(async (req, res) => {
  const b = req.body;
  const snapshot = await fetchClientSnapshot(b.client_id, req);
  if (!snapshot) return res.status(404).json({ error: { code: 'CLIENT_NOT_FOUND' } });

  const values = {};
  for (const key of SNAPSHOT_FIELDS) {
    values[key] = b[key] !== undefined && b[key] !== null ? b[key] : (snapshot[key] ?? null);
  }
  if (!values.full_name) {
    return res.status(400).json({ error: { code: 'FULL_NAME_REQUIRED' } });
  }

  // A client has one live consent at a time (draft or completed — the
  // pic_one_active_per_client_idx unique index). A second create used to
  // surface as a raw unique-violation 500; name the record instead so the
  // caller can resume the draft, or amend the completed consent via PATCH.
  // A new consent after a revocation is a new version of the revoked one,
  // so the history reads as one chain.
  const prior = await consentVersions(b.client_id, orgIdOf(req));
  const active = prior.find((r) => r.status === 'draft' || r.status === 'completed');
  if (active) {
    return res.status(409).json({
      error: {
        code: 'ACTIVE_CONSENT_EXISTS',
        message: active.status === 'draft'
          ? 'This client already has a consent in progress — continue it instead.'
          : 'This client already has a completed consent — amend it to create a new version.',
        id: active.id, status: active.status,
      },
    });
  }
  const previous = prior.find((r) => r.status !== 'archived') || prior[0] || null;
  const version = prior.reduce((max, r) => Math.max(max, Number(r.version) || 1), 0) + 1;

  const { rows } = await pool.query(
    `INSERT INTO pt_informed_consents (
       client_id, trainer_id, status, version, previous_version_id,
       full_name, gender, dob, mobile, email, emergency_contact, emergency_phone, address, occupation,
       created_by, organization_id
     ) VALUES ($1,$2,'draft',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [
      b.client_id, snapshot.trainer_id || null, version, previous ? previous.id : null,
      values.full_name, values.gender, values.dob, values.mobile, values.email,
      values.emergency_contact, values.emergency_phone, values.address, values.occupation,
      req.user.id, orgIdOf(req),
    ]
  );
  const record = rows[0];

  await logActivity(req, 'informed_consent.create', 'pt_informed_consents', record.id, {
    client_id: b.client_id, previous_version_id: previous ? previous.id : null,
  });
  res.status(201).json({ data: record });
}));

// PATCH /informed-consent/:id
// A draft is edited in place. A completed record is never overwritten —
// editing it archives the current row and creates a new draft version
// carrying the patched fields forward, per the module's versioning rule.
router.patch('/informed-consent/:id', auth, requireTrainer, validate(updateSchema), wrap(async (req, res) => {
  const { id } = req.params;
  const b = req.body;

  const editable = [
    'full_name', 'gender', 'dob', 'mobile', 'email', 'emergency_contact', 'emergency_phone',
    'address', 'occupation', 'acknowledgements', 'physician_advised_against',
    'physician_name', 'hospital', 'medical_condition',
    'exercise_consent_text', 'exercise_consent_checked', 'exercise_consent_date', 'exercise_consent_signature',
  ];
  const jsonFields = new Set(['acknowledgements']);

  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const scope = tenantScope(req);
    const upGuard = ' AND organization_id = $2';
    const { rows: existingRows } = await tx.query(
      `SELECT * FROM pt_informed_consents WHERE id = $1${upGuard} FOR UPDATE`,
      [id, scope.orgId]
    );
    const existing = existingRows[0];
    if (!existing) { await tx.query('ROLLBACK'); return res.status(404).json({ error: { code: 'NOT_FOUND' } }); }
    if (['revoked', 'archived', 'expired'].includes(existing.status)) {
      await tx.query('ROLLBACK');
      return res.status(409).json({ error: { code: 'NOT_EDITABLE', status: existing.status } });
    }

    let targetId = id;
    if (existing.status === 'completed') {
      await tx.query(
        `UPDATE pt_informed_consents SET status = 'archived', updated_at = NOW() WHERE id = $1`, [id]
      );
      const { rows: newRows } = await tx.query(
        `INSERT INTO pt_informed_consents (
           client_id, trainer_id, version, previous_version_id, status,
           full_name, gender, dob, mobile, email, emergency_contact, emergency_phone, address, occupation,
           acknowledgements, physician_advised_against, physician_name, hospital, medical_condition,
           exercise_consent_text, medical_clearance_file_url,
           created_by, organization_id
         )
         SELECT client_id, trainer_id, version + 1, id, 'draft',
                full_name, gender, dob, mobile, email, emergency_contact, emergency_phone, address, occupation,
                acknowledgements, physician_advised_against, physician_name, hospital, medical_condition,
                -- The medical clearance on file still stands for the new
                -- version: dropping it re-blocked a client whose physician
                -- had advised against exercise the moment the consent was
                -- amended. The exercise consent tick and signature are
                -- given again; its text carries forward.
                exercise_consent_text, medical_clearance_file_url,
                $2, organization_id
           FROM pt_informed_consents WHERE id = $1
         RETURNING id`,
        [id, req.user.id]
      );
      targetId = newRows[0].id;
    }

    const sets = [];
    const params = [targetId];
    for (const key of editable) {
      if (b[key] !== undefined) {
        const isJson = jsonFields.has(key) && b[key] !== null;
        params.push(isJson ? JSON.stringify(b[key]) : b[key]);
        sets.push(`${key} = $${params.length}${isJson ? '::jsonb' : ''}`);
      }
    }

    // Exercise Programme Consent completes in this same PATCH (it's not
    // routed through /sign — that endpoint is for the overall document's
    // client/trainer/witness roles). Stamp the timestamp server-side,
    // never trust a client-supplied one, the moment both the checkbox and
    // signature are present.
    if (b.exercise_consent_checked === true && b.exercise_consent_signature) {
      sets.push('exercise_consent_signed_at = NOW()');
    }

    const hasSignature = existing.client_signature || existing.trainer_signature || existing.witness_signature;
    const unsign = targetId === id && hasSignature && changesSignedContent(existing, b);
    if (unsign) {
      sets.push(
        'client_signature = NULL', 'client_signed_at = NULL',
        'trainer_signature = NULL', 'trainer_signed_at = NULL',
        'witness_signature = NULL', 'witness_signed_at = NULL', 'witness_name = NULL'
      );
    }

    if (sets.length) {
      sets.push('updated_at = NOW()');
      await tx.query(`UPDATE pt_informed_consents SET ${sets.join(', ')} WHERE id = $1`, params);
    }

    await tx.query('COMMIT');

    const { rows } = await pool.query('SELECT * FROM pt_informed_consents WHERE id = $1', [targetId]);
    if (unsign) {
      await logActivity(req, 'informed_consent.signatures_cleared', 'pt_informed_consents', targetId, { reason: 'content_changed' });
    }
    if (targetId !== id) {
      await logActivity(req, 'informed_consent.new_version', 'pt_informed_consents', targetId, { previous_version_id: id });
    }
    res.json({ data: rows[0] });
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    tx.release();
  }
}));

// POST /informed-consent/:id/sign
// Captures one signature (client/trainer/witness). Once both the client
// and trainer have signed and every acknowledgement is true, the record
// is finalized: status -> completed, capture metadata recorded, PDF
// generated.
router.post('/informed-consent/:id/sign', auth, requireTrainer, validate(signSchema), wrap(async (req, res) => {
  const { id } = req.params;
  const scope = tenantScope(req);
  const signGuard = ' AND organization_id = $2';
  const { rows: existingRows } = await pool.query(
    `SELECT * FROM pt_informed_consents WHERE id = $1${signGuard}`,
    [id, scope.orgId]
  );
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: { code: 'NOT_FOUND' } });
  if (['completed', 'revoked', 'archived', 'expired'].includes(existing.status)) {
    return res.status(409).json({ error: { code: 'NOT_SIGNABLE', status: existing.status } });
  }
  // A consent cannot be completed for a client who has since been deleted
  // (fetchClientSnapshot reads only live clients of this studio).
  if (!await fetchClientSnapshot(existing.client_id, req)) {
    return res.status(409).json({ error: { code: 'CLIENT_DELETED', message: 'This client has been deleted.' } });
  }

  const acks = existing.acknowledgements || {};
  const allAcked = ACK_KEYS.every((k) => acks[k] === true);
  if (!allAcked) {
    return res.status(400).json({ error: { code: 'ACKNOWLEDGEMENTS_INCOMPLETE' } });
  }
  // The exercise programme consent is the part of the document that agrees
  // to the training itself; a record could complete without it.
  if (existing.exercise_consent_checked !== true) {
    return res.status(400).json({
      error: { code: 'EXERCISE_CONSENT_REQUIRED', message: 'The exercise programme consent must be accepted before signing.' },
    });
  }

  const { signer, signature, witness_name } = req.body;
  const col = signer === 'client' ? 'client_signature' : signer === 'trainer' ? 'trainer_signature' : 'witness_signature';
  const atCol = signer === 'client' ? 'client_signed_at' : signer === 'trainer' ? 'trainer_signed_at' : 'witness_signed_at';

  const sets = [`${col} = $2`, `${atCol} = NOW()`, 'updated_at = NOW()'];
  const params = [id, signature];
  if (signer === 'witness' && witness_name) { params.push(witness_name); sets.push(`witness_name = $${params.length}`); }

  // Guarded on status: a record completed, revoked or archived between the
  // read above and this write must not take another signature.
  const { rows } = await pool.query(
    `UPDATE pt_informed_consents SET ${sets.join(', ')}
      WHERE id = $1 AND status NOT IN ('completed', 'revoked', 'archived', 'expired')
      RETURNING *`, params
  );
  if (!rows[0]) return res.status(409).json({ error: { code: 'NOT_SIGNABLE' } });
  let record = rows[0];

  await logActivity(req, `informed_consent.sign.${signer}`, 'pt_informed_consents', id, {});

  const bothSigned = Boolean(record.client_signature) && Boolean(record.trainer_signature);
  if (bothSigned && record.status !== 'completed') {
    const { device, browser } = describeAgent(req.headers['user-agent']);

    // Exactly one completion: a signer who loses the race to the other
    // gets the record as it stands, with no second PDF or completion log.
    const completion = await completeConsent(id, { ip: req.ip || null, device, browser });
    if (!completion.completed) return res.json({ data: completion.record });
    record = completion.record;

    // PDF generation failure shouldn't fail the signed record itself — it's
    // already durably stored and the PDF can be regenerated later.
    try {
      const pdfUrl = await generateInformedConsentPdf(record, req.user?.organization_name);
      const { rows: withPdf } = await pool.query(
        'UPDATE pt_informed_consents SET pdf_url = $1 WHERE id = $2 RETURNING *', [pdfUrl, id]
      );
      record = withPdf[0];
    } catch (err) {
      logger.error({ err: err.message, id }, 'informed consent PDF generation failed');
    }

    await logActivity(req, 'informed_consent.completed', 'pt_informed_consents', id, {});
  }

  res.json({ data: record });
}));

// POST /informed-consent/:id/revoke
//
// Only a COMPLETED consent can be revoked: it is the client withdrawing an
// agreement they gave. A draft was never given (discard or finish it), and
// an archived version is history. Revoking either used to succeed and, for
// an archived row, changed nothing the gate reads while looking as if it had.
// A revocation is a hard stop on training (see lib/screeningGate.js), so the
// reason is recorded with it.
const revokeSchema = {
  body: z.object({ reason: z.string().trim().max(1000).optional().nullable() }).optional().default({}),
};

router.post('/informed-consent/:id/revoke', auth, requireTrainer, validate(revokeSchema), wrap(async (req, res) => {
  const scope = tenantScope(req);
  const rvGuard = ' AND organization_id = $2';
  // One statement: find the record in this studio, revoke it only if it is
  // completed, and report its prior status either way (404 vs 409).
  const { rows: [r] } = await pool.query(
    `WITH target AS (
       SELECT id, status FROM pt_informed_consents WHERE id = $1${rvGuard}
     ), revoked AS (
       UPDATE pt_informed_consents ic SET status = 'revoked', updated_at = NOW()
         FROM target WHERE ic.id = target.id AND target.status = 'completed'
       RETURNING ic.*
     )
     SELECT (SELECT status FROM target) AS prior_status,
            (SELECT row_to_json(revoked) FROM revoked) AS record`,
    [req.params.id, scope.orgId]
  );
  if (!r || !r.prior_status) return res.status(404).json({ error: { code: 'NOT_FOUND' } });
  if (!r.record) return res.status(409).json({ error: { code: 'NOT_REVOCABLE', status: r.prior_status } });
  await logActivity(req, 'informed_consent.revoke', 'pt_informed_consents', req.params.id, {
    reason: req.body?.reason || null,
  });
  res.json({ data: r.record });
}));

// ─── Medical Clearance Upload ───────────────────────────────
// Same multer + memoryStorage + magic-byte-sniff pattern as parq.routes.js
// (MIME header alone can be spoofed).

const IC_MAX_UPLOAD_BYTES = parseInt(process.env.PARQ_MAX_UPLOAD_BYTES, 10) || 10 * 1024 * 1024;
const clearanceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: IC_MAX_UPLOAD_BYTES },
  fileFilter(_req, file, cb) {
    if (!/^image\/(png|jpe?g)$|^application\/pdf$/i.test(file.mimetype || '')) {
      return cb(invalidFileType('Only PNG, JPG, or PDF files are allowed'));
    }
    cb(null, true);
  },
});


// POST /informed-consent/:id/medical-clearance
router.post('/informed-consent/:id/medical-clearance', auth, requireTrainer, clearanceUpload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: { code: 'FILE_REQUIRED' } });

  const { id } = req.params;
  const scope = tenantScope(req);
  const mcGuard = ' AND organization_id = $2';
  const { rows: existingRows } = await pool.query(
    `SELECT id FROM pt_informed_consents WHERE id = $1${mcGuard}`,
    [id, scope.orgId]
  );
  if (!existingRows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND' } });

  const detected = detectFileType(req.file.buffer, DOCUMENTS);
  if (!detected) {
    return res.status(400).json({ error: { code: 'INVALID_FILE_TYPE' } });
  }

  const filename = `${id}-${Date.now()}.${detected.ext}`;
  const fileUrl = await saveFile('informed-consent', filename, req.file.buffer, detected.mime,
    { organizationId: req.user?.organization_id, uploadedBy: req.user?.id });

  const { rows } = await pool.query(
    `UPDATE pt_informed_consents SET medical_clearance_file_url = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [fileUrl, id]
  );
  await logActivity(req, 'informed_consent.clearance_upload', 'pt_informed_consents', id, {});
  res.status(201).json({ data: rows[0] });
}));

module.exports = router;
