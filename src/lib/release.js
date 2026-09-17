'use strict';
// src/lib/release.js
//
// Which build is this, exactly.
//
// ── What the platform could answer before ──────────────────────────────────
//
// Nothing. There was no GIT_SHA, no APP_VERSION, no build timestamp anywhere
// in the backend, the frontend or the gateway. `GET /` returned a hardcoded
// `version: '3.0.0'` string that had not changed across hundreds of deploys
// and could not, because nothing wrote it.
//
// That makes two ordinary questions unanswerable on a live system:
//
//   · "is the fix deployed?" — the only way to know was to trigger the bug
//     again and watch;
//   · "do these three services agree?" — the backend, the frontend and the
//     WhatsApp gateway deploy from three repositories on three workflows, and
//     nothing anywhere recorded which commit of each was live at once. A
//     rollback therefore could not restore a known-good SET, only a guess per
//     service.
//
// ── The contract ───────────────────────────────────────────────────────────
//
// `sha` is the deployed commit. It comes from the build, not from the running
// container's filesystem: a production image contains no .git directory, so
// anything that shells out to `git rev-parse` at runtime returns "unknown" on
// exactly the machine where the answer matters. The Dockerfile takes it as a
// build ARG and bakes it into an ENV.
//
// `unknown` is a real, reportable value and never an error. A locally built
// image genuinely does not have a sha, and pretending otherwise — inventing a
// timestamp, reading package.json's version and calling it a commit — would
// put a value that looks authoritative next to one that is.

const os = require('os');

/** package.json's version. The human-facing release number. */
function packageVersion() {
  try {
    return require('../../package.json').version || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Trim and validate a commit sha.
 *
 * A short sha is fine, an empty string is not, and neither is the literal
 * "${GIT_SHA}" — which is what an unsubstituted build arg looks like and is
 * the single most likely wrong value to reach here.
 */
function normalizeSha(raw) {
  const sha = String(raw || '').trim();
  if (!sha || sha.includes('$') || !/^[0-9a-f]{7,40}$/i.test(sha)) return 'unknown';
  return sha.toLowerCase();
}

const release = Object.freeze({
  service: 'backend',
  version: packageVersion(),
  sha: normalizeSha(process.env.GIT_SHA || process.env.SOURCE_COMMIT),
  // ISO-8601 from the build. Not the process start time, which is what a
  // restart would make it look like — "deployed 4 minutes ago" after a crash
  // loop is worse than no answer.
  builtAt: process.env.BUILD_TIME || null,
  node: process.version,
  env: process.env.NODE_ENV || 'development',
});

/**
 * The compatibility contract this service speaks.
 *
 * Separate from `version` on purpose, and the reason is what it is FOR. A
 * patch release changes `version` and breaks nothing; this number changes only
 * when the HTTP surface between services changes in a way that requires the
 * other side to move with it. The frontend and the gateway compare against
 * this, not against a semver string they would then have to parse rules out of.
 *
 * Bump it when, and only when, a change would break a caller running the
 * previous release: a removed or renamed field, a narrowed type, a new
 * required request field, a changed error code.
 */
const API_CONTRACT_VERSION = 1;

/**
 * Everything a health payload or a deployment check needs, as plain data.
 *
 * Deliberately contains no environment variable values, no connection details
 * and no hostnames beyond the container's own — a release identity is safe to
 * expose, and the things that sit next to it in process.env are not.
 */
function releaseInfo() {
  return {
    ...release,
    contract: API_CONTRACT_VERSION,
    // Useful when several containers serve one service and only one is wrong.
    instance: os.hostname(),
  };
}

/** One line for the boot log, so `docker logs` answers "what is running". */
function releaseLogLine() {
  const info = releaseInfo();
  return {
    service: info.service,
    version: info.version,
    sha: info.sha,
    contract: info.contract,
    built_at: info.builtAt,
    node: info.node,
    env: info.env,
  };
}

module.exports = { releaseInfo, releaseLogLine, normalizeSha, API_CONTRACT_VERSION };
