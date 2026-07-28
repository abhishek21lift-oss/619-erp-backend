// src/server.js
// MY PT STUDIO API — consolidated v2 + v3 entry point
// ───────────────────────────────────────────────────
// STARTUP ENV CHECKS — fail fast with clear messages
// ───────────────────────────────────────────────────
// Initialise error monitoring before anything else so Sentry can
// auto-instrument Express/pg. No-op unless SENTRY_DSN is set.
const Sentry = require('./instrument');
require('dotenv').config();

const logger = require('./lib/logger');

// Define isProd early — used in env checks below and throughout the file
const isProd = (process.env.NODE_ENV || 'development') === 'production';

const REQUIRED_ENV = ['DATABASE_URL', 'JWT_SECRET', 'FRONTEND_URL'];
const missing = REQUIRED_ENV.filter(function(k) { return !process.env[k]; });
if (missing.length) {
  logger.fatal({ missing }, 'Missing required environment variables');
  console.error('  Set them in your .env file or your Render dashboard.');
  process.exit(1);
}

if (process.env.JWT_SECRET.length < 32) {
  logger.fatal('JWT_SECRET is too short (minimum 32 characters). Use a strong random secret (96 hex chars recommended).');
  process.exit(1);
}

// Warn about missing recommended (non-fatal) vars so ops teams notice early.
// SUPABASE_URL / SUPABASE_SERVICE_KEY were removed from this list: no code
// path reads either one (the app reaches Postgres solely via DATABASE_URL +
// pg), so warning about them only pushed operators to provision a
// service_role key — which bypasses RLS entirely — that nothing consumes.
const RECOMMENDED_ENV = [
  'RP_ID',
  'WEBAUTHN_ORIGIN',
];
const missingRecommended = RECOMMENDED_ENV.filter(function(k) { return !process.env[k]; });
if (missingRecommended.length) {
  logger.warn({ missing: missingRecommended }, 'Recommended env vars not set — some features may be degraded');
}

// ── Cloudflare R2 object storage ────────────────────────────────────────────
// lib/fileStorage.js falls back to local disk whenever R2 is not fully
// configured. On Render the filesystem is ephemeral, so that fallback silently
// destroys every uploaded file — signed consent PDFs, PAR-Q forms, avatars —
// on the next deploy or restart, with nothing in the logs to show for it.
//
// Partial configuration is always a mistake, so it is fatal in every
// environment. A complete absence of R2 config is fatal in production only,
// where the ephemeral-disk fallback is never the intended behaviour; local dev
// keeps working on disk untouched.
const R2_VARS = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
const r2Set = R2_VARS.filter(function(k) { return Boolean(process.env[k]); });

if (r2Set.length > 0 && r2Set.length < R2_VARS.length) {
  logger.fatal(
    { set: r2Set, missing: R2_VARS.filter(function(k) { return !process.env[k]; }) },
    'R2 object storage is partially configured — uploads would silently fall back to ephemeral local disk. Set all three R2 variables, or none.'
  );
  process.exit(1);
}

if (isProd && r2Set.length === 0) {
  logger.fatal(
    { required: R2_VARS },
    'R2 object storage is not configured in production — uploaded consent PDFs, PAR-Q forms and avatars would be written to ephemeral disk and lost on every deploy.'
  );
  process.exit(1);
}

const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit     = require('express-rate-limit');
const cookieParser  = require('cookie-parser');

const { errorHandler, notFound } = require('./middleware/errorHandler');
const { auth, adminOnly }        = require('./middleware/auth');
const { requireSuperAdmin, requireSuperAdminMfa } = require('./middleware/tenant');
const { branchScope }            = require('./middleware/branch-scope');
const { requireFeature }         = require('./lib/features');

