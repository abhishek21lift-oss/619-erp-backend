// src/db/pool.js
require('dotenv').config();
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL is not set. Check your .env file.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // required for Supabase
  max: 10,
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
