#!/usr/bin/env node
'use strict';
// Does this backend still agree with the REAL WhatsApp gateway?
//
// ── The gap this closes ────────────────────────────────────────────────────
//
// Every test of the WhatsApp send path in this repo mocks the gateway. Every
// test in 619-erp-whatsapp exercises the gateway without this caller. So the
// HTTP seam between them — field names, header names, the error envelope, the
// error CODES that transport.js branches on — is verified by nobody, and a
// rename on either side passes both suites.
//
// What that costs is specific. `transport.js` reads
// `res.data.provider_message_id` and reports SENT when the call succeeds. If
// the gateway renamed that field, every send would still be recorded as SENT,
// with `provider_id: null` — a message the studio believes was delivered and
// which can never be matched to a delivery receipt, because the receipt
// arrives keyed on the id we failed to store. That is precisely the state the
// system is supposed to make impossible.
//
// ── Why this can run without a WhatsApp account ────────────────────────────
//
// The gateway ships a null connector (WA_CONNECTOR=null) that runs the whole
// service — auth, tenancy, manifest, lifecycle, the send route — and never
// reports `connected`. So the happy SEND cannot be exercised here, and is not
// claimed below. What can be exercised is everything the brief actually cares
// about: that a not-connected instance yields NOT_CONNECTED rather than SENT,
// that one studio cannot send on another's instance, and that the codes and
// shapes the ERP branches on are the ones the gateway really emits.
//
// ── What this does NOT prove ───────────────────────────────────────────────
//
// That a message reaches WhatsApp. Nothing automatable can prove that; it
// needs a paired phone. This proves the contract up to Baileys, which is the
// part that can silently rot between two repositories.

const assert = require('node:assert');
const { randomUUID } = require('node:crypto');

const GATEWAY_URL = process.env.WA_GATEWAY_URL;
const GATEWAY_KEY = process.env.WA_GATEWAY_KEY;

if (!GATEWAY_URL || !GATEWAY_KEY) {
  // Never a silent skip: a contract check that passes without contacting the
  // other side reports green for the one configuration where drift hides.
  console.error('✗ WA_GATEWAY_URL and WA_GATEWAY_KEY must both be set.');
  console.error('  This script must talk to a real gateway. It does not mock one,');
  console.error('  because mocking the thing under test is what created the gap.');
  process.exit(1);
}

// Required so the client module does not read a stale value at require time.
const gateway = require('../src/lib/whatsappGateway');

const ORG_A = randomUUID();
const ORG_B = randomUUID();
const INSTANCE = randomUUID();

const checks = [];
const record = (name, fn) => checks.push({ name, fn });

record('the client considers itself configured', async () => {
  assert.strictEqual(gateway.isConfigured(), true);
});

record('creating an instance returns the manifest the ERP expects', async () => {
  const res = await gateway.createInstance(ORG_A, INSTANCE, 'seam-create');
  assert.strictEqual(res.ok, true, `expected ok, got ${res.status}: ${JSON.stringify(res.data)}`);
  assert.strictEqual(res.status, 201);
  // routes/whatsapp.js renders these directly onto the studio's card.
  assert.strictEqual(res.data.instance_id, INSTANCE);
  assert.strictEqual(res.data.organization_id, ORG_A);
  assert.ok(typeof res.data.state === 'string', 'state must be present');
});

record('a send to a NOT-CONNECTED instance is refused, never reported as sent', async () => {
  const res = await gateway.sendMessage(
    ORG_A, INSTANCE,
    { to: '+911234567890', text: 'seam', clientMessageId: randomUUID() },
    'seam-send',
  );
  assert.strictEqual(res.ok, false, 'a send on an unpaired instance must not succeed');
  // transport.js branches on exactly this string to return SendStatus.NOT_CONNECTED.
  // If the gateway ever renames it, the fallthrough is FAILED — still not SENT,
  // but the studio loses "your WhatsApp is not connected" as the reason.
  assert.strictEqual(res.code, 'INSTANCE_NOT_CONNECTED',
    `transport.js branches on INSTANCE_NOT_CONNECTED; gateway said ${res.code}`);
  assert.strictEqual(res.data.error.code, 'INSTANCE_NOT_CONNECTED',
    'the error envelope must be { error: { code } } — whatsappGateway.call reads data.error.code');
});

record('one studio cannot send on another studio\'s instance', async () => {
  const res = await gateway.sendMessage(
    ORG_B, INSTANCE,
    { to: '+911234567890', text: 'seam', clientMessageId: randomUUID() },
    'seam-cross-tenant',
  );
  assert.strictEqual(res.ok, false, 'CROSS-TENANT SEND SUCCEEDED — stop and fix this');
  // NOT_FOUND rather than FORBIDDEN, deliberately: a distinct code would let a
  // caller probe which instance ids exist.
  assert.strictEqual(res.code, 'INSTANCE_NOT_FOUND',
    `expected the non-disclosing code; got ${res.code}`);
});

record('one studio cannot read another studio\'s instance', async () => {
  const res = await gateway.status(ORG_B, INSTANCE, 'seam-cross-read');
  assert.strictEqual(res.ok, false, 'CROSS-TENANT READ SUCCEEDED — stop and fix this');
  assert.strictEqual(res.code, 'INSTANCE_NOT_FOUND');
});

record('the owning studio can still read it (the isolation test is not vacuous)', async () => {
  const res = await gateway.status(ORG_A, INSTANCE, 'seam-own-read');
  assert.strictEqual(res.ok, true, 'org A must still reach its own instance');
  assert.strictEqual(res.data.organization_id, ORG_A);
});

record('a wrong service key is rejected', async () => {
  const real = process.env.WA_GATEWAY_KEY;
  process.env.WA_GATEWAY_KEY = 'wrong'.repeat(13);
  try {
    const res = await gateway.status(ORG_A, INSTANCE, 'seam-bad-key');
    assert.strictEqual(res.ok, false, 'a wrong key must not authenticate');
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.code, 'UNAUTHORIZED');
  } finally {
    process.env.WA_GATEWAY_KEY = real;
  }
});

record('an unreachable gateway degrades rather than throwing', async () => {
  // The ERP must keep working when the gateway is down — routes/whatsapp.js
  // renders a stale card, it does not 500. Port 1 is reserved and refuses.
  const real = process.env.WA_GATEWAY_URL;
  process.env.WA_GATEWAY_URL = 'http://127.0.0.1:1';
  try {
    const res = await gateway.status(ORG_A, INSTANCE, 'seam-unreachable');
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, 0, 'an unreachable gateway is status 0, not an exception');
  } finally {
    process.env.WA_GATEWAY_URL = real;
  }
});

(async () => {
  let failed = 0;
  for (const { name, fn } of checks) {
    try {
      await fn();
      console.info(`  ✓ ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`  ✗ ${name}\n      ${err.message}`);
    }
  }

  // Cannot pass vacuously: if the list is ever emptied or the loop skipped,
  // that is a failure, not a clean run.
  if (checks.length < 8) {
    console.error(`✗ only ${checks.length} checks defined — the suite shrank; this cannot be trusted`);
    process.exit(1);
  }

  console.info(`\ngateway seam: ${checks.length - failed}/${checks.length} against ${GATEWAY_URL}`);
  if (failed) {
    console.error('✗ the ERP and the gateway no longer agree. A mocked test will not catch this.');
    process.exit(1);
  }
  console.info('✓ the ERP and the real gateway agree on the contract');
})();
