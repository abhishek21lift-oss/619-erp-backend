// Production must not start with a security control switched off.
//
// TENANT_RLS_ENFORCE, PLATFORM_SESSION_ENFORCE and SUPER_ADMIN_REQUIRE_MFA
// each ship behind an env flag so they can be rolled out deliberately.
// SECURITY FIX: These now DEFAULT TO ON in production for security.
// Explicitly set to 'off' to disable (staged rollout only).
// Every read of them is an exact `!== 'off'` comparison, which is the right
// strictness: a typo, an empty string, "true", "1" or "ON" must all read as
// ON rather than be coerced into OFF by a truthiness check.
//
// The guard validates:
// - Invalid values (anything other than 'on' or 'off') cause fatal startup error
// - Explicit 'off' is allowed but warned (for staged rollout only)
// - Unset defaults to 'on' (secure default)
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

describe('production refuses to start with an INVALID security control value', () => {
  test('all three flags are named in the startup validation', () => {
    const guard = GUARD_BLOCK();
    for (const flag of FLAGS) {
      expect(guard).toContain(flag);
    }
  });

  test('the guard is fatal for invalid values, not a warning', () => {
    const guard = GUARD_BLOCK();
    expect(guard).toMatch(/logger\.fatal/);
    expect(guard).toMatch(/process\.exit\(1\)/);
  });

  test('the guard applies to production only, so dev and CI still run unset', () => {
    expect(GUARD_BLOCK()).toMatch(/if \(isProd\)/);
  });

  test('the guard tests for exactly "on" or "off", never a truthiness coercion', () => {
    const guard = GUARD_BLOCK();
    // Should check for invalid values (not 'on' and not 'off')
    expect(guard).toMatch(/val !== 'on' && val !== 'off'/);
    // The specific relaxations that would silently re-open the control.
    expect(guard).not.toMatch(/Boolean\(/);
    expect(guard).not.toMatch(/!!/);
    expect(guard).not.toMatch(/\?\?/);
  });

  test('explicit "off" is warned but allowed (for staged rollout)', () => {
    // The warn block is in the if (isProd) block after the invalid check
    // It's not in GUARD_BLOCK which stops at the first process.exit(1)
    const fullBlock = SERVER.slice(
      SERVER.indexOf('const SECURITY_FLAGS'),
      SERVER.indexOf('const express', SERVER.indexOf('const SECURITY_FLAGS'))
    );
    expect(fullBlock).toMatch(/logger\.warn/);
    expect(fullBlock).toMatch(/disabled.*via env/);
    // Should not exit for explicit 'off'
    const warnBlock = SERVER.slice(
      SERVER.indexOf('const disabled = SECURITY_FLAGS'),
      SERVER.indexOf('const express', SERVER.indexOf('const disabled = SECURITY_FLAGS'))
    );
    expect(warnBlock).not.toMatch(/process\.exit\(1\)/);
  });
});

describe('the strict comparison at every point of use is preserved (secure default: ON)', () => {
  const files = [
    'middleware/auth.js',
    'middleware/platformAuth.js',
    'middleware/tenant.js',
    'db/pool.js',
  ];

  it.each(files)('%s reads its flag with !== \'off\' (defaults ON)', (rel) => {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    const used = FLAGS.filter((f) => src.includes(`process.env.${f}`));
    expect(used.length).toBeGreaterThan(0);
    for (const flag of used) {
      // Every read of the flag in this file compares it to the exact string.
      const reads = src.match(new RegExp(`process\\.env\\.${flag}[^\\n]*`, 'g')) || [];
      for (const read of reads) {
        expect(read).toMatch(/!==\s*'off'/);
      }
    }
  });
});

/** The `if (isProd) { ... }` guard that consumes it. */
function GUARD_BLOCK() {
  const start = SERVER.indexOf('const SECURITY_FLAGS');
  expect(start).toBeGreaterThan(-1);
  // Through to the end of the guard's process.exit branch.
  const end = SERVER.indexOf('process.exit(1);', SERVER.indexOf('if (isProd)', start));
  expect(end).toBeGreaterThan(start);
  return SERVER.slice(start, end + 'process.exit(1);'.length);
}
