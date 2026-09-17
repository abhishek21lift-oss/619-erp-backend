'use strict';
// Correlation that actually correlates, and a release you can name.
//
// ── What was there ─────────────────────────────────────────────────────────
//
// middleware/requestId.js minted a uuid, set `req.id` and echoed an
// x-request-id header. Correct, and nearly useless on its own: `req.id`
// appeared in exactly ONE log statement in the whole application — the access
// log in server.js. Every line that says WHY a request behaved as it did was
// written through a logger that had never heard of it, so a support question
// about one member's failed payment could be answered with "a request finished
// and returned 500" and nothing else.
//
// And no build identity existed anywhere. GET / returned a hardcoded '3.0.0'
// that no deploy had ever changed, because nothing wrote it — so "is the fix
// deployed?" could only be answered by triggering the bug again.

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';

const { Writable } = require('stream');
const express = require('express');
const request = require('supertest');

const {
  runWithRequestContext, currentRequestId, setRequestContext,
} = require('../lib/request-context');
const { releaseInfo, releaseLogLine, normalizeSha } = require('../lib/release');
const requestId = require('../middleware/requestId');

/**
 * A pino logger built exactly like lib/logger.js, writing to an array.
 *
 * Rebuilt here rather than capturing the app's logger because the real one is
 * a module-level singleton bound to stdout and the Command Center ring. The
 * thing under test is the mixin's behaviour, and this shares it by
 * construction — it reads the same request-context module the real one does.
 */
function capturingLogger() {
  const pino = require('pino');
  const lines = [];
  const sink = new Writable({
    write(chunk, _enc, cb) { lines.push(JSON.parse(String(chunk))); cb(); },
  });
  const logger = pino({
    level: 'trace',
    mixin: () => {
      const { currentRequestContext } = require('../lib/request-context');
      const ctx = currentRequestContext();
      if (!ctx) return {};
      const fields = { req_id: ctx.requestId };
      if (ctx.actor) fields.actor = ctx.actor;
      if (ctx.org) fields.org = ctx.org;
      return fields;
    },
  }, sink);
  return { logger, lines };
}

describe('the correlation id reaches every log line, not one', () => {
  it('appears on a line written by a plain logger call', () => {
    const { logger, lines } = capturingLogger();

    runWithRequestContext({ requestId: 'req-1' }, () => logger.info('something happened'));

    expect(lines[0].req_id).toBe('req-1');
  });

  it('appears on a line written by a CHILD logger', () => {
    // The reason this is a mixin and not a wrapper around logger.info: a large
    // part of this codebase logs through `logger.child({...})`, and wrapping
    // the top-level methods would have missed all of it.
    const { logger, lines } = capturingLogger();

    runWithRequestContext({ requestId: 'req-2' }, () =>
      logger.child({ operation: 'whatsapp.send' }).warn('gateway refused'));

    expect(lines[0]).toMatchObject({ req_id: 'req-2', operation: 'whatsapp.send' });
  });

  it('survives awaits, which is the whole reason it is AsyncLocalStorage', async () => {
    // A plain variable would be correct up to the first await and wrong after
    // it, under any concurrency at all.
    const { logger, lines } = capturingLogger();

    await runWithRequestContext({ requestId: 'req-3' }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      await Promise.resolve();
      logger.info('after two awaits');
    });

    expect(lines[0].req_id).toBe('req-3');
  });

  it('keeps two concurrent requests apart', async () => {
    const { logger, lines } = capturingLogger();

    await Promise.all([
      runWithRequestContext({ requestId: 'req-A' }, async () => {
        await new Promise((r) => setTimeout(r, 10));
        logger.info('A finishing late');
      }),
      runWithRequestContext({ requestId: 'req-B' }, async () => {
        logger.info('B finishing first');
      }),
    ]);

    const byMessage = Object.fromEntries(lines.map((l) => [l.msg, l.req_id]));
    expect(byMessage['A finishing late']).toBe('req-A');
    expect(byMessage['B finishing first']).toBe('req-B');
  });

  it('is absent, not wrong, outside a request', () => {
    // Boot, cron and a bare worker have no request. An id invented for them
    // would look like a trace that could be followed and could not be.
    const { logger, lines } = capturingLogger();
    logger.info('boot');
    expect(lines[0].req_id).toBeUndefined();
  });
});

describe('the actor is added once known, and is only an id', () => {
  it('names the actor on lines written after authentication', () => {
    const { logger, lines } = capturingLogger();

    runWithRequestContext({ requestId: 'req-4' }, () => {
      logger.info('before auth');
      setRequestContext({ actor: 'user-123', org: 'org-9' });
      logger.info('after auth');
    });

    expect(lines[0].actor).toBeUndefined();
    expect(lines[1]).toMatchObject({ req_id: 'req-4', actor: 'user-123', org: 'org-9' });
  });

  it('carries no name, email or phone — ever', () => {
    // logger.js redacts these wherever they appear in request bodies, because
    // they kept arriving that way. Putting them back deliberately on every
    // line, as a convenience, would quietly undo that.
    const authSrc = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'middleware', 'auth.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    const call = authSrc.match(/setRequestContext\(\{[^}]*\}\)/);
    expect(call).not.toBeNull();
    expect(call[0]).not.toMatch(/name|email|mobile|phone/);
  });

  it('does not throw when there is no context to update', () => {
    // A worker calling this should have nothing to update, not crash.
    expect(() => setRequestContext({ actor: 'x' })).not.toThrow();
  });
});

