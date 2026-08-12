// src/routes/uploads.js
// Serves everything saved via lib/fileStorage.js — replaces the old bare
// express.static('/uploads') mount so reads transparently come from R2 in
// production and from local disk in dev, matching wherever saveFile()
// actually wrote the object.
//
// ── Access control ──────────────────────────────────────────────────────────
// This route used to be entirely unauthenticated, which meant PAR-Q health
// screenings and signed informed-consent PDFs (GDPR Art. 9 special-category
// health data) were served to anyone holding the URL. Object keys are row
// UUIDs so they are not enumerable, but that is obscurity, not authorization:
// there was no access check, no expiry and no revocation, so any URL that
// leaked via referrer, a shared link, log aggregation or browser history
// granted permanent access to that individual's health record.
//
// Two tiers now:
//   • PUBLIC tier — branding and avatars. Referenced from plain <img> tags
//     (see components/StudioMark.tsx), carry no sensitive content, and must
//     keep rendering without a session. Left open deliberately.
//   • Everything else — requires a valid session AND a registered category
//     whose owning record belongs to the caller's organization, so a valid
//     session in studio A cannot fetch studio B's consent PDFs. A category
//     nobody registered is refused rather than served on the session alone:
//     the default has to be the safe one, because the unsafe one is what you
//     get by forgetting.
const router = require('express').Router();
const pool = require('../db/pool');
const { auth } = require('../middleware/auth');
const { tenantScope } = require('../lib/tenant-db');
const { serveFile } = require('../lib/fileStorage');
const logger = require('../lib/logger');

const isProd = (process.env.NODE_ENV || 'development') === 'production';
const PUBLIC_CACHE_SECONDS = isProd ? 7 * 24 * 60 * 60 : 0;

// Categories whose object keys resolve to a tenant-scoped row. The UUID
// embedded in the key is looked up here to confirm the caller's org owns it.
const OWNED_CATEGORIES = {
  'parq': 'pt_parq_forms',
  'informed-consent': 'pt_informed_consents',
  'knowledge': 'ai_documents',
};

// Payment proofs are keyed differently: routes/upi-payments.js writes
// `upi-proof/<orderId>-<randomUUID>.<ext>`, so the owning row's id is the
// PREFIX of the filename rather than the whole of it. The generic resolver
// below strips the extension and expects the remainder to be a bare UUID,
// which would never match here — hence a category-specific extractor.
//
// This matters: a payment screenshot shows a member's bank app, their name and
// the amount they paid. Without this, any authenticated user in any studio
// holding the key could fetch another studio's proof.
const PROOF_CATEGORY = 'upi-proof';
const PROOF_TABLE = 'payment_orders';

// Portfolio media (migration 134). Deliberately NOT in the public tier: the
// public profile page is out of scope for now, so nothing needs unauthenticated
// access, and a before/after is a photograph of somebody's client.
const PORTFOLIO_CATEGORY = 'portfolio';

// Weekly progress reports, keyed `progress-reports/<clientUUID>-<YYYY-MM-DD>.pdf`
// by lib/weeklyProgressPdf.js. Like payment proofs, the owning id is a PREFIX
// of the filename rather than the whole of it, so the generic resolver — which
// strips the extension and expects a bare UUID — would reject every one of
// them and fall through to "not an owned category", which means any
// authenticated user in any studio could fetch another studio's report.
//
// A progress report carries a named client, what they lifted, how often they
// turned up and their coach's written notes about them. It gets the same
// treatment as a payment proof.
const REPORT_CATEGORY = 'progress-reports';
const REPORT_TABLE = 'pt_clients';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Derived from req.path rather than req.params[0]: this router registers both
// prefix routes ('/profile/*') and a catch-all ('/*'), and on a prefix route
// req.params[0] holds only the wildcard tail, which would silently drop the
// category segment from the storage key. req.path is relative to the mount
// point and always carries the full key.
function normaliseKey(req, res) {
  let key;
  try {
    key = decodeURIComponent(req.path).replace(/^\/+/, '');
  } catch {
    res.status(400).json({ error: 'Invalid path' });
    return null;
  }
  // Reject traversal before the key reaches storage.
  if (!key || key.includes('..')) {
    res.status(400).json({ error: 'Invalid path' });
    return null;
  }
  return key;
}