// Feature gating for tenant-facing routers.
//
// requireFeature() reads req.user, so it MUST run after auth — mounted before
// it, the guard sees no user and returns next(), enforcing nothing while
// looking wired. Most routers apply auth per-route rather than globally, so
// the gate brings its own. auth is stateless (verify token, load user) and
// safe to run twice.
//
// Only non-core, sellable capabilities are gated. Deliberately NOT gated:
// auth, subscription and payments (a studio must always be able to sign in
// and pay, whatever else is switched off), clients and sessions (is_core in
// the registry, never disableable), and anything whose feature key does not
// map cleanly to a whole mount.
//
// Every feature currently seeds default_enabled = true with no plan gating,
// so this changes nothing for anyone until an operator turns something off in
// the Control Centre — which is the point of the toggle existing.
const gate = (key) => [auth, requireFeature(key)];

const app  = express();
const PORT = Number(process.env.PORT) || 5000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Behind Render / Vercel / Cloudflare — trust the proxy hops in front of us so
// req.ip is the real client and rate-limit keys aren't bucketed to one IP.
//
// The correct value is the NUMBER OF PROXIES in front of this process, and it
// depends on the deployment topology: Render alone is 1, Cloudflare in front of
// Render is 2. Setting it too low makes req.ip an infrastructure address, which
// collapses every caller into a single rate-limit bucket and neuters the login
// brute-force protection below. Overridable so the value can match the actual
// topology without a code change; verify by logging req.ip in production and
// confirming it matches real client addresses.
const TRUST_PROXY = (() => {
  const raw = (process.env.TRUST_PROXY || '').trim();
  if (!raw) return 1;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : raw; // number of hops, or an express-compatible string
})();
app.set('trust proxy', TRUST_PROXY);
app.disable('x-powered-by');

// ────────────────────────
// SECURITY
// ────────────────────────
app.use(helmet({
  // H-01: strict CSP for a JSON API (no scripts/styles served here)
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'none'"],
      scriptSrc:      ["'none'"],
      styleSrc:       ["'none'"],
      imgSrc:         ["'self'"],
      connectSrc:     ["'self'"],
      frameAncestors: ["'none'"],
      formAction:     ["'none'"],
    },
  },
  crossOriginResourcePolicy: { policy: 'same-origin' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
}));

// ────────────────────────
// CORS
// ────────────────────────
function validOrigin(origin) {
  if (!origin) return null;
  const trimmed = origin.trim();
  try {
    const url = new URL(trimmed);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('invalid protocol');
    return url.origin;
  } catch {
    logger.warn({ origin: trimmed }, 'Ignoring invalid CORS origin');
    return null;
  }
}

const allowedOrigins = [
  ...(process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map(validOrigin) : []),
  validOrigin(process.env.FRONTEND_URL),
  // M-04: localhost only allowed in development — not in production builds
  ...(!isProd ? ['http://localhost:3000', 'http://127.0.0.1:3000'] : []),
].filter(Boolean);

app.use(cors({
  origin: function(origin, cb) {
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    logger.warn({ origin }, 'CORS blocked origin');
    return cb(new Error('CORS: origin not allowed'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  // x-org-id lets a platform super_admin scope requests to one tenant org
  // (the org-switcher). It is ignored for every non-super_admin (tenant users
  // are always locked to their JWT org — see lib/tenant-db.js), so allowing it
  // through CORS cannot widen any tenant user's access.
  allowedHeaders: ['Content-Type', 'Authorization', 'x-org-id'],
}));

// ────────────────────────
// RAZORPAY WEBHOOK (raw body — must be before json middleware)
// ────────────────────────
// H-06: route registers its own express.raw() parser so signature can be verified
app.use('/api/webhooks/razorpay', require('./routes/razorpay-webhook'));

// ────────────────────────
// BODY PARSING
// ────────────────────────
// L-06: 100kb default
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));
app.use(cookieParser());
app.use('/uploads', require('./routes/uploads'));

// ────────────────────────
// ORIGIN / REFERER CHECK (defense-in-depth)
// ────────────────────────
const { originCheck } = require('./middleware/originCheck');
app.use('/api/', originCheck);

// ────────────────────────
// INPUT SANITIZATION
// ────────────────────────
const { sanitizeBody, sanitizeQuery } = require('./middleware/sanitize');
app.use(sanitizeBody);
app.use(sanitizeQuery);

// ────────────────────────
// REQUEST ID
// ────────────────────────
const requestId = require('./middleware/requestId');
app.use(requestId);

// ────────────────────────
// STRUCTURED REQUEST LOGGER
// ────────────────────────
app.use(function(req, res, next) {
  const start = Date.now();
  res.on('finish', function() {
    const ms = Date.now() - start;
    if (req.path.startsWith('/api/')) {
      logger.info({
        method: req.method,
        url: req.originalUrl,
        status: res.statusCode,
        ms: ms,
        req_id: req.id,
        query: Object.keys(req.query).length ? req.query : undefined,
      }, '%s %s %d %dms', req.method, req.originalUrl, res.statusCode, ms);
    }
  });
  next();
});

// ────────────────────────
// HEALTH CHECK
// ────────────────────────
app.get('/', function(req, res) {
  res.json({ status: 'ok', app: 'MY PT STUDIO API', version: '3.0.0' });
});

app.get('/api/health', async function(req, res) {
  try {
    const pool = require('./db/pool');
    await pool.query('SELECT 1');
    res.json({ status: 'ok', version: 'v3', time: new Date().toISOString(), db: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'error', db: 'disconnected', error: err.message });
  }
});



// ────────────────────────
// RATE LIMITING
// ────────────────────────
// Global IP-based limiter (catches unauthenticated traffic)
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isProd ? 2000 : 5000,
  standardHeaders: true,
  legacyHeaders: false,
});

