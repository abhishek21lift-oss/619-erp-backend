'use strict';
/**
 * COMPATIBILITY.md is a promise; this keeps it one.
 *
 * ── Why a document needs a test ────────────────────────────────────────────
 *
 * The contract matrix is the only place that says which builds of the backend,
 * the frontend and the gateway are a set. A matrix that has drifted from the
 * code is worse than none at all: it is consulted during an incident, believed,
 * and acted on. TENANT-RLS-PLAN.md had already drifted this way once — it
 * described a rollout step as pending that had shipped — which is what makes
 * this a real failure mode here rather than a hypothetical one.
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const COMPAT = fs.readFileSync(path.join(root, 'COMPATIBILITY.md'), 'utf8');
const {
  API_CONTRACT_VERSION, MIN_GATEWAY_CONTRACT, isContractCompatible, releaseInfo,
} = require('../lib/release');

describe('the document matches the code', () => {
  it('states this backend\'s contract number', () => {
    expect(COMPAT).toMatch(new RegExp(`backend \\\\| \`contract: ${API_CONTRACT_VERSION}\``));
  });

  it('states what this backend requires of the gateway', () => {
    expect(COMPAT).toMatch(new RegExp(`gateway \`>= ${MIN_GATEWAY_CONTRACT}\``));
  });

  it('names where each service reports itself', () => {
    // The endpoints an operator is told to curl during an incident. A wrong
    // path here costs the minutes that matter most.
    expect(COMPAT).toMatch(/GET `?\/api\/health`?/);
    expect(COMPAT).toMatch(/GET `?\/healthz`?/);
    expect(COMPAT).toMatch(/x-app-version/);
  });
});

describe('the compatibility rule', () => {
  it('accepts a peer at or above the floor', () => {
    expect(isContractCompatible(1, 1)).toBe(true);
    expect(isContractCompatible(2, 1)).toBe(true);
  });

  it('refuses a peer below it', () => {
    expect(isContractCompatible(0, 1)).toBe(false);
  });

  // The case that decides whether this check works at all. Every service
  // reported no contract before release.js existed, so treating absence as
  // "probably current" would pass on exactly the builds this exists to catch.
  it('refuses a peer that reports no contract at all', () => {
    expect(isContractCompatible(undefined, 1)).toBe(false);
    expect(isContractCompatible(null, 1)).toBe(false);
    expect(isContractCompatible('1', 1)).toBe(false);
    expect(isContractCompatible(NaN, 1)).toBe(false);
  });
});

describe('the release payload carries what a deployment check reads', () => {
  it('declares its own contract and what it needs from the gateway', () => {
    const info = releaseInfo();
    expect(info.contract).toBe(API_CONTRACT_VERSION);
    expect(info.minGatewayContract).toBe(MIN_GATEWAY_CONTRACT);
  });
});

describe('the seam check actually checks the contract', () => {
  const seam = fs.readFileSync(path.join(root, 'scripts', 'assert-gateway-seam.js'), 'utf8');

  it('asserts BOTH directions, not just one', () => {
    // A one-way check is half a contract. The gateway declares the oldest
    // backend it can serve, and a backend below that floor fails at runtime in
    // ways that look like intermittent errors rather than a version mismatch.
    expect(seam).toMatch(/speaks a contract this backend can talk to/);
    expect(seam).toMatch(/this backend speaks a contract the gateway can serve/);
    expect(seam).toMatch(/minBackendContract/);
  });

  it('raised its vacuity floor to cover the new checks', () => {
    // The suite refuses to report success if it has shrunk. Adding checks
    // without raising the floor would let all three new ones be deleted
    // silently.
    expect(seam).toMatch(/checks\.length < 11/);
  });
});

describe('deployment verification exists in both workflows', () => {
  const backendDeploy = fs.readFileSync(path.join(root, '.github', 'workflows', 'deploy.yml'), 'utf8');

  it('the backend refuses to record a deploy it cannot confirm is serving', () => {
    // `docker compose up -d` returning 0 means a container STARTED. It does not
    // mean it is serving, and it does not mean it is serving the new code.
    expect(backendDeploy).toMatch(/deploy verification failed/);
    expect(backendDeploy).toMatch(/SERVING/);
    // The marker file must not advance past a failed verification — it is what
    // names the last commit known to have actually served traffic.
    expect(backendDeploy).toMatch(/rm -f [^\n]*\.backend-deployed-sha\.new/);
  });
});
