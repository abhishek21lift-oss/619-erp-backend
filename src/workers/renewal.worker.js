// src/workers/renewal.worker.js
// Daily job: send expiry reminders + auto-renew memberships flagged auto_renew=true.
//
// Run via: node src/workers/renewal.worker.js
// In production: schedule via cron, BullMQ, or a Vercel cron route.

const pool = require('../db/pool');
const notifier = require('../modules/notifications/notifications.service');
const razorpay = require('../lib/razorpay');

const REMINDER_DAYS = [7, 3, 1];   // send reminder when this many days remain

async function runReminders() {
  for (const days of REMINDER_DAYS) {
    const { rows } = await pool.query(`
      SELECT m.id AS member_id, m.user_id, m.name, m.email, m.phone,
             pl.name AS plan_name, mm.end_date,
             (mm.end_date - CURRENT_DATE) AS days_remaining
      FROM member_memberships mm
      JOIN members m ON m.id = mm.member_id
      JOIN plans pl ON pl.id = mm.plan_id
      WHERE mm.status = 'active'
        AND (mm.end_date - CURRENT_DATE) = $1
        AND m.deleted_at IS NULL
    `, [days]);

    for (const m of rows) {
      await notifier.send('membership_expiring', m, { days, plan: m.plan_name },
        ['inapp', 'email', 'whatsapp']);
    }
    console.log(`[reminders] sent ${rows.length} reminders for ${days}-day expiry`);
  }
}

async function runAutoRenew() {
  if (!razorpay.isConfigured()) {
    console.log('[auto-renew] Razorpay not configured — skipping auto-renew. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to enable.');
    return;
  }

  // Find memberships expiring TODAY with auto_renew=true and gateway available
  const { rows } = await pool.query(`
    SELECT mm.*, m.name, m.email, m.phone, m.user_id, pl.name AS plan_name, pl.duration, pl.price
    FROM member_memberships mm
    JOIN members m ON m.id = mm.member_id
    JOIN plans pl ON pl.id = mm.plan_id
    WHERE mm.auto_renew = TRUE
      AND mm.status = 'active'
      AND mm.end_date = CURRENT_DATE
  `);

  for (const m of rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Charge via Razorpay
      const order = await razorpay.createOrder(m.price * 100, 'INR', `renew_${m.id}_${Date.now()}`);
      const payment = order.status === 'created'
        ? await razorpay.capturePayment(order.id, m.price * 100)
        : null;
      const charge = payment || { id: order.id, status: order.status, amount: m.price };

      // 2. Create new membership
      const newEnd = new Date();
      newEnd.setDate(newEnd.getDate() + m.duration);

      await client.query(
        `INSERT INTO member_memberships
           (member_id, plan_id, trainer_id, start_date, end_date,
            base_amount, final_amount, paid_amount, auto_renew, renewed_from_id, status)
         VALUES ($1,$2,$3, CURRENT_DATE, $4, $5, $5, $5, TRUE, $6, 'active')`,
        [m.member_id, m.plan_id, m.trainer_id, newEnd, m.price, m.id]
      );

      // 3. Mark old as expired
      await client.query(`UPDATE member_memberships SET status='expired' WHERE id = $1`, [m.id]);

      // 4. Record payment
      await client.query(
        `INSERT INTO payments (member_id, amount, method, date, gateway, gateway_txn_id, gateway_status, branch_id)
         VALUES ($1,$2,'RAZORPAY', CURRENT_DATE, 'razorpay', $3, $4, COALESCE($5, 'br-main'))`,
        [m.member_id, m.price, charge.id, charge.status, process.env.BRANCH_ID || null]
      );

      await client.query('COMMIT');

      // 5. Notify member
      await notifier.send('payment_received', m,
        { amount: m.price, plan: m.plan_name }, ['inapp', 'email', 'whatsapp']);

      console.log(`[auto-renew] ✓ ${m.name} renewed`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[auto-renew] ✗ ${m.name}:`, err.message);
      try {
        await notifier.send('payment_failed', m,
          { amount: m.price, error: err.message }, ['inapp', 'email']);
      } catch (_) { /* best-effort */ }
    } finally {
      client.release();
    }
  }
  console.log(`[auto-renew] processed ${rows.length} renewals`);
}

async function runClassReminders() {
  // 30 minutes before each class, ping confirmed members
  const { rows } = await pool.query(`
    SELECT b.id AS booking_id, m.user_id, m.name, m.phone, m.email,
           ct.name AS class_name, TO_CHAR(cs.starts_at, 'HH24:MI') AS time,
           cs.id AS session_id
    FROM bookings b
    JOIN class_sessions cs ON cs.id = b.session_id
    JOIN class_templates ct ON ct.id = cs.template_id
    JOIN members m ON m.id = b.member_id
    WHERE b.status = 'confirmed'
      AND cs.starts_at BETWEEN NOW() + INTERVAL '25 minutes' AND NOW() + INTERVAL '35 minutes'
  `);
  for (const r of rows) {
    await notifier.send('class_reminder', r,
      { class_name: r.class_name, time: r.time }, ['inapp', 'whatsapp', 'push']);
  }
}

async function main() {
  console.log('--- 619 worker run', new Date().toISOString());
  try {
    await runReminders();
    await runAutoRenew();
    await runClassReminders();
  } catch (err) {
    console.error('worker error:', err);
    process.exitCode = 1;
  }
  process.exit(0);
}

if (require.main === module) main();

module.exports = { runReminders, runAutoRenew, runClassReminders };
