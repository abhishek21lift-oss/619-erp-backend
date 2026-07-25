'use strict';
/**
 * Global search.
 *
 * The top-bar search box used to filter a hardcoded list of page names in the
 * browser. This replaces it with a real server-side search over the data the
 * studio actually cares about, starting with clients.
 *
 * ── Shape of this module ─────────────────────────────────────────────────────
 * Search is a registry of PROVIDERS, not a query. A provider owns one entity
 * type: it knows how to find rows and how to flatten them into the generic
 * result item the UI renders. Adding workouts, invoices, diet plans or files
 * later means appending a provider here — the route, the envelope and the
 * entire frontend stay untouched. That constraint is the reason every provider
 * returns the same flat item shape instead of its own row.
 *
 * ── Tenant isolation ─────────────────────────────────────────────────────────
 * Every provider receives an already-resolved scope and MUST apply it. Search
 * is the single easiest place in an app to leak another tenant's data — one
 * forgotten clause and a coach can enumerate a rival studio's client list by
 * typing letters. So the scope clause is built once, here, by `scopeClause()`,
 * and a provider that does not use it returns nothing useful. A trainer is
 * additionally pinned to their own clients; that is a stricter rule than the
 * org filter and is applied on top of it, never instead of it.
 */

const pool = require('../../db/pool');

/** Hard ceiling per group. Keeps one broad query ("a") from returning a studio's
 *  entire book, and keeps the payload small enough to stay under the latency
 *  budget on a phone. */
const MAX_LIMIT = 25;
const DEFAULT_LIMIT = 8;

/** Below this length a substring search matches almost everything and the
 *  trigram index cannot help (a trigram is 3 characters). Two characters is
 *  still allowed for initials/short codes, one is not. */
const MIN_QUERY_LENGTH = 2;

/** Fuzzy matching only kicks in from this length. Below it, "typo tolerance"
 *  is indistinguishable from returning random rows. */
const FUZZY_MIN_LENGTH = 4;

/** pg_trgm word_similarity threshold for the typo fallback. Calibrated against
 *  the requirement that "Rhul" finds "Rahul Sharma", which scores exactly 0.4;
 *  0.35 leaves headroom for a second transposition without opening the gate to
 *  unrelated names. Set explicitly in the SQL rather than relying on the
 *  pg_trgm.word_similarity_threshold GUC, because that is session state and
 *  this backend talks to a connection pooler that may not preserve it. */
const FUZZY_THRESHOLD = 0.35;

// ── Input handling ───────────────────────────────────────────────────────────

/** LIKE treats % and _ as wildcards, so a user typing "100%" would otherwise
 *  match every row. Escape them (and the escape character itself) for the
 *  pattern form of the query. The unescaped form is kept separately because
 *  word_similarity() is not a pattern match and must not see the backslashes. */
