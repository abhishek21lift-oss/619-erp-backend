'use strict';
// One incident, one announcement — under concurrency.
//
// ── The race ───────────────────────────────────────────────────────────────
//
// Announcing was read, act, stamp:
//
//     SELECT notified_at            both passes see NULL
//     await notify(row)             both write a notification row per operator
//                                   and open an SMTP connection per operator
//     UPDATE SET notified_at        both stamp; the second changes nothing
//
// Three callers can be inside that window: the 60s interval in server.js, an
// operator pressing "Evaluate alerts now", and a second API container's
// interval. The window is as long as the mail provider takes, because notify()
// sends inside it.
//
// server.js says overlapping ticks are safe because migration 150's partial
// unique index cannot double-OPEN an alert. True — and about a different
// column. Nothing made the ANNOUNCEMENT once-only.

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';

jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn(),
}));
jest.mock('../lib/activityLog', () => ({ logActivity: jest.fn(async () => {}) }));

/**
 * A Postgres double that models the ONE property the fix depends on: a
 * conditional UPDATE is atomic, so only the first caller to match the
 * predicate gets a row back.
 */
const db = { alerts: new Map() };
const mockQuery = jest.fn(async (sql, params = []) => {
  const q = String(sql).replace(/\s+/g, ' ').trim();

  if (/^UPDATE system_alerts SET notified_at = NOW\(\) WHERE id = \$1 AND notified_at IS NULL/i.test(q)) {
    const row = db.alerts.get(params[0]);
    // The row lock, modelled: whoever reads NULL first wins, and the write is
    // indivisible from the read.
    if (!row || row.notified_at !== null) return { rows: [], rowCount: 0 };
    row.notified_at = new Date().toISOString();
    return { rows: [{ id: row.id }], rowCount: 1 };
  }
  if (/^SELECT id, severity, notified_at FROM system_alerts/i.test(q)) {
    const row = [...db.alerts.values()].find((r) => r.fingerprint === params[0] && r.status !== 'resolved');
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }
  if (/^INSERT INTO system_alerts/i.test(q)) {
    const [fingerprint, source, severity, title, reason] = params;
    const existing = [...db.alerts.values()].find((r) => r.fingerprint === fingerprint && r.status !== 'resolved');
    if (existing) { existing.occurrences += 1; return { rows: [existing], rowCount: 1 }; }
    const row = {
      id: `alert-${db.alerts.size + 1}`, fingerprint, source, severity, title, reason,
      status: 'open', occurrences: 1, notified_at: null,
    };
    db.alerts.set(row.id, row);
    return { rows: [row], rowCount: 1 };
  }
  if (/^UPDATE system_alerts SET last_seen_at/i.test(q)) {
    const row = db.alerts.get(params[0]);
    row.reason = params[1]; row.severity = params[2];
    // Read from the STATEMENT, not from the parameter. A double that honours
    // the caller's intent rather than its SQL cannot see the clause being
    // deleted — which is how an escalation silently stops re-announcing.
    if (/notified_at\s*=\s*CASE WHEN \$4::boolean THEN NULL/i.test(q) && params[3] === true) {
      row.notified_at = null;
    }
    row.occurrences += 1;
    return { rows: [row], rowCount: 1 };
  }
  if (/FROM users/i.test(q)) {
    return { rows: [{ id: 'op1', email: 'a@x.com' }, { id: 'op2', email: 'b@x.com' }], rowCount: 2 };
  }
  if (/^INSERT INTO notifications/i.test(q)) {
    inappWrites.push(params[0]);
    return { rows: [], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
});
jest.mock('../db/pool', () => ({ query: (...a) => mockQuery(...a) }));

const inappWrites = [];
const emailsSent = [];
jest.mock('../lib/email', () => ({
  isConfigured: () => true,
  sendRaw: jest.fn(async (msg) => {
    // Mail is SLOW, and the old window was exactly this long.
    await new Promise((r) => setTimeout(r, 20));
    emailsSent.push(msg.to);
  }),
}));

const mockCollect = jest.fn();
jest.mock('../modules/command-center/snapshot.service', () => ({
  collect: (...a) => mockCollect(...a),
  invalidate: jest.fn(),
}));

const alerts = require('../modules/command-center/alerts.service');

const sickSnapshot = () => ({
  status: 'critical',
  cards: { redis: { name: 'redis', status: 'critical', reason: 'Redis is unreachable' } },
});

beforeEach(() => {
  db.alerts.clear();
  inappWrites.length = 0;
  emailsSent.length = 0;
  mockQuery.mockClear();
  mockCollect.mockClear();
  alerts._resetStreaks();
  mockCollect.mockImplementation(async () => sickSnapshot());
});

/** Damping: a condition must be seen CONSECUTIVE_TO_OPEN times before it opens. */
async function warmUpDamping() {
  for (let i = 1; i < alerts.CONSECUTIVE_TO_OPEN; i += 1) {
    await alerts.evaluate({ fresh: true });
  }
}

describe('an alert is announced exactly once, however many passes race', () => {
  it('notifies once when the tick and the operator button land together', async () => {
    await warmUpDamping();
    expect(inappWrites).toEqual([]);          // damping held

    // The tick and "Evaluate alerts now", in the same instant.
    await Promise.all([
      alerts.evaluate({ fresh: true }),
      alerts.evaluate({ fresh: true }),
      alerts.evaluate({ fresh: true }),
    ]);

    // Two operators, one announcement each. Not six.
    expect(inappWrites.sort()).toEqual(['op1', 'op2']);
    expect(emailsSent.sort()).toEqual(['a@x.com', 'b@x.com']);
  });

  it('stays at once across many sequential passes', async () => {
    await warmUpDamping();
    for (let i = 0; i < 5; i += 1) {
      await alerts.evaluate({ fresh: true });
    }
    expect(inappWrites).toHaveLength(2);
  });

  it('announces AGAIN when the alert escalates, and only once', async () => {
    mockCollect.mockImplementation(async () => ({
      status: 'warning',
      cards: { redis: { name: 'redis', status: 'warning', reason: 'slow' } },
    }));
    await warmUpDamping();
    await alerts.evaluate({ fresh: true });
    expect(inappWrites).toHaveLength(2);

    // warning -> critical clears notified_at, which must re-announce once.
    mockCollect.mockImplementation(async () => sickSnapshot());
    await Promise.all([
      alerts.evaluate({ fresh: true }),
      alerts.evaluate({ fresh: true }),
    ]);
    expect(inappWrites).toHaveLength(4);
  });
});

describe('claimNotification is the atomic primitive, and is testable alone', () => {
  it('returns true for exactly one of many concurrent claimants', async () => {
    db.alerts.set('a1', { id: 'a1', fingerprint: 'redis', status: 'open', notified_at: null, occurrences: 1 });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => alerts.claimNotification('a1')),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('refuses rather than announcing when the claim itself fails', async () => {
    // A claim that errors must NOT fall through to notifying — that would
    // announce on every tick for the life of the incident.
    mockQuery.mockImplementationOnce(async () => { throw new Error('deadlock detected'); });
    await expect(alerts.claimNotification('whatever')).resolves.toBe(false);
  });
});

describe('concurrent evaluations are coalesced', () => {
  it('collects once for simultaneous non-fresh passes', async () => {
    await Promise.all([alerts.evaluate(), alerts.evaluate(), alerts.evaluate()]);
    expect(mockCollect).toHaveBeenCalledTimes(1);
  });

  it('does NOT let a fresh request ride a cached pass', async () => {
    // "Evaluate alerts now" is an operator asking for current readings.
    // Handing them the tick's cached ones answers a different question.
    let release;
    mockCollect.mockImplementationOnce(async () => {
      await new Promise((r) => { release = r; });
      return sickSnapshot();
    });
    const slow = alerts.evaluate();                 // non-fresh, in flight
    await new Promise((r) => setImmediate(r));
    const fresh = alerts.evaluate({ fresh: true }); // must not join it
    expect(mockCollect).toHaveBeenCalledTimes(2);
    release();
    await Promise.all([slow, fresh]);
  });
});
