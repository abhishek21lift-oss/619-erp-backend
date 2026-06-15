const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const { readSheet } = require('read-excel-file/node');
const pool = require('../db/pool');
const { auth, adminOnly } = require('../middleware/auth');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const name = String(file.originalname || '').toLowerCase();
    if (!/\.(xlsx|csv)$/.test(name)) {
      return cb(new Error('Only .xlsx and .csv files are supported'));
    }
    cb(null, true);
  },
});

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (quoted && ch === '"' && next === '"') {
      cell += '"';
      i++;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (!quoted && ch === ',') {
      row.push(cell);
      cell = '';
    } else if (!quoted && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && next === '\n') i++;
      row.push(cell);
      if (row.some((v) => String(v).trim())) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  if (row.some((v) => String(v).trim())) rows.push(row);
  return rows;
}

function rowsToObjects(rows) {
  const headers = (rows[0] || []).map((h) => String(h || '').trim());
  return rows.slice(1).map((row) => {
    const out = {};
    headers.forEach((header, index) => {
      if (header) out[header] = row[index] ?? '';
    });
    return out;
  });
}

async function parseUploadedRows(file) {
  const name = String(file.originalname || '').toLowerCase();
  if (name.endsWith('.csv')) {
    return rowsToObjects(parseCsv(file.buffer.toString('utf8')));
  }

  const rows = await readSheet(file.buffer);
  return rowsToObjects(rows);
}

/* ──────────────────────────────────────────────
   POST /import/import-excel
   Body: multipart/form-data  field: file (.xlsx/.csv)
   Writes to pt_clients — the table shown in All Clients / PT OS module.
   Returns: { imported, skipped, total, errors[] }
────────────────────────────────────────────── */
router.post('/import-excel', auth, adminOnly, upload.single('file'), async (req, res) => {
  // Express 4 does not catch async throws automatically — wrap to avoid 502.
  try { return await _handleImport(req, res); }
  catch (err) { return res.status(500).json({ error: err?.message || 'Import failed' }); }
});

