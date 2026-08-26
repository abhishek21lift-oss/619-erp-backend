// Calendar sync is fire-and-forget, so a regression here is silent: bookings
// keep working and the events simply stop appearing. These tests pin the two
// properties that would otherwise fail invisibly — that the sync happens
// AFTER the transaction commits, and that a calendar failure never breaks a
// booking.

const mockClient = {
  query: jest.fn(),
  release: jest.fn(),
};

jest.mock('../db/pool', () => ({
  connect: jest.fn(() => Promise.resolve(mockClient)),
  query: jest.fn(),
}));

jest.mock('../lib/google-calendar', () => ({
  isConfigured: jest.fn(() => true),
  createBookingEvent: jest.fn(() => Promise.resolve()),
  deleteBookingEvent: jest.fn(() => Promise.resolve()),
}));

const pool = require('../db/pool');
const cal = require('../lib/google-calendar');
const bookings = require('../modules/bookings/bookings.service');

/** Let the fire-and-forget promise chain drain. */
const flush = () => new Promise((r) => setImmediate(r));

const SESSION = {
  id: 'sess-1',
  capacity: 10,
  starts_at: new Date(Date.now() + 86400e3).toISOString(),
  status: 'scheduled',
  template_id: 'tpl-1',
};

function bookQueue({ confirmedCount = 0 } = {}) {
  // Mirrors book()'s exact query order: BEGIN, lock session, existing-booking
  // check, entitlement (the client row), confirmed count, [waitlist position],
  // insert, audit, COMMIT.
  const overCapacity = confirmedCount >= SESSION.capacity;
  const calls = [
    {},                                                   // BEGIN
    { rows: [SESSION] },                                  // lock session
    { rows: [] },                                         // no existing booking
    // The entitlement check: an active pt_clients row in the caller's studio.
    // This slot used to hold a member_memberships row joined to plans — the
    // abandoned v3 model that holds no rows, so in production it returned
    // nothing and every booking was refused with 402 NO_MEMBERSHIP.
    { rows: [{ id: 'pc-1', name: 'Asha Rao', status: 'active' }] },
    { rows: [{ n: String(confirmedCount) }] },            // confirmed count
  ];
  if (overCapacity) calls.push({ rows: [{ pos: '1' }] });  // waitlist position
  calls.push(
    { rows: [{ id: 'bk-1', status: overCapacity ? 'waitlist' : 'confirmed' }] },
    {},                                                   // audit
    {},                                                   // COMMIT
  );
  mockClient.query.mockReset();
  calls.forEach((r) => mockClient.query.mockResolvedValueOnce(r));
  mockClient.query.mockResolvedValue({ rows: [] });
}

// Migration 176 made bookings.organization_id NOT NULL; book() now refuses a
// ctx with no studio rather than inserting NULL. Every ctx below carries one.
const ORG = '11111111-1111-4111-8111-111111111111';

describe('booking → Google Calendar sync', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pool.query.mockResolvedValue({ rows: [{ id: 'usr-1', organization_name: 'Acme Fitness' }] });
    cal.isConfigured.mockReturnValue(true);
  });

  it('creates the event only after COMMIT', async () => {
    bookQueue();
    await bookings.book({ session_id: 'sess-1', client_id: 'pc-1' }, { user_id: 'usr-9', organization_id: ORG });
    await flush();

    expect(cal.createBookingEvent).toHaveBeenCalledWith('usr-1', 'bk-1', 'Acme Fitness');

    // The session row is locked FOR UPDATE for the whole transaction. Calling
    // Google before COMMIT would hold that lock across a network round-trip
    // and serialise every concurrent booker behind it.
    const committed = mockClient.query.mock.calls.findIndex((c) => c[0] === 'COMMIT');
    expect(committed).toBeGreaterThan(-1);
    expect(mockClient.query.mock.calls.length - 1).toBe(committed);
  });

  it('syncs to the CLIENT, not the admin who made the booking', async () => {
    bookQueue();
    await bookings.book({ session_id: 'sess-1', client_id: 'pc-1' }, { user_id: 'admin-7', organization_id: ORG });
    await flush();

    // The user lookup must be by pt_client_id — an admin booking on someone's
    // behalf must not get the class in their own diary.
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/WHERE u\.pt_client_id = \$1/);
    expect(params).toEqual(['pc-1']);
    expect(sql).toMatch(/organizations/);
  });

  it('does not put a waitlist place in anyone diary', async () => {
    bookQueue({ confirmedCount: SESSION.capacity });
    await bookings.book({ session_id: 'sess-1', client_id: 'pc-1' }, { user_id: 'usr-9', organization_id: ORG });
    await flush();
    expect(cal.createBookingEvent).not.toHaveBeenCalled();
  });

  it('skips entirely when Google Calendar is not configured', async () => {
    cal.isConfigured.mockReturnValue(false);
    bookQueue();
    await bookings.book({ session_id: 'sess-1', client_id: 'pc-1' }, { user_id: 'usr-9', organization_id: ORG });
    await flush();
    expect(pool.query).not.toHaveBeenCalled();
    expect(cal.createBookingEvent).not.toHaveBeenCalled();
  });

  it('skips a client who has no login', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    bookQueue();
    await bookings.book({ session_id: 'sess-1', client_id: 'pc-1' }, { user_id: 'usr-9', organization_id: ORG });
    await flush();
    expect(cal.createBookingEvent).not.toHaveBeenCalled();
  });

  it('returns the booking even when the calendar call rejects', async () => {
    // The booking is the product; the calendar entry is a convenience. A
    // Google outage must never cost a member their class.
    cal.createBookingEvent.mockRejectedValueOnce(new Error('google is down'));
    bookQueue();
    const booking = await bookings.book(
      { session_id: 'sess-1', client_id: 'pc-1' }, { user_id: 'usr-9', organization_id: ORG }
    );
    await flush();
    expect(booking.id).toBe('bk-1');
  });
});
