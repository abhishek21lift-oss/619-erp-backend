// Every route that reads a tenant table must scope it to an organization.
//
// This is the standing guard for audit finding C-2. The finding is structural,
// not a bug list: verified against the live database, the app connects as
// `postgres`, which has rolbypassrls = true, and of 247 RLS policies in
// `public` exactly ZERO are organization-scoped. Every existing policy is a
// deny-all for the PostgREST `anon`/`authenticated` roles — protection against
// a leaked publishable key, not against this API.
//
// So the database cannot catch a query that forgets its tenant filter. There
// is no backstop under the application. With six live studios in production,
// one missed filter in one route is a cross-tenant data leak, and nothing
// below the Express layer would notice.
//
// Enforcing real RLS is the durable fix, and it is deliberately NOT what this
// test does — see db/migrations/TENANT-RLS-PLAN.md for the verified policy
// design and the reason it cannot land as a migration alone. Until that ships,
// the honest mitigation is to make the omission loud on the branch instead of
// silent in production. That is this test.
//
// ── Why the check is static ─────────────────────────────────────────────
//
// Same reasoning as rls.convention.test.js next door: CI has no live database,
// and a runtime check would only catch the mistake after it shipped. Reading
// the source catches it before merge.
//
// ── Why it is coarse, deliberately ──────────────────────────────────────
//
// It asserts file-level awareness — a file that queries a tenant table must
// reference the tenant helpers somewhere — not per-query correctness. A
// per-query analyser over 839 call sites would need to understand every
// dynamic WHERE-clause builder in the codebase, and would produce false
// positives on correct code. A test that cries wolf gets deleted (the comment
// in rls.convention.test.js makes the same point), so this one is built to
// have a near-zero false-positive rate and catch the failure that actually
// happens: a whole new route file written without tenancy in mind.

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');
const MIGRATIONS = path.join(SRC, 'db', 'migrations');

/**
 * Tables that carry organization_id, derived from the migrations rather than
 * hardcoded, so a tenant table added next month is covered without anyone
 * remembering to update this list.
 */
