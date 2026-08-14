'use strict';
// The platform user directory — every account on the platform, in one place.
//
// The one module the console genuinely did not have. Users were reachable only
// through the studio that owns them: GET /organizations/:id returns its own
// users, and there are per-user actions (PATCH, DELETE, force-logout,
// reset-mfa, reset-password) that each take an id somebody must already know.
// There was no way to ask "which accounts exist", "who has not signed in since
// March", or "who holds platform access" without opening studios one at a time.
//
// ── Why this reads platform-wide explicitly ─────────────────────────────────
//
// runAsPlatform, not the ambient context, and that is a correctness
// requirement rather than a style choice.
//
// db/pool.js routes to the owner connection only when isPlatformWide() is
// true, and auth.js computes that as `role === 'super_admin' && orgId == null`.
// The frontend sends `x-org-id` from localStorage on every request, so an
// operator who once pinned the org-switcher makes orgId non-null on every
// request thereafter — and a cross-tenant directory would quietly become a
// single-studio directory, showing a short list with no indication it had been
// filtered. Once DATABASE_URL points at app_tenant it would show nothing at
// all for most tables.
//
// The same trap cost the platform grant lookup a lockout bug (see
// middleware/platformAuth.js). A directory that is meant to span tenants says
// so, and takes its scoping from an explicit parameter instead.

const router = require('express').Router();
const pool = require('../../../db/pool');
const { runAsPlatform } = require('../../../lib/tenant-context');

// Page size. Capped rather than unbounded: this table is every account on the
// platform, and an operator who fat-fingers a filter should get a slow page,
// not a slow platform.
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function intParam(value, fallback, max) {
  const n = parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return max != null ? Math.min(n, max) : n;
}

// ── GET /users ───────────────────────────────────────────────────────────────
//
// The directory. Filters compose; every one of them is optional.
//
//   q          name or email, case-insensitive substring
//   role       exact role, or 'platform' for the operators
//   status     active | inactive | deleted
//   org        organization id — the ONLY way to scope to one studio here
//   limit/offset
//
// `deleted` is a status rather than a default exclusion. Soft-deleted accounts
// are exactly what somebody is looking for when they ask "what happened to this
// login", and hiding them by default with no way to ask is how an operator ends
// up querying the database by hand.
router.get('/users', async (req, res, next) => {
  try {
    const limit = intParam(req.query.limit, DEFAULT_LIMIT, MAX_LIMIT);
    const offset = intParam(req.query.offset, 0);
    const q = String(req.query.q || '').trim();
    const role = String(req.query.role || '').trim();
    const status = String(req.query.status || '').trim();
    const org = String(req.query.org || '').trim();

    // Filters are built as (fragment, bind) pairs. Every caller-supplied value
    // is a bind parameter — none of them is concatenated into SQL text, which
    // is the whole reason this is a builder rather than a template string.
    const where = [];
    const params = [];
    /** Push a value and return its placeholder, e.g. `$3`. */
    const bind = (value) => `$${params.push(value)}`;

    if (q) {
      const p = bind(`%${q}%`);
      where.push(`(u.name ILIKE ${p} OR u.email ILIKE ${p})`);
    }
    if (org) where.push(`u.organization_id = ${bind(org)}`);

    if (role === 'platform') where.push("u.role = 'super_admin'");
    else if (role) where.push(`u.role = ${bind(role)}`);

    if (status === 'deleted') where.push('u.deleted_at IS NOT NULL');
    else if (status === 'inactive') where.push('u.deleted_at IS NULL AND u.is_active = false');
    else if (status === 'active') where.push('u.deleted_at IS NULL AND u.is_active = true');

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // Two queries rather than a window function for the total: the count has no
    // LIMIT and would otherwise be recomputed per row.
    const [{ rows }, { rows: totals }] = await runAsPlatform(() => Promise.all([
      pool.query(
        `SELECT u.id, u.name, u.email, u.role, u.is_active, u.last_login,
                u.created_at, u.deleted_at, u.organization_id,
                o.name AS organization_name, o.status AS organization_status,
                -- Platform access is the grant, not the role. An account whose
                -- role says super_admin but which holds no live grant cannot
                -- reach the console (middleware/platformAuth.js), and the
                -- directory must show what is true rather than what the role
                -- column claims.
                (po.user_id IS NOT NULL) AS has_platform_grant,
                COALESCE(up.mfa_enabled, false) AS mfa_enabled,
                (SELECT count(*) FROM refresh_tokens rt
                  WHERE rt.user_id = u.id AND rt.revoked_at IS NULL
                    AND rt.expires_at > NOW())::int AS active_sessions
           FROM users u
           LEFT JOIN organizations o ON o.id = u.organization_id
           LEFT JOIN user_profiles up ON up.user_id = u.id
           LEFT JOIN platform_owners po
                  ON po.user_id = u.id AND po.revoked_at IS NULL
           ${whereSql}
          ORDER BY u.created_at DESC
          -- Interpolated, not bound, and safe: both went through intParam(),
          -- which returns a finite non-negative integer or the fallback. They
          -- are the only two values in this file that are not bind parameters,
          -- and they are numbers by construction rather than by inspection.
          LIMIT ${limit} OFFSET ${offset}`,
        params
      ),
      pool.query(`SELECT count(*)::int AS total FROM users u ${whereSql}`, params),
    ]));

    res.json({ data: rows, total: totals[0]?.total ?? 0, limit, offset });
  } catch (err) { next(err); }
});

// ── GET /users/summary ───────────────────────────────────────────────────────
//
// The counts the directory's header shows, computed in one pass rather than by
// the client fetching every page and tallying.
//
// Declared BEFORE /users/:id would be, if one existed here — a literal segment
// after a :param route is unreachable. There is no /users/:id in this module
// today, but organizations.js already owns PATCH and DELETE on that path, and
// the next person to add a GET will add it there; this note is for whoever
// wonders why the order looks defensive.
router.get('/users/summary', async (req, res, next) => {
  try {
    const { rows } = await runAsPlatform(() => pool.query(`
      SELECT
        count(*) FILTER (WHERE deleted_at IS NULL)::int                                AS total,
        count(*) FILTER (WHERE deleted_at IS NULL AND is_active)::int                  AS active,
        count(*) FILTER (WHERE deleted_at IS NULL AND NOT is_active)::int              AS inactive,
        count(*) FILTER (WHERE deleted_at IS NOT NULL)::int                            AS deleted,
        count(*) FILTER (WHERE deleted_at IS NULL AND role = 'admin')::int             AS owners,
        count(*) FILTER (WHERE deleted_at IS NULL AND role = 'trainer')::int           AS trainers,
        count(*) FILTER (WHERE deleted_at IS NULL AND role = 'member')::int            AS members,
        count(*) FILTER (WHERE deleted_at IS NULL AND role = 'super_admin')::int       AS platform,
        -- "Never signed in" is a real operational category: an invitation that
        -- was accepted but never used looks identical to an active account in
        -- every other column.
        count(*) FILTER (WHERE deleted_at IS NULL AND last_login IS NULL)::int         AS never_signed_in,
        count(*) FILTER (WHERE deleted_at IS NULL AND last_login < NOW() - INTERVAL '90 days')::int AS dormant_90d
      FROM users`));
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

module.exports = router;
