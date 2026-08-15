// Production must not start with a security control switched off.
//
// TENANT_RLS_ENFORCE, PLATFORM_SESSION_ENFORCE and SUPER_ADMIN_REQUIRE_MFA
// each ship dark behind an env flag so they can be rolled out deliberately.
// Every read of them is an exact `=== 'on'` comparison, which is the right
// strictness: a typo, an empty string, "true", "1" or "ON" must all read as
// OFF rather than be coerced into ON by a truthiness check.
//
// The gap was that nothing noticed when they were off. The process booted
// clean and served traffic with all three silently disabled. This asserts the
// startup guard that closes it, and — just as importantly — that the strict
// comparison was not quietly relaxed into Boolean()/!!/?? while adding it,
// which would turn "TENANT_RLS_ENFORCE=off" into an enabled control.
//
// The guard is asserted by reading server.js rather than by booting it: the
// module opens a database pool, a Redis connection and five BullMQ queues at
// require() time, none of which exist in CI. Same reasoning as
// tenantScope.convention.test.js next door — a static check catches this
// before merge instead of after it ships.
'use strict';

const fs = require('fs');
const path = require('path');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

const FLAGS = [
  'TENANT_RLS_ENFORCE',
  'PLATFORM_SESSION_ENFORCE',
  'SUPER_ADMIN_REQUIRE_MFA',
];

describe('production refuses to start with a security control disabled', () => {
  test('all three flags are named in the startup guard', () => {
    const guard = SECURITY_FLAGS_BLOCK();
    for (const flag of FLAGS) {
      expect(guard).toContain(flag);
    }
  });

  test('the guard is fatal, not a warning', () => {
    // A warning is what the old behaviour effectively was: the log line
    // scrolled past and the process served traffic anyway.
    const guard = GUARD_BLOCK();
    expect(guard).toMatch(/logger\.fatal/);
    expect(guard).toMatch(/process\.exit\(1\)/);
  });

  test('the guard applies to production only, so dev and CI still run unset', () => {
    expect(GUARD_BLOCK()).toMatch(/if \(isProd\)/);
  });

  test('the guard tests for exactly "on", never a truthiness coercion', () => {
    const guard = GUARD_BLOCK();
    expect(guard).toMatch(/!== 'on'/);
    // The specific relaxations that would silently re-open the control.
    expect(guard).not.toMatch(/Boolean\(/);
    expect(guard).not.toMatch(/!!/);
    expect(guard).not.toMatch(/\?\?/);
  });

  test('the failure message names the control without printing any value', () => {
    const guard = GUARD_BLOCK();
    // It reports the flag NAME and what it protects…
    expect(guard).toMatch(/protects/);
    // …and never interpolates the env value itself into the log.
    expect(guard).not.toMatch(/process\.env\[[^\]]+\]\s*\}/);
  });
});

describe('the strict comparison at every point of use is preserved', () => {
  const files = [
    'middleware/auth.js',
    'middleware/platformAuth.js',
    'middleware/tenant.js',
    'db/pool.js',
  ];

  it.each(files)('%s reads its flag with === \'on\'', (rel) => {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    const used = FLAGS.filter((f) => src.includes(`process.env.${f}`));
    expect(used.length).toBeGreaterThan(0);
    for (const flag of used) {
      // Every read of the flag in this file compares it to the exact string.
      const reads = src.match(new RegExp(`process\\.env\\.${flag}[^\\n]*`, 'g')) || [];
      for (const read of reads) {
        expect(read).toMatch(/===\s*'on'/);
      }
    }
  });
});

/** The SECURITY_FLAGS table in server.js. */
function SECURITY_FLAGS_BLOCK() {
  const start = SERVER.indexOf('const SECURITY_FLAGS');
  expect(start).toBeGreaterThan(-1);
  return SERVER.slice(start, SERVER.indexOf('];', start));
}

/** The `if (isProd) { ... }` guard that consumes it. */
function GUARD_BLOCK() {
  const start = SERVER.indexOf('const SECURITY_FLAGS');
  expect(start).toBeGreaterThan(-1);
  // Through to the end of the guard's process.exit branch.
  const end = SERVER.indexOf('process.exit(1);', SERVER.indexOf('if (isProd)', start));
  expect(end).toBeGreaterThan(start);
  return SERVER.slice(start, end + 'process.exit(1);'.length);
}