function tenantTables() {
  const found = new Set();
  for (const f of fs.readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql'))) {
    const sql = fs.readFileSync(path.join(MIGRATIONS, f), 'utf8').replace(/--[^\n]*/g, ' ');
    // Retrofit form: ALTER TABLE foo ADD COLUMN ... organization_id
    for (const m of sql.matchAll(
      /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?["']?([a-z0-9_]+)["']?\s+ADD\s+COLUMN[^;]*?organization_id/gi
    )) found.add(m[1].toLowerCase());
    // Born-multi-tenant form: CREATE TABLE foo ( ... organization_id ... )
    for (const m of sql.matchAll(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?["']?([a-z0-9_]+)["']?\s*\(([\s\S]*?)\n\s*\)/gi
    )) if (/\borganization_id\b/i.test(m[2])) found.add(m[1].toLowerCase());
  }
  return found;
}

/**
 * Tables whose rows are platform-global by design, where a bare
 * `organization_id = $org` filter would be the bug rather than the fix.
 *
 * Confirmed against production, not assumed: `exercises` holds 890 rows and
 * every single one has organization_id IS NULL — it is the shared exercise
 * library every studio draws from. Scoping it strictly would empty the library
 * for all six studios at once. Same shape for the reference tables below;
 * login_events is NULL for the 131 failed attempts where no user was
 * identified yet, so there was no org to record.
 */
const PLATFORM_GLOBAL = new Set([
  'exercises',
  'muscle_volume_landmarks',
  'diet_templates',
  'login_events',
]);

/**
 * Files allowed to touch a tenant table without referencing the tenant
 * helpers. Each entry is a reviewed exception with the reason it is safe —
 * NOT a place to silence a failure. Adding one means asserting the file
 * genuinely cannot leak across tenants.
 */
const REVIEWED_EXCEPTIONS = {
  'routes/public.js':
    'GET /api/public/stats — unauthenticated marketing endpoint returning ' +
    'platform-wide COUNTs only (studios, trainers, active clients, sessions). ' +
    'Aggregates across all tenants is the intended behaviour; it returns no ' +
    'rows, no identifiers and no PII.',
  'routes/classes.js':
    'LEFT JOIN trainers ON t.id = cs.trainer_id — resolves a trainer name for ' +
    'a class row that the surrounding query has already scoped. The join is on ' +
    'a specific FK, not an open read of the trainers table.',
  'routes/leave.js':
    'Self-lookup (SELECT id FROM trainers WHERE id = $1 OR user_id = $1, keyed ' +
    'on req.user.id) plus name-resolution joins on leave rows already scoped ' +
    'to the caller.',
  'modules/bookings/bookings.service.js':
    'Name-resolution join only. Note this module targets the legacy ' +
    'members/member_memberships tables that server.js documents as abandoned.',
  'modules/automation/automation.routes.js':
    'LEFT JOIN users u ON u.id = ar.created_by — resolves an author name for ' +
    'automation rows the surrounding query already filters. Join is on an FK.',
  'modules/command-center/alerts.service.js':
    'Platform-operator alerting. Both user queries are explicitly ' +
    "WHERE role = 'super_admin', i.e. accounts that have no organization by " +
    'design. Mounted under /api/super-admin behind requireSuperAdmin.',
  'modules/command-center/collectors/smtp.collector.js':
    'Command Center SMTP health collector — reads admin_invitations delivery ' +
    'errors platform-wide, which is the operator console\'s purpose. Mounted ' +
    'under /api/super-admin behind requireSuperAdmin + requireSuperAdminMfa.',
  'modules/platform/super-admin/shared.js':
    'audit() logs super-admin actions (organisation suspend/activate, plan ' +
    'changes, impersonation, invitations) that operate ON a tenant from ' +
    'outside it, or across several — the action does not have one owning ' +
    'organisation to filter by the way a business write does. Same shape as ' +
    'the Command Centre alerting exception above. Mounted under ' +
    '/api/super-admin behind requireSuperAdmin.',
};

/** Every route/module source file. */
function sourceFiles() {
  const out = [];
  for (const root of ['routes', 'modules']) {
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js')) out.push(p);
      }
    })(path.join(SRC, root));
  }
  return out;
}

const rel = (f) => path.relative(SRC, f).split(path.sep).join('/');

/** Tenant tables this file actually reads or writes. */
function tenantTablesUsedBy(src, tables) {
  const body = src.replace(/--[^\n]*/g, ' ');
  return [...tables].filter(
    (t) => !PLATFORM_GLOBAL.has(t) && new RegExp(`\\b(?:FROM|JOIN|INTO|UPDATE)\\s+${t}\\b`, 'i').test(body)
  );
}

/** Does the file show any awareness of the tenant boundary at all? */
function scopesByTenant(src) {
  return /tenantScope|orgIdOf|resolveOrgId|organization_id|orgGuard|clientInOrg|requireSuperAdmin/.test(src);
}