function escapeLike(value) {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Mobile numbers are stored bare and 10 digits long (validation enforces
 * /^[6-9]\d{9}$/), but people paste them with a country code, spaces and
 * dashes. Reducing to digits handles the punctuation; dropping everything
 * before the last 10 handles "+91". Keeping the tail rather than stripping a
 * literal "91" prefix also means the stored form could gain a country code
 * later without this breaking, because a substring search for the local part
 * still hits.
 */
function phoneDigits(raw) {
  const digits = (raw.match(/\d/g) || []).join('');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function normalise(raw) {
  const trimmed = String(raw ?? '').trim().slice(0, 120);
  const lower = trimmed.toLowerCase();
  return {
    raw: trimmed,
    lower,
    like: escapeLike(lower),
    digits: phoneDigits(trimmed),
  };
}

// ── Scope ────────────────────────────────────────────────────────────────────

/**
 * Builds the isolation clause every provider must include.
 *
 * `scope` comes from lib/tenant-db#tenantScope and is already fail-closed: a
 * tenant user with no organization resolves to orgId=null, and
 * `organization_id = NULL` matches no rows.
 *
 * `trainerId` is set when the caller is a trainer, pinning them to their own
 * roster. Admins and managers see the whole studio.
 */
function scopeClause({ scope, trainerId }, alias, params) {
  const clauses = [];
  if (scope.applyFilter) {
    params.push(scope.orgId);
    clauses.push(`${alias}.organization_id = $${params.length}`);
  }
  if (trainerId) {
    params.push(trainerId);
    clauses.push(`${alias}.trainer_id = $${params.length}`);
  }
  // A super admin operating platform-wide has no filter at all; that is the
  // one and only case where this returns TRUE.
  return clauses.length ? clauses.join(' AND ') : 'TRUE';
}

// ── Clients provider ─────────────────────────────────────────────────────────

/**
 * In this schema "archived" is not a status value — it is the absence of
 * `active`. lib/subscription.js defines a seat as being consumed by an ACTIVE
 * client only, so expiring, freezing or soft-deleting a client is what the
 * product means by archiving. Search groups on exactly that definition so the
 * two surfaces agree.
 */
const LIVE_PREDICATE = `(c.deleted_at IS NULL AND c.status = 'active')`;

const CLIENT_COLUMNS = `
  c.id, c.client_id, c.name, c.mobile, c.email, c.photo_url, c.goal,
  c.package_type, c.status, c.pt_end_date, c.trainer_name, c.deleted_at`;

/**
 * One query, two independently-planned branches.
 *
 * The literal branch (LIKE) can use the trigram GIN indexes. The fuzzy branch
 * (word_similarity) cannot use any index and is driven by the tenant filter
 * instead. Written as a UNION ALL rather than an OR so the planner picks the
 * right strategy for each half — an OR would force one plan for both and
 * degrade the common case to a sequential scan.
 *
 * Scores are deliberately coarse integers. The point is a stable, explainable
 * ordering (exact name > name prefix > word prefix > substring > phone > code >
 * fuzzy), not a relevance model.
 */
async function searchClients(ctx, { archived }) {
  const { q, limit } = ctx;
  const params = [q.like, q.lower, q.digits];
  const isolation = scopeClause(ctx, 'c', params);
  const groupPredicate = archived ? `NOT ${LIVE_PREDICATE}` : LIVE_PREDICATE;
  const base = `${isolation} AND ${groupPredicate}`;

  // $1 escaped-for-LIKE, $2 raw lowered (for word_similarity), $3 digits.
  const literal = `
    SELECT c.id,
           CASE
             WHEN lower(c.name) = $2                              THEN 100
             WHEN lower(c.name) LIKE $1 || '%'                    THEN 92
             -- A match at the start of any word: "sha" finds "Rahul Sharma".
             -- The leading space makes the first word behave like the rest.
             WHEN lower(' ' || c.name) LIKE '% ' || $1 || '%'     THEN 84
             WHEN lower(c.name) LIKE '%' || $1 || '%'             THEN 76
             WHEN $3 <> '' AND c.mobile LIKE $3 || '%'            THEN 72
             WHEN $3 <> '' AND c.mobile LIKE '%' || $3            THEN 70
             WHEN $3 <> '' AND c.mobile LIKE '%' || $3 || '%'     THEN 66
             WHEN c.client_id IS NOT NULL
              AND lower(c.client_id) LIKE '%' || $1 || '%'        THEN 62
             ELSE 55
           END AS score
    FROM pt_clients c
    WHERE ${base}
      AND (
            lower(c.name) LIKE '%' || $1 || '%'
        OR ($3 <> '' AND length($3) >= 3 AND c.mobile LIKE '%' || $3 || '%')
        OR (c.email IS NOT NULL AND lower(c.email) LIKE '%' || $1 || '%')
        OR (c.client_id IS NOT NULL AND lower(c.client_id) LIKE '%' || $1 || '%')
      )`;

  // Only pay for the fuzzy branch when it can plausibly help. Skipping it for
  // short queries also keeps the cheap, common case to a single index scan.
  const fuzzy = q.lower.length >= FUZZY_MIN_LENGTH
    ? `
    UNION ALL
    SELECT c.id,
           -- Capped below every literal score: a guess never outranks a match.
           (30 + word_similarity($2, lower(c.name)) * 20)::int AS score
    FROM pt_clients c
    WHERE ${base}
      AND word_similarity($2, lower(c.name)) >= ${FUZZY_THRESHOLD}
      AND lower(c.name) NOT LIKE '%' || $1 || '%'`
    : '';

  params.push(limit);
  const limitParam = `$${params.length}`;

  const sql = `
    WITH matched AS (${literal}${fuzzy}),
    ranked AS (SELECT id, max(score) AS score FROM matched GROUP BY id)
    SELECT ${CLIENT_COLUMNS}, r.score
    FROM ranked r
    JOIN pt_clients c ON c.id = r.id
    ORDER BY r.score DESC, c.name ASC
    LIMIT ${limitParam}`;

  const { rows } = await pool.query(sql, params);
  return rows;
}

/** Flattens a client row into the generic item every result card renders. */
function toClientItem(row) {
  const isLive = !row.deleted_at && row.status === 'active';
  const badges = [
    isLive
      ? { label: 'Active', tone: 'positive' }
      : { label: row.deleted_at ? 'Deleted' : titleCase(row.status || 'Inactive'), tone: 'muted' },
  ];
  if (row.package_type) badges.push({ label: row.package_type, tone: 'neutral' });

  return {
    id: row.id,
    type: 'client',
    title: row.name,
    subtitle: row.mobile || row.email || null,
    // Secondary line: what distinguishes two clients with similar names.
    meta: [row.goal, row.trainer_name && `Coach ${row.trainer_name}`]
      .filter(Boolean).join(' · ') || null,
    href: `/pt-os/clients/${row.id}`,
    avatar_url: row.photo_url || null,
    badges,
    // Typed extras for the client card. Generic consumers ignore this; the
    // client renderer uses it rather than re-deriving from the strings above.
    fields: {
      client_id: row.client_id,
      mobile: row.mobile,
      email: row.email,
      goal: row.goal,
      package_type: row.package_type,
      pt_end_date: row.pt_end_date,
      trainer_name: row.trainer_name,
      status: row.deleted_at ? 'deleted' : row.status,
      is_active: isLive,
    },
  };
}

function titleCase(s) {
  return String(s).charAt(0).toUpperCase() + String(s).slice(1);
}

// ── Provider registry ────────────────────────────────────────────────────────

/**
 * Order here IS the order the UI renders, and it encodes the product's stated
 * priority: live clients first, archived clients second. Future providers
 * (workouts, invoices, files, …) append to this list and appear automatically.
 *
 * `enabled` lets a provider opt out per request — the archived group is skipped
 * on very short queries, where it would be all noise and no signal.
 */
const PROVIDERS = [
  {
    type: 'clients',
    label: 'Clients',
    run: (ctx) => searchClients(ctx, { archived: false }).then((r) => r.map(toClientItem)),
  },
  {
    type: 'archived_clients',
    label: 'Archived clients',
    enabled: (ctx) => ctx.q.lower.length >= 3,
    run: (ctx) => searchClients(ctx, { archived: true }).then((r) => r.map(toClientItem)),
  },
];

/**
 * Runs every applicable provider and assembles the envelope.
 *
 * Providers run concurrently: they are independent queries against the same
 * pool, and running them in series would make total latency the sum of the
 * parts — exactly the thing the <200ms budget cannot afford once there are five
 * entity types instead of two.
 */
async function search({ query, scope, trainerId, limit, types }) {
  const started = Date.now();
  const q = normalise(query);

  if (q.lower.length < MIN_QUERY_LENGTH) {
    return { query: q.raw, groups: [], took_ms: Date.now() - started };
  }

  const ctx = {
    q,
    scope,
    trainerId,
    limit: Math.min(Math.max(parseInt(limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT),
  };

  const wanted = PROVIDERS.filter((p) => {
    if (types && types.length && !types.includes(p.type)) return false;
    return p.enabled ? p.enabled(ctx) : true;
  });

  const results = await Promise.all(wanted.map((p) => p.run(ctx)));

  const groups = wanted
    .map((p, i) => ({ type: p.type, label: p.label, items: results[i], total: results[i].length }))
    // An empty group is chrome with nothing in it; the UI should not have to
    // filter these out itself.
    .filter((g) => g.total > 0);

  return { query: q.raw, groups, took_ms: Date.now() - started };
}

module.exports = {
  search,
  // Exported for tests and for future providers that need the same guarantees.
  normalise,
  escapeLike,
  scopeClause,
  MAX_LIMIT,
  MIN_QUERY_LENGTH,
  FUZZY_MIN_LENGTH,
  FUZZY_THRESHOLD,
};