// M-05: per-user limiter applied after auth so shared IPs don't block each other
const userApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? req.ip,
  skip: (req) => !req.user,
  message: { error: 'Too many requests. Please slow down.' },
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please wait 15 minutes.' },
});

const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many account creation attempts. Please wait 15 minutes.' },
});

app.use('/api/', apiLimiter);
app.use('/api/auth/login',          loginLimiter);
app.use('/api/v1/auth/login',       loginLimiter);
app.use('/api/auth/google-login',   loginLimiter);
app.use('/api/v1/auth/google-login',loginLimiter);
app.use('/api/v1/auth/forgot-password', registerLimiter);
app.use('/api/v1/auth/reset-password',  registerLimiter);
app.use('/api/auth/create-user', registerLimiter);
app.use('/api/auth/users',      registerLimiter);
app.use('/api/auth/forgot-password', registerLimiter);
app.use('/api/auth/reset-password',  registerLimiter);
app.use('/api/v1/auth/refresh',      loginLimiter);
app.use('/api/auth/refresh',         loginLimiter);

// ────────────────────────
// BRANCH SCOPE (ISSUE-004)
// Must run AFTER auth middleware (so req.user is set) but BEFORE route handlers.
// branchScope is safe to apply globally — it is a no-op when req.user is absent
// or when the user has no branch_id (single-branch / legacy installs).
// TODO: downstream route handlers should append req.branchScope.sql / params to
//       multi-branch-aware queries once branch_id columns are fully populated.
// ────────────────────────
app.use('/api/', branchScope);

// ────────────────────────
// v2 ROUTES (production)
// ────────────────────────

// ROUTE INTEGRITY NOTE (R-01):
// /api/auth and /api/v1/auth both mount the same router intentionally.
// /api/v1/auth exists for legacy mobile app callers. Any changes to auth
// behaviour must be tested against both URL prefixes.
// Unauthenticated marketing data (plan catalogue + platform aggregates) for the
// public landing page. Aggregate-only — no per-tenant values are exposed.
app.use('/api/public',            require('./routes/public'));

app.use('/api/auth',              require('./routes/auth'));
app.use('/api/auth',              require('./routes/auth-google'));
app.use('/api/auth/webauthn',     require('./routes/auth-webauthn'));
app.use('/api/v1/auth',           require('./routes/auth'));
app.use('/api/v1/auth',           require('./routes/auth-google'));
app.use('/api/v1/auth/webauthn',  require('./routes/auth-webauthn'));
app.use('/api/profile',           require('./routes/profile'));
// Read-only: the caller's own studio's feature flags. Additive — nothing that
// existed before this route consults it (see lib/features.js).
app.use('/api/features',          require('./routes/features'));
app.use('/api/subscription',      require('./routes/subscription'));
// Global top-nav search. Carries its own rate limiter (see routes/search.js),
// so it is deliberately NOT wrapped in userApiLimiter — debounced typing would
// otherwise consume the shared per-user budget that real API calls need.
app.use('/api/search',            require('./routes/search'));

