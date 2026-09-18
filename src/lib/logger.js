const pino = require('pino');

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProd = NODE_ENV === 'production';

// ── Command Center log capture (Phase 8, decision D4) ───────────────────────
//
// Every line still goes to stdout exactly as before, and now additionally to an
// in-memory ring the console tails; lines at `error` and above are also batched
// into `system_logs`. Docker keeps collecting stdout, so `docker logs` is
// unaffected — this adds a reader, it does not move the output.
//
// Implemented as a pino multistream rather than by wrapping the logger's
// methods. Wrapping would miss anything logging through a child logger or
// through pino directly, and would put a function call in front of every log
// statement in the app. A second stream is the mechanism pino provides for
// exactly this, and it cannot change what stdout receives.
//
// This REPLACES the previous dev-only `transport: pino/file → fd 1`: pino
// cannot combine a transport with a custom destination, and that transport was
// writing to stdout anyway, so the output is unchanged either way.
//
// LOG_CAPTURE=off restores the original single-stream logger. This is the most
// widely required module in the app, and a change here should be revertible by
// an environment variable rather than a deploy.
const captureEnabled = process.env.LOG_CAPTURE !== 'off';

// ── Correlation, applied to every line rather than to one ──────────────────
//
// pino calls `mixin` for each log statement and merges the result in. Reading
// the request context here is what turns a correlation id from a header into
// something that actually correlates: every logger.info() in every route,
// service, library and child logger gains `req_id` without one call site
// changing. req.id existed before this and appeared in exactly ONE log line in
// the whole application — the access log — so the lines that say WHY a request
// failed could not be tied to it or to each other.
//
// Required at module scope, and it has to be. The first draft required it
// lazily inside the function to avoid a load-order dependency — but a mixin
// runs on EVERY log line, so that put a module lookup in the hottest path in
// the application, and under Jest it threw outright: a line logged after a
// test file's registry is torn down cannot require anything, so every late log
// statement raised "require after teardown" behind the catch below.
//
// There was never a cycle to avoid. request-context.js imports async_hooks and
// nothing else — in particular it does not import this file, which is the only
// thing that would have made a top-level import unsafe.
//
// The catch stays. A logger that can throw while formatting a line turns a
// diagnosable incident into a silent one, which is the opposite of the job.
const { currentRequestContext } = require('./request-context');

function correlationMixin() {
  try {
    const ctx = currentRequestContext();
    if (!ctx) return {};
    // `actor` is a user id. Never a name, never an email — see redact below,
    // which exists because PII kept arriving through request bodies.
    const fields = { req_id: ctx.requestId };
    if (ctx.actor) fields.actor = ctx.actor;
    if (ctx.org) fields.org = ctx.org;
    return fields;
  } catch {
    return {};
  }
}

const options = {
  level: process.env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
  mixin: correlationMixin,
  // Stamped on every line so a log aggregator can filter one deploy from the
  // next without joining against anything. Read once — it cannot change while
  // the process runs.
  base: (() => {
    try {
      const { releaseInfo } = require('./release');
      const info = releaseInfo();
      return { pid: process.pid, hostname: info.instance, service: info.service, sha: info.sha };
    } catch {
      return undefined;
    }
  })(),
  redact: {
    paths: [
      'req.headers.authorization', 'req.headers.cookie',
      'body.password', 'body.currentPassword', 'body.newPassword', 'body.token',
      // L-04: redact PII fields that appear in request bodies and nested objects
      'body.email', 'body.mobile', 'body.phone', 'body.face_descriptor',
      '*.email', '*.mobile', '*.phone', '*.face_descriptor',
    ],
    censor: '[REDACTED]',
  },
  serializers: {
    req: (r) => ({
      method: r.method,
      url: r.url,
      query: r.query,
    }),
    res: (r) => ({
      statusCode: r.statusCode,
    }),
    err: pino.stdSerializers.err,
  },
};

let logger;

if (captureEnabled) {
  // Required here rather than at the top of the file to keep the dependency
  // one-way: logCapture reaches db/pool only inside its flush, which runs on a
  // timer long after this module has loaded. Requiring the pool at module scope
  // would be a cycle, because the pool logs.
  const { stream: captureStream } = require('../modules/command-center/logCapture');
  logger = pino(options, pino.multistream([
    { level: 'trace', stream: process.stdout },
    { level: 'trace', stream: captureStream },
  ]));
} else {
  logger = pino({
    ...options,
    transport: isProd ? undefined : { target: 'pino/file', options: { destination: 1 } },
  });
}

module.exports = logger;
