// src/modules/bookings/bookings.service.js
// Class booking with capacity enforcement, waitlist, and cancellation policy.
// Uses transactions + row locking to prevent overbooking under concurrent load.
//
// ── This module was written against a schema that was never migrated ────────
//
// Every statement here referenced something that does not exist: class_sessions
// columns `starts_at` / `ends_at` / `trainer_id` (the real ones are `date`,
// `start_time`, `end_time`, `instructor_id`), bookings columns `membership_id`
// and `position`, and the statuses `waitlist` and `attended`. Migration 182
// adds the four columns that were genuinely missing and widens the status
// CHECK; everything else is fixed here, by naming the columns the schema has.
//
// SESSION_START / SESSION_END below are that fix in one place. `date` is a DATE
// and `start_time` a TIME, so the sum is a timestamp WITHOUT a zone; it is
// resolved against the connection's TimeZone — which db/pool.js sets to the
// studio's on every connect — so a 09:00 class is 09:00 where the studio is,
// not 09:00 UTC. Aliased back to starts_at/ends_at because that is the shape
// the member Classes screen reads.
//
// ── Entitlement ─────────────────────────────────────────────────────────────
//
// The membership gate is an ACTIVE-CLIENT check, not a credit ledger. The old
// one read `member_memberships` joined to `plans.included_classes` — the
// abandoned v3 model, which no code path writes and which holds no rows. There
// is no class-credit model in the live schema to replace it with:
// pt_client_subscriptions carries money and dates, not class counts.
//
// Inventing one would be inventing a pricing product. So the rule is the
// narrowest defensible one — a studio's own active client may book its classes
// — and selling class packs with a credit balance remains an open product
// decision rather than something guessed at here.

const pool = require('../../db/pool');
const { HttpError } = require('../../middleware/errorHandler');
const cal = require('../../lib/google-calendar');
const logger = require('../../lib/logger');

const CANCEL_GRACE_HOURS = 2;     // free cancel if > 2h before start

// A class session's start and end, from the columns the table actually has.
const SESSION_START = "(cs.date + cs.start_time) AT TIME ZONE current_setting('TimeZone')";
const SESSION_END   = "(cs.date + cs.end_time)   AT TIME ZONE current_setting('TimeZone')";

// attendance_logs.method is CHECK-constrained, and the route takes its value
// straight from the request body — so an unrecognised string would abort the
// mirror write with a constraint violation AFTER the booking was already marked
// checked in, leaving the two records disagreeing. Anything unknown records as
// 'manual', which is what a person clicking the button in the studio is.
const ATTENDANCE_METHODS = ['face', 'manual', 'qr', 'biometric'];
const attendanceMethod = (m) => (ATTENDANCE_METHODS.includes(m) ? m : 'manual');

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
 * The event goes to the CLIENT's calendar, not the acting user's — an admin
 * booking a class on someone's behalf should not have it appear in their own
 * diary. Members without a login simply have nothing to sync to.
 */