// ROUTE INTEGRITY NOTE (R-02):
// /api/clients mounts two separate routers. Express resolves in registration
// order — if both files define the same METHOD+PATH, client-actions.js will
// be shadowed. Audit both files for overlapping routes before adding new ones.
app.use('/api/clients',           userApiLimiter, require('./routes/clients'));
app.use('/api/clients',           userApiLimiter, require('./routes/client-actions'));

app.use('/api/trainers',          require('./routes/trainers'));
// Manual UTR verification payments. MUST be mounted before the finance ledger
// router below: that one owns DELETE /:id and a bare /:id would otherwise
// swallow /api/payments/upi/... before this router ever sees it.
app.use('/api/payments/upi',      userApiLimiter, require('./routes/upi-payments'));
app.use('/api/payments',          userApiLimiter, require('./routes/payments'));
app.use('/api/attendance',        ...gate('attendance'), require('./routes/attendance'));

// ROUTE INTEGRITY NOTE (R-03):
// Legacy /api/reports (routes/reports.js) and v3 /api/v1/reports
// (modules/reports) coexist. Frontend pages must call the correct version.
// New pages should use /api/v1/reports. Do not add endpoints to the legacy
// router — it will be removed once all consumers are migrated.
app.use('/api/reports',           userApiLimiter, ...gate('insights'), require('./routes/reports'));

app.use('/api/plans',             ...gate('packages'), require('./routes/plans'));
app.use('/api/leave',             require('./routes/leave'));
app.use('/api/expenses',          ...gate('finance'), require('./routes/expenses'));

// ROUTE INTEGRITY NOTE (R-03 / bookings):
// /api/bookings and /api/v1/bookings both mount the same router.
// Same policy as auth: legacy callers use /api/bookings, new callers use /api/v1/bookings.
app.use('/api/v1/bookings',       require('./modules/bookings/bookings.routes'));
app.use('/api/bookings',          require('./modules/bookings/bookings.routes'));

// FIX (Route Integrity R-10):
// /api/admin previously relied solely on individual route handlers to apply
// auth + adminOnly middleware. This left the mount unguarded — any handler
// that forgot to include the middleware chain would be publicly accessible.
// We now enforce auth + adminOnly at the mount level as defense-in-depth.
// Individual handlers may still include the middleware; it is a no-op.
app.use('/api/admin',             auth, adminOnly, require('./routes/admin-reset'));

// Platform Super Admin portal (multi-tenant SaaS). Guarded at the mount with
// auth + requireSuperAdmin — inaccessible to tenant admins and everyone else.
app.use('/api/super-admin',       auth, requireSuperAdmin, requireSuperAdminMfa, require('./modules/platform/super-admin.routes'));

app.use('/api/modules',           require('./modules/operations/operations.routes'));

// ────────────────────────
// PREMIUM FEATURE ROUTES (v4)
// ────────────────────────
app.use('/api/calendar',          require('./routes/calendar'));
app.use('/api/qr',               ...gate('attendance'), require('./routes/qr-checkin'));
app.use('/api/settings',          require('./routes/settings'));
app.use('/api/invoices',          ...gate('finance'), require('./routes/invoices'));
app.use('/api/workouts',          ...gate('programs'), require('./routes/workouts'));
app.use('/api/diet',              require('./routes/diet'));
app.use('/api/biometric-attend',  ...gate('attendance'), require('./routes/biometric-attend'));
app.use('/api/webauthn',          require('./routes/webauthn'));
app.use('/api/integrations',      ...gate('integrations'), require('./routes/integrations'));
app.use('/api/campaigns',         ...gate('communication'), require('./routes/campaigns'));
app.use('/api/offers',            require('./routes/offers'));
app.use('/api/feedback',          require('./routes/feedback'));
app.use('/api/communication',     ...gate('communication'), require('./routes/communication'));
// Mounted before /api/ai so /api/ai/knowledge/* is matched here first,
// regardless of what routes/ai.js's own router does internally.
app.use('/api/ai/knowledge',      userApiLimiter, ...gate('ai_knowledge_base'), require('./routes/aiKnowledge'));
app.use('/api/ai',               ...gate('ai_suite'), require('./routes/ai'));

