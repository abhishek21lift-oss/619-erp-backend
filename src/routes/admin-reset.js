const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const { auth, adminOnly } = require('../middleware/auth');

/* ══════════════════════════════════════════════════════════════════════
   POST /admin/reset-all-data
   Body: { confirm: "DELETE_ALL_619_DATA" }
   Deletes ALL clients, payments, attendance, and related records.
   Resets sequences where applicable.
   IRREVERSIBLE — admin only.
══════════════════════════════════════════════════════════════════════ */
router.post('/reset-all-data', auth, adminOnly, async (req, res) => {
  if (req.body?.confirm !== 'DELETE_ALL_619_DATA') {
    return res.status(400).json({ error: 'Missing confirmation token. Send { confirm: "DELETE_ALL_619_DATA" } in request body.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Delete dependent tables first (FK order)
    await client.query('DELETE FROM attendance');
    await client.query('DELETE FROM payments');
    await client.query('DELETE FROM subscriptions');
    await client.query('DELETE FROM invoices');
    await client.query('DROP TABLE IF EXISTS outstanding_dues CASCADE');
    await client.query('DELETE FROM client_goals');
    await client.query('DELETE FROM transformations');
    await client.query('DELETE FROM face_embeddings');
    await client.query('DELETE FROM notifications');
    await client.query('DELETE FROM message_logs');
    await client.query('DELETE FROM clients');

    // Reset sequences if they exist
    const seqs = [
      'clients_id_seq',
      'payments_id_seq',
      'attendance_id_seq',
      'subscriptions_id_seq',
      'invoices_id_seq',
    ];
    for (const seq of seqs) {
      try {
        await client.query(`ALTER SEQUENCE ${seq} RESTART WITH 1`);
      } catch {} // ignore if sequence doesn't exist
    }

    await client.query('COMMIT');
    res.json({ success: true, message: 'All member data, payments, attendance, and related records have been cleared. Any legacy outstanding_dues table was removed safely. You can now start fresh.' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Reset error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

/* ══════════════════════════════════════════════════════════════════════
   POST /admin/reset-outstanding-dues
   Clears ONLY outstanding dues / payments — keeps members intact.
══════════════════════════════════════════════════════════════════════ */
router.post('/reset-outstanding-dues', auth, adminOnly, async (req, res) => {
  if (req.body?.confirm !== 'CLEAR_DUES_619') {
    return res.status(400).json({ error: 'Missing confirmation token. Send { confirm: "CLEAR_DUES_619" }' });
  }
  try {
    await pool.query('DROP TABLE IF EXISTS outstanding_dues CASCADE');
    await pool.query('DELETE FROM payments');
    res.json({ success: true, message: 'All payments cleared. If an outstanding_dues table existed, it was removed safely.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
