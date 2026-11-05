'use strict';
// A studio's contact details, set by its own trainer and shown to its members.
//
// The SQL lives here rather than in routes/profile.js, which the layering
// convention test caps at 28 literals — the same reason studioBranding.js
// exists. Free text on purpose: "hours" is what the studio says, not a
// schedule this app parses.

async function getStudio(db, orgId) {
  const { rows } = await db.query(
    `SELECT name, phone, address, hours FROM organizations WHERE id = $1`,
    [orgId]
  );
  return rows[0] || null;
}

async function setStudio(db, orgId, { phone, address, hours }) {
  const { rows } = await db.query(
    `UPDATE organizations
        SET phone = $2, address = $3, hours = $4, updated_at = NOW()
      WHERE id = $1
      RETURNING name, phone, address, hours`,
    [orgId, phone, address, hours]
  );
  return rows[0] || null;
}

module.exports = { getStudio, setStudio };
