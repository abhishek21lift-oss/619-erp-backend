#!/usr/bin/env node
'use strict';
// Read-only tenant-isolation posture check.
//
//   npm run verify:rls
//
// ── Why this is a script and not a Jest test ────────────────────────────────
//
// The question is not "does the code contain a set_config call" — the
// convention tests already answer that. It is "which role did THIS deployment
// actually connect as, and do its policies filter?". That answer lives in the
// database, not in the repository, and it changes with the deployment's
// DATABASE_URL. A test with a fixture would only prove the fixture.
//
// src/db/rlsPreflight.js already asks the database. This exposes the same
// check as one command an operator can run before trusting a production box,
// and makes the exit code the gate: 0 only when isolation is demonstrated.
//
// ── What it does, and does not, do ──────────────────────────────────────────
//
// It opens no write transaction. The isolation probe runs inside an explicit
// BEGIN … ROLLBACK and issues only SELECTs; it returns counts, never rows. It
// prints role names and booleans, never a connection string, password or
// client record.
//
// Exit codes:
//   0  isolation demonstrated, no fatal/error findings
//   1  isolation not demonstrated (bypassing role, no policies, probe failed,
//      or the database could not be inspected)
//   2  could not start (no DATABASE_URL, unexpected error before the check)
//
// `TENANT_RLS_ENFORCE=on` is the default and only REPORTS posture; it does not
// refuse to start on a bypassing role. `strict` is the boot-time fail-closed
// mode. Either way, this command is how a human confirms the live role.

require('dotenv').config();

// Fail cleanly when the required variable is absent. src/db/pool.js throws at
// require time without DATABASE_URL, which would print a stack trace instead
// of the one line an operator can act on.
if (!process.env.DATABASE_URL) {
  console.error('verify:rls: DATABASE_URL is not set; nothing to inspect.');
  process.exit(2);
}

const pool = require('../src/db/pool');
const { verifyRlsPosture } = require('../src/db/rlsPreflight');

function printSummary(result) {
  const blocking = (result.findings || []).filter(
    (f) => f.severity === 'fatal' || f.severity === 'error'
  );

  const summary = {
    posture: result.posture,
    enforced: Boolean(result.enforced),
    pass: Boolean(result.enforced) && blocking.length === 0,
    tenant_role: result.tenant ? result.tenant.role : null,
    tenant_bypasses_rls: result.tenant ? Boolean(result.tenant.bypasses_rls) : null,
    tenant_is_superuser: result.tenant ? Boolean(result.tenant.is_superuser) : null,
    owner_role: result.owner ? result.owner.role : null,
    probe: result.probe,
    findings: (result.findings || []).map((f) => ({
      code: f.code,
      severity: f.severity,
      detail: f.detail,
    })),
  };

  console.log(JSON.stringify(summary, null, 2));
  return summary.pass;
}

async function main() {
  const tenantPool = pool.tenantPoolForDiagnostics();
  const ownerPool = pool.ownerPoolForDiagnostics();

  if (!tenantPool) {
    console.error('verify:rls: no tenant pool is available.');
    process.exit(2);
  }

  const result = await verifyRlsPosture({ tenantPool, ownerPool });
  const pass = printSummary(result);

  if (!pass) {
    console.error(
      '\nverify:rls: tenant isolation is NOT demonstrated. '
      + 'Do not describe RLS as enforced until this exits 0.'
    );
  }

  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  // No connection string, no password, no client data: the message only.
  console.error(`verify:rls: ${err && err.message ? err.message : String(err)}`);
  process.exit(2);
});