// ── Handler granularity ─────────────────────────────────────────────────
//
// Everything above asks the question per FILE. That catches a whole new route
// file written without tenancy in mind, and it is why the check was built that
// way — but it cannot catch the failure that actually happened next.
//
// GET /api/pt-os/revenue and GET /api/pt-os/trainer-performance aggregated
// pt_payments and pt_trainers for every studio on the platform. Both live in
// pt-os.routes.js, a file that references the tenant helpers roughly forty
// times, so the file-level assertion passed on every commit while any staff
// account in any studio could read another studio's revenue.
//
// So the same question is asked again, once per route handler.
//
// ── Keeping the false-positive rate near zero ───────────────────────────
//
// The comment at the top of this file is right that a test which cries wolf
// gets deleted, and a naive per-handler check cries loudly: 30 of the ~330
// handlers touch a tenant table without naming a tenant helper, and almost all
// of them are correct. Three shapes account for nearly all of that noise, and
// each is DETECTED rather than listed, so the exception list stays short
// enough to actually be read:
//
//   1. Self-scoped. The handler reaches rows through the CALLER's identity —
//      `WHERE user_id = $1` bound to req.user.id, or a handler that takes no
//      identifying input from the request at all. req.user is loaded from the
//      database by auth.js and never from the request, so such a row cannot
//      belong to another tenant.
//   2. Name-resolution join. The tenant table is only ever JOINed to put a
//      name on a row the surrounding query already selected, never read on
//      its own. Several entries in the file-level list above describe exactly
//      this shape by hand; detecting it means those files need no second,
//      handler-level exception written for them here.
//   3. Guarded. The handler defers to a helper that resolves the row inside
//      the caller's org and 404s otherwise (clientInOrg, findClientForRequest,
//      loadOrderForCaller, planReadFilter).
//
// What remains is five handlers, each genuinely unscopeable, each listed below
// with the reason. Verified against the pre-fix commit: this check flags both
// leaked endpoints and nothing else new.

