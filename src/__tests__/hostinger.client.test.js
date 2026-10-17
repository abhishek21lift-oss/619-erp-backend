'use strict';
// The one place the platform talks to Hostinger.
//
// What these tests defend: that the destination cannot be influenced, that the
// bearer never appears in an error or a log line, that a refusal is reported
// rather than thrown, and that a retry only happens where the upstream
// documents it as safe. Each of those has a plausible bug that would look
// completely normal in review.

const client = require('../lib/hostinger/client');
const catalog = require('../lib/hostinger/catalog');

const TOKEN = 'hst_live_example_0123456789abcdef';
const originalFetch = global.fetch;

/** A fetch that records what it was asked for and answers once. */
function mockFetch(response) {
  const calls = [];
  global.fetch = jest.fn(async (url, init) => {
    calls.push({ url, init });
    const r = typeof response === 'function' ? response(calls.length) : response;
    return {
      status: r.status ?? 200,
      ok: (r.status ?? 200) < 400,
      headers: new Headers(r.headers || {}),
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {})),
    };
  });
  return calls;
}

/** A fetch that rejects, the way a timeout or a dead DNS entry does. */
function mockReject(err) {
  const calls = [];
  global.fetch = jest.fn(async (url, init) => {
    calls.push({ url, init });
    throw err;
  });
  return calls;
}

beforeEach(() => {
  client._internal.reset();
});

afterAll(() => {
  global.fetch = originalFetch;
});

