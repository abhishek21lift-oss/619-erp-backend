// src/db/seed.js
// One-time admin bootstrap for a fresh database. Run after setup:
//   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=strong-secret node src/db/seed.js
//
// No demo/sample identities: this creates only the single admin account you
// pass via environment variables. Everyone else (trainers, clients, staff) is
// created through the app UI.
require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool   = require('./pool');

async function seed() {
  const email    = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  const name     = process.env.ADMIN_NAME || 'Admin';

  if (!email || !password) {
    console.error('ADMIN_EMAIL and ADMIN_PASSWORD env vars are required to seed the admin account.');
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 12);

  // Which studio this admin belongs to.
  //
  // This used to insert no organization_id at all, which migration 175 now
  // refuses: every user carries a studio except the platform super_admin, and
  // this is an `admin`. That refusal is right rather than inconvenient — an
  // admin with no organisation authenticates fine and then sees nothing,
  // because tenantScope() resolves them to orgId=null and every filter they
  // produce matches no rows. A bootstrap that silently produces such an
  // account is a bootstrap that produces a support ticket.
  //
  // ORG_ID names the studio explicitly. With none given, the single-org
  // fallback is the same rule migration 174 uses for the same reason: where
  // the database holds exactly one organisation there is nowhere else the row
  // could belong, and that is the shape of every fresh install this script
  // exists for. More than one, and it has to be said out loud.
  let orgId = process.env.ORG_ID || null;
  if (!orgId) {
    const { rows } = await pool.query('SELECT id, name FROM organizations ORDER BY created_at');
    if (rows.length === 1) {
      orgId = rows[0].id;
      console.log(`Attaching admin to the only studio present: ${rows[0].name}`);
    } else if (rows.length === 0) {
      console.error(
        'No organizations exist yet, so there is no studio to attach this admin to.\n'
        + 'Create one first (the platform console does this when it registers a studio),\n'
        + 'then re-run with ORG_ID=<uuid>.'
      );
      process.exit(1);
    } else {
      console.error(
        `${rows.length} organizations exist, so which studio this admin belongs to cannot be guessed.\n`
        + 'Re-run with ORG_ID=<uuid>. Candidates:\n'
        + rows.map((r) => `  ${r.id}  ${r.name}`).join('\n')
      );
      process.exit(1);
    }
  }

  await pool.query(
    `INSERT INTO users (id, name, email, password, role, organization_id)
     VALUES (gen_random_uuid()::TEXT, $1, $2, $3, 'admin', $4)
     ON CONFLICT (email) DO UPDATE SET password = $3, name = $1,
                                       organization_id = EXCLUDED.organization_id,
                                       updated_at = NOW()`,
    [name, email, hash, orgId]
  );

  console.log(`Admin account ready: ${email}`);
  await pool.end();
}

if (require.main === module) {
  seed().catch(err => {
    console.error('Seed failed:', err.message);
    process.exit(1);
  });
}

module.exports = { seed };