/**
 * For an owned category, confirm the record the key points at belongs to the
 * caller's organization.
 *
 * Fails closed: an unparseable key, a missing row, or a row in another org all
 * deny. A platform super_admin operating without a target org (applyFilter
 * false) is allowed through, consistent with tenantScope() everywhere else.
 */
async function callerOwnsRecord(req, category, key) {
  const scope = tenantScope(req);

  // A platform super admin operating platform-wide is unrestricted, consistent
  // with tenantScope() everywhere else. Hoisted here so it is stated once
  // instead of repeated per branch, and so the unknown-category denial below
  // cannot accidentally lock the platform console out of a category it is the
  // only caller for.
  if (!scope.applyFilter) return true;

  // Portfolio media is resolved by KEY, not by an id parsed out of the
  // filename. A before/after row owns two objects and each carries its own
  // UUID, so the generic "basename is the row id" resolver below cannot match
  // either of them — and without this branch `portfolio` falls through as an
  // unowned category, meaning any authenticated user in any studio holding a
  // key could fetch it. Before/after client photos are the last thing that
  // should be readable across a tenant boundary.
  if (category === PORTFOLIO_CATEGORY) {
    const { rows } = await pool.query(
      `SELECT organization_id FROM user_portfolio_items
        WHERE file_key = $1 OR after_file_key = $1`,
      [key]
    );
    if (rows.length === 0) return false;
    return rows[0].organization_id === scope.orgId;
  }

  const isProof = category === PROOF_CATEGORY;
  const isReport = category === REPORT_CATEGORY;
  const table = isProof ? PROOF_TABLE : isReport ? REPORT_TABLE : OWNED_CATEGORIES[category];

  // Unknown category → denied.
  //
  // This used to `return true` — "not an owned category, so a valid session
  // suffices" — which made the SAFE outcome the one you got by remembering.
  // Every category written today is either public-tier or ownership-checked,
  // so nothing relied on it; the defect was the default. The twelfth category
  // somebody adds would have been readable by any authenticated user in any
  // studio holding the key, and the things stored here are health screenings,
  // payment proofs and photographs of somebody's client.
  //
  // Inverted, adding a category to saveFile() without registering it here
  // fails visibly on the first read instead of silently serving it across the
  // tenant boundary. If a category genuinely needs "any session may read it",
  // that is the public tier above (servePublic) — an explicit decision with a
  // route of its own, not a fallthrough.
  if (!table) return false;

  // Keys are written as `<category>/pdf/<record-uuid>.pdf` by lib/parqPdf.js
  // and lib/informedConsentPdf.js — except payment proofs and progress
  // reports, where the owning id is a prefix of a longer filename (see
  // PROOF_CATEGORY and REPORT_CATEGORY above).
  const basename = key.split('/').pop() || '';
  const id = (isProof || isReport)
    ? basename.slice(0, 36)
    : basename.replace(/\.[^.]+$/, '');
  if (!UUID_RE.test(id)) return false;

  // Table name comes from the OWNED_CATEGORIES allowlist above, never from
  // the request, so it is not an injection vector.
  const { rows } = await pool.query(
    `SELECT organization_id FROM ${table} WHERE id = $1`,
    [id]
  );
  if (rows.length === 0) return false;
  return rows[0].organization_id === scope.orgId;
}

// ── Tier 1: public branding assets (no session required) ────────────────────
async function servePublic(req, res, next) {
  try {
    const key = normaliseKey(req, res);
    if (key === null) return;
    await serveFile(key, res, { maxAgeSeconds: PUBLIC_CACHE_SECONDS });
  } catch (err) {
    next(err);
  }
}

router.get('/profile/*', servePublic);
router.get('/org-logos/*', servePublic);

// ── Tier 2: authenticated, with an ownership check on tenant-owned records ──
router.get('/*', auth, async (req, res, next) => {
  try {
    const key = normaliseKey(req, res);
    if (key === null) return;

    const category = key.split('/')[0];
    if (!(await callerOwnsRecord(req, category, key))) {
      logger.warn(
        { userId: req.user?.id, orgId: tenantScope(req).orgId, key },
        'uploads: cross-tenant or unknown record access denied'
      );
      // 404 rather than 403 so the response does not confirm the object exists.
      return res.status(404).json({ error: 'Not found' });
    }

    // Private records must never land in a shared or CDN cache.
    res.set('Cache-Control', 'private, no-store');
    await serveFile(key, res, {});
  } catch (err) {
    next(err);
  }
});

module.exports = router;
