// GET /workout-log/today — the trainer's roster for one day.
//
// Two things here are worth a test and the rest is plumbing.
//
// The first is the LATERAL join. Nothing in the schema stops a client having
// two workout_sessions on one date, and the live database already has one who
// does. A plain LEFT JOIN fans that client into two rows, so the trainer sees
// them twice on the only screen they open every day. That was caught by
// running the query against real data, not by reading it.
//
// The second is scoping. This endpoint returns clients, so a trainer who is
// not an admin must see only their own, and a tenant must never see another
// tenant's — the same rule every other read in this module follows.

const request = require('supertest');

jest.mock('../db/pool', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = global.__mockUser; next(); },
  adminOrManager: (_req, _res, next) => next(),
  adminManagerOrTrainer: (_req, _res, next) => next(),
}));
jest.mock('../middleware/rbac', () => ({ requireRole: () => (_req, _res, next) => next() }));
jest.mock('../lib/activityLog', () => ({ logActivity: jest.fn() }));

const pool = require('../db/pool');

function app() {
  const express = require('express');
  const a = express();
  a.use(express.json());
  a.use('/api/pt-os', require('../modules/pt-os/workout-log.routes'));
  return a;
}

/** The ISODOW lookup the route runs before its main query. */
const DOW_ROW = { rows: [{ dow: 4 }] };

beforeEach(() => {
  jest.clearAllMocks();
  global.__mockUser = { id: 'u-1', role: 'admin', organization_id: 'org-1' };
});

