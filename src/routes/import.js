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
  // Top-level catch: Express 4 does not catch async throws automatically.
  // Without this, any unhandled throw hangs the request → Render timeout → 502.
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
    name:           ['name','full_name','member_name','client_name','member'],
    mobile:         ['mobile','phone','contact','mobile_number','phone_number','contact_number','whatsapp'],
    email:          ['email','email_id','email_address'],
    dob:            ['dob','date_of_birth','birth_date','birthday'],
    gender:         ['gender','sex'],
    address:        ['address','addr','location'],
    joining_date:   ['joining_date','join_date','joined','start_date','enrollment_date','date_of_joining'],
    expiry_date:    ['expiry_date','expiry','end_date','membership_end','valid_till','valid_upto'],
    plan:           ['plan','package','membership','membership_plan','membership_type','plan_name','subscription_plan'],
    amount_paid:    ['amount_paid','amount','fee','fees','payment','paid','selling_price','sale_price','final_amount','total_amount'],
    payment_method: ['payment_method','mode','payment_mode','method'],
    trainer:        ['trainer','trainer_name','coach','assigned_trainer','select_trainer'],
    notes:          ['notes','note','remarks','comment','primary_fitness_goal','fitness_goal','goal'],
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
    try {
      if (!val) return null;
      if (val instanceof Date) return isNaN(val) ? null : val.toISOString().slice(0, 10);
      const s = String(val).trim();
      if (!s) return null;
      // Already ISO YYYY-MM-DD
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
      const parts = s.split(/[\/\-\.]/);
      if (parts.length === 3) {
        const [p0, p1, p2] = parts;
        if (p2.length === 4) {
          // DD-MM-YYYY or MM-DD-YYYY — assume DD-MM-YYYY (Indian format)
          return `${p2}-${p1.padStart(2,'0')}-${p0.padStart(2,'0')}`;
        }
        if (p2.length <= 2) {
          // DD-MM-YY — expand 2-digit year: 00-49 → 2000s, 50-99 → 1900s
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

  let imported = 0, skipped = 0;
  const errors = [];

  const lockClient = await pool.connect();
  try {
    await lockClient.query('BEGIN');
    await lockClient.query("SELECT pg_advisory_xact_lock(hashtext('clients_seq'))");

    /* ── Pre-fetch ID counters ONCE (2 queries instead of 2 per row) ── */
    const { rows: [lastCid] } = await lockClient.query(
      `SELECT client_id FROM clients WHERE client_id ~ '^FS[0-9]+$'
       ORDER BY CAST(SUBSTRING(client_id FROM 3) AS INTEGER) DESC LIMIT 1`
    );
    let clientIdCtr = lastCid?.client_id ? parseInt(lastCid.client_id.replace('FS', ''), 10) + 1 : 1;

    const { rows: [lastMc] } = await lockClient.query(
      `SELECT member_code FROM clients WHERE member_code ~ '^SIX19-[0-9]+$'
       ORDER BY CAST(SUBSTRING(member_code FROM 7) AS INTEGER) DESC LIMIT 1`
    );
    let memberCodeCtr = lastMc?.member_code ? parseInt(lastMc.member_code.replace('SIX19-', ''), 10) + 1 : 1;

    /* ── Batch mobile existence check (1 query instead of N queries) ── */
    const allMobiles = rawRows.map(row => get(row, 'mobile').replace(/\D/g, '').slice(-10)).filter(Boolean);
    const existingMobiles = new Set();
    if (allMobiles.length) {
      const { rows: existing } = await lockClient.query(
        'SELECT mobile FROM clients WHERE mobile = ANY($1)', [allMobiles]
      );
      existing.forEach(r => existingMobiles.add(r.mobile));
    }

    /* ── Per-row insert loop (N INSERT queries only) ── */
    for (let i = 0; i < rawRows.length; i++) {
      const row = rawRows[i];
      const name   = get(row, 'name');
      const mobile = get(row, 'mobile').replace(/\D/g, '').slice(-10);

      if (!name) { skipped++; errors.push({ row: i + 2, issue: 'Missing name' }); continue; }

      // Normalize gender to match DB check constraint: 'Male','Female','Other'
      const rawGender = get(row, 'gender').trim().toLowerCase();
      const genderMap = { male: 'Male', female: 'Female', other: 'Other', m: 'Male', f: 'Female' };
      const gender = genderMap[rawGender] || null;

      const client = {
        name,
        mobile:            mobile || null,
        email:             get(row, 'email') || null,
        dob:               fmt_date(get(row, 'dob')) || null,
        gender,
        address:           get(row, 'address') || null,
        joining_date:      fmt_date(get(row, 'joining_date')) || new Date().toISOString().slice(0, 10),
        pt_end_date:       fmt_date(get(row, 'expiry_date')) || null,
        package_type:      get(row, 'plan') || null,
        paid_amount:       parseFloat(get(row, 'amount_paid')) || null,
        payment_method:    get(row, 'payment_method') || null,
        trainer_name:      get(row, 'trainer') || null,
        status:            get(row, 'status') || 'active',
        weight:            parseFloat(get(row, 'weight')) || null,
        emergency_contact: get(row, 'emergency_contact') || null,
        notes:             get(row, 'notes') || null,
      };

      // Assign IDs in-memory — no extra DB round-trip per row
      let clientCode = null, memberCode = null;
      const isNew = !client.mobile || !existingMobiles.has(client.mobile);
      if (isNew) {
        clientCode = 'FS' + String(clientIdCtr++).padStart(5, '0');
        memberCode = 'SIX19-' + String(memberCodeCtr++).padStart(5, '0');
      }

      try {
        await lockClient.query(`
          INSERT INTO clients
            (id, client_id, member_code, name, mobile, email, dob, gender, address,
             joining_date, pt_end_date, package_type, paid_amount, payment_method, trainer_name,
             status, weight, emergency_contact, notes)
          VALUES (gen_random_uuid()::TEXT, $1, $2, $3, $4, $5, $6, $7, $8,
                  $9, $10, $11, $12, $13, $14,
                  $15, $16, $17, $18)
          ON CONFLICT (mobile) WHERE mobile IS NOT NULL AND mobile != '' DO UPDATE SET
            name              = EXCLUDED.name,
            email             = COALESCE(EXCLUDED.email, clients.email),
            dob               = COALESCE(EXCLUDED.dob, clients.dob),
            gender            = COALESCE(EXCLUDED.gender, clients.gender),
            address           = COALESCE(EXCLUDED.address, clients.address),
            joining_date      = COALESCE(EXCLUDED.joining_date, clients.joining_date),
            pt_end_date       = COALESCE(EXCLUDED.pt_end_date, clients.pt_end_date),
            package_type      = COALESCE(EXCLUDED.package_type, clients.package_type),
            paid_amount       = COALESCE(EXCLUDED.paid_amount, clients.paid_amount),
            payment_method    = COALESCE(EXCLUDED.payment_method, clients.payment_method),
            trainer_name      = COALESCE(EXCLUDED.trainer_name, clients.trainer_name),
            status            = COALESCE(EXCLUDED.status, clients.status),
            weight            = COALESCE(EXCLUDED.weight, clients.weight),
            emergency_contact = COALESCE(EXCLUDED.emergency_contact, clients.emergency_contact),
            notes             = COALESCE(EXCLUDED.notes, clients.notes),
            updated_at        = NOW()
        `, [
          clientCode, memberCode, client.name, client.mobile, client.email, client.dob,
          client.gender, client.address, client.joining_date, client.pt_end_date,
          client.package_type, client.paid_amount, client.payment_method, client.trainer_name,
          client.status, client.weight, client.emergency_contact, client.notes,
        ]);
        imported++;
      } catch (err) {
        skipped++;
        errors.push({ row: i + 2, name, issue: err.message });
      }
    }

    await lockClient.query('COMMIT');
  } catch (err) {
    await lockClient.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    lockClient.release();
  }

  res.json({ imported, skipped, total: rawRows.length, errors: errors.slice(0, 50) });
}

module.exports = router;
