'use strict';
// Every path that records a client payment must tell automation about it.
//
// ── The incident this exists to prevent recurring ───────────────────────────
//
// A studio reported that WhatsApp automation "was not reliably delivering".
// The whole delivery pipeline was healthy — engine, BullMQ, worker, transport,
// gateway, a CONNECTED instance — and production proved it: on 2026-09-11 two
// payments for one client sent WhatsApp within two seconds each.
//
// A third payment, recorded between those two, produced nothing. No queued
// row, no failed row, no job. Not a delivery failure: the message was never
// asked for. POST /api/pt-os/payments — the endpoint the PT-OS payments screen
// actually calls — wrote the payment and never emitted payment_received.
//
// So money could arrive through five paths and only two of them raised the
// event. Which two you hit decided whether the client heard from the studio,
// and nothing anywhere recorded the difference. A missing EMIT is invisible in
// a way a failed send is not: there is no row to find.
//
// This test makes it visible. It fails the build when a file that writes
// pt_payments does not also raise the event, so the next payment surface
// cannot be added with the same hole.
//
// ── Comments are stripped before matching ──────────────────────────────────
//
// Without that this passes on its own subject matter: the call sites are
// documented with comments that name payment_received and paymentReceived, and
// a mutation removing the real call would leave those comments behind and stay
// green. That exact false pass has bitten this repo twice — the api-transport
// guardrail and the client-term-money guardrail both shipped wrong first.

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');

/**
 * A call that raises payment_received, in either of its two shapes.
 *
 * paymentReceived(req, …)      from a route handler
 * paymentReceivedFor(orgId, …) from a service that has no request
 *
 * Both must count. The narrower /paymentReceived\s*\(/ does NOT match
 * `paymentReceivedFor(` — the "For" sits between the name and the paren — so
 * with only that pattern this guard reported lib/upiPayments.js as silent
 * immediately after it was fixed. Caught by the guard failing on a correct
 * file, which is the good direction for a guard to be wrong in.
 */