// ────────────────────────
// MEMBER PORTAL ROUTES
// ────────────────────────
app.use('/api/classes',           require('./routes/classes'));

// ────────────────────────
// PT OS — Personal Training Operating System
// ────────────────────────
app.use('/api/pt-os',            require('./modules/pt-os/pt-os.routes'));
app.use('/api/pt-os',            require('./modules/pt-os/parq.routes'));
app.use('/api/pt-os',            require('./modules/pt-os/informed-consent.routes'));
app.use('/api/pt-os',            require('./modules/pt-os/workout-log.routes'));

// ────────────────────────
// BUSINESS FLOW ROUTES (v4 — Progress, Automation)
// ────────────────────────
app.use('/api/progress',         require('./modules/progress/progress.routes'));
app.use('/api/automation',       require('./modules/automation/automation.routes'));

// ────────────────────────
// v3 MODULE ROUTES
// ────────────────────────
app.use('/api/v1/members',        require('./modules/members/members.routes'));
app.use('/api/v1/pt-sessions',    require('./modules/sessions/sessions.routes'));
app.use('/api/v1/notifications',  require('./modules/notifications/notifications.routes'));
app.use('/api/v1/reports',        require('./modules/reports/reports.routes'));

// ────────────────────────
// 404 + GLOBAL ERROR HANDLER
// ────────────────────────
app.use(notFound);
// Report unhandled route errors to Sentry (no-op unless SENTRY_DSN set) before
// the JSON error handler formats the response.
if (process.env.SENTRY_DSN) Sentry.setupExpressErrorHandler(app);
app.use(errorHandler);

// ────────────────────────
// START — run migrations first, then listen
// ────────────────────────
const { runMigrationsWithRetry } = require('./db/migrate');

