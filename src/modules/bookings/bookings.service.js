// src/modules/bookings/bookings.service.js
// Class booking with capacity enforcement, waitlist, and cancellation policy.
// Uses transactions + row locking to prevent overbooking under concurrent load.

const pool = require('../../db/pool');
const { HttpError } = require('../../middleware/errorHandler');

const CANCEL_GRACE_HOURS = 2;     // free cancel if > 2h before start
const NO_SHOW_PENALTY = 1;        // class-pack credits forfeited

/**
 * Book a class session for a member.
 * Atomic: locks the session row, counts confirmed bookings, decides confirmed vs waitlist.
 */
async function book({ session_id, member_id }, ctx) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Lock the session row to serialize concurrent bookers
    const sessionRes = await client.query(
      `SELECT id, capacity, starts_at, status, template_id
       FROM class_sessions WHERE id = $1 FOR UPDATE`,
      [session_id]
    );
    if (sessionRes.rows.length === 0) throw new HttpError(404, 'NOT_FOUND', 'Class session not found');
    const session = sessionRes.rows[0];
    if (session.status !== 'scheduled') throw new HttpError(400, 'BAD_STATE', 'Session is not scheduled');
    if (new Date(session.starts_at) < new Date()) throw new HttpError(400, 'BAD_STATE', 'Session already started');

    // 2. Verify no existing booking
    const existing = await client.query(
      `SELECT id, status FROM bookings WHERE session_id = $1 AND member_id = $2`,
      [session_id, member_id]
    );
    if (existing.rows.length > 0 && ['confirmed','waitlist'].includes(existing.rows[0].status)) {
      throw new HttpError(409, 'ALREADY_BOOKED', 'You already have a booking for this session');
    }

    // 3. Check active membership
    const mm = await client.query(
      `SELECT id, classes_used, plan_id, p.included_classes
       FROM member_memberships mm
       JOIN plans p ON p.id = mm.plan_id
       WHERE mm.member_id = $1 AND mm.status = 'active'
         AND mm.start_date <= CURRENT_DATE AND mm.end_date >= CURRENT_DATE
       ORDER BY mm.end_date DESC LIMIT 1`,
      [member_id]
    );
    if (mm.rows.length === 0) throw new HttpError(402, 'NO_MEMBERSHIP', 'Active membership required');
    const membership = mm.rows[0];

    if (membership.included_classes !== null && membership.classes_used >= membership.included_classes) {
      throw new HttpError(402, 'CLASSES_EXHAUSTED', 'No class credits left on your plan');
    }

    // 4. Count confirmed bookings (with the lock from step 1, this is safe)
    const countRes = await client.query(
      `SELECT COUNT(*) AS n FROM bookings WHERE session_id = $1 AND status = 'confirmed'`,
      [session_id]
    );
    const confirmed = parseInt(countRes.rows[0].n);

    let status, position = null;
    if (confirmed < session.capacity) {
      status = 'confirmed';
    } else {
      status = 'waitlist';
      const wlRes = await client.query(
        `SELECT COALESCE(MAX(position),0) + 1 AS pos FROM bookings WHERE session_id = $1 AND status = 'waitlist'`,
        [session_id]
      );
      position = parseInt(wlRes.rows[0].pos);
    }

    // 5. Insert booking
    const bookingRes = await client.query(
      `INSERT INTO bookings (session_id, member_id, membership_id, status, position)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [session_id, member_id, membership.id, status, position]
    );
    const booking = bookingRes.rows[0];

    // 6. If confirmed and plan has limited classes, increment usage
    if (status === 'confirmed' && membership.included_classes !== null) {
      await client.query(
        `UPDATE member_memberships SET classes_used = classes_used + 1 WHERE id = $1`,
        [membership.id]
      );
    }

    // 7. Audit + notification (queued; not awaited here in real impl)
    await client.query(
      `INSERT INTO audit_log (user_id, action, entity, entity_id, after) VALUES ($1,'booking.create','booking',$2,$3)`,
      [ctx.user_id, booking.id, booking]
    );

    await client.query('COMMIT');
    return booking;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Cancel a booking. Enforces grace-period policy and promotes from waitlist.
 */
async function cancel(bookingId, { reason } = {}, ctx) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const r = await client.query(
      `SELECT b.*, cs.starts_at, cs.capacity, mm.plan_id, p.included_classes
       FROM bookings b
       JOIN class_sessions cs ON cs.id = b.session_id
       LEFT JOIN member_memberships mm ON mm.id = b.membership_id
       LEFT JOIN plans p ON p.id = mm.plan_id
       WHERE b.id = $1 FOR UPDATE OF b`,
      [bookingId]
    );
    if (r.rows.length === 0) throw new HttpError(404, 'NOT_FOUND', 'Booking not found');
    const b = r.rows[0];

    // Authorization
    if (ctx.role === 'member' && b.member_id !== ctx.member_id) {
      throw new HttpError(403, 'FORBIDDEN', 'Not your booking');
    }
    if (b.status === 'cancelled') throw new HttpError(400, 'ALREADY_CANCELLED', 'Already cancelled');

    const hoursUntil = (new Date(b.starts_at) - new Date()) / 36e5;
    const inGrace = hoursUntil >= CANCEL_GRACE_HOURS;

    await client.query(
      `UPDATE bookings SET status='cancelled', cancelled_at=NOW(), cancellation_reason=$2 WHERE id = $1`,
      [bookingId, reason || null]
    );

    // Refund credit if cancelled in grace period and was confirmed and uses credits
    if (b.status === 'confirmed' && inGrace && b.included_classes !== null) {
      await client.query(
        `UPDATE member_memberships SET classes_used = GREATEST(classes_used - 1, 0) WHERE id = $1`,
        [b.membership_id]
      );
    }

    // Promote first waitlist booking if a confirmed slot freed up
    if (b.status === 'confirmed') {
      const promote = await client.query(
        `SELECT id, member_id, membership_id FROM bookings
         WHERE session_id = $1 AND status='waitlist'
         ORDER BY position ASC LIMIT 1 FOR UPDATE`,
        [b.session_id]
      );
      if (promote.rows.length > 0) {
        await client.query(
          `UPDATE bookings SET status='confirmed', position=NULL WHERE id = $1`,
          [promote.rows[0].id]
        );
        // Reshuffle waitlist positions
        await client.query(
          `UPDATE bookings SET position = position - 1
           WHERE session_id = $1 AND status='waitlist' AND position > 1`,
          [b.session_id]
        );
      }
    }

    await client.query(
      `INSERT INTO audit_log (user_id, action, entity, entity_id) VALUES ($1,'booking.cancel','booking',$2)`,
      [ctx.user_id, bookingId]
    );
    await client.query('COMMIT');
    return { id: bookingId, status: 'cancelled', refunded: inGrace };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Check in (member arrives at the gym).
 */
async function checkIn(bookingId, { method = 'manual' }, ctx) {
  const r = await pool.query(
    `UPDATE bookings SET status='attended', checked_in_at = NOW(), check_in_method = $2
     WHERE id = $1 AND status = 'confirmed'
     RETURNING *`,
    [bookingId, method]
  );
  if (r.rows.length === 0) throw new HttpError(400, 'BAD_STATE', 'Booking not confirmed or already attended');

  // Mirror to attendance table
  const b = r.rows[0];
  await pool.query(
    `INSERT INTO attendance (type, ref_id, member_id, booking_id, branch_id, date, check_in, status, check_in_method)
     VALUES ('client', $1, $1, $2, 'br-main', CURRENT_DATE, NOW()::time, 'present', $3)
     ON CONFLICT (type, ref_id, date) DO UPDATE SET check_in = EXCLUDED.check_in, status = 'present'`,
    [b.member_id, b.id, method]
  );
  return b;
}

async function listForMember(memberId, { from, to, status } = {}) {
  const params = [memberId];
  const where = [`b.member_id = $1`];
  if (from)   { params.push(from);   where.push(`cs.starts_at >= $${params.length}`); }
  if (to)     { params.push(to);     where.push(`cs.starts_at <= $${params.length}`); }
  if (status) { params.push(status); where.push(`b.status = $${params.length}`); }

  const { rows } = await pool.query(
    `SELECT b.id, b.status, b.position, b.booked_at, b.checked_in_at,
            cs.id AS session_id, cs.starts_at, cs.ends_at,
            ct.name AS class_name, ct.color, t.name AS trainer_name
     FROM bookings b
     JOIN class_sessions cs ON cs.id = b.session_id
     JOIN class_templates ct ON ct.id = cs.template_id
     LEFT JOIN trainers t ON t.id = cs.trainer_id
     WHERE ${where.join(' AND ')}
     ORDER BY cs.starts_at DESC LIMIT 200`,
    params
  );
  return rows;
}

module.exports = { book, cancel, checkIn, listForMember };
