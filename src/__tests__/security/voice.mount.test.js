// The voice router's SERVER MOUNT, not its handlers.
//
// voice.authz.test.js drives the router directly, which is the right way to
// test what the handlers do — but mounting it directly also means those tests
// would keep passing if server.js dropped `requireStaff` from the mount, or
// mounted the router on an unauthenticated path, or forgot the rate limiter.
//
// The router applies auth + requireStaff itself, so the mount is defence in
// depth rather than the only gate. This file exists so that the depth cannot
// be quietly removed: a voice surface reachable from a locked phone should
// have to survive somebody deleting one line in either place.
//
// Asserted by reading server.js rather than booting it — the real server opens
// Postgres, Redis and a queue on import, none of which exist in a unit test,
// and the property being checked is a static one about how the route is wired.

'use strict';

const fs = require('fs');
const path = require('path');

const serverSrc = fs.readFileSync(
  path.join(__dirname, '..', '..', 'server.js'),
  'utf8'
);

/** The single `app.use('/api/voice', …)` line. */
const mountLine = serverSrc
  .split('\n')
  .find((l) => l.includes("app.use('/api/voice'"));

describe('the /api/voice mount', () => {
  test('exists exactly once', () => {
    const mounts = serverSrc
      .split('\n')
      .filter((l) => l.includes("app.use('/api/voice'"));
    expect(mounts).toHaveLength(1);
  });

  test('is behind auth', () => {
    expect(mountLine).toMatch(/\bauth\b/);
  });

  test('is behind requireStaff', () => {
    // The escalation this stops: `member` is the role client activation gives
    // a gym client, and the roster size is studio-wide staff data.
    expect(mountLine).toMatch(/requireStaff/);
  });

  test('is rate limited per user, not per IP', () => {
    // A phone on cellular shares an egress IP with the whole carrier, so an
    // IP-keyed limit would let one device throttle unrelated studios.
    expect(mountLine).toMatch(/userApiLimiter/);
  });
});