logger.info('Running database migrations…');
runMigrationsWithRetry()
  .then(function() {
    const server = app.listen(PORT, '0.0.0.0', function() {
      logger.info({
        port: PORT,
        env: NODE_ENV,
        corsOrigins: allowedOrigins.length ? allowedOrigins : '(server-to-server only)',
      }, 'MY PT STUDIO API listening on port %d (%s)', PORT, NODE_ENV);
    });

    // Render free tier sleeps after 15 min without inbound traffic — ping every
    // 14 min, during studio hours only. See lib/keepalive.js for why the ping
    // has to go to the public URL rather than localhost, and why it stops
    // overnight instead of running around the clock.
    if (isProd) {
      const { resolveKeepalive, isWithinActiveHours } = require('./lib/keepalive');
      const PING_INTERVAL_MS = 14 * 60 * 1000;
      const ka = resolveKeepalive(process.env);

      if (!ka.url) {
        logger.warn(
          'Keepalive disabled — no RENDER_EXTERNAL_URL or KEEPALIVE_URL. The service will sleep after 15 minutes idle and the next visitor pays a cold start.'
        );
      } else {
        setInterval(() => {
          if (!isWithinActiveHours(new Date(), ka)) return;
          fetch(ka.url).catch(() => {});
        }, PING_INTERVAL_MS).unref();
        logger.info(
          { url: ka.url, activeHours: `${ka.startHour}:00–${ka.endHour}:00 ${ka.timeZone}`, interval: '14min' },
          'Uptime keepalive enabled'
        );
      }
    }

    // AI knowledge-base embedding warmup: the local embedding model
    // (@xenova/transformers) downloads its weights from Hugging Face on
    // first use, which is slow and — in network-restricted environments —
    // can fail outright. Doing that on server boot rather than on the first
    // real document upload surfaces a broken/blocked download in the logs
    // immediately instead of as a confusing "upload succeeded, indexing
    // failed" for whichever user happens to try it first. Non-fatal either
    // way: a failure here just means documents will show status='failed'
    // until it's fixed, not that the server won't start.
    if (process.env.AI_EMBEDDING_WARMUP !== 'off') {
      require('./lib/ai/embeddings').embedText('warmup').then(
        () => logger.info('AI embedding model ready'),
        (err) => logger.warn({ err: err.message }, 'AI embedding model warmup failed — document indexing will error until this is resolved')
      );
    }

    // Subscription sweep: freeze lapsed trials/subscriptions + send 7/3/1/expiry
    // reminders. Idempotent + de-duplicated, so a simple interval is safe (and
    // freezing is also enforced lazily on every request, independent of this).
    // Disable with SUBSCRIPTION_SWEEP=off.
    if (process.env.SUBSCRIPTION_SWEEP !== 'off') {
      const { runSubscriptionSweep } = require('./workers/subscription.worker');
      setTimeout(() => { runSubscriptionSweep(); }, 60 * 1000).unref();
      setInterval(() => { runSubscriptionSweep(); }, 6 * 60 * 60 * 1000).unref();
      logger.info({ interval: '6h' }, 'Subscription sweep scheduled');
    }

    // Scheduled platform announcements. Each send is guarded by its own row
    // lock and status check (lib/announcements.js), so an overlapping tick
    // cannot deliver twice — which is what makes a plain interval safe here.
    // The minute-level granularity matches the UI, which schedules to the
    // minute. Disable with ANNOUNCEMENT_DISPATCH=off.
    if (process.env.ANNOUNCEMENT_DISPATCH !== 'off') {
      const { dispatchDue } = require('./lib/announcements');
      const poolRef = require('./db/pool');
      const tick = () => dispatchDue(poolRef)
        .then((n) => { if (n) logger.info({ sent: n }, 'Scheduled announcements dispatched'); })
        .catch((err) => logger.warn({ err: err.message }, 'Announcement dispatch failed'));
      setTimeout(tick, 45 * 1000).unref();
      setInterval(tick, 60 * 1000).unref();
      logger.info({ interval: '60s' }, 'Announcement dispatcher scheduled');
    }

    // UPI order expiry: close orders nobody ever paid so they stop occupying
    // the one-open-order-per-plan slot and cluttering the member's history.
    // Only touches CREATED/PAYMENT_PENDING — an order awaiting the studio's
    // verification is never expired out from under the admin.
    // Disable with UPI_EXPIRY_SWEEP=off.
    if (process.env.UPI_EXPIRY_SWEEP !== 'off') {
      const { expireStaleOrders } = require('./lib/upiPayments');
      const { expireStaleRequests } = require('./lib/subscriptionCheckout');
      const sweep = () => Promise.all([
        expireStaleOrders()
          .then((n) => { if (n) logger.info({ expired: n }, 'UPI member orders expired'); }),
        expireStaleRequests()
          .then((n) => { if (n) logger.info({ expired: n }, 'Subscription checkouts expired'); }),
      ]).catch((err) => logger.warn({ err: err.message }, 'UPI expiry sweep failed'));
      setTimeout(sweep, 90 * 1000).unref();
      setInterval(sweep, 15 * 60 * 1000).unref();
      logger.info({ interval: '15min' }, 'UPI expiry sweeps scheduled');
    }

    const pool = require('./db/pool');
    function shutdown(sig) {
      return function() {
        logger.info({ signal: sig }, 'Received signal — shutting down');
        server.close(function() {
          pool.end(function() { process.exit(0); });
        });
        setTimeout(function() { process.exit(1); }, 10_000).unref();
      };
    }
    process.on('SIGTERM', shutdown('SIGTERM'));
    process.on('SIGINT',  shutdown('SIGINT'));
  })
  .catch(function(err) {
    logger.fatal({ err: err.message }, 'Startup migration failed');
    process.exit(1);
  });

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'unhandledRejection');
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaughtException — exiting');
  process.exit(1);
});

module.exports = app;
