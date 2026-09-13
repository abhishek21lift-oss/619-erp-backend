'use strict';
// The seam check exists because both suites lie by omission.
//
// Every test of the WhatsApp send path in THIS repo mocks the gateway. Every
// test in 619-erp-whatsapp exercises the gateway without this caller. The HTTP
// contract between them was therefore verified by nobody, and a rename on
// either side passed both suites green.
//
// Verified when this was written, against a real gateway process on the null
// connector: 8/8 checks pass, and renaming INSTANCE_NOT_CONNECTED to
// INSTANCE_OFFLINE in the gateway turns it red — while both repositories'
// own suites stay green. That is the whole argument for the job.
//
// These tests pin the things that rot quietly: whether the check is still
// wired into CI, and whether it still refuses to pass without contacting a
// real gateway.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const script = fs.readFileSync(path.join(ROOT, 'scripts', 'assert-gateway-seam.js'), 'utf8');
const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

describe('the gateway seam check is wired into CI', () => {
  it('runs as a step', () => {
    expect(workflow).toContain('scripts/assert-gateway-seam.js');
  });

  it('checks out the real gateway repository to run against', () => {
    expect(workflow).toContain('repository: abhishek21lift-oss/619-erp-whatsapp');
  });

  it('pins the gateway branch rather than assuming main', () => {
    // Its default branch is feature/whatsapp-gateway-mvp. Assuming `main`
    // would check out nothing and the job would fail for the wrong reason.
    expect(workflow).toContain('ref: feature/whatsapp-gateway-mvp');
  });

  it('runs the gateway on the null connector, so no WhatsApp account is needed', () => {
    expect(workflow).toMatch(/WA_CONNECTOR:\s*'null'/);
  });

  it('gives the gateway the Redis it stores its send ledger in', () => {
    expect(workflow).toContain('redis:7-alpine');
  });

  it('fails loudly if the gateway never becomes healthy', () => {
    // A job that proceeded with a dead gateway would report the contract
    // broken when the truth is that nothing was listening.
    expect(workflow).toContain('the gateway never became healthy');
  });
});

describe('the seam check cannot pass without a real gateway', () => {
  it('exits non-zero when the gateway URL or key is missing', () => {
    expect(script).toContain('WA_GATEWAY_URL and WA_GATEWAY_KEY must both be set');
    expect(script).toMatch(/process\.exit\(1\)/);
  });

  it('says why it refuses to mock the thing under test', () => {
    expect(script).toContain('mocking the thing under test is what created the gap');
  });

  it('refuses a suite that has shrunk', () => {
    expect(script).toMatch(/checks\.length < 8/);
  });

  it('asserts the exact error code transport.js branches on', () => {
    // transport.js maps INSTANCE_NOT_CONNECTED to SendStatus.NOT_CONNECTED.
    // If the gateway renames it the fallthrough is FAILED — still not SENT,
    // but the studio loses "your WhatsApp is not connected" as the reason.
    expect(script).toContain('INSTANCE_NOT_CONNECTED');
    const transport = fs.readFileSync(
      path.join(ROOT, 'src', 'modules', 'messaging', 'transport.js'), 'utf8',
    );
    expect(transport).toContain('INSTANCE_NOT_CONNECTED');
  });

  it('asserts the error envelope shape the client actually parses', () => {
    const client = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'whatsappGateway.js'), 'utf8');
    expect(client).toContain('data.error.code');
    expect(script).toContain('data.error.code');
  });

  it('proves the cross-tenant refusal is not vacuous', () => {
    // An isolation test that only ever asserts failure passes just as well
    // when the instance does not exist at all.
    expect(script).toContain('the isolation test is not vacuous');
  });

  it('requires the non-disclosing code for a cross-tenant attempt', () => {
    // NOT_FOUND rather than FORBIDDEN: a distinct code would let a caller
    // probe which instance ids exist.
    expect(script).toContain('INSTANCE_NOT_FOUND');
    expect(script).toContain('non-disclosing');
  });
});
