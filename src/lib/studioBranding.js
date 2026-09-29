'use strict';
// A studio's logo, set by its own trainer.
//
// The column (organizations.logo_url, migration 092) was only writable from
// the platform console, so a trainer had no way to put their own mark on the
// sidebar and every studio without an operator's help showed a monogram.
//
// The SQL lives here rather than in routes/profile.js, which the layering
// convention test caps.

/** The key an object was stored under, when it is one this app uploaded. */
function ownedKey(url) {
  const m = /^\/uploads\/(org-logos\/[^?#]+)$/.exec(String(url || ''));
  return m ? m[1] : null;
}

/** Point the studio at a new logo. Returns the URL it replaced. */
async function setLogo(db, orgId, url) {
  const { rows } = await db.query(
    `WITH prev AS (SELECT logo_url FROM organizations WHERE id = $1)
     UPDATE organizations SET logo_url = $2, updated_at = NOW()
      WHERE id = $1
     RETURNING (SELECT logo_url FROM prev) AS previous`,
    [orgId, url]
  );
  return rows[0] ? { previous: rows[0].previous || null } : null;
}

/** Remove the studio's logo. Returns the URL it held. */
async function clearLogo(db, orgId) {
  const { rows } = await db.query(
    `WITH prev AS (SELECT logo_url FROM organizations WHERE id = $1)
     UPDATE organizations SET logo_url = NULL, updated_at = NOW()
      WHERE id = $1
     RETURNING (SELECT logo_url FROM prev) AS previous`,
    [orgId]
  );
  return rows[0] ? { previous: rows[0].previous || null } : null;
}

module.exports = { ownedKey, setLogo, clearLogo };
