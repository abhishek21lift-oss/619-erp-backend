// src/db/receipts.js
//
// Concurrency-safe receipt-number generator.
//
// WHY: code paths in payments.js and clients.js (and the since-deleted
// client-actions.js) all built
// receipt numbers with `Date.now()` and `Math.random()`. Under concurrency
// the millisecond timestamp + 4-digit random tail can collide and Postgres
// rejects the insert because `payments.receipt_no` is UNIQUE — surfacing
// as a 500 to the cashier mid-payment.
//
// FIX: draw from a Postgres sequence; format as RCP-YYYYMMDD-NNNNNN.
//
// The sequence is created by migration 214. The lazy CREATE below is only a
// fallback for a database that has not run it, and it is issued ONLY when the
// sequence is missing: Postgres checks the CREATE privilege before it looks
// for the object, so `CREATE SEQUENCE IF NOT EXISTS` fails for app_tenant —
// which may not create objects — even when the sequence exists. Issued on
// every call, it failed every payment under RLS.
//
// USAGE:
//   const { genReceiptNo } = require('../db/receipts');
//   const receipt = await genReceiptNo(tx); // tx is optional — pool by default

const pool = require('./pool');

// Once the sequence is known to exist it cannot stop existing, so the check
// runs once per process rather than once per receipt.
let sequenceKnown = false;

async function ensureSequence(client) {
  if (sequenceKnown) return;
  // to_regclass needs no privilege on the schema, unlike CREATE.
  const { rows } = await client.query(`SELECT to_regclass('receipt_no_seq') IS NOT NULL AS present`);
  if (!rows[0]?.present) {
    await client.query(`CREATE SEQUENCE IF NOT EXISTS receipt_no_seq START 100001`);
  }
  sequenceKnown = true;
}

function pad(n, w) {
  const s = String(n);
  return s.length >= w ? s : '0'.repeat(w - s.length) + s;
}

function todayCompact() {
  const d = new Date();
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1, 2) +
    pad(d.getUTCDate(), 2)
  );
}

async function genReceiptNo(client) {
  const c = client || pool;
  await ensureSequence(c);
  const { rows } = await c.query(`SELECT nextval('receipt_no_seq') AS n`);
  return `RCP-${todayCompact()}-${pad(rows[0].n, 6)}`;
}

module.exports = { genReceiptNo };