describe('GET /workout-log/today', () => {
  it('asks for one session per client, not a plain join', async () => {
    pool.query
      .mockResolvedValueOnce(DOW_ROW)
      .mockResolvedValueOnce({ rows: [] });

    await request(app()).get('/api/pt-os/workout-log/today').expect(200);

    const sql = pool.query.mock.calls[1][0];
    // A LATERAL subquery with LIMIT 1 is what collapses a client's multiple
    // sessions to one row. Asserting the shape rather than the row count
    // because the fan-out only appears with data that has the duplicate.
    expect(sql).toMatch(/LEFT JOIN LATERAL/i);
    expect(sql).toMatch(/LIMIT 1/i);
    // An in-progress session must win, or Resume points at a stale one.
    expect(sql).toMatch(/status = 'in_progress'\s*\)\s*DESC/i);
  });

  it('reports a day with no prescribed exercises as a rest day', async () => {
    pool.query
      .mockResolvedValueOnce(DOW_ROW)
      .mockResolvedValueOnce({
        rows: [
          { source_rank: 2, start_time: null,
            assignment_id: 'a1', client_id: 'c1', client_name: 'Rest Client', client_photo: null,
            plan_id: 'p1', plan_name: 'Upper / Lower', progress_pct: 0,
            session_id: null, session_status: null, planned_exercises: '0' },
          { source_rank: 2, start_time: null,
            assignment_id: 'a2', client_id: 'c2', client_name: 'Training Client', client_photo: null,
            plan_id: 'p1', plan_name: 'Full Body', progress_pct: 20,
            session_id: null, session_status: null, planned_exercises: '3' },
        ],
      });

    const res = await request(app()).get('/api/pt-os/workout-log/today').expect(200);

    const [rest, training] = res.body.data.clients;
    expect(rest.is_rest_day).toBe(true);
    expect(training.is_rest_day).toBe(false);
    // Counts arrive from pg as strings; the client renders them arithmetically.
    expect(training.planned_exercises).toBe(3);
    expect(res.body.data.day_of_week).toBe('Thursday');
  });

  // ── The assigned programme that did not appear ──────────────────────────
  //
  // The bug: design a plan, assign it, and the client still showed as a rest
  // day on the dashboard's Today panel and on /pt-os/today.
  //
  // Cause: this route resolves ONE assignment per client through a LATERAL
  // with LIMIT 1, and it ordered them by start_date alone. A client here
  // commonly holds several active assignments — an upper/lower split is two,
  // and nothing retires the old plan when a new one is written — so the
  // LIMIT 1 chose on recency, which says nothing about whether the chosen
  // plan prescribes anything today. Pick the silent one and the client is a
  // rest day while their real workout sits in the assignment beside it.
  //
  // Measured against production before the fix: 26 of 55 programmed
  // client-days across the week resolved to the wrong assignment — 8 of 14
  // on a Tuesday. One client, Vipul Bhatia, held three active assignments and
  // showed as resting on a day one of them prescribed.

  it('prefers the assignment that prescribes THIS weekday over the newest one', async () => {
    pool.query.mockResolvedValueOnce(DOW_ROW).mockResolvedValueOnce({ rows: [] });
    await request(app()).get('/api/pt-os/workout-log/today').expect(200);

    // Comments stripped first: the query explains this fix at length and the
    // prose says "LIMIT 1", which would truncate the slice before the ORDER BY
    // and fail on a sentence rather than on the code.
    const sql = String(pool.query.mock.calls[1][0]).replace(/--.*$/gm, '');
    // The assignment-resolving LATERAL, isolated from the session one.
    const lateral = sql.slice(sql.indexOf('FROM workout_assignments a'));
    const head = lateral.slice(0, lateral.indexOf('LIMIT 1'));
    // Day match is the FIRST ordering key; recency only breaks the tie.
    const dayKey = head.indexOf('we.day_of_week = $2');
    const dateKey = head.indexOf('a.start_date DESC');
    expect(dayKey).toBeGreaterThan(-1);
    expect(dateKey).toBeGreaterThan(-1);
    expect(dayKey).toBeLessThan(dateKey);
    // week_number = 1, matching planned_exercises — otherwise the row this
    // picks and the count it displays can disagree.
    expect(head).toMatch(/we\.week_number = 1/);
  });

  it('still calls it a rest day when NO assignment prescribes today', async () => {
    // The fix must not turn every programme client into a training day.
    pool.query
      .mockResolvedValueOnce(DOW_ROW)
      .mockResolvedValueOnce({
        rows: [{ source_rank: 2, start_time: null,
          assignment_id: 'a1', client_id: 'c1', client_name: 'Resting', client_photo: null,
          plan_id: 'p1', plan_name: 'Lower', progress_pct: 0,
          session_id: null, session_status: null, planned_exercises: '0' }],
      });
    const res = await request(app()).get('/api/pt-os/workout-log/today').expect(200);
    expect(res.body.data.clients[0].is_rest_day).toBe(true);
    expect(res.body.data.clients[0].source).toBe('programme');
  });

  it('keeps a booked slot a booked slot, with its time', async () => {
    pool.query
      .mockResolvedValueOnce(DOW_ROW)
      .mockResolvedValueOnce({
        rows: [{ source_rank: 1, start_time: '06:00:00',
          assignment_id: null, client_id: 'c1', client_name: 'Booked', client_photo: null,
          plan_id: null, plan_name: null, progress_pct: null,
          session_id: null, session_status: null, planned_exercises: '0' }],
      });
    const res = await request(app()).get('/api/pt-os/workout-log/today').expect(200);
    const row = res.body.data.clients[0];
    expect(row.source).toBe('booked');
    expect(row.start_time).toBe('06:00');
    // Zero planned exercises and NO plan is not a rest day — it is a client
    // with an appointment and no programme written yet. Calling it a rest day
    // would grey out and sink the one row with a real appointment on it.
    expect(row.is_rest_day).toBe(false);
  });

  it('shows a booked client once when a programme also covers today', async () => {
    // Deduplication happens in SQL, so this pins the mechanism: candidates are
    // grouped by client and the strongest source wins. Without the GROUP BY a
    // client who is both booked and programmed is two rows on the one screen
    // the trainer opens every day.
    pool.query.mockResolvedValueOnce(DOW_ROW).mockResolvedValueOnce({ rows: [] });
    await request(app()).get('/api/pt-os/workout-log/today').expect(200);
    const sql = pool.query.mock.calls[1][0];
    expect(sql).toMatch(/GROUP BY client_id/);
    expect(sql).toMatch(/MIN\(source_rank\)/);
    // Booked ranks 1, programme 2, enrolment 3 — MIN keeps the most specific.
    expect(sql).toMatch(/AS source_rank[\s\S]*?NULL::time, 2[\s\S]*?, 3/);
  });

  it('ignores an assignment whose window has closed', async () => {
    pool.query.mockResolvedValueOnce(DOW_ROW).mockResolvedValueOnce({ rows: [] });
    await request(app()).get('/api/pt-os/workout-log/today').expect(200);
    const sql = pool.query.mock.calls[1][0];
    // Both the candidate arm and the resolving LATERAL check status AND the
    // date window, or an expired plan would keep filling the roster.
    const statusChecks = sql.match(/status = 'active'/g) || [];
    expect(statusChecks.length).toBeGreaterThanOrEqual(2);
    const windowChecks = sql.match(/end_date IS NULL OR \w+\.end_date >= \$1::date/g) || [];
    expect(windowChecks.length).toBeGreaterThanOrEqual(2);
  });

  it('filters to the caller organization for a tenant user', async () => {
    pool.query.mockResolvedValueOnce(DOW_ROW).mockResolvedValueOnce({ rows: [] });
    await request(app()).get('/api/pt-os/workout-log/today').expect(200);

    const [sql, params] = pool.query.mock.calls[1];
    // $3 is the weekday token now, so the org moved to $4 — and it is applied
    // to each source inside the union rather than once at the end, or a
    // foreign row could be grouped against a local client.
    expect(sql).toMatch(/s\.organization_id = \$4/);
    expect(sql).toMatch(/wa\.organization_id = \$4/);
    expect(sql).toMatch(/c2\.organization_id = \$4/);
    expect(params).toContain('org-1');
  });

  it('limits a plain trainer to their own clients', async () => {
    global.__mockUser = { id: 'u-2', role: 'trainer', organization_id: 'org-1', trainer_id: 't-9' };
    pool.query.mockResolvedValueOnce(DOW_ROW).mockResolvedValueOnce({ rows: [] });

    await request(app()).get('/api/pt-os/workout-log/today').expect(200);

    const [sql, params] = pool.query.mock.calls[1];
    expect(sql).toMatch(/c\.trainer_id = \$5/);
    expect(params).toContain('t-9');
  });

  it('does NOT restrict by trainer for an admin', async () => {
    pool.query.mockResolvedValueOnce(DOW_ROW).mockResolvedValueOnce({ rows: [] });
    await request(app()).get('/api/pt-os/workout-log/today').expect(200);
    expect(pool.query.mock.calls[1][0]).not.toMatch(/c\.trainer_id =/);
  });

  it('rejects a malformed date instead of interpolating it', async () => {
    pool.query.mockResolvedValueOnce(DOW_ROW).mockResolvedValueOnce({ rows: [] });
    await request(app()).get('/api/pt-os/workout-log/today?date=not-a-date').expect(200);

    // Falls back to today rather than passing the input through — the value
    // reaches a ::date cast, so a rejected shape is the safe outcome.
    const passed = pool.query.mock.calls[0][1][0];
    expect(passed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(passed).not.toBe('not-a-date');
  });

  // ── The three sources ────────────────────────────────────────────────────
  //
  // This endpoint was an INNER JOIN on workout_assignments, so it answered
  // only for clients who already had a programme. A client enrolled yesterday
  // with a 6am slot booked and no plan written yet — the commonest state for a
  // new client — was absent from the one screen a trainer opens on the floor,
  // and could not be started from it.

  it('carries the time through to the client, normalised to HH:MM', async () => {
    pool.query
      .mockResolvedValueOnce(DOW_ROW)
      .mockResolvedValueOnce({
        rows: [
          { source_rank: 1, start_time: '06:00:00', client_id: 'c1', client_name: 'Booked',
            assignment_id: null, plan_id: null, plan_name: null, progress_pct: null,
            session_id: null, session_status: null, planned_exercises: '0' },
        ],
      });

    const res = await request(app()).get('/api/pt-os/workout-log/today').expect(200);
    const [row] = res.body.data.clients;
    // Postgres hands back a full TIME; the row shows a clock time.
    expect(row.start_time).toBe('06:00');
    expect(row.source).toBe('booked');
  });

  it('does not call a booked client with no plan a rest day', async () => {
    // The narrowing that matters. `planned_exercises === 0` was safe while
    // every row came from an assignment; a booked client with no programme
    // also has zero, and greying that row out would hide the one person with
    // a real appointment.
    pool.query
      .mockResolvedValueOnce(DOW_ROW)
      .mockResolvedValueOnce({
        rows: [
          { source_rank: 1, start_time: '07:00:00', client_id: 'c1', client_name: 'No plan yet',
            assignment_id: null, plan_id: null, plan_name: null, progress_pct: null,
            session_id: null, session_status: null, planned_exercises: '0' },
        ],
      });

    const [row] = (await request(app()).get('/api/pt-os/workout-log/today').expect(200))
      .body.data.clients;
    expect(row.is_rest_day).toBe(false);
    expect(row.plan_name).toBeNull();
  });

  it('labels an enrolment-only client and leaves it untimed when no time is set', async () => {
    pool.query
      .mockResolvedValueOnce(DOW_ROW)
      .mockResolvedValueOnce({
        rows: [
          { source_rank: 3, start_time: null, client_id: 'c1', client_name: 'Habit only',
            assignment_id: null, plan_id: null, plan_name: null, progress_pct: null,
            session_id: null, session_status: null, planned_exercises: '0' },
        ],
      });

    const [row] = (await request(app()).get('/api/pt-os/workout-log/today').expect(200))
      .body.data.clients;
    expect(row.source).toBe('enrolled');
    expect(row.start_time).toBeNull();
    expect(row.is_rest_day).toBe(false);
  });

  it('passes the weekday token the enrolment column stores', async () => {
    // dow 4 is Thursday, and the enrolment form writes 'Thu'. A mismatch here
    // matches nothing and does it silently.
    pool.query.mockResolvedValueOnce(DOW_ROW).mockResolvedValueOnce({ rows: [] });
    await request(app()).get('/api/pt-os/workout-log/today').expect(200);
    expect(pool.query.mock.calls[1][1][2]).toBe('Thu');
  });
});
