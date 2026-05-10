// src/server.v3.js
// New v3 server composition. Run with `node src/server.v3.js`.
//
// v3 INCLUDES every v2 endpoint mounted under /api/* PLUS the new v3
// modules under /api/v1/*. Running this binary in place of server.js is
// safe — the live frontend keeps working because /api/auth, /api/clients
// etc. are still present.

require('dotenv').config();

// ── Startup env checks (parity with server.js) ────────────────────────────
const REQUIRED_ENV = ['DATABASE_URL', 'JWT_SECRET'];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error('Missing required environment variables:', missing.join(', '));
  process.exit(1);
}
if (process.env.JWT_SECRET.length < 16) {
  console.error('JWT_SECRET is too short (minimum 16 characters).');
  process.exit(1);
}

const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');

const { errorHandler, notFound } = require('./middleware/errorHandler');

const app  = express();
const PORT = Number(process.env.PORT) || 4000;
const NODE_ENV = process.env.NODE_ENV || 'development';

app.set('trust proxy', 1);
app.disable('x-powered-by');

// ── Security ──────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));

// ── CORS — accept both CORS_ORIGIN (v3) and FRONTEND_URL (v2) for parity ─
function validOrigin(origin) {
  if (!origin) return null;
  const trimmed = origin.trim();
  try {
    const url = new URL(trimmed);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('invalid protocol');
    return url.origin;
  } catch {
    console.warn(`Ignoring invalid CORS origin: ${trimmed}`);
    return null;
  }
}

const allowedOrigins = [
  ...(process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map(validOrigin) : []),
  validOrigin(process.env.FRONTEND_URL),
  'http://localhost:3000',
  'http://127.0.0.1:3000',
].filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    // SECURITY: do NOT honor an explicit '*' with credentials:true. Browsers
    // already reject that combination but server-to-server callers wouldn't.
    console.warn('CORS blocked origin:', origin, '— allowed:', allowedOrigins);
    cb(new Error('CORS: origin not allowed'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Rate limiting ─────────────────────────────────────────────────────────
const generalLimiter = rateLimit({ windowMs: 60_000, max: 2000, standardHeaders: true, legacyHeaders: false });
const authLimiter    = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
app.use('/api/', generalLimiter);
app.post('/api/auth/login',    authLimiter);
app.post('/api/v1/auth/login', authLimiter);

// ── Health check ──────────────────────────────────────────────────────────
app.get('/',           (req, res) => res.json({ status: 'ok', app: '619 ERP API', version: '3.0.0' }));
app.get('/api/health', (req, res) => res.json({
  status: 'ok', version: 'v3', time: new Date().toISOString(),
  env: { mode: NODE_ENV, database: !!process.env.DATABASE_URL, jwt: !!process.env.JWT_SECRET },
}));

// ── v2 routes (still in production use) ───────────────────────────────────
app.use('/api/auth',       require('./routes/auth'));
app.use('/api/clients',    require('./routes/clients'));
app.use('/api/clients',    require('./routes/client-actions'));
app.use('/api/trainers',   require('./routes/trainers'));
app.use('/api/payments',   require('./routes/payments'));
app.use('/api/dashboard',  require('./routes/dashboard'));
app.use('/api/attendance', require('./routes/attendance'));
app.use('/api/checkin',    require('./routes/checkin'));
app.use('/api/reports',    require('./routes/reports'));
app.use('/api/plans',      require('./routes/plans'));
app.use('/api/subscriptions', require('./modules/subscriptions/subscriptions.routes'));

// ── v3 routes (new modules) ───────────────────────────────────────────────
app.use('/api/v1/members',       require('./modules/members/members.routes'));
app.use('/api/v1/bookings',      require('./modules/bookings/bookings.routes'));
app.use('/api/v1/pt-sessions',   require('./modules/sessions/sessions.routes'));
app.use('/api/v1/notifications', require('./modules/notifications/notifications.routes'));
app.use('/api/v1/reports',       require('./modules/reports/reports.routes'));
app.use('/api/v1/subscriptions', require('./modules/subscriptions/subscriptions.routes'));

// ── Error handling (mounts last) ──────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`619 ERP v3 API on :${PORT}  (${NODE_ENV})`);
});

// Graceful shutdown
const shutdown = (sig) => () => {
  console.log(`Received ${sig} — shutting down…`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', shutdown('SIGTERM'));
process.on('SIGINT', shutdown('SIGINT'));

module.exports = app;
