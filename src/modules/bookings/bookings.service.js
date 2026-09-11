// src/modules/bookings/bookings.service.js
// Class booking with capacity enforcement, waitlist, and cancellation policy.
// Uses transactions + row locking to prevent overbooking under concurrent load.

const pool = require('../../db/pool');
const { HttpError } = require('../../middleware/errorHandler');
const cal = require('../../lib/google-calendar');
const logger = require('../../lib/logger');

const CANCEL_GRACE_HOURS = 2;     // free cancel if > 2h before start

// attendance_logs.method carries a CHECK constraint; the legacy `attendance`
// table's check_in_method did not. The check-in route takes `method` straight
// from the request body without validating it, so a caller posting
// {"method":"turnstile"} used to write that string verbatim and would now get
// a 500 from a constraint violation instead. Clamping keeps the endpoint's
// contract: an unrecognised method degrades to 'manual' rather than failing
// the check-in, and the raw value the caller sent is still recorded verbatim
// on bookings.check_in_method by checkIn()'s own UPDATE, so nothing is lost.
const ATTENDANCE_METHODS = new Set(['face', 'manual', 'qr', 'biometric']);
const attendanceMethod = (m) => (ATTENDANCE_METHODS.has(m) ? m : 'manual');

/**
 * Push a booking to (or remove it from) the member's own Google Calendar.
 *
 * Two rules govern every call site below, and both matter:
 *
 * 1. ALWAYS AFTER COMMIT. Booking runs inside a transaction that holds a
 *    FOR UPDATE lock on the class_sessions row to prevent overbooking. A
 *    Google API round-trip inside that transaction would make every concurrent
 *    booker for that session queue behind an external network call — turning a
 *    lock held for microseconds into one held for hundreds of milliseconds,
 *    and coupling the studio's booking throughput to Google's latency.
 *
 * 2. NEVER FATAL. Calendar sync is a convenience; the booking is the product.
 *    google-calendar.js already swallows its own errors, and this adds a
 *    .catch() so a rejection can never surface as an unhandled promise and
 *    take the process down.
 *
 * The event goes to the MEMBER's calendar, not the acting user's — an admin
 * booking a class on someone's behalf should not have it appear in their own
 * diary. Members without a login simply have nothing to sync to.
 */
function syncBookingToCalendar(action, memberId, bookingId) {
  if (!memberId || !bookingId || !cal.isConfigured()) return;

  (async () => {
    const { rows } = await pool.query(
      `SELECT u.id, o.name AS organization_name
       FROM users u
       LEFT JOIN organizations o ON o.id = u.organization_id
       WHERE u.member_id = $1 AND u.deleted_at IS NULL
       LIMIT 1`,
      [memberId]
    );
    const userId = rows[0]?.id;
    if (!userId) return;

    if (action === 'create') await cal.createBookingEvent(userId, bookingId, rows[0].organization_name);
    else await cal.deleteBookingEvent(userId, bookingId);
  })().catch((err) => {
    logger.warn({ err: err.message, action, bookingId }, 'calendar sync failed (non-critical)');
  });
}

/**
 * Book a class session for a member.
 * Atomic: locks the session row, counts confirmed bookings, decides confirmed vs waitlist.
 */