function syncBookingToCalendar(action, clientId, bookingId) {
  if (!clientId || !bookingId || !cal.isConfigured()) return;

  (async () => {
    const { rows } = await pool.query(
      // pt_client_id, not member_id: the latter is always NULL for a real
      // client account (see middleware/rbac.js and migration 154), so this
      // lookup could never have found anybody to sync a calendar for.
      `SELECT u.id, o.name AS organization_name
       FROM users u
       LEFT JOIN organizations o ON o.id = u.organization_id
       WHERE u.pt_client_id = $1 AND u.deleted_at IS NULL
       LIMIT 1`,
      [clientId]
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
async function book({ session_id, client_id }, ctx) {
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
      `SELECT cs.id, cs.capacity, cs.status, cs.template_id,
              ${SESSION_START} AS starts_at
       FROM class_sessions cs
       WHERE cs.id = $1 AND cs.organization_id = $2 FOR UPDATE`,
      [session_id, ctx.organization_id]
    );
    if (sessionRes.rows.length === 0) throw new HttpError(404, 'NOT_FOUND', 'Class session not found');
    const session = sessionRes.rows[0];
    if (session.status !== 'scheduled') throw new HttpError(400, 'BAD_STATE', 'Session is not scheduled');
    if (new Date(session.starts_at) < new Date()) throw new HttpError(400, 'BAD_STATE', 'Session already started');

    // 2. Verify no existing booking
    const existing = await client.query(
      `SELECT id, status FROM bookings WHERE session_id = $1 AND client_id = $2`,
      [session_id, client_id]
    );
    if (existing.rows.length > 0 && ['confirmed','waitlist'].includes(existing.rows[0].status)) {
      throw new HttpError(409, 'ALREADY_BOOKED', 'You already have a booking for this session');
    }

    // 3. Entitlement: an ACTIVE client of THIS studio.
    //
    // This replaces a credit check against member_memberships + plans, which is
    // the abandoned v3 model — no code path writes it and it holds no rows, so
    // the check refused everybody. See the note at the top of this file for why
    // a credit ledger is not reinvented here.
    //
    // The organization predicate is doing real work, not just repeating step 1:
    // it is what stops a client of studio A booking into studio B by presenting
    // their own id against a session id they guessed.
    const cli = await client.query(
      `SELECT id, name, status FROM pt_clients
        WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
      [client_id, ctx.organization_id]
    );
    if (cli.rows.length === 0) throw new HttpError(404, 'NOT_FOUND', 'Client not found');
    if (cli.rows[0].status !== 'active') {
      throw new HttpError(402, 'CLIENT_INACTIVE', 'This membership is not active');
    }
    const bookingClient = cli.rows[0];

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
      `INSERT INTO bookings (session_id, client_id, client_name, status, position, organization_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [session_id, client_id, bookingClient.name, status, position, ctx.organization_id]
    );
    const booking = bookingRes.rows[0];

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
      syncBookingToCalendar('create', client_id, booking.id);
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
      `SELECT b.*, cs.capacity, ${SESSION_START} AS starts_at
       FROM bookings b
       JOIN class_sessions cs ON cs.id = b.session_id
       WHERE b.id = $1${orgClause} FOR UPDATE OF b`,
      params
    );
    if (r.rows.length === 0) throw new HttpError(404, 'NOT_FOUND', 'Booking not found');
    const b = r.rows[0];

    // Authorization
    if (ctx.role === 'member' && b.client_id !== ctx.client_id) {
      throw new HttpError(403, 'FORBIDDEN', 'Not your booking');
    }
    if (b.status === 'cancelled') throw new HttpError(400, 'ALREADY_CANCELLED', 'Already cancelled');

    const hoursUntil = (new Date(b.starts_at) - new Date()) / 36e5;
    const inGrace = hoursUntil >= CANCEL_GRACE_HOURS;

    await client.query(
      `UPDATE bookings SET status='cancelled', cancelled_at=NOW(), cancellation_reason=$2 WHERE id = $1`,
      [bookingId, reason || null]
    );

    // No credit to refund: there is no credit ledger (see the note at the top).
    // `inGrace` is still computed and still returned, because the grace period
    // is what a studio's cancellation policy is written against — it is now
    // reported rather than acted on, and is the hook a future credit model
    // would attach to.

    // Promote first waitlist booking if a confirmed slot freed up
    let promoted = null;
    if (b.status === 'confirmed') {
      const promote = await client.query(
        `SELECT id, client_id, position FROM bookings
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
    syncBookingToCalendar('delete', b.client_id, bookingId);

    // Someone promoted off the waitlist now genuinely has a class to attend,
    // so they get the event the cancelled member just lost. Without this, a
    // promotion is invisible in their calendar and they miss the session.
    if (promoted) {
      syncBookingToCalendar('create', promoted.client_id, promoted.id);
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
  // 'checked_in', not 'attended'. The status CHECK has always had `checked_in`
  // and never had `attended`, so this UPDATE violated the constraint on every
  // call. Two spellings of one state is how a status column stops being
  // trustworthy, so the existing one wins.
  const r = await pool.query(
    `UPDATE bookings SET status='checked_in', checked_in_at = NOW(), check_in_method = $2
     WHERE id = $1 AND status = 'confirmed'${orgClause}
     RETURNING *`,
    params
  );
  if (r.rows.length === 0) throw new HttpError(400, 'BAD_STATE', 'Booking not confirmed or already checked in');

  // Mirror into attendance_logs — the table the studio's attendance screens,
  // client reports, AI tools and platform analytics all read.
  //
  // This used to write `attendance`, which has exactly one writer (this line)
  // and no readers anywhere in the codebase, so a class check-in was recorded
  // where nobody would ever see it. Same shape as routes/qr-checkin.js, so a
  // class arrival and a QR arrival are one row per client per day rather than
  // two competing records.
  //
  // organization_id comes from the booking row that was just verified, not from
  // ctx — so the mirror cannot land in a different studio from the booking it
  // mirrors even if the two disagree.
  const b = r.rows[0];
  await pool.query(
    `INSERT INTO attendance_logs
       (ref_id, ref_type, ref_name, date, check_in_time, method, status, notes, organization_id)
     VALUES ($1, 'client', $2, CURRENT_DATE, NOW(), $3, 'present', $4, $5)
     ON CONFLICT (ref_id, ref_type, date) DO UPDATE
       SET check_in_time = COALESCE(attendance_logs.check_in_time, EXCLUDED.check_in_time),
           status        = 'present'`,
    [b.client_id, b.client_name || null, attendanceMethod(method), `Class booking ${b.id}`, b.organization_id]
  );
  return b;
}

// `clientId` reaches this from ?client_id= for any non-member caller, so the
// organization filter is the only thing standing between a studio A admin and
// studio B's clients' class history. Passing an unknown client id returns an
// empty list rather than another studio's bookings.
async function listForClient(clientId, { from, to, status } = {}, scope = {}) {
  const params = [clientId];
  const where = [`b.client_id = $1`];
  if (scope.applyFilter) {
    params.push(scope.orgId);
    where.push(`b.organization_id = $${params.length}`);
  }
  if (from)   { params.push(from);   where.push(`${SESSION_START} >= $${params.length}`); }
  if (to)     { params.push(to);     where.push(`${SESSION_START} <= $${params.length}`); }
  if (status) { params.push(status); where.push(`b.status = $${params.length}`); }

  // class_templates is LEFT JOINed, not INNER. cs.template_id is nullable, and
  // an inner join silently drops every ad-hoc session that was not built from a
  // template — which would read as "you have no bookings" rather than as a
  // missing class name.
  const { rows } = await pool.query(
    `SELECT b.id, b.status, b.position, b.booked_at, b.checked_in_at,
            cs.id AS session_id,
            ${SESSION_START} AS starts_at,
            ${SESSION_END}   AS ends_at,
            COALESCE(ct.name, cs.title) AS class_name, ct.color,
            COALESCE(t.name, cs.instructor_name) AS trainer_name
     FROM bookings b
     JOIN class_sessions cs ON cs.id = b.session_id
     LEFT JOIN class_templates ct ON ct.id = cs.template_id
     LEFT JOIN trainers t ON t.id = cs.instructor_id
     WHERE ${where.join(' AND ')}
     ORDER BY ${SESSION_START} DESC LIMIT 200`,
    params
  );
  return rows;
}

module.exports = { book, cancel, checkIn, listForClient };
