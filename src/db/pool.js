// src/db/pool.js
require('dotenv').config();
const fs = require('fs');
const { Pool } = require('pg');
const logger = require('../lib/logger');

if (!process.env.DATABASE_URL) {
  logger.fatal('DATABASE_URL is not set. Check your .env file.');
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
      logger.fatal({ caPath, err: err.message }, 'DATABASE_SSL_CA file could not be read');
      process.exit(1);
    }
  }
  if (process.env.NODE_ENV === 'production') {
    // In production without a CA bundle, trust the system CA store (Render/Supabase
    // use certs signed by trusted CAs). This validates the cert chain — only
    // rejectUnauthorized:false should be used in local dev.
    logger.info('DATABASE_SSL_CA not set — using system CA store for TLS verification.');
    return true;
  }
  return { rejectUnauthorized: false };
}

const POOL_MAX = (() => {
  const n = parseInt(process.env.DATABASE_POOL_SIZE || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 20;
})();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: buildSslConfig(),
  max: POOL_MAX,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  // statement_timeout (server-side): PostgreSQL cancels the query after 20s.
  // query_timeout (client-side): node-postgres gives up waiting after 15s,
  // freeing the connection before the DB-side cancel fires.
  statement_timeout: 20000,
  query_timeout: 15000,
});

pool.on('error', (err) => {
  logger.error({ err: err.message }, 'Unexpected DB pool error');
});

// Instrument pool.query to log slow queries (> 1 second).
const _origQuery = pool.query.bind(pool);
pool.query = function slowQueryInstrument(...args) {
  const start = Date.now();
  const result = _origQuery(...args);
  if (result && typeof result.then === 'function') {
    return result.then(
      (r) => {
        const ms = Date.now() - start;
        if (ms > 1000) {
          const sql = (typeof args[0] === 'string' ? args[0] : (args[0]?.text ?? '[object]')).slice(0, 200);
          logger.warn({ sql, ms }, 'slow_query');
        }
        return r;
      },
      (err) => { throw err; }
    );
  }
  return result;
};

// Test connection on startup. Don't crash here — Render's healthcheck will
// surface a 5xx and you can read the log. Crashing prevents redeploys from
// recovering when Supabase has a brief connectivity blip.
pool.connect()
  .then(client => {
    logger.info('Connected to Supabase PostgreSQL');
    client.release();
  })
  .catch(err => {
    logger.error({ err: err.message }, 'Database connection failed on startup');
    logger.error('  1. Check DATABASE_URL is set in your .env / Render env');
    logger.error('  2. Check the Supabase project is not paused');
    logger.error('  3. Check the password in the URI matches your DB password');
  });

module.exports = pool;
