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
 * Writers that deliberately do NOT raise payment_received yet, and why.
 *
 * Both are real gaps of the same shape as the incident, not exemptions on
 * principle. They are listed rather than fixed in the same change because
 * neither is a one-line addition:
 *
 *   lib/upiPayments.js   is a service, not a route. It has no `req`, and the
 *                        trigger layer resolves the organization with
 *                        orgIdOf(req). Raising the event here needs a req-less
 *                        variant of paymentReceived, as the sweep already has
 *                        for membershipExpiring and birthday.
 *
 *   routes/invoices.js   writes the payment inside a CTE within a transaction
 *                        that uses savepoints, and has no post-commit section
 *                        to hang the emit on. Emitting inside the transaction
 *                        would message a client for a payment a rollback then
 *                        erased.
 *
 * Adding to this list is the thing to argue about in review; that is the point
 * of it being a list.
 */
const KNOWN_GAPS = new Set([
  'src/lib/upiPayments.js',
  'src/routes/invoices.js',
]);

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
      .filter((h) => !/paymentReceived\s*\(/.test(h.chunk))
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
    expect(byFile['src/modules/pt-os/pt-os.routes.js']).toMatch(/paymentReceived\s*\(/);

    // POST /api/payments — the finance ledger, same gap.
    expect(byFile['src/routes/payments.js']).toBeDefined();
    expect(byFile['src/routes/payments.js']).toMatch(/paymentReceived\s*\(/);
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
      .filter((chunk) => /paymentReceived\s*\(/.test(chunk))
      .map((chunk) => {
        const at = chunk.search(/paymentReceived\s*\(/);
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