async function _handleImport(req, res) {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

  let rawRows;
  try {
    rawRows = await parseUploadedRows(req.file);
  } catch {
    return res.status(400).json({ error: 'Could not parse file. Please upload a valid .xlsx or .csv file.' });
  }

  if (!rawRows.length) return res.status(400).json({ error: 'Sheet is empty.' });

  /* ── column name normaliser ─────────────────────────────────────────── */
  const norm = (s) => String(s).trim().toLowerCase().replace(/[^a-z0-9]/g, '_');

  const FIELD_MAP = {
    name:         ['name','full_name','member_name','client_name','member'],
    mobile:       ['mobile','phone','contact','mobile_number','phone_number','contact_number','whatsapp'],
    email:        ['email','email_id','email_address'],
    dob:          ['dob','date_of_birth','birth_date','birthday'],
    gender:       ['gender','sex'],
    address:      ['address','addr','location'],
    joining_date: ['joining_date','join_date','joined','start_date','enrollment_date','date_of_joining'],
    plan:         ['plan','package','membership','membership_plan','membership_type','plan_name','subscription_plan'],
    final_amount: ['final_amount','total_amount','total','selling_price','sale_price','total_fee','total_fees'],
    amount_paid:  ['amount_paid','amount','fee','fees','payment','paid','collected','amount_collected'],
    trainer:      ['trainer','trainer_name','coach','assigned_trainer','select_trainer'],
    notes:        ['notes','note','remarks','comment','primary_fitness_goal','fitness_goal','goal','interested_in'],
    weight:       ['weight','weight_kg'],
    emergency_contact: ['emergency_contact','emergency_phone','emergency_number'],
  };

  const headers = Object.keys(rawRows[0]).map(norm);
  const keyFor = {};
  for (const [field, aliases] of Object.entries(FIELD_MAP)) {
    const match = headers.find(h => aliases.includes(h));
    if (match) {
      const original = Object.keys(rawRows[0])[headers.indexOf(match)];
      keyFor[field] = original;
    }
  }

  if (!keyFor.name && !keyFor.mobile) {
    return res.status(400).json({
      error: 'Could not find required columns (name / mobile). Please check your column headers.',
      detected_headers: Object.keys(rawRows[0]),
    });
  }

  const fmt_date = (val) => {
    try {
      if (!val) return null;
      if (val instanceof Date) return isNaN(val) ? null : val.toISOString().slice(0, 10);
      const s = String(val).trim();
      if (!s) return null;
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
      const parts = s.split(/[\/\-\.]/);
      if (parts.length === 3) {
        const [p0, p1, p2] = parts;
        if (p2.length === 4) return `${p2}-${p1.padStart(2,'0')}-${p0.padStart(2,'0')}`;
        if (p2.length <= 2) {
          const yy = parseInt(p2, 10);
          const yyyy = yy <= 49 ? 2000 + yy : 1900 + yy;
          return `${yyyy}-${p1.padStart(2,'0')}-${p0.padStart(2,'0')}`;
        }
      }
      const d = new Date(s);
      return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
    } catch { return null; }
  };

  const get = (row, field) => {
    const key = keyFor[field];
    return key ? String(row[key] ?? '').trim() : '';
  };

  /* ── Pre-fetch existing pt_clients mobiles (1 query) ── */
  const allMobiles = rawRows
    .map(row => get(row, 'mobile').replace(/\D/g, '').slice(-10))
    .filter(Boolean);
  const existingMap = new Map(); // mobile → id
  if (allMobiles.length) {
    const { rows: existing } = await pool.query(
      'SELECT id, mobile FROM pt_clients WHERE mobile = ANY($1) AND deleted_at IS NULL',
      [allMobiles]
    );
    existing.forEach(r => existingMap.set(r.mobile, r.id));
  }

  let imported = 0, skipped = 0;
  const errors = [];

  for (let i = 0; i < rawRows.length; i++) {
    const row = rawRows[i];
    const name   = get(row, 'name');
    const mobile = get(row, 'mobile').replace(/\D/g, '').slice(-10);

    if (!name) { skipped++; errors.push({ row: i + 2, issue: 'Missing name' }); continue; }

    const startDate  = fmt_date(get(row, 'joining_date'));
    const rawFinal   = parseFloat(get(row, 'final_amount')) || 0;
    const paidAmt    = parseFloat(get(row, 'amount_paid')) || 0;
    const finalAmt   = rawFinal || paidAmt; // if no separate final column, fall back to paid

    const c = {
      name,
      mobile:        mobile || null,
      email:         get(row, 'email') || null,
      dob:           fmt_date(get(row, 'dob')) || null,
      gender:        get(row, 'gender') || null,
      address:       get(row, 'address') || null,
      joining_date:  startDate || new Date().toISOString().slice(0, 10),
      pt_start_date: startDate || null,
      package_type:  get(row, 'plan') || null,
      paid_amount:   paidAmt,
      final_amount:  finalAmt,
      trainer_name:  get(row, 'trainer') || null,
      weight:        parseFloat(get(row, 'weight')) || null,
      emergency_contact: get(row, 'emergency_contact') || null,
      notes:         get(row, 'notes') || null,
      status:        'active',
    };

    try {
      const existingId = mobile ? existingMap.get(mobile) : null;
      if (existingId) {
        // Update existing pt_client — don't overwrite non-null fields with null
        await pool.query(`
          UPDATE pt_clients SET
            name          = $1,
            email         = COALESCE($2, email),
            dob           = COALESCE($3, dob),
            gender        = COALESCE($4, gender),
            address       = COALESCE($5, address),
            joining_date  = COALESCE($6, joining_date),
            pt_start_date = COALESCE($7, pt_start_date),
            package_type  = COALESCE($8, package_type),
            paid_amount   = CASE WHEN $9 > 0 THEN $9 ELSE paid_amount END,
            final_amount  = CASE WHEN $10 > 0 THEN $10 ELSE final_amount END,
            trainer_name  = COALESCE($11, trainer_name),
            weight        = COALESCE($12, weight),
            emergency_contact = COALESCE($13, emergency_contact),
            notes         = COALESCE($14, notes),
            updated_at    = NOW()
          WHERE id = $15
        `, [
          c.name, c.email, c.dob, c.gender, c.address,
          c.joining_date, c.pt_start_date, c.package_type,
          c.paid_amount, c.final_amount, c.trainer_name, c.weight,
          c.emergency_contact, c.notes, existingId,
        ]);
      } else {
        await pool.query(`
          INSERT INTO pt_clients
            (name, mobile, email, dob, gender, address,
             joining_date, pt_start_date, package_type,
             paid_amount, final_amount, trainer_name,
             weight, emergency_contact, notes, status)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
        `, [
          c.name, c.mobile, c.email, c.dob, c.gender, c.address,
          c.joining_date, c.pt_start_date, c.package_type,
          c.paid_amount, c.final_amount, c.trainer_name,
          c.weight, c.emergency_contact, c.notes, c.status,
        ]);
      }
      imported++;
    } catch (err) {
      skipped++;
      errors.push({ row: i + 2, name, issue: err.message });
    }
  }

  res.json({ imported, skipped, total: rawRows.length, errors: errors.slice(0, 50) });
}

module.exports = router;
