// src/server.js
require('dotenv').config();

// ─────────────────────────────────────────────────────
// ✅ STARTUP ENV CHECKS — fail fast with clear messages
// ─────────────────────────────────────────────────────
const REQUIRED_ENV = ['DATABASE_URL', 'JWT_SECRET'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error('❌ Missing required environment variables:', missing.join(', '));
  console.error('   Set them in your .env file or Render dashboard.');
  process.exit(1);
}

if (process.env.JWT_SECRET.length < 16) {
  console.error('❌ JWT_SECRET is too short (minimum 16 characters). Use a strong random secret.');
  process.exit(1);
}

const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');

const app  = express();
const PORT = process.env.PORT || 5000;

// ─────────────────────────────
// ✅ SECURITY
// ─────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));

// ─────────────────────────────
// ✅ CORS
// ─────────────────────────────
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:3000',
  'http://127.0.0.1:3000',
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);          // curl / server-to-server
    if (allowedOrigins.includes(origin)) return cb(null, true);
    console.warn('⚠️  CORS blocked origin:', origin);
    console.warn('   Allowed origins:', allowedOrigins);
    return cb(new Error('CORS: origin not allowed'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.options('*', (req, res) => res.sendStatus(200));

// ─────────────────────────────
// ✅ BODY PARSING
// ─────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ─────────────────────────────
// ✅ HEALTH CHECK
// ─────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', app: '619 ERP API' }));

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    env: {
      database: !!process.env.DATABASE_URL,
      jwt:      !!process.env.JWT_SECRET,
      frontend: process.env.FRONTEND_URL || '(not set)',
    },
  });
});

// ─────────────────────────────
// ✅ RATE LIMITING
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
app.post('/api/auth/login', loginLimiter);

// ─────────────────────────────
// ✅ ROUTES
// ─────────────────────────────
app.use('/api/auth',       require('./routes/auth'));
app.use('/api/clients',    require('./routes/clients'));
app.use('/api/trainers',   require('./routes/trainers'));
app.use('/api/payments',   require('./routes/payments'));
app.use('/api/dashboard',  require('./routes/dashboard'));
app.use('/api/attendance', require('./routes/attendance'));
app.use('/api/reports',    require('./routes/reports'));

// ─────────────────────────────
// ✅ 404
// ─────────────────────────────
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: `Not found: ${req.method} ${req.path}` });
});

// ─────────────────────────────
// ✅ GLOBAL ERROR HANDLER
// ─────────────────────────────
app.use((err, req, res, next) => {
  console.error('Server error:', err.message);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
  });
});

// ─────────────────────────────
// ✅ START
// ─────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 619 ERP API running on port ${PORT}`);
  console.log(`   Health → http://localhost:${PORT}/api/health`);
  console.log(`   ENV    → DATABASE_URL ✅  JWT_SECRET ✅  FRONTEND_URL: ${process.env.FRONTEND_URL || '⚠️ not set'}`);
});

module.exports = app;