describe('the middleware', () => {
  const buildApp = () => {
    const app = express();
    app.use(requestId);
    app.get('/thing', (req, res) => res.json({ seen: currentRequestId(), onReq: req.id }));
    return app;
  };

  it('opens the context around the rest of the request', async () => {
    const res = await request(buildApp()).get('/thing');
    // The handler ran INSIDE the context — that is what next() being called
    // inside runWithRequestContext buys, and what was missing before.
    expect(res.body.seen).toBe(res.body.onReq);
    expect(res.body.seen).toBe(res.headers['x-request-id']);
  });

  it('continues a trace the caller started', async () => {
    const res = await request(buildApp()).get('/thing').set('x-request-id', 'frontend-abc-1');
    expect(res.body.seen).toBe('frontend-abc-1');
  });

  it('refuses a hostile inbound id rather than logging it', async () => {
    // It lands in every log line downstream. A header from outside does not
    // get to put newlines or arbitrary text there.
    const res = await request(buildApp()).get('/thing').set('x-request-id', 'bad id with spaces');
    expect(res.body.seen).not.toBe('bad id with spaces');
    expect(res.body.seen).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('bounds an absurdly long inbound id', async () => {
    const res = await request(buildApp()).get('/thing').set('x-request-id', 'a'.repeat(5000));
    expect(res.body.seen.length).toBeLessThanOrEqual(128);
  });
});

describe('release identity', () => {
  it('reports the fields a deployment check needs', () => {
    expect(releaseInfo()).toMatchObject({
      service: 'backend',
      version: expect.any(String),
      sha: expect.any(String),
      contract: expect.any(Number),
    });
  });

  it('reports "unknown" rather than inventing a sha', () => {
    // A locally built image genuinely has no commit. Making one up — a
    // timestamp, or package.json's version relabelled — would put a value that
    // looks authoritative next to ones that are.
    expect(normalizeSha('')).toBe('unknown');
    expect(normalizeSha(undefined)).toBe('unknown');
    expect(normalizeSha('not-a-sha')).toBe('unknown');
  });

  it('rejects an unsubstituted build argument', () => {
    // The single most likely wrong value to arrive here, and it would
    // otherwise be reported as a commit.
    expect(normalizeSha('${GIT_SHA}')).toBe('unknown');
  });

  it('accepts short and full shas, normalised', () => {
    expect(normalizeSha('7B02267')).toBe('7b02267');
    expect(normalizeSha('7b02267dd09309019e90f6d1e148620c98e94f8c'))
      .toBe('7b02267dd09309019e90f6d1e148620c98e94f8c');
  });

  it('exposes no secrets', () => {
    // It goes on an unauthenticated health endpoint and on every response
    // header. Everything sitting next to it in process.env must not follow.
    const serialised = JSON.stringify(releaseInfo()) + JSON.stringify(releaseLogLine());
    expect(serialised).not.toMatch(/DATABASE_URL|JWT_SECRET|password|postgres:\/\//i);
  });
});

describe('the build plumbing that makes sha real in production', () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..', '..');
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

  // Each of these links is silent when broken: the sha simply reports
  // "unknown" forever, on precisely the machine where the answer matters.
  it('the Dockerfile takes the sha as a build arg and bakes it in', () => {
    const dockerfile = read('Dockerfile');
    expect(dockerfile).toMatch(/ARG GIT_SHA/);
    expect(dockerfile).toMatch(/GIT_SHA=\$GIT_SHA/);
  });

  it('compose passes it to the api AND the worker', () => {
    const compose = read('docker-compose.yml');
    const argBlocks = compose.match(/GIT_SHA: \$\{GIT_SHA:-unknown\}/g) || [];
    expect(argBlocks.length).toBe(2);
  });

  it('the deploy workflow exports it before building', () => {
    // The sha was already resolved here and written to a file that nothing the
    // running container could read. This is what connects the two.
    const deploy = read('.github/workflows/deploy.yml');
    expect(deploy).toMatch(/export GIT_SHA=/);
    expect(deploy).toMatch(/export GIT_SHA=[\s\S]{0,200}docker compose build/);
  });
});

describe('queue work is attributable to the request that caused it', () => {
  const { withJobContext } = require('../workers/jobContext');

  it('re-opens the enqueuing request\'s context inside the processor', async () => {
    // The gap this closes: a request's context ends with its response, and
    // most of what this platform DOES happens after that, on a worker.
    let seen;
    const processor = withJobContext('whatsapp', async () => { seen = currentRequestId(); });

    await processor({ id: '1', data: { requestId: 'req-from-http', orgId: 'org-1' } });

    expect(seen).toBe('req-from-http');
  });

  it('gives scheduled work an id of its own rather than none', async () => {
    // The nightly sweep has no originating request and never will. One id per
    // run still lets a single pass be read end to end.
    let seen;
    const processor = withJobContext('automation-sweep', async () => { seen = currentRequestId(); });

    await processor({ id: '77', data: {} });

    expect(seen).toBe('job:automation-sweep:77');
  });

  it('every worker wraps its processor', () => {
    // Source-level, because the risk is a SEVENTH worker added later without
    // it — which no test of the existing six would notice.
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '..', 'workers');

    const workers = fs.readdirSync(dir).filter((f) => f.endsWith('.worker.js'));
    expect(workers.length).toBeGreaterThanOrEqual(6);

    for (const file of workers) {
      const src = fs.readFileSync(path.join(dir, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (!/new Worker\(/.test(src)) continue;
      expect([file, /new Worker\([^,]+,\s*withJobContext\(/.test(src)]).toEqual([file, true]);
    }
  });
});
