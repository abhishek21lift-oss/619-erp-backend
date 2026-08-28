// Why passkey enrolment fails silently, and the four functions that decide it.
//
// A wrong rpId is the worst-behaved bug in this route. /register/options
// returns 200, a challenge lands in webauthn_challenges, the request log looks
// perfect — and the browser refuses to sign, reporting that to nobody but the
// person holding the phone. The database state after a total failure is
// identical to the state after a successful first step, which is exactly what
// happened in production: two registration challenges written, zero
// credentials, zero errors anywhere on this side.
//
// So these are pinned as pure functions. Everything here is about agreeing with
// a rule the browser enforces and we cannot see.
// db/pool exits the process when DATABASE_URL is unset, and requiring the route
// requires the pool. Nothing here opens a connection — the four functions under
// test never touch it — so a syntactically valid URL pointing nowhere is enough.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';

const {
  isRegistrableSuffix, getEffectiveRpId, getExpectedOrigin, signedChallenge,
} = require('../routes/auth-webauthn');

const req = (headers = {}) => ({ headers, secure: true });

const KEYS = ['RP_ID', 'WEBAUTHN_ORIGIN', 'FRONTEND_URL'];
const ENV = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
beforeEach(() => { for (const k of KEYS) delete process.env[k]; });
afterAll(() => {
  for (const k of KEYS) {
    if (ENV[k] === undefined) delete process.env[k]; else process.env[k] = ENV[k];
  }
});

describe('isRegistrableSuffix', () => {
  it('accepts the exact host and its subdomains', () => {
    expect(isRegistrableSuffix('example.com', 'example.com')).toBe(true);
    expect(isRegistrableSuffix('example.com', 'app.example.com')).toBe(true);
    expect(isRegistrableSuffix('example.com', 'a.b.example.com')).toBe(true);
  });

  it('is not endsWith', () => {
    // The reason this is a function and not a `.endsWith()` call at the call
    // site. Without the dot boundary, a passkey minted for "myexample.com"
    // would be accepted for "example.com".
    expect(isRegistrableSuffix('example.com', 'myexample.com')).toBe(false);
    expect(isRegistrableSuffix('fitnessstudio.com', 'my619fitnessstudio.com')).toBe(false);
  });

  it('rejects the other direction', () => {
    // A subdomain rpId on a parent-domain page: the browser refuses this, and
    // "api.example.com" as RP_ID while the app is served from "example.com" is
    // an easy mistake to make.
    expect(isRegistrableSuffix('app.example.com', 'example.com')).toBe(false);
  });

  it('rejects missing values rather than guessing', () => {
    expect(isRegistrableSuffix(null, 'example.com')).toBe(false);
    expect(isRegistrableSuffix('example.com', null)).toBe(false);
  });
});

describe('getEffectiveRpId', () => {
  it('uses RP_ID when the browser could accept it', () => {
    process.env.RP_ID = 'example.com';
    expect(getEffectiveRpId(req({ origin: 'https://app.example.com' }))).toBe('example.com');
  });

  it('drops an RP_ID the browser is certain to reject, for FRONTEND_URL', () => {
    // The production failure: RP_ID left pointing at a previous domain after a
    // rebrand. Honouring it means every enrolment fails with SecurityError and
    // no log line on this side, so it is not an operator preference worth
    // keeping — it is an outage. The replacement comes from FRONTEND_URL, not
    // from the request.
    process.env.RP_ID = '619fitnessstudio.com';
    process.env.FRONTEND_URL = 'https://myptstudio.in';
    expect(getEffectiveRpId(req({ origin: 'https://myptstudio.in' }))).toBe('myptstudio.in');
  });

  it('never takes the rpId from a request header when config is available', () => {
    // The whole reason FRONTEND_URL is the fallback. A header is chosen by
    // whoever is calling; if a stale RP_ID meant "believe the caller", any
    // origin able to reach this route could pick the domain a credential gets
    // minted for. FRONTEND_URL is required config and is nobody's to set.
    process.env.RP_ID = 'example.com';
    process.env.FRONTEND_URL = 'https://app.example.com';
    expect(getEffectiveRpId(req({ origin: 'https://evil.test' }))).toBe('app.example.com');
  });

  it('keeps RP_ID when there is no host to check it against', () => {
    process.env.RP_ID = 'example.com';
    expect(getEffectiveRpId(req({}))).toBe('example.com');
  });

  it('uses FRONTEND_URL when RP_ID was never set', () => {
    // The likelier production state of the two: RP_ID is only a "recommended"
    // env var, so a deployment that never set it used to fall all the way
    // through to the request headers — or to literal 'localhost'.
    process.env.FRONTEND_URL = 'https://app.example.com/';
    expect(getEffectiveRpId(req({ origin: 'https://app.example.com' }))).toBe('app.example.com');
    expect(getEffectiveRpId(req({}))).toBe('app.example.com');
  });

  it('accepts a subdomain of the configured rpId', () => {
    process.env.RP_ID = 'example.com';
    process.env.FRONTEND_URL = 'https://example.com';
    expect(getEffectiveRpId(req({ origin: 'https://studio.example.com' }))).toBe('example.com');
  });

  describe('reading the host, when there is no FRONTEND_URL (local dev only)', () => {
    it('prefers Origin over the forwarded host', () => {
      // Origin is the browser's own account of the page. x-forwarded-host is a
      // proxy's, and a proxy can be wrong about which name the client used.
      expect(getEffectiveRpId(req({
        origin: 'https://app.example.com',
        'x-forwarded-host': 'internal.lan',
      }))).toBe('app.example.com');
    });

    it('falls back to x-forwarded-host when the proxy dropped Origin', () => {
      expect(getEffectiveRpId(req({ 'x-forwarded-host': 'app.example.com' }))).toBe('app.example.com');
    });

    it('takes the first entry of a comma-joined forwarded host and drops the port', () => {
      expect(getEffectiveRpId(req({ 'x-forwarded-host': 'app.example.com:443, proxy.internal' })))
        .toBe('app.example.com');
    });

    it('uses Host when nothing else is present', () => {
      expect(getEffectiveRpId(req({ host: 'app.example.com' }))).toBe('app.example.com');
    });

    it('survives a malformed Origin instead of throwing', () => {
      expect(getEffectiveRpId(req({ origin: 'not a url', host: 'app.example.com' })))
        .toBe('app.example.com');
    });

    it('stays on localhost for local development', () => {
      expect(getEffectiveRpId(req({ origin: 'http://localhost:3000' }))).toBe('localhost');
      expect(getEffectiveRpId(req({}))).toBe('localhost');
    });
  });
});

