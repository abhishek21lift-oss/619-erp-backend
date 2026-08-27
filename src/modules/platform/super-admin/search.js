'use strict';
// Global search — the Command Centre's ⌘K backend.
//
// The CommandBar (frontend) navigates to tabs but until this module
// shipped it could not search across the platform's actual data. Now
// it can: one endpoint, one query, every result carries its org_id so
// the UI can render "Acme Fitness · studio · Growth" rather than
// "Acme Fitness" alone.
//
// The brief's rule: never return ambiguous records from different
// tenants without showing their organization. This module enforces
// that structurally: every SELECT projects organization_id, every
// response row carries org_id (the same field name, regardless of
// kind), and the UI cannot strip it without deliberately not
// rendering a field it has.
//
// The endpoint is read-only. It does not write to activity_log
// (search is not an action; every successful read on a tenant record
// is the platform admin reading their own platform, not a mutation
// on the tenant).
//
// Mounted on the platform router. Inherits the auth chain.

const router = require('express').Router();
const { pool } = require('./shared');

const DEFAULT_KINDS = ['studio', 'owner', 'trainer', 'client'];
const ALLOWED_KINDS = new Set(['studio', 'owner', 'trainer', 'client', 'subscription', 'invoice', 'audit']);
const SEARCH_LIMIT_PER_KIND = 10;
const SEARCH_TOTAL_LIMIT = 50;
const MAX_QUERY_LENGTH = 100;

