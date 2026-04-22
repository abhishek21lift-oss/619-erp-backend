// src/server.js — 619 Fitness ERP API
require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');

const app  = express();
const PORT = process.env.PORT || 5000;

// ── Security ──
app.use(helmet({ contentSecurityPolicy: false }));

// ─────────────────────────────────────────────
// ✅ CORS — FIXED (CRITICAL)
// ─────────────────────────────────────────────
app.use(cors({
  origin: '*', // allow all for now (safe for testing)
  methods: ['GET','POST','PUT','DELETE','PATCH','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
}));

// ✅ Handle preflight properly
app.options('*', cors());

// ── Body parsing ──
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ─────────────────────────────────────────────
// ✅ RATE LIMITING — FIXED
// ─────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 2000,
  standardHeaders: true,
  legacyHeaders: false
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30
});

// Apply general limiter
app.use('/api/', apiLimiter);

// ── Health ──
app.get('/', (req, res) =>
  res.json({ status: 'ok', app: '619 Fitness ERP v2' })
);

app.get('/api/health', (req, res) =>
  res.json({
    status: 'ok',
    app: '619 Fitness ERP',
    version: '2.0.0',
    time: new Date().toISOString()
  })
);

// ─────────────────────────────────────────────
// ✅ ROUTES
// ─────────────────────────────────────────────
app.use('/api/auth',       require('./routes/auth'));
app.use('/api/clients',    require('./routes/clients'));
app.use('/api/trainers',   require('./routes/trainers'));
app.use('/api/payments',   require('./routes/payments'));
app.use('/api/dashboard',  require('./routes/dashboard'));
app.use('/api/attendance', require('./routes/attendance'));
app.use('/api/reports',    require('./routes/reports'));

// ✅ APPLY LOGIN RATE LIMIT ONLY TO POST
app.post('/api/auth/login', loginLimiter);

// ── 404 ──
app.use('/api/*', (req, res) =>
  res.status(404).json({ error: `Not found: ${req.method} ${req.path}` })
);

// ── Global error handler ──
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error'
  });
});

// ── Start server ──
app.listen(PORT, () => {
  console.log(`\n🚀 619 ERP API → http://localhost:${PORT}`);
  console.log(`   Health      → http://localhost:${PORT}/api/health\n`);
});

module.exports = app;