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

// Warn about missing recommended (non-fatal) vars so ops teams notice early
const RECOMMENDED_ENV = [
  'KIOSK_HMAC_SECRET',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'RP_ID',
  'WEBAUTHN_ORIGIN',
  'FACE_ENCRYPTION_KEY',
];
const missingRecommended = RECOMMENDED_ENV.filter(function(k) { return !process.env[k]; });
if (missingRecommended.length) {
  logger.warn({ missing: missingRecommended }, 'Recommended env vars not set — some features may be degraded');
}

// Hard warn on missing face encryption key in production — biometric data
// would be stored as plaintext JSONB, which violates GDPR Art. 9.
if (isProd && !process.env.FACE_ENCRYPTION_KEY) {
  logger.warn(
    'FACE_ENCRYPTION_KEY is not set — face descriptors will be stored as plaintext. ' +
    'Generate a 64-char hex key and set FACE_ENCRYPTION_KEY to enable AES-256-GCM encryption.'
  );
}

const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit     = require('express-rate-limit');
const cookieParser  = require('cookie-parser');

const { errorHandler, notFound } = require('./middleware/errorHandler');
const { auth, adminOnly }        = require('./middleware/auth');
const { requireSuperAdmin }      = require('./middleware/tenant');
const { branchScope }            = require('./middleware/branch-scope');

const app  = express();
const PORT = Number(process.env.PORT) || 5000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Behind Render / Vercel / Cloudflare — trust the first proxy so
// req.ip is real and rate-limit keys aren’t bucketed to one IP.
app.set('trust proxy', 1);
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
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ────────────────────────
// RAZORPAY WEBHOOK (raw body — must be before json middleware)
// ────────────────────────
// H-06: route registers its own express.raw() parser so signature can be verified
app.use('/api/webhooks/razorpay', require('./routes/razorpay-webhook'));

// ────────────────────────
// BODY PARSING
// ────────────────────────
// L-06: 100kb default — checkin routes get a higher limit for face descriptors
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
app.use('/api/auth',              require('./routes/auth'));
app.use('/api/auth',              require('./routes/auth-google'));
app.use('/api/auth/webauthn',     require('./routes/auth-webauthn'));
app.use('/api/v1/auth',           require('./routes/auth'));
app.use('/api/v1/auth',           require('./routes/auth-google'));
app.use('/api/v1/auth/webauthn',  require('./routes/auth-webauthn'));
app.use('/api/profile',           require('./routes/profile'));

// ROUTE INTEGRITY NOTE (R-02):
// /api/clients mounts two separate routers. Express resolves in registration
// order — if both files define the same METHOD+PATH, client-actions.js will
// be shadowed. Audit both files for overlapping routes before adding new ones.
app.use('/api/clients',           userApiLimiter, require('./routes/clients'));
app.use('/api/clients',           userApiLimiter, require('./routes/client-actions'));

app.use('/api/trainers',          require('./routes/trainers'));
app.use('/api/payments',          userApiLimiter, require('./routes/payments'));
app.use('/api/attendance',        require('./routes/attendance'));
app.use('/api/checkin',           express.json({ limit: '50kb' }), require('./routes/checkin'));

// ROUTE INTEGRITY NOTE (R-03):
// Legacy /api/reports (routes/reports.js) and v3 /api/v1/reports
// (modules/reports) coexist. Frontend pages must call the correct version.
// New pages should use /api/v1/reports. Do not add endpoints to the legacy
// router — it will be removed once all consumers are migrated.
app.use('/api/reports',           userApiLimiter, require('./routes/reports'));

app.use('/api/plans',             require('./routes/plans'));
app.use('/api/leave',             require('./routes/leave'));
app.use('/api/expenses',          require('./routes/expenses'));

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
app.use('/api/super-admin',       auth, requireSuperAdmin, require('./modules/platform/super-admin.routes'));

app.use('/api/modules',           require('./modules/operations/operations.routes'));

// ────────────────────────
// PREMIUM FEATURE ROUTES (v4)
// ────────────────────────
app.use('/api/calendar',          require('./routes/calendar'));
app.use('/api/qr',               require('./routes/qr-checkin'));
app.use('/api/settings',          require('./routes/settings'));
app.use('/api/invoices',          require('./routes/invoices'));
app.use('/api/workouts',          require('./routes/workouts'));
app.use('/api/diet',              require('./routes/diet'));
app.use('/api/biometric-attend',  require('./routes/biometric-attend'));
app.use('/api/webauthn',          require('./routes/webauthn'));
app.use('/api/integrations',      require('./routes/integrations'));
app.use('/api/campaigns',         require('./routes/campaigns'));
app.use('/api/offers',            require('./routes/offers'));
app.use('/api/feedback',          require('./routes/feedback'));
app.use('/api/communication',     require('./routes/communication'));
app.use('/api/ai',               require('./routes/ai'));

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

    // Render free tier sleeps after 15 min of inactivity — ping every 14 min.
    // Self-ping keeps the service warm without external dependencies.
    if (isProd) {
      const PING_INTERVAL_MS = 14 * 60 * 1000;
      const selfPingUrl = `http://localhost:${PORT}/api/health`;
      setInterval(() => {
        fetch(selfPingUrl).catch(() => {});
      }, PING_INTERVAL_MS).unref();
      logger.info({ interval: '14min' }, 'Uptime self-ping enabled');
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
