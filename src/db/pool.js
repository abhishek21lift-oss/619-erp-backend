// src/db/pool.js
require('dotenv').config();
const fs = require('fs');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL is not set. Check your .env file.');
  process.exit(1);
}

// Build SSL config:
//   - If DATABASE_SSL_CA is set, use that CA file with full cert verification.
//     This is the secure path for production — Supabase publishes a CA bundle.
//   - Otherwise fall back to rejectUnauthorized:false (Supabase-compatible
//     but doesn't verify the cert chain). Logs a warning so it's visible.
function buildSslConfig() {
  const caPath = process.env.DATABASE_SSL_CA;
  if (caPath) {
    try {
      return { ca: fs.readFileSync(caPath, 'utf8'), rejectUnauthorized: true };
    } catch (err) {
      console.error(`❌ DATABASE_SSL_CA points to "${caPath}" but the file could not be read:`, err.message);
      process.exit(1);
    }
  }
  if (process.env.NODE_ENV === 'production') {
    console.warn('⚠️  DATABASE_SSL_CA not set — using rejectUnauthorized:false. Set it for full cert verification.');
  }
  return { rejectUnauthorized: false };
}

const POOL_MAX = (() => {
  const n = parseInt(process.env.DATABASE_POOL_SIZE || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 10;
})();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: buildSslConfig(),
  max: POOL_MAX,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('Unexpected DB pool error:', err.message);
});

// Test connection on startup. Don't crash here — Render's healthcheck will
// surface a 5xx and you can read the log. Crashing prevents redeploys from
// recovering when Supabase has a brief connectivity blip.
pool.connect()
  .then(client => {
    console.log('✅ Connected to Supabase PostgreSQL');
    client.release();
  })
  .catch(err => {
    console.error('❌ Database connection failed on startup:', err.message);
    console.error('   1. Check DATABASE_URL is set in your .env / Render env');
    console.error('   2. Check the Supabase project is not paused');
    console.error('   3. Check the password in the URI matches your DB password');
  });

module.exports = pool;
