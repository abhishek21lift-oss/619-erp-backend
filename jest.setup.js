// Test-environment defaults, applied before any test module loads.
//
// The suite is almost entirely mock-driven, but a handful of files require
// src/db/pool.js for real. That module needs DATABASE_URL at import time, so
// `npm test` on a freshly cloned checkout — no .env, nothing exported — failed
// six suites before a single assertion ran. Contributors had to know to export
// a variable that no error message named.
//
// Only ever fills in what is *absent*: CI sets a real DATABASE_URL for the
// integration suites and must win. The value below is deliberately a dead
// address rather than a plausible local one — nothing here should ever open a
// connection, and if something starts trying to, it should fail loudly instead
// of quietly finding a developer's own database on localhost:5432.
//
// The real-database suites gate on their own variables (RLS_TEST_DATABASE_URL
// and friends) and self-skip, so this default never causes them to run.
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL =
    'postgres://jest:jest@127.0.0.1:1/619_erp_jest_placeholder?sslmode=disable';
}
