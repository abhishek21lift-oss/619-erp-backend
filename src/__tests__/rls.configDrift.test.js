'use strict';
/**
 * The RLS cutover, as a contract across code, compose and the env reference.
 *
 * ── The drift this exists to stop ──────────────────────────────────────────
 *
 * Tenant isolation depends on two environment variables reaching two
 * containers, and on an operator knowing they exist. Every one of those links
 * has already broken once on this platform:
 *
 *   · the boot guard in server.js read TENANT_RLS_ENFORCE for truthiness while
 *     db/pool.js compared it to the string 'off' — they disagreed in both
 *     directions, and the production default was the silent one;
 *   · ADMIN_DATABASE_URL was absent from docker-compose.yml, so setting it in
 *     the box's .env did nothing at all, which looks identical to never having
 *     set it;
 *   · .env.example — the only file an operator reads before a deploy — did not
 *     name either variable, so the cutover had no documented procedure outside
 *     a design document in the migrations directory.
 *
 * None of those produce an error. They produce a platform that reports
 * isolation it does not have, which is the single worst outcome available
 * here. So each link is asserted rather than trusted.
 *
 * This file cannot see the compose file or the .env on the VPS. It verifies
 * the ones in this repository, which is what review and CI can reach — and
 * db/rlsPreflight.js covers the rest by asking the running database directly
 * instead of believing any of these files.
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const ENV_EXAMPLE = read('.env.example');
const COMPOSE = read('docker-compose.yml');

/** The variables the posture depends on. Both, in both containers. */
const RLS_ENV_VARS = ['TENANT_RLS_ENFORCE', 'ADMIN_DATABASE_URL'];

describe('.env.example documents the cutover', () => {
  it.each(RLS_ENV_VARS)('names %s', (name) => {
    expect(ENV_EXAMPLE).toContain(name);
  });

  it('documents all three postures the code implements', () => {
    // Read out of the flag module rather than hardcoded here, so adding a
    // fourth posture without documenting it fails this test instead of
    // shipping an undocumented mode.
    const flagSrc = read('src/lib/tenantRlsFlag.js');
    const postures = ['off', 'on', 'strict'];

    for (const posture of postures) {
      expect(flagSrc).toContain(posture);
      // The env reference has to explain each one, not merely mention it.
      expect(ENV_EXAMPLE).toMatch(new RegExp(`^#\\s+${posture}\\s`, 'm'));
    }
  });

  it('states the ordering constraint that makes the cutover safe', () => {
    // ADMIN_DATABASE_URL first, DATABASE_URL second. The other order takes
    // every worker, migration and operator screen to empty results with no
    // error anywhere, because platform-wide work matches no tenant policy.
    expect(ENV_EXAMPLE).toMatch(/ADMIN_DATABASE_URL[\s\S]{0,400}?Do this first/);
  });

  it('tells the operator how to read the posture off a running box', () => {
    expect(ENV_EXAMPLE).toMatch(/\/api\/health/);
    expect(ENV_EXAMPLE).toMatch(/rls_posture_degraded|rls_posture_verified/);
  });
});

describe('docker-compose passes the variables to every process that needs them', () => {
  /**
   * The environment block of one service.
   *
   * Parsed by slicing between service keys rather than with a YAML library:
   * this repo has no YAML dependency, and the question — does this variable
   * appear inside this service's block — is answerable from the text. A
   * variable set on `api` but not `worker` is the exact failure being tested,
   * so the two blocks must be read separately.
   */
  function serviceBlock(name) {
    const start = COMPOSE.indexOf(`\n  ${name}:`);
    expect(start).toBeGreaterThan(-1);
    const rest = COMPOSE.slice(start + 1);
    const nextService = rest.slice(1).search(/\n {2}[a-z0-9_-]+:\n/);
    return nextService === -1 ? rest : rest.slice(0, nextService + 1);
  }

  // The worker matters at least as much as the api. After the cutover a worker
  // still connecting as app_tenant with no request context has no org id, so
  // it matches no policy and every scheduled job reads nothing — the sweep
  // finds no expiring memberships and reports success.
  it.each(['api', 'worker'])('service %s receives both variables', (service) => {
    const block = serviceBlock(service);
    for (const name of RLS_ENV_VARS) {
      expect(block).toContain(`${name}:`);
    }
  });

  it('passes them through from the host environment rather than hardcoding', () => {
    for (const name of RLS_ENV_VARS) {
      // `${VAR:-}` or `${VAR}` — either is a pass-through. A literal value
      // committed here would override the box's .env and be invisible to the
      // operator changing it.
      expect(COMPOSE).toMatch(new RegExp(`${name}:\\s*\\$\\{${name}(:-[^}]*)?\\}`));
    }
  });
});

describe('the flag module is the only place the posture is decided', () => {
  it('no file re-implements the TENANT_RLS_ENFORCE comparison', () => {
    // The original bug: three files, three copies, one of them wrong. Anything
    // that reads the variable directly instead of importing the predicate is a
    // fourth copy waiting to disagree.
    const srcDir = path.join(root, 'src');
    const offenders = [];

    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.js')) continue;
        // The flag module defines it; the tests assert on it.
        if (full.endsWith(path.join('lib', 'tenantRlsFlag.js'))) continue;
        if (full.includes(`${path.sep}__tests__${path.sep}`)) continue;

        const text = fs.readFileSync(full, 'utf8');
        // Strip block and line comments: several files explain the flag at
        // length, and an explanation naming it is not a second implementation.
        // This is the trap a source-text test walks into if it reads raw.
        const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        if (/process\.env\.TENANT_RLS_ENFORCE/.test(code)) {
          offenders.push(path.relative(root, full));
        }
      }
    };
    walk(srcDir);

    expect(offenders).toEqual([]);
  });
});
