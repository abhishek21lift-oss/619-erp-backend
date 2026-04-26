// src/server.js — FINAL FIXED VERSION

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');

const app  = express();
const PORT = process.env.PORT || 5000;

// ─────────────────────────────
// ✅ SECURITY
// ─────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));

// ─────────────────────────────
// ✅ CORS — restricted to FRONTEND_URL + localhost
// ─────────────────────────────
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:3000',
  'http://127.0.0.1:3000',
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // allow same-origin / curl / server-to-server (no Origin header)
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('CORS: origin not allowed'));
  },
  credentials: true,
  methods: ['GET','POST','PUT','DELETE','PATCH','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
}));

// ✅ HANDLE PREFLIGHT
app.options('*', (req, res) => {
  res.sendStatus(200);
});

// ─────────────────────────────
// ✅ BODY PARSING
// ─────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ─────────────────────────────
// ✅ HEALTH CHECK (before rate limit so monitors don't hit it)
// ─────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', app: '619 ERP API' });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
  });
});

// ─────────────────────────────
// ✅ RATE LIMITING
// ─────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 2000,
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
});

// Apply general limiter
app.use('/api/', apiLimiter);

// ✅ APPLY LOGIN LIMITER BEFORE THE AUTH ROUTER (CRITICAL FIX)
app.post('/api/auth/login', loginLimiter);

// ─────────────────────────────
// ✅ ROUTES
// ─────────────────────────────
app.use('/api/auth', require('./routes/auth'));
app.use('/api/clients', require('./routes/clients'));
app.use('/api/trainers', require('./routes/trainers'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/attendance', require('./routes/attendance'));
app.use('/api/reports', require('./routes/reports'));

// ─────────────────────────────
// ✅ 404 HANDLER
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
    error: err.message || 'Internal server error'
  });
});

// ─────────────────────────────
// ✅ START SERVER
// ─────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 API running on http://localhost:${PORT}`);
  console.log(`   Health → http://localhost:${PORT}/api/health`);
});

module.exports = app;
