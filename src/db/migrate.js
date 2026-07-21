// src/db/migrate.js
// Run all pending SQL migrations in order.
//
// Two modes:
//   1. CLI:    node src/db/migrate.js   (closes pool when done)
//   2. Module: require('./migrate').runMigrations()  (pool stays open)
//              Called automatically from server.js on startup.

const fs   = require('fs');
const path = require('path');
const pool = require('./pool');

/**
 * Apply any pending migrations from src/db/migrations/*.sql.
 * Safe to call on every startup — already-applied files are skipped.
 * Does NOT close the pool so the server can keep using it.
 */
const LOCK_ID = 619619619; // Unique advisory lock for 619 ERP migrations

async function runMigrations() {
  const client = await pool.connect();
  let holdsLock = false;
  try {
    // Acquire the advisory lock WITHOUT blocking. A blocking pg_advisory_lock()
    // sits in the lock queue, where the pool's statement_timeout/query_timeout
    // eventually kills it — and under crash-loop restarts that piles up waiters
    // and orphans lock-holding sessions behind the Supavisor pooler (a boot
    // grabs the lock, the container is SIGKILLed mid-migration, and the pooled
    // backend lingers still holding it, blocking every later boot). Polling a
    // non-blocking pg_try_advisory_lock never queues, so a stale holder just
    // makes us retry rather than deadlock the whole service. lock_timeout is a
    // belt-and-braces guard for any other lock this session waits on.
    await client.query("SET lock_timeout = '5s'");
    for (let attempt = 1; attempt <= 15; attempt++) {
      const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_ID]);
      if (rows[0].ok) { holdsLock = true; break; }
      console.log(`  … migration lock held by another instance, retry ${attempt}/15`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    if (!holdsLock) {
      throw new Error('Could not acquire migration advisory lock (another instance may be migrating or a stale lock is held)');
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id         SERIAL PRIMARY KEY,
        filename   TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const dir   = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();

    for (const file of files) {
      const { rows } = await client.query(
        'SELECT id FROM _migrations WHERE filename=$1', [file]
      );
      if (rows.length > 0) {
        console.log(`  ✓ ${file} (already applied)`);
        continue;
      }
      console.log(`  → Applying ${file}…`);
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`  ✓ ${file} applied`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`  ✗ ${file} FAILED:`, err.message);
        throw err;
      }
    }
    console.log('✅ All migrations complete.');
  } finally {
    if (holdsLock) {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(function() {});
    }
    client.release();
  }
}

/**
 * Run migrations, retrying on transient connection/query failures.
 *
 * On a cold start (Render waking from hibernate, or the Supabase pooler
 * spinning up) the first DB connection can take longer than the pool's
 * connectionTimeoutMillis, so pool.connect() rejects with "Connection
 * terminated due to connection timeout" or a "Query read timeout". A single
 * failure used to exit(1) and crash-loop the whole service; retrying with
 * backoff lets the boot ride out that initial blip. The migration runner is
 * idempotent (already-applied files are skipped, each file is transactional),
 * so re-running is always safe.
 */
async function runMigrationsWithRetry({ attempts = 5, baseDelayMs = 2000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await runMigrations();
      return;
    } catch (err) {
      lastErr = err;
      console.error(`  ⚠ migration attempt ${attempt}/${attempts} failed: ${err.message}`);
      if (attempt === attempts) break;
      const delay = baseDelayMs * 2 ** (attempt - 1); // 2s, 4s, 8s, 16s
      console.error(`    retrying in ${delay / 1000}s…`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

// When executed directly as CLI, close the pool after finishing.
if (require.main === module) {
  require('dotenv').config();
  runMigrations()
    .then(() => pool.end())
    .catch(err => {
      console.error('Migration failed:', err.message);
      process.exit(1);
    });
}

module.exports = { runMigrations, runMigrationsWithRetry };