/** Route handlers in a file, sliced on the router.<verb>( boundary. */
function handlersIn(src) {
  const out = [];
  const re = /router\.(get|post|put|patch|delete)\s*\(\s*(['"`])([^'"`]*)\2/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    // Balance parens from router.verb( to find where the handler ends, so a
    // block cannot bleed into the next route and inherit its scoping.
    let depth = 0;
    let end = src.indexOf('(', m.index);
    for (; end < src.length; end++) {
      if (src[end] === '(') depth++;
      else if (src[end] === ')') { depth--; if (depth === 0) break; }
    }
    out.push({
      verb: m[1].toUpperCase(),
      route: m[3],
      line: src.slice(0, m.index).split('\n').length,
      body: src.slice(m.index, end + 1),
    });
  }
  return out;
}

/** SQL-looking string and template literals inside a handler body. */
function sqlLiteralsIn(block) {
  const out = [];
  let m;
  const tpl = /`([^`\\]*(?:\\.[^`\\]*)*)`/g;
  while ((m = tpl.exec(block)) !== null) {
    if (/\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|WITH)\b/i.test(m[1])) out.push(m[1]);
  }
  const str = /(['"])((?:(?!\1)[^\\\n]|\\.)*)\1/g;
  while ((m = str.exec(block)) !== null) {
    if (/\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i.test(m[2])
      && /\b(FROM|INTO|UPDATE)\s+[a-z_]/i.test(m[2])) out.push(m[2]);
  }
  return out;
}

/** Tenant tables a single handler reads or writes. */
function tenantTablesInBlock(block, tables) {
  const hits = new Set();
  for (const sql of sqlLiteralsIn(block)) {
    for (const m of sql.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+(?:public\.)?["']?([a-z0-9_]+)["']?/gi)) {
      const t = m[1].toLowerCase();
      if (tables.has(t) && !PLATFORM_GLOBAL.has(t)) hits.add(t);
    }
  }
  return [...hits];
}

/** Names the handler takes from the request that could identify a row. */
const NOT_IDENTITY = new Set([
  'limit', 'offset', 'page', 'per_page', 'sort', 'order', 'from', 'to', 'date',
  'start', 'end', 'year', 'month', 'q', 'search', 'status', 'type', 'week',
  'range', 'days', 'format', 'hard',
]);
function requestIdentifiers(block) {
  const ids = new Set();
  for (const m of block.matchAll(/req\.(?:params|body|query)\.([a-zA-Z_]\w*)/g)) ids.add(m[1]);
  for (const m of block.matchAll(/(?:const|let)\s*\{([^}]*)\}\s*=\s*req\.(?:params|body|query)/g)) {
    for (const raw of m[1].split(',')) {
      const name = raw.split(':').pop().split('=')[0].trim();
      if (name) ids.add(name);
    }
  }
  return [...ids].filter((n) => !NOT_IDENTITY.has(n.toLowerCase()));
}

const SCOPE_HELPERS = /tenantScope|orgIdOf|orgWhere|resolveOrgId|organization_id|orgClause|requireOrg|scope\.orgId|req\.orgId|isSuperAdmin/;
// The training domain's guards (modules/training/authz.js) are the same shape
// as the ones above: each loads the row through the caller's org — and, for a
// non-admin trainer, through the client's trainer_id — and returns null when
// it is not theirs, so the handler answers 404 having established scope.
//
// Adding names to this list weakens the check unless the guards really do that,
// so they are not taken on trust: training.authz.test.js attacks each of them
// across a studio boundary with real requests, and is mutation-checked —
// removing the org predicate fails 4 of those tests, removing the trainer
// predicate fails 2, and dropping the walk back to pt_clients fails 1.
const OWNERSHIP_GUARDS = /clientInOrg|findClientForRequest|loadOrderForCaller|planReadFilter|loadEditablePlan|requireSuperAdmin|assertClientInOrg|authz\.(loadOwned|loadSession|loadPerformance|loadSet|loadCardio|canAccessClient)/;
const IDENTITY_COLUMN = /\b(user_id|member_id|pt_client_id|uploaded_by|created_by|changed_by|submitted_by|actor_id)\b/i;

/** Does the handler reach rows only through the caller's own identity? */
function selfScoped(block) {
  // \b rather than a trailing dot: `const user = req.user;` then `user.id`.
  if (!/req\.user\b/.test(block)) return false;
  // Nothing identifying came from the request, so the only rows reachable are
  // the caller's own. This is what clears /sessions/revoke-all, /my-history
  // and the WebAuthn ceremonies.
  if (requestIdentifiers(block).length === 0) return true;
  // Otherwise require an explicit identity predicate. Checked against the whole
  // block, not just the SQL literals, because predicates are often assembled
  // in a JS array — conds.push('user_id = $1') — and interpolated as ${where},
  // so the column never appears inside the template itself.
  return IDENTITY_COLUMN.test(block);
}

/** Is this table only ever JOINed, never selected from in its own right? */
function joinOnly(block, table) {
  const owned = new RegExp(`\\b(?:FROM|INTO|UPDATE)\\s+(?:public\\.)?["']?${table}\\b`, 'i');
  return !sqlLiteralsIn(block).some((sql) => owned.test(sql));
}

/**
 * Handlers allowed to read a tenant table without scoping. Same discipline as
 * REVIEWED_EXCEPTIONS above: each entry asserts the handler cannot leak.
 * Keyed `file::VERB route`.
 */
const HANDLER_EXCEPTIONS = {
  'routes/public.js::GET /stats':
    'Unauthenticated marketing endpoint returning platform-wide COUNTs only. '
    + 'Aggregating across all tenants IS the feature; it returns no rows, no '
    + 'identifiers and no PII.',
  'routes/auth.js::POST /forgot-password':
    'Pre-authentication: there is no session yet, so there is no org to scope '
    + 'to. Looks a user up by the email supplied in order to send a reset '
    + 'link, and answers identically whether or not the address exists.',
  'routes/auth.js::POST /reset-password':
    'Pre-authentication. The reset token IS the credential — it is looked up '
    + 'by hash and carries the user identity, so an org filter has nothing to '
    + 'read from and would add no protection.',
  'routes/auth-webauthn.js::POST /login/options':
    'Pre-authentication passkey ceremony. Resolves the account by email to '
    + 'return its registered credential ids; the assertion is verified against '
    + 'that account before any session is issued.',
  'routes/qr-checkin.js::GET /generate/:type/:id':
    'Returns a signed QR payload built from the id the caller supplied — it '
    + 'reads no client row for staff and echoes back nothing the caller did '
    + 'not already send. The trainer path IS ownership-checked (trainer_id = '
    + 'the caller). A code minted for a foreign id is useless: POST /scan '
    + 'resolves the person org-filtered, so the check-in simply is not found. '
    + 'See attendance.tenant-isolation.test.js.',
};

describe('tenant-scope convention — no route reads a tenant table unscoped', () => {
  const tables = tenantTables();
  const files = sourceFiles();

  it('derives the tenant-table list from the migrations, so it cannot pass vacuously', () => {
    // If this drops, the regex above stopped matching the migration style and
    // every assertion below silently checks nothing.
    expect(tables.size).toBeGreaterThan(30);
    for (const core of ['pt_clients', 'pt_payments', 'attendance_logs', 'invoices']) {
      expect(tables.has(core)).toBe(true);
    }
  });

  it('finds route files to check', () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it('every file querying a tenant table references the tenant boundary', () => {
    const offenders = [];
    for (const f of files) {
      const name = rel(f);
      if (REVIEWED_EXCEPTIONS[name]) continue;
      const src = fs.readFileSync(f, 'utf8');
      const used = tenantTablesUsedBy(src, tables);
      if (used.length && !scopesByTenant(src)) {
        offenders.push(`${name} → ${used.slice(0, 5).join(', ')}`);
      }
    }
    // A failure here means a file reads tenant-owned rows with no visible
    // organization filter, and the database will NOT stop it — the API role
    // bypasses RLS. Fix by scoping the query through lib/tenant-db.js:
    //
    //   const { orgId, applyFilter } = tenantScope(req);
    //   ... WHERE ($1::uuid IS NULL OR organization_id = $1) ...
    //
    // If the file is a genuine exception (platform-wide aggregate, super-admin
    // route, name-resolution join on an already-scoped row), add it to
    // REVIEWED_EXCEPTIONS above WITH the reason it cannot leak.
    expect(offenders).toEqual([]);
  });

  it('keeps the exception list honest — every entry still exists and still needs to be there', () => {
    // Stops the list becoming a graveyard that silently exempts files which
    // were later rewritten, moved, or fixed.
    const stale = [];
    for (const [name, reason] of Object.entries(REVIEWED_EXCEPTIONS)) {
      const full = path.join(SRC, name);
      if (!fs.existsSync(full)) { stale.push(`${name} (file no longer exists)`); continue; }
      const src = fs.readFileSync(full, 'utf8');
      if (!tenantTablesUsedBy(src, tables).length) {
        stale.push(`${name} (no longer touches a tenant table — drop the exception)`);
      }
      expect(reason.length).toBeGreaterThan(40); // a real reason, not "ok"
    }
    expect(stale).toEqual([]);
  });
});

describe('tenant-scope convention — no HANDLER reads a tenant table unscoped', () => {
  const tables = tenantTables();

  /** Every handler in the codebase, with the file it came from. */
  function allHandlers() {
    const out = [];
    for (const f of sourceFiles()) {
      const name = rel(f);
      // The platform operator console reads across tenants by definition; it
      // is gated at the mount by requireSuperAdmin + requireSuperAdminMfa.
      if (/^modules\/(platform\/super-admin|command-center)\//.test(name)) continue;
      for (const h of handlersIn(fs.readFileSync(f, 'utf8'))) out.push({ file: name, ...h });
    }
    return out;
  }

  /** Handlers that read a tenant table with nothing establishing the tenant. */
  function unscopedHandlers(handlers) {
    const out = [];
    for (const h of handlers) {
      const key = `${h.file}::${h.verb} ${h.route}`;
      if (HANDLER_EXCEPTIONS[key]) continue;
      if (SCOPE_HELPERS.test(h.body) || OWNERSHIP_GUARDS.test(h.body)) continue;
      if (selfScoped(h.body)) continue;
      const used = tenantTablesInBlock(h.body, tables).filter((t) => !joinOnly(h.body, t));
      if (used.length) out.push(`${key} → ${used.join(', ')}`);
    }
    return out;
  }

  it('can actually see the handlers it is guarding', () => {
    // Without this, a change to how routes are declared would make the whole
    // check green by finding nothing at all to look at.
    const handlers = allHandlers();
    expect(handlers.length).toBeGreaterThan(250);
    expect(handlers.some((h) => h.file === 'modules/pt-os/pt-os.routes.js')).toBe(true);
  });

  it('flags a handler that reads a tenant table with no scoping', () => {
    // The positive control, and the reason this suite can be trusted: the
    // detector is run against a handler shaped exactly like the two that
    // leaked. If the signals below ever drift far enough to clear this, the
    // check has stopped working and says so here rather than going quietly
    // green over a real leak.
    const leaky = [{
      file: 'routes/synthetic.js',
      verb: 'GET',
      route: '/revenue',
      body: "router.get('/revenue', auth, wrap(async (req, res) => {"
        + ' const { rows } = await pool.query(`SELECT SUM(amount) FROM pt_payments'
        + ' WHERE deleted_at IS NULL`); res.json({ data: rows }); }));',
    }];
    expect(unscopedHandlers(leaky)).toEqual(['routes/synthetic.js::GET /revenue → pt_payments']);
  });

  it('does not flag a handler that scopes, self-scopes, or defers to a guard', () => {
    // The negative control. Each of these is a shape the codebase uses
    // constantly; flagging any of them would make the check unusable and it
    // would be deleted rather than fixed.
    const fine = [
      { file: 'a.js', verb: 'GET', route: '/scoped', body:
        'const scope = tenantScope(req); pool.query(`SELECT * FROM pt_clients WHERE organization_id = $1`, [scope.orgId]);' },
      { file: 'b.js', verb: 'GET', route: '/self', body:
        'pool.query(`SELECT * FROM user_portfolio_items WHERE user_id = $1`, [req.user.id]);' },
      { file: 'c.js', verb: 'GET', route: '/guarded', body:
        'const client = await findClientForRequest(req); pool.query(`SELECT * FROM pt_payments WHERE client_id = $1`, [req.params.id]);' },
      { file: 'd.js', verb: 'GET', route: '/namejoin', body:
        'pool.query(`SELECT r.id, u.name FROM automation_rules r LEFT JOIN users u ON u.id = r.created_by`);' },
    ];
    expect(unscopedHandlers(fine)).toEqual([]);
  });

  it('every handler querying a tenant table establishes the tenant', () => {
    // A failure here is a cross-tenant read: the handler reaches tenant-owned
    // rows and nothing in it says whose. The database will not stop it — the
    // API role bypasses RLS — so this is the only thing standing between the
    // mistake and production.
    //
    // Fix by scoping through the file's own idiom (tenantScope/orgWhere), or
    // by deferring to a guard that resolves the row inside the caller's org.
    // If the handler genuinely cannot be scoped — pre-authentication, or a
    // deliberate platform-wide aggregate — add it to HANDLER_EXCEPTIONS above
    // WITH the reason it cannot leak.
    expect(unscopedHandlers(allHandlers())).toEqual([]);
  });

  it('keeps the handler exception list honest', () => {
    // Same reasoning as the file-level list: an exception whose handler was
    // renamed, fixed or deleted must not linger and silently exempt whatever
    // takes its place.
    const live = new Set(allHandlers().map((h) => `${h.file}::${h.verb} ${h.route}`));
    const stale = [];
    for (const [key, reason] of Object.entries(HANDLER_EXCEPTIONS)) {
      if (!live.has(key)) stale.push(`${key} (no such handler any more)`);
      expect(reason.length).toBeGreaterThan(40); // a real reason, not "ok"
    }
    expect(stale).toEqual([]);
  });
});
