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
    name:             ['name','full_name','member_name','client_name','member'],
    mobile:           ['mobile','phone','contact','mobile_number','phone_number','contact_number','whatsapp'],
    email:            ['email','email_id','email_address'],
    dob:              ['dob','date_of_birth','birth_date','birthday'],
    gender:           ['gender','sex'],
    address:          ['address','addr','location'],
    joining_date:     ['joining_date','join_date','joined','start_date','enrollment_date','date_of_joining'],
    pt_end_date:      ['pt_end_date','end_date','expiry_date','expiry','expires','validity_date'],
    duration_months:  ['duration_months','duration','months','duration_month','plan_duration'],
    plan:             ['plan','package','membership','membership_plan','membership_type','plan_name','subscription_plan'],
    base_amount:      ['base_amount','base','original_amount','mrp','list_price'],
    final_amount:     ['final_amount','total_amount','total','selling_price','sale_price','total_fee','total_fees'],
    amount_paid:      ['amount_paid','amount','fee','fees','payment','paid','collected','amount_collected'],
    trainer:          ['trainer','trainer_name','coach','assigned_trainer','select_trainer'],
    notes:            ['notes','note','remarks','comment','primary_fitness_goal','fitness_goal','goal','interested_in'],
    weight:           ['weight','weight_kg'],
    emergency_contact:['emergency_contact','emergency_phone','emergency_number'],
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
      const parts = s.split(/[/.-]/);
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

    const startDate      = fmt_date(get(row, 'joining_date'));
    const rawFinal       = parseFloat(get(row, 'final_amount')) || 0;
    const rawBase        = parseFloat(get(row, 'base_amount')) || 0;
    const paidAmt        = parseFloat(get(row, 'amount_paid')) || 0;
    const finalAmt       = rawFinal || paidAmt; // fall back to paid if no final column
    const baseAmt        = rawBase || finalAmt; // fall back to final if no base column
    const balanceAmt     = Math.max(finalAmt - paidAmt, 0);
    const durationMonths = parseInt(get(row, 'duration_months')) || null;

    // Compute end date: explicit column wins, else start + duration
    let ptEndDate = fmt_date(get(row, 'pt_end_date')) || null;
    if (!ptEndDate && startDate && durationMonths) {
      const d = new Date(startDate);
      d.setMonth(d.getMonth() + durationMonths);
      ptEndDate = d.toISOString().slice(0, 10);
    }

    // Status: expired if end date is in the past, otherwise active
    const status = ptEndDate && new Date(ptEndDate) < new Date() ? 'expired' : 'active';

    const c = {
      name,
      mobile:            mobile || null,
      email:             get(row, 'email') || null,
      dob:               fmt_date(get(row, 'dob')) || null,
      gender:            get(row, 'gender') || null,
      address:           get(row, 'address') || null,
      joining_date:      startDate || new Date().toISOString().slice(0, 10),
      pt_start_date:     startDate || null,
      pt_end_date:       ptEndDate,
      duration_months:   durationMonths,
      package_type:      get(row, 'plan') || null,
      base_amount:       baseAmt,
      final_amount:      finalAmt,
      paid_amount:       paidAmt,
      balance_amount:    balanceAmt,
      trainer_name:      get(row, 'trainer') || null,
      weight:            parseFloat(get(row, 'weight')) || null,
      emergency_contact: get(row, 'emergency_contact') || null,
      notes:             get(row, 'notes') || null,
      status,
    };

    try {
      const existingId = mobile ? existingMap.get(mobile) : null;
      if (existingId) {
        // Update existing — don't overwrite non-null fields with null
        await pool.query(`
          UPDATE pt_clients SET
            name              = $1,
            email             = COALESCE($2, email),
            dob               = COALESCE($3, dob),
            gender            = COALESCE($4, gender),
            address           = COALESCE($5, address),
            joining_date      = COALESCE($6, joining_date),
            pt_start_date     = COALESCE($7, pt_start_date),
            pt_end_date       = COALESCE($8, pt_end_date),
            duration_months   = COALESCE($9, duration_months),
            package_type      = COALESCE($10, package_type),
            base_amount       = CASE WHEN $11 > 0 THEN $11 ELSE base_amount END,
            final_amount      = CASE WHEN $12 > 0 THEN $12 ELSE final_amount END,
            paid_amount       = CASE WHEN $13 > 0 THEN $13 ELSE paid_amount END,
            balance_amount    = CASE WHEN $12 > 0 THEN $14 ELSE balance_amount END,
            trainer_name      = COALESCE($15, trainer_name),
            weight            = COALESCE($16, weight),
            emergency_contact = COALESCE($17, emergency_contact),
            notes             = COALESCE($18, notes),
            status            = $19,
            updated_at        = NOW()
          WHERE id = $20
        `, [
          c.name, c.email, c.dob, c.gender, c.address,
          c.joining_date, c.pt_start_date, c.pt_end_date, c.duration_months,
          c.package_type, c.base_amount, c.final_amount, c.paid_amount, c.balance_amount,
          c.trainer_name, c.weight, c.emergency_contact, c.notes,
          c.status, existingId,
        ]);
      } else {
        await pool.query(`
          INSERT INTO pt_clients
            (name, mobile, email, dob, gender, address,
             joining_date, pt_start_date, pt_end_date, duration_months,
             package_type, base_amount, final_amount, paid_amount, balance_amount,
             trainer_name, weight, emergency_contact, notes, status)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
        `, [
          c.name, c.mobile, c.email, c.dob, c.gender, c.address,
          c.joining_date, c.pt_start_date, c.pt_end_date, c.duration_months,
          c.package_type, c.base_amount, c.final_amount, c.paid_amount, c.balance_amount,
          c.trainer_name, c.weight, c.emergency_contact, c.notes, c.status,
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

/* ──────────────────────────────────────────────
   POST /import/smart-import
   Body: JSON { clients: [ { name, mobile, gender, trainer_name, joining_date,
                              subscriptions: [ { plan_name, start_date, end_date,
                                duration_months, selling_price, amount_paid,
                                balance_amount, trainer_name, status } ] } ] }
   Smart dedup: one pt_clients row per unique phone, all subs → pt_client_subscriptions.
   Returns: { clients_created, clients_updated, subscriptions_created, review, errors }
────────────────────────────────────────────── */
router.post('/smart-import', auth, adminOnly, async (req, res) => {
  try { return await _handleSmartImport(req, res); }
  catch (err) { return res.status(500).json({ error: err?.message || 'Smart import failed' }); }
});

async function _handleSmartImport(req, res) {
  const { clients } = req.body || {};
  if (!Array.isArray(clients) || !clients.length)
    return res.status(400).json({ error: 'No client data provided.' });

  const { randomUUID } = require('crypto');
  let clients_created = 0, clients_updated = 0, subscriptions_created = 0;
  const errors = [];
  const review = [];

  for (const c of clients) {
    try {
      const mobile = c.mobile ? String(c.mobile).replace(/\D/g, '').slice(-10) : null;
      const name   = (c.name || '').trim();
      if (!name) { errors.push({ name: '(blank)', issue: 'Missing name' }); continue; }

      // Determine earliest start date for joining_date
      const allDates = (c.subscriptions || []).map(s => s.start_date).filter(Boolean).sort();
      const joiningDate = c.joining_date || allDates[0] || new Date().toISOString().slice(0, 10);

      // Latest subscription drives current profile fields
      const subs = (c.subscriptions || []).slice().sort((a, b) =>
        (b.start_date || '').localeCompare(a.start_date || ''));
      const latest = subs[0] || {};

      // Compute status from latest sub's end_date
      const status = latest.end_date && new Date(latest.end_date) < new Date()
        ? 'expired' : 'active';

      let clientId;

      // Try match by mobile first, then by name
      let existing = null;
      if (mobile) {
        const { rows } = await pool.query(
          'SELECT id FROM pt_clients WHERE mobile = $1 AND deleted_at IS NULL LIMIT 1',
          [mobile]
        );
        existing = rows[0] || null;
      }
      if (!existing) {
        const { rows } = await pool.query(
          `SELECT id FROM pt_clients WHERE UPPER(TRIM(name)) = $1 AND deleted_at IS NULL LIMIT 1`,
          [name.toUpperCase()]
        );
        existing = rows[0] || null;
      }

      if (existing) {
        clientId = existing.id;
        // Update master profile with latest info
        await pool.query(`
          UPDATE pt_clients SET
            name          = $1,
            mobile        = COALESCE($2, mobile),
            gender        = COALESCE($3, gender),
            trainer_name  = COALESCE($4, trainer_name),
            pt_start_date = COALESCE($5, pt_start_date),
            pt_end_date   = COALESCE($6, pt_end_date),
            duration_months = COALESCE($7, duration_months),
            package_type  = COALESCE($8, package_type),
            base_amount   = CASE WHEN $9 > 0 THEN $9 ELSE base_amount END,
            final_amount  = CASE WHEN $10 > 0 THEN $10 ELSE final_amount END,
            paid_amount   = CASE WHEN $11 > 0 THEN $11 ELSE paid_amount END,
            balance_amount= CASE WHEN $12 >= 0 THEN $12 ELSE balance_amount END,
            status        = $13,
            updated_at    = NOW()
          WHERE id = $14`,
          [name, mobile || null, c.gender || null, latest.trainer_name || null,
           latest.start_date || null, latest.end_date || null,
           latest.duration_months || null, latest.plan_name || null,
           parseFloat(latest.selling_price) || 0, parseFloat(latest.selling_price) || 0,
           parseFloat(latest.amount_paid) || 0, parseFloat(latest.balance_amount) || 0,
           status, clientId]
        );
        clients_updated++;
      } else {
        clientId = randomUUID();
        await pool.query(`
          INSERT INTO pt_clients
            (id, name, mobile, gender, trainer_name, joining_date,
             pt_start_date, pt_end_date, duration_months, package_type,
             base_amount, final_amount, paid_amount, balance_amount, status)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [clientId, name, mobile || null, c.gender || null,
           latest.trainer_name || null, joiningDate,
           latest.start_date || null, latest.end_date || null,
           latest.duration_months || null, latest.plan_name || null,
           parseFloat(latest.selling_price) || 0, parseFloat(latest.selling_price) || 0,
           parseFloat(latest.amount_paid) || 0, parseFloat(latest.balance_amount) || 0,
           status]
        );
        clients_created++;
      }

      if (c.needs_review) review.push({ name, mobile, reason: c.review_reason || 'Name conflict' });

      // Insert all subscriptions
      for (const s of (c.subscriptions || [])) {
        const sellingPrice = parseFloat(s.selling_price) || 0;
        const amtPaid      = parseFloat(s.amount_paid) || 0;
        const balance      = parseFloat(s.balance_amount) ?? Math.max(sellingPrice - amtPaid, 0);
        const subStatus    = s.end_date && new Date(s.end_date) < new Date() ? 'expired' : 'active';

        await pool.query(`
          INSERT INTO pt_client_subscriptions
            (id, client_id, plan_name, start_date, end_date, duration_months,
             selling_price, amount_paid, balance_amount, trainer_name, status, source)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'import')`,
          [randomUUID(), clientId,
           s.plan_name || null, s.start_date || null, s.end_date || null,
           s.duration_months || null, sellingPrice, amtPaid, balance,
           s.trainer_name || null, subStatus]
        );
        subscriptions_created++;
      }
    } catch (err) {
      errors.push({ name: c.name || '?', issue: err.message });
    }
  }

  res.json({
    clients_created,
    clients_updated,
    subscriptions_created,
    total_clients: clients.length,
    review,
    errors: errors.slice(0, 50),
  });
}

module.exports = router;