async function book({ session_id, member_id }, ctx) {
  // A booking is a studio-owned record, so it must have a studio. A platform
  // super admin operating platform-wide has no organization_id and cannot pick
  // one implicitly — refusing here is clearer than inserting NULL and hitting
  // the NOT NULL constraint from migration 176 as an opaque 500.
  if (!ctx.organization_id) {
    throw new HttpError(400, 'NO_ORGANIZATION', 'Booking requires a studio context');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Lock the session row to serialize concurrent bookers.
    //
    // Scoped by organization: without it a member of studio A could book a
    // seat in studio B's class simply by knowing (or guessing) a session id,
    // consuming a credit against the wrong studio's capacity. 404 rather than
    // 403 so the response does not confirm the session exists elsewhere.
    const sessionRes = await client.query(
      `SELECT id, capacity, starts_at, status, template_id
       FROM class_sessions WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
      [session_id, ctx.organization_id]
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

    // 3. Check active membership.
    // Qualify every column with mm./p. — `id`, `classes_used`, `plan_id` exist
    // on both tables and Postgres throws "column reference is ambiguous" if
    // they're left unqualified.
    const mm = await client.query(
      `SELECT mm.id, mm.classes_used, mm.plan_id, p.included_classes
       FROM member_memberships mm
       JOIN plans p ON p.id = mm.plan_id
       WHERE mm.member_id = $1 AND mm.status = 'active'
         AND mm.organization_id = $2
         AND mm.start_date <= CURRENT_DATE AND mm.end_date >= CURRENT_DATE
       ORDER BY mm.end_date DESC LIMIT 1`,
      [member_id, ctx.organization_id]
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
      `INSERT INTO bookings (session_id, member_id, membership_id, status, position, organization_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [session_id, member_id, membership.id, status, position, ctx.organization_id]
    );
    const booking = bookingRes.rows[0];

    // 6. If confirmed and plan has limited classes, increment usage
    if (status === 'confirmed' && membership.included_classes !== null) {
      await client.query(
        `UPDATE member_memberships SET classes_used = classes_used + 1 WHERE id = $1`,
        [membership.id]
      );
    }

    // 7. Audit + notification (queued; not awaited here in real impl).
    // Previously targeted a differently-shaped legacy table and threw on
    // every call (unreached in practice — this module has no frontend
    // caller). Fixed to the table every other audited write in the app
    // uses, on the same client/transaction so a rollback also rolls this
    // back.
    await client.query(
      `INSERT INTO activity_log (user_id, user_name, action, entity_type, entity_id, new_data, organization_id)
       VALUES ($1,$2,'booking.create','booking',$3,$4,$5)`,
      [ctx.user_id, ctx.user_name || null, booking.id, JSON.stringify(booking), ctx.organization_id || null]
    );

    await client.query('COMMIT');

    // Only confirmed bookings get a calendar entry — a waitlist place is not
    // an appointment, and putting one in someone's diary would be a lie. It
    // gets its event later, if and when the waitlist promotes it in cancel().
    if (booking.status === 'confirmed') {
      syncBookingToCalendar('create', member_id, booking.id);
    }
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

    // Scoped by organization. The role check below only ever constrained
    // `member`, so before this an admin, manager or trainer of ANY studio
    // could cancel ANY booking on the platform by id — the booking's own
    // studio was never consulted. 404 rather than 403: a caller outside the
    // studio must not be able to tell the booking exists.
    const params = [bookingId];
    let orgClause = '';
    if (ctx.organization_id) {
      params.push(ctx.organization_id);
      orgClause = ` AND b.organization_id = $${params.length}`;
    }
    const r = await client.query(
      `SELECT b.*, cs.starts_at, cs.capacity, mm.plan_id, p.included_classes
       FROM bookings b
       JOIN class_sessions cs ON cs.id = b.session_id
       LEFT JOIN member_memberships mm ON mm.id = b.membership_id
       LEFT JOIN plans p ON p.id = mm.plan_id
       WHERE b.id = $1${orgClause} FOR UPDATE OF b`,
      params
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
    let promoted = null;
    if (b.status === 'confirmed') {
      const promote = await client.query(
        `SELECT id, member_id, membership_id, position FROM bookings
         WHERE session_id = $1 AND status='waitlist'
         ORDER BY position ASC LIMIT 1 FOR UPDATE`,
        [b.session_id]
      );
      if (promote.rows.length > 0) {
        promoted = promote.rows[0];
        const promotedPos = promote.rows[0].position;
        await client.query(
          `UPDATE bookings SET status='confirmed', position=NULL WHERE id = $1`,
          [promote.rows[0].id]
        );
        // Reshuffle waitlist positions (decrement all above the promoted slot)
        await client.query(
          `UPDATE bookings SET position = position - 1
           WHERE session_id = $1 AND status='waitlist' AND position > $2`,
          [b.session_id, promotedPos]
        );
      }
    }

    await client.query(
      `INSERT INTO activity_log (user_id, user_name, action, entity_type, entity_id, organization_id)
       VALUES ($1,$2,'booking.cancel','booking',$3,$4)`,
      [ctx.user_id, ctx.user_name || null, bookingId, ctx.organization_id || null]
    );
    await client.query('COMMIT');

    // Remove the cancelled member's event. Safe even if there was never one
    // (waitlist bookings never got one) — deleteBookingEvent no-ops when it
    // finds no stored google_event_id.
    syncBookingToCalendar('delete', b.member_id, bookingId);

    // Someone promoted off the waitlist now genuinely has a class to attend,
    // so they get the event the cancelled member just lost. Without this, a
    // promotion is invisible in their calendar and they miss the session.
    if (promoted) {
      syncBookingToCalendar('create', promoted.member_id, promoted.id);
    }

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
async function checkIn(bookingId, { method = 'manual' }, ctx = {}) {
  // The route gates this on requireRole('admin','manager','trainer') — but a
  // role is not an ownership check. Any admin or trainer of any studio could
  // mark any booking on the platform as attended, and the mirrored attendance
  // row landed in whatever studio the row belonged to. The organization filter
  // is what makes the role check mean "of THIS studio".
  const params = [bookingId, method];
  let orgClause = '';
  if (ctx.organization_id) {
    params.push(ctx.organization_id);
    orgClause = ` AND organization_id = $${params.length}`;
  }
  const r = await pool.query(
    `UPDATE bookings SET status='attended', checked_in_at = NOW(), check_in_method = $2
     WHERE id = $1 AND status = 'confirmed'${orgClause}
     RETURNING *`,
    params
  );
  if (r.rows.length === 0) throw new HttpError(400, 'BAD_STATE', 'Booking not confirmed or already attended');

  // Mirror into attendance_logs, the canonical register.
  //
  // This used to write a second table, `attendance`, and nothing in the
  // product ever read it. Every attendance surface — the register at
  // /api/attendance, the QR dashboard, the AI attendance_summary tool, the
  // automation missed-visit sweep, the client portal's own history and the
  // super-admin analytics — reads attendance_logs. So a check-in taken
  // through a class booking was recorded where no screen, report or
  // automation would ever look at it.
  //
  // organization_id still comes from the booking row that was just verified
  // rather than from ctx, so the mirror cannot land in a different studio
  // from the booking it mirrors even if the two disagree.
  //
  // Two deliberate differences from the legacy write:
  //
  //  · The conflict clause keeps the FIRST check-in of the day instead of
  //    overwriting it. That is the convention routes/attendance.js and
  //    routes/qr-checkin.js already follow on this table, and it is the
  //    correct one — a second check-in should not rewrite when someone
  //    actually arrived. Sharing a table means sharing its semantics.
  //  · booking_id has no column here, so the link is carried in `notes`.
  //    It is not restated on conflict: a row written by a QR scan or by the
  //    register keeps its own note rather than having it clobbered. If the
  //    class-booking flow is ever revived in earnest, booking_id deserves a
  //    real column rather than free text — today `bookings` holds 0 rows.
  //
  // ref_name is left NULL, as the legacy write also left it. Filling it would
  // mean a name subselect against the `members` table, which carries no
  // organization_id — there is nothing to scope such a read by. Writing the
  // register a name obtained from an untenanted lookup is a worse trade than
  // a blank one, and tenantColumns.convention.test.js refuses it outright:
  // it flagged exactly that subselect when this was first written, comment
  // included, since its scanner reads comments as SQL too.
  const b = r.rows[0];
  await pool.query(
    `INSERT INTO attendance_logs
       (ref_id, ref_type, date, check_in_time, method, status,
        notes, branch_id, organization_id)
     VALUES ($1, 'client', CURRENT_DATE, NOW(), $2, 'present', $3,
             COALESCE($4, 'br-main'), $5)
     ON CONFLICT (ref_id, ref_type, date) DO UPDATE
       SET check_in_time = COALESCE(attendance_logs.check_in_time, EXCLUDED.check_in_time),
           status        = 'present',
           method        = CASE WHEN attendance_logs.method = 'manual' THEN EXCLUDED.method
                                ELSE attendance_logs.method END`,
    [b.member_id, attendanceMethod(method), `Class booking ${b.id}`,
     process.env.BRANCH_ID || null, b.organization_id]
  );
  return b;
}

// `memberId` reaches this from ?member_id= for any non-member caller, so the
// organization filter is the only thing standing between a studio A admin and
// studio B's members' class history. Passing an unknown member id now returns
// an empty list rather than another studio's bookings.
async function listForMember(memberId, { from, to, status } = {}, scope = {}) {
  const params = [memberId];
  const where = [`b.member_id = $1`];
  if (scope.applyFilter) {
    params.push(scope.orgId);
    where.push(`b.organization_id = $${params.length}`);
  }
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
