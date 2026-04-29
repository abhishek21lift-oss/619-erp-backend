// src/server.v3.js
// New v3 server composition. Run with `node src/server.v3.js`.
// (Keep your existing server.js for v2 backwards compat during migration.)

const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const { errorHandler, notFound } = require('./middleware/errorHandler');

const app = express();

// ── Security ──────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: (process.env.CORS_ORIGIN || '*').split(','),
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));

// ── Rate limiting ─────────────────────────────────────────────────────────
const generalLimiter = rateLimit({ windowMs: 60_000, max: 200 });
const authLimiter    = rateLimit({ windowMs: 60_000, max: 10 });
app.use('/api/', generalLimiter);
app.use('/api/v1/auth', authLimiter);

// ── Health check ──────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ ok: true, version: 'v3', time: new Date() }));

// ── v2 routes (existing) ──────────────────────────────────────────────────
// app.use('/api/auth',       require('./routes/auth'));        // v2 endpoints
// app.use('/api/clients',    require('./routes/clients'));
// app.use('/api/trainers',   require('./routes/trainers'));
// app.use('/api/payments',   require('./routes/payments'));
// app.use('/api/dashboard',  require('./routes/dashboard'));
// app.use('/api/attendance', require('./routes/attendance'));

// ── v3 routes (new modules) ───────────────────────────────────────────────
app.use('/api/v1/members',       require('./modules/members/members.routes'));
app.use('/api/v1/bookings',      require('./modules/bookings/bookings.routes'));
app.use('/api/v1/pt-sessions',   require('./modules/sessions/sessions.routes'));
app.use('/api/v1/notifications', require('./modules/notifications/notifications.routes'));
app.use('/api/v1/reports',       require('./modules/reports/reports.routes'));

// ── Error handling ────────────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`✅ 619 ERP v3 API on :${PORT}`);
});
