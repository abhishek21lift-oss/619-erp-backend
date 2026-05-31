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
   POST /clients/import-excel
   Body: multipart/form-data  field: file (.xlsx/.csv)
   Returns: { imported, skipped, errors[] }
────────────────────────────────────────────── */
router.post('/import-excel', auth, adminOnly, upload.single('file'), async (req, res) => {
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
    name:           ['name','full_name','member_name','client_name','member'],
    mobile:         ['mobile','phone','contact','mobile_number','phone_number','contact_number','whatsapp'],
    email:          ['email','email_id','email_address'],
    dob:            ['dob','date_of_birth','birth_date','birthday'],
    gender:         ['gender','sex'],
    address:        ['address','addr','location'],
    joining_date:   ['joining_date','join_date','joined','start_date','enrollment_date','date_of_joining'],
    expiry_date:    ['expiry_date','expiry','end_date','membership_end','valid_till','valid_upto'],
    plan:           ['plan','package','membership','membership_plan','membership_type','plan_name'],
    amount_paid:    ['amount_paid','amount','fee','fees','payment','paid'],
    payment_method: ['payment_method','mode','payment_mode','method'],
    trainer:        ['trainer','trainer_name','coach','assigned_trainer'],
    status:         ['status','member_status'],
    height:         ['height','height_cm'],
    weight:         ['weight','weight_kg'],
    blood_group:    ['blood_group','blood','blood_type'],
    emergency_contact: ['emergency_contact','emergency_phone','emergency_number'],
    notes:          ['notes','note','remarks','comment'],
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
    if (!val) return null;
    if (val instanceof Date) return val.toISOString().slice(0, 10);
    const s = String(val).trim();
    if (!s) return null;
    const parts = s.split(/[\/\-\.]/);
    if (parts.length === 3) {
      if (parts[2].length === 4) return `${parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}`;
      return new Date(s).toISOString().slice(0, 10);
    }
    const d = new Date(s);
    return isNaN(d) ? null : d.toISOString().slice(0, 10);
  };

  const get = (row, field) => {
    const key = keyFor[field];
    return key ? String(row[key] ?? '').trim() : '';
  };

  let imported = 0, skipped = 0;
  const errors = [];

  for (let i = 0; i < rawRows.length; i++) {
    const row = rawRows[i];
    const name   = get(row, 'name');
    const mobile = get(row, 'mobile').replace(/\D/g, '').slice(-10);

    if (!name) { skipped++; errors.push({ row: i + 2, issue: 'Missing name' }); continue; }

    const client = {
      name,
      mobile:           mobile || null,
      email:            get(row, 'email') || null,
      dob:              fmt_date(get(row, 'dob')) || null,
      gender:           (get(row, 'gender') || '').toLowerCase() || null,
      address:          get(row, 'address') || null,
      joining_date:     fmt_date(get(row, 'joining_date')) || new Date().toISOString().slice(0, 10),
      expiry_date:      fmt_date(get(row, 'expiry_date')) || null,
      plan:             get(row, 'plan') || null,
      amount_paid:      parseFloat(get(row, 'amount_paid')) || null,
      payment_method:   get(row, 'payment_method') || null,
      trainer_name:     get(row, 'trainer') || null,
      status:           get(row, 'status') || 'active',
      height:           parseFloat(get(row, 'height')) || null,
      weight:           parseFloat(get(row, 'weight')) || null,
      blood_group:      get(row, 'blood_group') || null,
      emergency_contact:get(row, 'emergency_contact') || null,
      notes:            get(row, 'notes') || null,
    };

    try {
      await pool.query(`
        INSERT INTO clients
          (name, mobile, email, dob, gender, address, joining_date, expiry_date,
           plan, amount_paid, payment_method, trainer_name, status,
           height, weight, blood_group, emergency_contact, notes)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
        ON CONFLICT (mobile) DO UPDATE SET
          name            = EXCLUDED.name,
          email           = COALESCE(EXCLUDED.email, clients.email),
          dob             = COALESCE(EXCLUDED.dob, clients.dob),
          gender          = COALESCE(EXCLUDED.gender, clients.gender),
          address         = COALESCE(EXCLUDED.address, clients.address),
          joining_date    = COALESCE(EXCLUDED.joining_date, clients.joining_date),
          expiry_date     = COALESCE(EXCLUDED.expiry_date, clients.expiry_date),
          plan            = COALESCE(EXCLUDED.plan, clients.plan),
          amount_paid     = COALESCE(EXCLUDED.amount_paid, clients.amount_paid),
          payment_method  = COALESCE(EXCLUDED.payment_method, clients.payment_method),
          trainer_name    = COALESCE(EXCLUDED.trainer_name, clients.trainer_name),
          status          = COALESCE(EXCLUDED.status, clients.status),
          height          = COALESCE(EXCLUDED.height, clients.height),
          weight          = COALESCE(EXCLUDED.weight, clients.weight),
          blood_group     = COALESCE(EXCLUDED.blood_group, clients.blood_group),
          emergency_contact = COALESCE(EXCLUDED.emergency_contact, clients.emergency_contact),
          notes           = COALESCE(EXCLUDED.notes, clients.notes),
          updated_at      = NOW()
      `, [
        client.name, client.mobile, client.email, client.dob, client.gender, client.address,
        client.joining_date, client.expiry_date, client.plan, client.amount_paid, client.payment_method,
        client.trainer_name, client.status, client.height, client.weight, client.blood_group,
        client.emergency_contact, client.notes
      ]);
      imported++;
    } catch (err) {
      skipped++;
      errors.push({ row: i + 2, name, issue: err.message });
    }
  }

  res.json({ imported, skipped, total: rawRows.length, errors: errors.slice(0, 50) });
});

module.exports = router;