describe('getExpectedOrigin', () => {
  beforeEach(() => { process.env.FRONTEND_URL = 'https://app.example.com'; });

  it('returns the configured origin when it is the one being used', () => {
    // Plus its www-toggled sibling: withWwwSibling runs over the accepted
    // list unconditionally, closing the same apex/www gap regardless of
    // whether the origin came from WEBAUTHN_ORIGIN or the request.
    process.env.RP_ID = 'example.com';
    process.env.WEBAUTHN_ORIGIN = 'https://app.example.com';
    expect(getExpectedOrigin(req({ origin: 'https://app.example.com' })))
      .toEqual(['https://app.example.com', 'https://www.app.example.com']);
  });

  it('accepts a second domain on the same rpId that WEBAUTHN_ORIGIN forgot', () => {
    // Not a hole. The browser only signs for an rpId that is a registrable
    // suffix of the page, so an origin passing that same test is one the
    // browser already vetted; nothing gets in that the rpId check was keeping
    // out. What it prevents is a single-valued WEBAUTHN_ORIGIN breaking
    // verification the day a second hostname is pointed at this API.
    process.env.RP_ID = 'example.com';
    process.env.WEBAUTHN_ORIGIN = 'https://app.example.com';
    const out = getExpectedOrigin(req({ origin: 'https://studio.example.com' }));
    expect(out).toEqual([
      'https://app.example.com', 'https://www.app.example.com',
      'https://studio.example.com', 'https://www.studio.example.com',
    ]);
  });

  it('does not accept an origin that fails the rpId test', () => {
    // The guard on the paragraph above, and the case that caught the first
    // version of this change: with the rpId taken from the request, evil.test
    // vouched for itself and then passed its own test.
    process.env.RP_ID = 'example.com';
    process.env.WEBAUTHN_ORIGIN = 'https://app.example.com';
    expect(getExpectedOrigin(req({ origin: 'https://evil.test' })))
      .toEqual(['https://app.example.com', 'https://www.app.example.com']);
  });

  it('reconstructs the origin from forwarded headers when Origin is absent', () => {
    expect(getExpectedOrigin(req({
      'x-forwarded-host': 'app.example.com', 'x-forwarded-proto': 'https',
    }))).toEqual(['https://app.example.com', 'https://www.app.example.com']);
  });

  it('falls back to the rpId when there is nothing to go on', () => {
    process.env.RP_ID = 'example.com';
    process.env.FRONTEND_URL = 'https://example.com';
    expect(getExpectedOrigin(req({})))
      .toEqual(['https://example.com', 'https://www.example.com']);
    delete process.env.RP_ID;
    delete process.env.FRONTEND_URL;
    expect(getExpectedOrigin(req({})))
      .toEqual(['http://localhost:3000', 'http://www.localhost:3000']);
  });
});

describe('signedChallenge', () => {
  const wrap = (clientData) => ({
    response: { clientDataJSON: Buffer.from(JSON.stringify(clientData)).toString('base64url') },
  });

  it('reads back the challenge the authenticator actually signed', () => {
    expect(signedChallenge(wrap({
      type: 'webauthn.create', challenge: 'DTMfXwul1f9MA6mV', origin: 'https://example.com',
    }))).toBe('DTMfXwul1f9MA6mV');
  });

  it('returns null rather than throwing on anything unreadable', () => {
    // A null here means "fall back to the newest challenge for this user",
    // which is what every path did unconditionally before — so a client that
    // sends something unparseable is no worse off than it used to be.
    expect(signedChallenge(undefined)).toBeNull();
    expect(signedChallenge({})).toBeNull();
    expect(signedChallenge({ response: {} })).toBeNull();
    expect(signedChallenge({ response: { clientDataJSON: 42 } })).toBeNull();
    expect(signedChallenge({ response: { clientDataJSON: '!!!not base64!!!' } })).toBeNull();
    expect(signedChallenge(wrap({ type: 'webauthn.create' }))).toBeNull();
  });
});
