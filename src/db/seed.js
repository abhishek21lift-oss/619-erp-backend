// src/db/seed.js
// Run this ONCE after setting up your Supabase database:
//   node src/db/seed.js
//
// This sets the correct bcrypt hashes for the demo accounts.
// Pass passwords via environment variables for security:
//   ADMIN_PASSWORD=securepass123 TRAINER_PASSWORD=securepass456 node src/db/seed.js
require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool   = require('./pool');

async function seed() {
  console.log('\nSetting up demo account passwords...\n');

  const adminPassword = process.env.ADMIN_PASSWORD || 'admin@619';
  const trainerPassword = process.env.TRAINER_PASSWORD || 'trainer@619';

  const adminHash   = await bcrypt.hash(adminPassword, 10);
  const trainerHash = await bcrypt.hash(trainerPassword, 10);

  // Upsert admin
  await pool.query(`
    INSERT INTO users (id, name, email, password, role)
    VALUES ('usr-admin-001', 'Admin', 'admin@619fitness.com', $1, 'admin')
    ON CONFLICT (email) DO UPDATE SET password=$1, updated_at=NOW()`,
    [adminHash]
  );
  console.log('admin@619fitness.com  /  (password from ADMIN_PASSWORD env or default)');

  // Upsert demo trainers
  for (const [name, email, tid] of [
    ['Riya Sharma',    'riya@619fitness.com',     'tr-001'],
    ['Abhishek Gupta', 'abhishek@619fitness.com', 'tr-002'],
    ['Rajat Singh',    'rajat@619fitness.com',    'tr-003'],
  ]) {
    await pool.query(`
      INSERT INTO users (id, name, email, password, role, trainer_id)
      VALUES (gen_random_uuid()::TEXT, $1, $2, $3, 'trainer', $4)
      ON CONFLICT (email) DO UPDATE SET password=$3, trainer_id=$4, updated_at=NOW()`,
      [name, email, trainerHash, tid]
    );
    console.log(`${email}  /  (password from TRAINER_PASSWORD env or default)`);
  }

  console.log('\nSeed complete! You can now log in.\n');
  await pool.end();
}

if (require.main === module) {
  seed().catch(err => {
    console.error('Seed failed:', err.message);
    process.exit(1);
  });
}

module.exports = { seed };
