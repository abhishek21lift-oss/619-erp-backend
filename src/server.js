// src/server.js
require('dotenv').config();

// ─────────────────────────────────────────────────────
// STARTUP ENV CHECKS — fail fast with clear messages
// ─────────────────────────────────────────────────────
const REQUIRED_ENV = ['DATABASE_URL', 'JWT_SECRET'];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error('Missing required environment variables:', missing.join(', '));
  console.error('  Set them in your .env file or your Render dashboard.');
  process.exit(1);
}

if (process.env.JWT_SECRET.length < 16) {
  console.error('JWT_SECRET is too short (minimum 16 characters). Use a strong random secret.');
  process.exit(1);
}

const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');

const app  = express();
const PORT = Number(process.env.PORT) || 5000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const isProd = NODE_ENV === 'production';

// Behind Render / Vercel / Cloudflare — trust the first proxy so
// req.ip is real and rate-limit keys aren't bucketed to one IP.
app.set('trust proxy', 1);
app.disable('x-powered-by');

// ─────────────────────────────
// SECURITY
// ─────────────────────────────
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));

// ─────────────────────────────
// CORS
// ─────────────────────────────
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
  validOrigin(process.env.FRONTEND_URL),
  'http://localhost:3000',
  'http://127.0.0.1:3000',
].filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // curl / server-to-server
      if (allowedOrigins.includes(origin)) return cb(null, true);
      console.warn('CORS blocked origin:', origin, '— allowed:', allowedOrigins);
      return cb(new Error('CORS: origin not allowed'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);
// cors() already handles preflight — no need for a manual app.options('*', ...).

// ─────────────────────────────
// BODY PARSING
// ─────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ─────────────────────────────
// REQUEST LOGGER (compact, single line)
// ─────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    if (req.path.startsWith('/api/')) {
      console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`);
    }
  });
  next();
});

// ─────────────────────────────
// HEALTH CHECK
// ─────────────────────────────
app.get('/', (req, res) =>
  res.json({ status: 'ok', app: '619 ERP API', version: '3.0.0' })
);

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    env: {
      mode:     NODE_ENV,
      database: !!process.env.DATABASE_URL,
      jwt:      !!process.env.JWT_SECRET,
      frontend: allowedOrigins.filter((o) => !o.includes('localhost') && !o.includes('127.0.0.1')),
    },
  });
});

// ─────────────────────────────
// RATE LIMITING
// ─────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 2000,
  standardHeaders: true,
  legacyHeaders: false,
});
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please wait 15 minutes.' },
});

app.use('/api/', apiLimiter);
// Mount as scoped middleware (not as a route handler) so it runs for the
// auth router's POST /login regardless of method nuances.
app.use('/api/auth/login', loginLimiter);

// ─────────────────────────────
// ROUTES
// ─────────────────────────────
app.use('/api/auth',       require('./routes/auth'));
app.use('/api/clients',    require('./routes/clients'));
// Membership action sub-routes: /api/clients/:id/freeze|upgrade|downgrade|etc.
app.use('/api/clients',    require('./routes/client-actions'));
app.use('/api/trainers',   require('./routes/trainers'));
app.use('/api/payments',   require('./routes/payments'));
app.use('/api/dashboard',  require('./routes/dashboard'));
app.use('/api/attendance', require('./routes/attendance'));
app.use('/api/checkin',    require('./routes/checkin'));
app.use('/api/reports',    require('./routes/reports'));
app.use('/api/plans',      require('./routes/plans'));
app.use('/api/subscriptions', require('./modules/subscriptions/subscriptions.routes'));
app.use('/api/modules',    require('./modules/operations/operations.routes'));

// ─────────────────────────────
// 404 (any unmatched /api route)
// ─────────────────────────────
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: `Not found: ${req.method} ${req.path}` });
});

// ─────────────────────────────
// GLOBAL ERROR HANDLER
//   - Logs the full stack server-side
//   - In production, hides raw 5xx error messages
// ─────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  console.error(`[${status}] ${req.method} ${req.originalUrl}`);
  if (err.stack) console.error(err.stack);

  const safe =
    status >= 500 && isProd
      ? 'Internal server error'
      : err.message || 'Internal server error';

  res.status(status).json({ error: safe });
});

// ─────────────────────────────
// START
// ─────────────────────────────
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`619 ERP API listening on port ${PORT}  (${NODE_ENV})`);
  console.log(`  Health → http://localhost:${PORT}/api/health`);
  console.log(
    `  CORS   → ${allowedOrigins.length ? allowedOrigins.join(', ') : '(none — server-to-server only)'}`
  );
});

// Graceful shutdown on container signals (Render, Docker, Kubernetes).
const shutdown = (sig) => () => {
  console.log(`Received ${sig} — shutting down…`);
  server.close(() => process.exit(0));
  // Hard exit if close hangs.
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', shutdown('SIGTERM'));
process.on('SIGINT', shutdown('SIGINT'));

module.exports = app;