// Sanitise free-text search input against ILIKE pattern injection.
// A query of `%` would match every row; backslash and underscore are
// also wildcard metacharacters. We escape them and wrap in %...% for
// the partial-match. The trim() caps the length so a 10MB query
// cannot be a vector for log bloat.
function escapeLike(s) {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

router.get('/search', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, MAX_QUERY_LENGTH);
    const kindsParam = String(req.query.kinds || '').trim();
    const kinds = (kindsParam ? kindsParam.split(',') : DEFAULT_KINDS)
      .map(k => k.trim())
      .filter(k => ALLOWED_KINDS.has(k));

    if (q.length < 2) {
      return res.json({ data: [], query: q, kinds, total: 0 });
    }
    if (kinds.length === 0) {
      return res.status(400).json({
        error: { code: 'BAD_KINDS', message: 'kinds must include at least one of: ' + Array.from(ALLOWED_KINDS).join(', ') },
      });
    }

    const pattern = `%${escapeLike(q)}%`;
    const results = [];
    const perKindLimit = Math.max(
      1,
      Math.min(SEARCH_LIMIT_PER_KIND, Math.floor(SEARCH_TOTAL_LIMIT / kinds.length))
    );

    if (kinds.includes('studio')) {
      const { rows } = await pool.query(`
        SELECT o.id, o.name, o.slug, o.status, o.organization_id AS org_id
          FROM organizations o
         WHERE o.name ILIKE $1 ESCAPE '\\' OR o.slug ILIKE $1 ESCAPE '\\'
         ORDER BY o.created_at DESC
         LIMIT $2
      `, [pattern, perKindLimit]);
      rows.forEach(r => results.push({
        kind: 'studio',
        id: r.id,
        org_id: r.org_id,
        title: r.name,
        subtitle: r.slug,
        status: r.status,
        url: `/platform/studios/${r.org_id}`,
      }));
    }

    if (kinds.includes('owner')) {
      const { rows } = await pool.query(`
        SELECT u.id, u.name, u.email, u.organization_id AS org_id, o.name AS org_name
          FROM users u
          JOIN organizations o ON o.id = u.organization_id
         WHERE u.role = 'admin'
           AND u.deleted_at IS NULL
           AND (u.name ILIKE $1 ESCAPE '\\' OR u.email ILIKE $1 ESCAPE '\\')
         ORDER BY u.last_login DESC NULLS LAST
         LIMIT $2
      `, [pattern, perKindLimit]);
      rows.forEach(r => results.push({
        kind: 'owner',
        id: r.id,
        org_id: r.org_id,
        title: r.name,
        subtitle: `${r.email} · ${r.org_name}`,
        url: `/platform/studios/${r.org_id}`,
      }));
    }

    if (kinds.includes('trainer')) {
      const { rows } = await pool.query(`
        SELECT t.id, t.name, t.email, t.organization_id AS org_id, o.name AS org_name
          FROM trainers t
          JOIN organizations o ON o.id = t.organization_id
         WHERE t.deleted_at IS NULL
           AND (t.name ILIKE $1 ESCAPE '\\' OR t.email ILIKE $1 ESCAPE '\\')
         ORDER BY t.created_at DESC
         LIMIT $2
      `, [pattern, perKindLimit]);
      rows.forEach(r => results.push({
        kind: 'trainer',
        id: r.id,
        org_id: r.org_id,
        title: r.name,
        subtitle: `${r.email} · ${r.org_name}`,
        url: `/platform/studios/${r.org_id}`,
      }));
    }

    if (kinds.includes('client')) {
      const { rows } = await pool.query(`
        SELECT c.id, c.name, c.organization_id AS org_id, o.name AS org_name
          FROM pt_clients c
          JOIN organizations o ON o.id = c.organization_id
         WHERE c.deleted_at IS NULL
           AND c.name ILIKE $1 ESCAPE '\\'
         ORDER BY c.created_at DESC
         LIMIT $2
      `, [pattern, perKindLimit]);
      rows.forEach(r => results.push({
        kind: 'client',
        id: r.id,
        org_id: r.org_id,
        title: r.name,
        subtitle: r.org_name,
        url: `/platform/studios/${r.org_id}`,
      }));
    }

    if (kinds.includes('subscription')) {
      const { rows } = await pool.query(`
        SELECT s.id, s.plan_code, s.status, s.ends_at,
               s.organization_id AS org_id, o.name AS org_name
          FROM subscriptions s
          JOIN organizations o ON o.id = s.organization_id
         WHERE o.name ILIKE $1 ESCAPE '\\' OR s.plan_code ILIKE $1 ESCAPE '\\'
         ORDER BY s.created_at DESC
         LIMIT $2
      `, [pattern, perKindLimit]);
      rows.forEach(r => results.push({
        kind: 'subscription',
        id: r.id,
        org_id: r.org_id,
        title: `${r.plan_code} · ${r.status}`,
        subtitle: `${r.org_name} · ends ${r.ends_at ? new Date(r.ends_at).toISOString().slice(0, 10) : '—'}`,
        url: `/platform/billing/subscriptions?org=${r.org_id}`,
      }));
    }

    if (kinds.includes('invoice')) {
      const { rows } = await pool.query(`
        SELECT i.id, i.invoice_number, i.amount_inr, i.status, i.issued_at,
               i.organization_id AS org_id, o.name AS org_name
          FROM subscription_invoices i
          JOIN organizations o ON o.id = i.organization_id
         WHERE i.invoice_number ILIKE $1 ESCAPE '\\' OR o.name ILIKE $1 ESCAPE '\\'
         ORDER BY i.issued_at DESC
         LIMIT $2
      `, [pattern, perKindLimit]);
      rows.forEach(r => results.push({
        kind: 'invoice',
        id: r.id,
        org_id: r.org_id,
        title: r.invoice_number,
        subtitle: `${r.org_name} · ₹${Number(r.amount_inr).toLocaleString('en-IN')} · ${r.status}`,
        url: `/platform/billing/invoices?id=${r.id}`,
      }));
    }

    if (kinds.includes('audit')) {
      const { rows } = await pool.query(`
        SELECT a.id, a.action, a.user_name, a.created_at,
               u.organization_id AS org_id, o.name AS org_name
          FROM activity_log a
          LEFT JOIN users u ON u.id = a.user_id
          LEFT JOIN organizations o ON o.id = u.organization_id
         WHERE a.action ILIKE $1 ESCAPE '\\'
            OR a.user_name ILIKE $1 ESCAPE '\\'
            OR a.entity_id::text ILIKE $1 ESCAPE '\\'
         ORDER BY a.created_at DESC
         LIMIT $2
      `, [pattern, perKindLimit]);
      rows.forEach(r => results.push({
        kind: 'audit',
        id: r.id,
        org_id: r.org_id,
        title: r.action,
        subtitle: `${r.user_name || '—'} · ${r.org_name || '—'} · ${new Date(r.created_at).toISOString().slice(0, 16).replace('T', ' ')}`,
        url: `/platform/security/audit?id=${r.id}`,
      }));
    }

    res.json({ data: results.slice(0, SEARCH_TOTAL_LIMIT), query: q, kinds, total: results.length });
  } catch (err) { next(err); }
});

module.exports = router;
