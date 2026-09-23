// src/db/seed.js
// One-time trainer bootstrap for a fresh studio. Run after setup:
//   TRAINER_EMAIL=you@example.com TRAINER_PASSWORD=strong-secret node src/db/seed.js
//
// No demo/sample identities: this creates only the studio's trainer — its one
// owner account — from the environment variables you pass, together with the
// trainer profile the rest of the app links to. Members are created through
// the app (client activation). The platform operator is not created here.
require('dotenv').config();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pool   = require('./pool');

async function seed() {
  const email    = (process.env.TRAINER_EMAIL || '').trim().toLowerCase();
  const password = process.env.TRAINER_PASSWORD;
  const name     = process.env.TRAINER_NAME || 'Trainer';

  if (!email || !password) {
    console.error('TRAINER_EMAIL and TRAINER_PASSWORD env vars are required to seed the studio trainer.');
    process.exit(1);
  }

  // Which studio this trainer owns.
  //
  // Every account except the platform operator carries a studio (migration
  // 175's users_tenant_or_platform constraint). ORG_ID
  // names it explicitly. With none given, the single-org fallback is the same
  // rule migration 174 uses: where the database holds exactly one
  // organisation there is nowhere else the row could belong, and that is the
  // shape of every fresh install this script exists for. More than one, and
  // it has to be said out loud.
  let orgId = process.env.ORG_ID || null;
  if (!orgId) {
    const { rows } = await pool.query('SELECT id, name FROM organizations ORDER BY created_at');
    if (rows.length === 1) {
      orgId = rows[0].id;
      console.log(`Attaching the trainer to the only studio present: ${rows[0].name}`);
    } else if (rows.length === 0) {
      console.error(
        'No organizations exist yet, so there is no studio for this trainer to own.\n'
        + 'Create one first (the platform console does this when it registers a studio),\n'
        + 'then re-run with ORG_ID=<uuid>.'
      );
      process.exit(1);
    } else {
      console.error(
        `${rows.length} organizations exist, so which studio this trainer owns cannot be guessed.\n`
        + 'Re-run with ORG_ID=<uuid>. Candidates:\n'
        + rows.map((r) => `  ${r.id}  ${r.name}`).join('\n')
      );
      process.exit(1);
    }
  }

  const hash = await bcrypt.hash(password, 12);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // A studio has exactly one trainer (uq_one_trainer_per_org). Re-running
    // for the same account resets its password; a different account is
    // refused rather than silently given a second owner's key to the studio.
    const { rows: existing } = await client.query(
      `SELECT id, email, trainer_id FROM users
        WHERE organization_id = $1 AND role = 'trainer' AND deleted_at IS NULL`,
      [orgId]
    );
    const { rows: byEmail } = await client.query(
      'SELECT id, role, organization_id FROM users WHERE LOWER(email) = $1', [email]
    );
    if (existing[0] && existing[0].email.toLowerCase() !== email) {
      throw new Error(`This studio already has a trainer (${existing[0].email}). A studio has exactly one.`);
    }
    if (byEmail[0] && (byEmail[0].role !== 'trainer' || byEmail[0].organization_id !== orgId)) {
      throw new Error(`${email} already belongs to another account; refusing to change its role or studio.`);
    }

    let trainerId = existing[0]?.trainer_id || null;
    if (!trainerId) {
      const { rows } = await client.query(
        `INSERT INTO trainers (name, email, organization_id) VALUES ($1, $2, $3) RETURNING id`,
        [name, email, orgId]
      );
      trainerId = rows[0].id;
    }

    if (existing[0]) {
      await client.query(
        `UPDATE users SET password = $2, name = $3, trainer_id = $4,
                          token_version = token_version + 1, updated_at = NOW()
          WHERE id = $1`,
        [existing[0].id, hash, name, trainerId]
      );
    } else {
      await client.query(
        `INSERT INTO users (id, name, email, password, role, trainer_id, organization_id)
         VALUES ($1, $2, $3, $4, 'trainer', $5, $6)`,
        [crypto.randomUUID(), name, email, hash, trainerId, orgId]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`Seed failed: ${err.message}`);
    process.exitCode = 1;
    return;
  } finally {
    client.release();
  }

  console.log(`Trainer account ready: ${email}`);
}

if (require.main === module) {
  seed()
    .catch((err) => { console.error('Seed failed:', err.message); process.exitCode = 1; })
    .finally(() => pool.end());
}

module.exports = { seed };
