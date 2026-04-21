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

// ── CORS — Must be BEFORE routes ──
// Allows requests from Vercel and localhost dev
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
].filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    // curl / Postman / mobile apps have no origin header — allow them
    if (!origin) return cb(null, true);
    if (allowedOrigins.some(o => origin.startsWith(o))) return cb(null, true);
    // In dev mode, allow all
    if (process.env.NODE_ENV !== 'production') return cb(null, true);
    cb(new Error(`CORS: ${origin} not allowed`));
  },
  credentials: true,
  methods: ['GET','POST','PUT','DELETE','PATCH','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','Accept'],
}));

// Handle OPTIONS preflight for all routes
app.options('*', cors());

// ── Body parsing ──
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── Rate limiting ──
app.use('/api/', rateLimit({ windowMs: 15*60*1000, max: 2000, standardHeaders: true, legacyHeaders: false }));
app.use('/api/auth/login', rateLimit({ windowMs: 15*60*1000, max: 30 }));

// ── Health (no auth, for uptime pings) ──
app.get('/', (req, res) => res.json({ status: 'ok', app: '619 Fitness ERP v2' }));
app.get('/api/health', (req, res) => res.json({
  status: 'ok', app: '619 Fitness ERP', version: '2.0.0',
  db: 'Supabase PostgreSQL', time: new Date().toISOString()
}));

// ── Routes ──
app.use('/api/auth',       require('./routes/auth'));
app.use('/api/clients',    require('./routes/clients'));
app.use('/api/trainers',   require('./routes/trainers'));
app.use('/api/payments',   require('./routes/payments'));
app.use('/api/dashboard',  require('./routes/dashboard'));
app.use('/api/attendance', require('./routes/attendance'));
app.use('/api/reports',    require('./routes/reports'));

// ── 404 ──
app.use('/api/*', (req, res) =>
  res.status(404).json({ error: `Not found: ${req.method} ${req.path}` })
);

// ── Global error handler ──
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`\n🚀 619 ERP API → http://localhost:${PORT}`);
  console.log(`   Health      → http://localhost:${PORT}/api/health\n`);
});

module.exports = app;