const RAISES_EVENT = /paymentReceived(?:For)?\s*\(/;

/** Drop block and line comments so claims are about code, not prose. */
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const rel = (f) => path.relative(path.join(SRC, '..'), f).replace(/\\/g, '/');

/** Route files split into per-HANDLER chunks, comments already stripped. */
function handlersOf(file, code) {
  // Granularity is the point. An earlier cut of this test asked whether the
  // FILE mentioned paymentReceived, and a mutation removing the emit from
  // POST /pt-os/payments sailed through — because the renew and enrolment
  // handlers in the same file still had theirs. That is not a hypothetical
  // weakness: it is precisely the shape of the incident, a file with some
  // emits and one missing, so a file-level check could not have caught the
  // very bug it was written for.
  return code
    .split(/router\.(?:get|post|patch|put|delete)\(/)
    .map((chunk, i) => ({ file, chunk, handler: `${file}#${i}` }));
}

const allFiles = walk(SRC).map((f) => ({
  file: rel(f),
  code: stripComments(fs.readFileSync(f, 'utf8')),
}));

/** Files whose CODE writes a pt_payments row. */
const writers = allFiles.filter((x) => /INSERT\s+INTO\s+pt_payments/i.test(x.code));

/** Individual route handlers that write a pt_payments row. */
const writingHandlers = writers
  .flatMap((w) => handlersOf(w.file, w.code))
  .filter((h) => /INSERT\s+INTO\s+pt_payments/i.test(h.chunk));

/**
 * Writers that deliberately do NOT raise payment_received, and why.
 *
 * EMPTY, and that is the point. It held two entries when this guard was
 * written — lib/upiPayments.js and routes/invoices.js — and both have since
 * been closed:
 *
 *   lib/upiPayments.js   is a service with no `req`, so it could not use the
 *                        request-driven trigger. It now calls the req-less
 *                        paymentReceivedFor with its own resolved orgId, the
 *                        same shape the sweep-driven triggers use.
 *
 *   routes/invoices.js   turned out to have a perfectly good post-commit line
 *                        after all; the earlier note claiming otherwise was
 *                        wrong. It keys the event on the INVOICE id rather
 *                        than a payment id, because its insert carries
 *                        ON CONFLICT DO NOTHING and a re-mark may create no
 *                        payment row to key on.
 *
 * Adding an entry back is the thing to argue about in review; that is the
 * point of it being a list rather than a silence.
 */
const KNOWN_GAPS = new Set([]);

describe('every payment writer raises payment_received', () => {
  it('finds the payment writers at all', () => {
    // If this drops to zero the whole suite passes vacuously.
    expect(writers.map((w) => w.file).sort().length).toBeGreaterThanOrEqual(4);
  });

  it('every handler that writes a payment also raises the event', () => {
    // Handler-level, not file-level — see handlersOf() for why that
    // distinction is the whole test.
    const silent = writingHandlers
      .filter((h) => !KNOWN_GAPS.has(h.file))
      .filter((h) => !RAISES_EVENT.test(h.chunk))
      .map((h) => h.handler);

    // A studio taking money through a silent handler gets no WhatsApp and no
    // failed row to explain it. Raise the event after COMMIT, or add the file
    // to KNOWN_GAPS with a reason.
    expect({ handlersWritingPaymentsButSilent: silent })
      .toEqual({ handlersWritingPaymentsButSilent: [] });
  });

  it('finds several distinct writing handlers, not one blob', () => {
    // Guards the split itself: if the regex stopped matching, every file would
    // collapse to a single chunk and the check above would go file-level again
    // without anything failing.
    expect(writingHandlers.length).toBeGreaterThanOrEqual(3);
  });

  it('keeps the known gaps honest — each must still be a payment writer', () => {
    // Stops the list rotting into an exemption for files that no longer write
    // payments at all, which would quietly widen it.
    const files = new Set(writers.map((w) => w.file));
    const stale = [...KNOWN_GAPS].filter((gap) => !files.has(gap));
    // Named in the value so the failure says WHICH entry to drop.
    expect({ staleKnownGaps: stale }).toEqual({ staleKnownGaps: [] });
  });

  it('pins the two endpoints the incident was actually about', () => {
    const byFile = Object.fromEntries(writers.map((w) => [w.file, w.code]));

    // POST /api/pt-os/payments — the PT-OS payments screen. This is the one
    // that recorded a payment in production and sent nothing.
    expect(byFile['src/modules/pt-os/pt-os.routes.js']).toBeDefined();
    expect(byFile['src/modules/pt-os/pt-os.routes.js']).toMatch(RAISES_EVENT);

    // POST /api/payments — the finance ledger, same gap.
    expect(byFile['src/routes/payments.js']).toBeDefined();
    expect(byFile['src/routes/payments.js']).toMatch(RAISES_EVENT);
  });
});

describe('the event is raised outside the transaction that owns the payment', () => {
  // Automation must never be able to roll back or fail a payment, and a
  // rolled-back payment must never message the client.
  //
  // The rule is per HANDLER, not per file: a handler that opens a transaction
  // must COMMIT before it raises the event. Handlers that never open one — the
  // renew path writes through the pool directly — have nothing to be inside
  // of, and are correctly unconstrained. Checking the file as a whole would
  // have failed on exactly that, which is how this test was wrong first.
  const handlersRaising = (file) => {
    const code = stripComments(fs.readFileSync(path.join(SRC, '..', file), 'utf8'));
    return code
      .split(/router\.(?:get|post|patch|put|delete)\(/)
      .filter((chunk) => RAISES_EVENT.test(chunk))
      .map((chunk) => {
        const at = chunk.search(RAISES_EVENT);
        const before = chunk.slice(0, at);
        return {
          opensTransaction: /BEGIN/.test(before),
          committedFirst: before.lastIndexOf('COMMIT') > -1,
        };
      });
  };

  it.each([
    ['src/modules/pt-os/pt-os.routes.js'],
    ['src/routes/payments.js'],
  ])('%s never raises it with a transaction still open', (file) => {
    const handlers = handlersRaising(file);
    expect(handlers.length).toBeGreaterThan(0);

    const offenders = handlers.filter((h) => h.opensTransaction && !h.committedFirst);
    expect({ file, raisingInsideAnOpenTransaction: offenders.length })
      .toEqual({ file, raisingInsideAnOpenTransaction: 0 });
  });
});

describe('the event key is a payment identity, not a clock reading', () => {
  // ── Two bugs that shared one cause ────────────────────────────────────────
  //
  // Two of the six payment call sites keyed their event on a composite —
  //
  //   `renewal:${clientId}:${amount}:${new Date().toISOString().slice(0, 10)}`
  //
  // — because "the payment row carries no id we can read back here". That was
  // true only for as long as the INSERT above it declined to RETURN one, and
  // it cost two separate silent message losses in production:
  //
  //   1. Two genuinely different payments of the same amount from one client
  //      on one day produce the SAME key. The second is refused by the dedupe
  //      index as a duplicate of the first, so that client is never told their
  //      money arrived. No failed row, no queued row — the dedupe index did
  //      exactly what it was built to do, to an event that was not a replay.
  //
  //   2. `new Date()` is the Node process, and it reports UTC. A studio in IST
  //      taking a payment at any time between midnight and 05:30 gets the
  //      PREVIOUS day's date in the key — so a payment late one evening and
  //      another early the next morning collide, and the second client hears
  //      nothing. automation.sweep.js documents this exact trap at length and
  //      keeps every date in SQL because of it; these two call sites were the
  //      last places still reaching for the JS clock.
  //
  // A payment id has neither problem: unique per payment, stable across a
  // retried request, and carrying no clock at all.

  const CALL_SITES = [
    'src/modules/pt-os/pt-os.routes.js',
    'src/routes/payments.js',
    'src/routes/invoices.js',
    'src/lib/upiPayments.js',
  ];

  /** The `eventKey:` argument of every payment event raised in a file. */
  const eventKeysIn = (file) => {
    const code = stripComments(fs.readFileSync(path.join(SRC, '..', file), 'utf8'));
    return code
      .split(RAISES_EVENT)
      .slice(1)
      .map((chunk) => chunk.match(/eventKey:\s*([^\n,]+)/))
      .filter(Boolean)
      .map((m) => m[1].trim());
  };

  it.each(CALL_SITES.map((f) => [f]))('%s builds no event key from the JS clock', (file) => {
    for (const key of eventKeysIn(file)) {
      // `new Date()`, `Date.now()`, `toISOString()` — any of them makes the key
      // depend on the Node process's idea of the day rather than on the
      // payment. The database is the only clock this system agrees on.
      expect({ file, key }).toEqual({ file, key: expect.not.stringMatching(/new Date|Date\.now|toISOString/) });
    }
  });

  it.each(CALL_SITES.map((f) => [f]))('%s keys every payment event on an id', (file) => {
    for (const key of eventKeysIn(file)) {
      // Either a bare identifier (`id`, `ptPaymentId`, `rows[0].id`,
      // `paid[0].id`) or a template whose only interpolation is one — never a
      // composite of attributes that two different payments can share.
      expect({ file, key }).toEqual({
        file,
        key: expect.stringMatching(/^(?:[A-Za-z_$][\w$.[\]]*|`[^`]*\$\{[^}]+\}`)$/),
      });
      expect({ file, key }).toEqual({ file, key: expect.not.stringMatching(/\}:\$\{/) });
    }
  });

  it('every payment call site was actually examined', () => {
    // A regex that quietly matches nothing would pass both guards above
    // without reading a line of the thing it claims to check. Six call sites
    // exist across the four files; this fails if that stops being true rather
    // than silently narrowing.
    const total = CALL_SITES.reduce((n, f) => n + eventKeysIn(f).length, 0);
    expect(total).toBe(6);
  });
});