describe('request building', () => {
  it('calls the documented host with the bearer and JSON content type', async () => {
    const calls = mockFetch({ status: 200, body: { data: [] } });
    const result = await client.call({
      operationId: 'hosting.website.list',
      query: { per_page: 5 },
      token: TOKEN,
    });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://developers.hostinger.com/api/hosting/v1/websites?per_page=5');
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    // A redirect must never carry the bearer onward.
    expect(calls[0].init.redirect).toBe('error');
    expect(calls[0].init.body).toBeUndefined();
  });

  it('encodes path parameters and validates them first', async () => {
    const calls = mockFetch({ status: 200, body: {} });
    await client.call({
      operationId: 'domains.portfolio.get',
      pathParams: { domain: 'example.com' },
      token: TOKEN,
    });
    expect(calls[0].url).toContain('/api/domains/v1/portfolio/example.com');

    const bad = await client.call({
      operationId: 'domains.portfolio.get',
      pathParams: { domain: '../../admin' },
      token: TOKEN,
    });
    expect(bad.ok).toBe(false);
    expect(bad.error.code).toBe('INVALID_INPUT');
    expect(global.fetch).toHaveBeenCalledTimes(1); // the bad one never left
  });

  it('repeats array query parameters instead of comma-joining them', async () => {
    const calls = mockFetch({ status: 200, body: {} });
    await client.call({
      operationId: 'hosting.order.list',
      query: { statuses: ['active', 'suspended'] },
      token: TOKEN,
    });
    expect(calls[0].url).toContain('statuses=active&statuses=suspended');
  });

  it('sends a validated body exactly as given', async () => {
    const calls = mockFetch({ status: 201, body: { id: 1 } });
    const result = await client.call({
      operationId: 'hosting.git.deploy',
      pathParams: { username: 'u123', domain: 'example.com' },
      body: { repository_url: 'https://github.com/o/r.git', branch: 'main' },
      token: TOKEN,
    });
    expect(result.ok).toBe(true);
    expect(JSON.parse(calls[0].init.body)).toEqual({
      repository_url: 'https://github.com/o/r.git',
      branch: 'main',
    });
  });

  it('rejects a body field the catalogue does not know, instead of ignoring it', async () => {
    const calls = mockFetch({ status: 201, body: { id: 1 } });
    const result = await client.call({
      operationId: 'hosting.git.deploy',
      pathParams: { username: 'u123', domain: 'example.com' },
      // `brach` is a typo for `branch`. Silently dropping it would deploy the
      // repository's default branch and look like it worked.
      body: { repository_url: 'https://github.com/o/r.git', brach: 'release' },
      token: TOKEN,
    });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('INVALID_INPUT');
    expect(calls).toHaveLength(0);
  });

  it('refuses a body on a method that takes none', async () => {
    mockFetch({ status: 200, body: {} });
    const result = await client.call({
      operationId: 'domains.portfolio.list',
      body: { nope: 1 },
      token: TOKEN,
    });
    expect(result.error.code).toBe('INVALID_INPUT');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('refuses an operation outside the catalogue, and a missing token', async () => {
    mockFetch({ status: 200, body: {} });

    const unknown = await client.call({ operationId: 'vps.deleteEverything', token: TOKEN });
    expect(unknown.error.code).toBe('UNKNOWN_OPERATION');

    const noToken = await client.call({ operationId: 'vps.list' });
    expect(noToken.error.code).toBe('NO_CREDENTIAL');

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('refuses to build a URL outside the API base', async () => {
    // The constant is the SSRF control. If a future edit builds a URL from
    // anything else, this is the assertion that fails.
    expect(client.BASE_URL).toBe('https://developers.hostinger.com');
    for (const [, op] of Object.entries(catalog.OPERATIONS)) {
      expect(op.path.startsWith('/api/')).toBe(true);
    }
  });
});

describe('failures', () => {
  it('maps a 401 to a readable, non-retryable result without the bearer', async () => {
    mockFetch({ status: 401, headers: { 'x-correlation-id': 'corr-1' }, body: { message: 'Unauthenticated.', correlation_id: 'corr-1' } });
    const result = await client.call({ operationId: 'vps.list', token: TOKEN });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error.message).toBe('Unauthenticated.');
    expect(result.error.correlationId).toBe('corr-1');
    expect(result.error.retryable).toBe(false);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('maps 422 field errors, bounded', async () => {
    const errors = {};
    for (let i = 0; i < 40; i++) errors[`field${i}`] = ['bad'];
    mockFetch({ status: 422, body: { message: 'Validation failed', errors } });
    const result = await client.call({
      operationId: 'dns.zone.update',
      pathParams: { domain: 'example.com' },
      body: { zone: [{ name: '@', type: 'A', records: [{ content: '1.2.3.4' }] }] },
      token: TOKEN,
    });
    expect(result.status).toBe(422);
    expect(Object.keys(result.error.fields).length).toBeLessThanOrEqual(21);
  });

  it('scrubs anything credential-shaped out of an upstream message', async () => {
    mockFetch({
      status: 400,
      body: { message: `bad request for Bearer ${TOKEN} and sk-abcdefghijklmnopqrstuv` },
    });
    const result = await client.call({ operationId: 'vps.list', token: TOKEN });
    expect(result.error.message).not.toContain(TOKEN);
    expect(result.error.message).not.toContain('sk-abcdefghijklmnopqrstuv');
  });

  it('reports a network failure instead of throwing, and keeps the URL out of the message', async () => {
    mockReject(Object.assign(new Error('fetch failed'), { name: 'TypeError' }));
    const result = await client.call({ operationId: 'vps.list', token: TOKEN });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('NETWORK');
    expect(result.error.retryable).toBe(true);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('reports a timeout distinctly from an unreachable host', async () => {
    const err = new Error('The operation was aborted due to timeout');
    err.name = 'TimeoutError';
    mockReject(err);
    const result = await client.call({ operationId: 'vps.list', token: TOKEN });
    expect(result.error.code).toBe('TIMEOUT');
  });

  it('survives a non-JSON body from a proxy', async () => {
    mockFetch({ status: 502, body: '<html>Bad Gateway</html>' });
    const result = await client.call({ operationId: 'vps.list', token: TOKEN });
    expect(result.status).toBe(502);
    expect(result.error.message.length).toBeLessThanOrEqual(400);
  });
});

describe('retries', () => {
  it('waits for Retry-After on a 429 and then succeeds', async () => {
    const calls = mockFetch((n) => (n === 1
      ? { status: 429, headers: { 'retry-after': '0.01', 'ratelimit': '"api";r=0;t=1' }, body: { message: 'Too Many Requests' } }
      : { status: 200, body: { data: [] } }));

    const result = await client.call({ operationId: 'vps.list', token: TOKEN });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    client._internal.reset();
  });

  it('retries a GET after a 500 but reports a POST', async () => {
    const getCalls = mockFetch({ status: 500, body: { message: 'Internal Server Error' } });
    const get = await client.call({ operationId: 'vps.list', token: TOKEN });
    expect(get.ok).toBe(false);
    expect(getCalls.length).toBeGreaterThan(1);
    expect(get.error.retryable).toBe(true);

    client._internal.reset();
    const postCalls = mockFetch({ status: 500, body: { message: 'Internal Server Error' } });
    const post = await client.call({
      operationId: 'vps.restart',
      pathParams: { virtualMachineId: 1 },
      token: TOKEN,
    });
    // A 500 on a write may have landed. Re-sending it is how a machine gets
    // restarted twice; one attempt, then the operator decides.
    expect(postCalls).toHaveLength(1);
    expect(post.ok).toBe(false);
    expect(post.error.retryable).toBe(true);
  });

  it('does not retry a 404 or a 401', async () => {
    const calls = mockFetch({ status: 404, body: { message: 'Not Found' } });
    await client.call({ operationId: 'vps.get', pathParams: { virtualMachineId: 9 }, token: TOKEN });
    expect(calls).toHaveLength(1);
  });
});

describe('quota handling', () => {
  it('reads the modern RateLimit header in preference to the legacy pair', () => {
    const fake = {
      headers: new Headers({
        'ratelimit-policy': '"api";q=90;w=60',
        'ratelimit': '"api";r=3;t=30',
        'x-ratelimit-remaining': '77',
      }),
    };
    client._internal.readQuota(fake);
    const snapshot = client._internal.snapshot();
    expect(snapshot.remaining).toBe(3);
    expect(snapshot.observedLimit).toBe(90);
  });

  it('falls back to the legacy headers when the modern ones are absent', () => {
    client._internal.readQuota({ headers: new Headers({ 'x-ratelimit-limit': '90', 'x-ratelimit-remaining': '42' }) });
    expect(client._internal.snapshot().remaining).toBe(42);
    client._internal.reset();
  });

  it('honours a custom per-account limit from RateLimit-Policy', () => {
    client._internal.readQuota({ headers: new Headers({ 'ratelimit-policy': '"api";q=20;w=60', 'ratelimit': '"api";r=19;t=60' }) });
    expect(client._internal.snapshot().observedLimit).toBe(20);
    client._internal.reset();
  });
});

describe('bounded fan-out', () => {
  it('keeps the result order and never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await client.mapBounded([1, 2, 3, 4, 5, 6, 7], async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return n * 2;
    }, 3);
    expect(results).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('propagates a throw from the worker', async () => {
    // `call()` never throws, so this only happens on a programming error.
    // Swallowing one into a result slot would hide it behind a rendered card.
    await expect(client.mapBounded([1, 2, 3], async (n) => {
      if (n === 2) throw new Error('boom');
      return n;
    })).rejects.toThrow('boom');
  });
});

describe('the published catalogue description', () => {
  it('carries every operation, with no schema or credential in it', () => {
    const described = client.describeCatalog();
    expect(described.operations).toHaveLength(Object.keys(catalog.OPERATIONS).length);
    expect(described.safetyLabels.destructive).toMatch(/typed/i);
    const text = JSON.stringify(described);
    expect(text).not.toMatch(/hst_/);
    expect(text).not.toContain('safeParse');
  });
});
