'use strict';
// A capped list beside an uncapped aggregate is an uncapped endpoint.
//
// ── The shape ──────────────────────────────────────────────────────────────
//
// Both Command Centre panels looked paginated. Each returned a clamped page of
// rows, and each then ran a second query beside it for the stats strip:
//
//     SELECT id, level, … FROM system_logs WHERE … ORDER BY … LIMIT $n   ← capped
//     SELECT COUNT(*), COUNT(*) FILTER (…), MIN(logged_at) FROM system_logs
//                                                                       ← not
//
// The LIMIT is the thing a reviewer looks for, and it was there. It bounded the
// list and nothing else. The aggregate had no WHERE clause at all, so it could
// only ever be a sequential scan of the whole table, and it ran on the same
// request.
//
// ── Why it mattered here specifically ──────────────────────────────────────
//
// Measured against production before the fix:
//
//     system_logs    56,874 rows / 20MB   Seq Scan   1824 buffers   21.1 ms
//     24-hour window                      Index Scan    8 buffers    0.17 ms
//
// 21ms is not an outage. What makes it worth a test is the shape of the cost
// rather than its size:
//
//   1. The History tab polls every few seconds, so the scan was on a timer.
//   2. `system_logs` is quiet when the platform is healthy and enormous when it
//      is not — 97.7% of every row it holds came from one Redis outage between
//      4 and 14 August. The scan was therefore cheapest when nobody was looking
//      and dearest on the screen an operator opens during an incident.
//   3. Retention bounds the table's AGE at thirty days. Nothing bounded its
//      row count, so "how expensive is this" had no answer, only a history.
//
// ── What this file pins ────────────────────────────────────────────────────
//
// Not a performance number — a property, and only over the tables that grow
// without bound: an aggregate over one of them must carry a WHERE clause. It
// does not check that the clause is a GOOD bound; a test cannot know that.
// `alerts.service.js` is the reason to say so out loud, because the first
// bound written there was `status <> 'resolved' OR resolved_at > NOW() - …`,
// which satisfies every rule in this file and was measured at 194ms — SLOWER
// than the unbounded scan it replaced, because an OR across two columns cannot
// use either index. This test would have passed it. Only EXPLAIN caught it.

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');

/**
 * Tables with no natural ceiling: rows accumulate with usage and nothing
 * deletes them on a schedule the reader can rely on.
 *
 * `system_logs` is on the list despite having a retention sweep, because the
 * sweep bounds the window and not the volume — see the header.
 */
const UNBOUNDED_TABLES = new Set([
  'system_logs', 'system_alerts', 'notifications', 'activity_log',
  'login_events', 'ai_usage_log', 'ai_messages', 'attendance',
  'payments', 'membership_payments', 'invoices', 'expenses',
  'payment_audit_logs', 'subscription_events', 'bookings',
  'pt_sessions', 'training_sessions', 'workout_sessions', 'set_performances',
]);

/**
 * Aggregates that are deliberately unbounded, each with the reason.
 *
 * An entry is a claim that reading every row is the point, not that the test
 * is inconvenient. Both current entries are index-only scans of a single
 * value, which is why they cost 3 buffers rather than 1,824.
 */
const ALLOWED_UNBOUNDED = {
  'MIN(logged_at) AS oldest':
    'How far back history goes — the one question a windowed count cannot answer. Index-only scan backward on system_logs_time_idx, measured at 3 buffers, and it reads exactly one row.',
};

/** Strip comments so prose about SQL is not read as SQL. */
function stripComments(js) {
  return js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Every string literal in the tree that looks like a statement.
 *
 * Backticks AND long quoted strings. A first draft read only backticks, and so
 * could not see `pool.query('SELECT MIN(logged_at) AS oldest FROM system_logs')`
 * — a query with no WHERE, over one of the listed tables, sitting in the very
 * handler this test was written for. It happened to be the one such query that
 * is fine (index-only scan, one row), but the scanner did not know that; it
 * simply could not see it. A guard with a blind spot in the same place as the
 * code it guards is the failure this whole directory keeps re-learning.
 */
function sqlLiterals() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === '__tests__' || e.name === 'db') continue;
        walk(p);
      } else if (e.name.endsWith('.js')) {
        const src = stripComments(fs.readFileSync(p, 'utf8'));
        const matches = [
          ...src.matchAll(/`([^`]*)`/g),
          ...src.matchAll(/'([^'\n]{20,})'/g),
          ...src.matchAll(/"([^"\n]{20,})"/g),
        ];
        for (const m of matches) {
          const raw = m[1];
          if (!/\bSELECT\b[\s\S]*\bFROM\b/i.test(raw)) continue;
          out.push({
            file: p.replace(`${SRC}/`, 'src/'),
            line: src.slice(0, m.index).split('\n').length,
            sql: raw,
            flat: raw.replace(/\s+/g, ' ').trim(),
          });
        }
      }
    }
  };
  walk(SRC);
  return out;
}

/** The table a statement reads FROM, lowercased, or null. */
function fromTable(flat) {
  const m = flat.match(/\bFROM\s+(?:ONLY\s+)?["']?([a-z][a-z0-9_]*)/i);
  return m ? m[1].toLowerCase() : null;
}

/** Does the statement aggregate over many rows? */
function isAggregate(flat) {
  return /\b(?:COUNT|SUM|AVG)\s*\(/i.test(flat);
}

/**
 * Does it constrain what it reads?
 *
 * A WHERE, or a join whose ON carries a parameter, both narrow the scan. This
 * is intentionally generous — the point is to catch the aggregate with NO
 * predicate whatsoever, which is what both real defects were.
 */
function isBounded(flat, fileSrc) {
  if (/\bWHERE\b/i.test(flat)) return true;
  if (/\bON\s+[^)]*\$\d/i.test(flat)) return true;

  // The capped-count idiom: `SELECT COUNT(*) FROM (SELECT 1 FROM t … LIMIT n)`.
  // The LIMIT has to be the one CLOSING a subquery. A bare trailing `LIMIT 1`
  // on an aggregate bounds the rows returned, which is always one, and bounds
  // nothing about the scan underneath it.
  if (/\bLIMIT\s+[^)]*\)/i.test(flat)) return true;

  // A WHERE built elsewhere and interpolated in: `${whereSql}`.
  //
  // Two conditions, and the second was found by mutation rather than by
  // thinking about it.
  //
  // FIRST: the identifier must be assigned a template literal that BEGINS with
  // WHERE. Anything conditional bounds only sometimes, and the "sometimes not"
  // case is the unfiltered request this test exists to catch:
  //
  //     const whereSql = `WHERE ${where.join(' AND ')}`;        always bounds
  //     return { clause: where.length ? `WHERE ...` : '', ... } sometimes
  //
  // SECOND: no OTHER binding of that name may exist in the file. Matching a
  // name across a whole file ignores which function it belongs to, and
  // security.js has two different `clause` variables in two different
  // handlers — one conditional (buildLoginFilter, line 48) and one
  // unconditional (the sessions handler, line 236). The unconditional one
  // vouched for the conditional one, and the guard passed a login-events count
  // with its ceiling deleted. Shadowing beat it.
  //
  // So: bounded only when every binding of the name agrees. Anything ambiguous
  // is treated as unbounded, because a guard that guesses in the permissive
  // direction is the thing being guarded against.
  for (const m of flat.matchAll(/\$\{([A-Za-z_$][\w$]*)\}/g)) {
    const name = m[1];
    const unconditional = new RegExp('\\b' + name + '\\s*=\\s*`\\s*WHERE\\b', 'i');
    if (!unconditional.test(fileSrc)) continue;
    // Any other way of binding the same name: an object property, or a
    // destructuring that pulls it out of a function's return value.
    const otherBinding = new RegExp(
      '\\b' + name + '\\s*:' + '|' + '\\{[^{}]*\\b' + name + '\\b[^{}]*\\}\\s*=', '');
    if (otherBinding.test(fileSrc)) continue;
    return true;
  }
  return false;
}

describe('aggregates over unbounded tables carry a bound', () => {
  const literals = sqlLiterals();
  const fileSources = new Map();
  for (const lit of literals) {
    if (!fileSources.has(lit.file)) {
      fileSources.set(lit.file, fs.readFileSync(path.join(SRC, '..', lit.file), 'utf8'));
    }
  }

  it('finds a real corpus of SQL to check', () => {
    // A scanner matching nothing would make every assertion below vacuous —
    // the failure mode of every source-reading guard in this directory.
    expect(literals.length).toBeGreaterThan(100);
  });

  it('no aggregate reads an unbounded table with no predicate at all', () => {
    const offenders = [];
    for (const lit of literals) {
      const table = fromTable(lit.flat);
      if (!table || !UNBOUNDED_TABLES.has(table)) continue;
      if (!isAggregate(lit.flat)) continue;
      if (isBounded(lit.flat, fileSources.get(lit.file))) continue;
      if (Object.keys(ALLOWED_UNBOUNDED).some((k) => lit.flat.includes(k))) continue;
      offenders.push(`${lit.file}:${lit.line} [${table}] ${lit.flat.slice(0, 120)}`);
    }
    // system_logs and system_alerts each sat here.
    expect(offenders.sort()).toEqual([]);
  });

  it('every deliberate exemption gives a reason, not a shrug', () => {
    for (const [sql, reason] of Object.entries(ALLOWED_UNBOUNDED)) {
      expect(reason.length).toBeGreaterThan(60);
      expect(sql.length).toBeGreaterThan(0);
    }
  });

  it('the exemption list still describes SQL that exists', () => {
    // An exemption that outlives its query is a note about a problem nobody
    // has any more, and it silently widens the rule for the next one.
    const body = literals.map((l) => l.flat).join('\n');
    for (const sql of Object.keys(ALLOWED_UNBOUNDED)) {
      expect(body).toContain(sql);
    }
  });
});

describe('the two aggregates this was written for stay bounded', () => {
  // Named, so deleting the bound fails by name rather than by a count moving.
  it('the log history stats query is windowed', () => {
    const src = fs.readFileSync(
      path.join(SRC, 'modules', 'command-center', 'command-center.routes.js'), 'utf8');
    expect(src).toMatch(/WHERE logged_at > NOW\(\) - \(\$1 \|\| ' hours'\)::interval/);
    // The window is clamped at both ends: 0 or a negative would be read as
    // "no window", and an unbounded upper end is the bug wearing a parameter.
    expect(src).toMatch(/Math\.min\(Math\.max\(Number\(req\.query\.stats_hours\) \|\| 24, 1\), 720\)/);
  });

  it('the alert stats query is split into two indexed halves', () => {
    // stripComments, not the raw file. The comment above these queries QUOTES
    // the one-query form in order to explain why it is wrong, and a raw-text
    // check would read that explanation as the defect returning. The same slip
    // has now happened twice in this repo — once with a `requireStaff` check
    // that matched the word inside an inserted comment.
    const src = stripComments(fs.readFileSync(
      path.join(SRC, 'modules', 'command-center', 'alerts.service.js'), 'utf8'));
    expect(src).toMatch(/FROM system_alerts\s+WHERE status <> 'resolved'/);
    expect(src).toMatch(/AND resolved_at > NOW\(\) - INTERVAL '24 hours'/);
    // The one-query form passes every rule above and is slower than the bug.
    expect(src).not.toMatch(/status <> 'resolved'\s*\n?\s*OR resolved_at/);
  });

  it('migration 178 supplies the index the resolved arm needs', () => {
    const dir = path.join(SRC, 'db', 'migrations');
    const f = fs.readdirSync(dir).find((n) => n.startsWith('178_'));
    expect(f).toBeDefined();
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS system_alerts_resolved_recent_idx/);
    expect(sql).toMatch(/WHERE status = 'resolved'/);
  });
});

describe('no page size or offset is clamped on one side only', () => {
  // `Math.min(x, MAX)` reads as a clamp and is half of one. Postgres does not
  // treat a negative LIMIT as an empty page or a negative OFFSET as zero — it
  // rejects both outright:
  //
  //     LIMIT must not be negative      (SQLSTATE 2201W)
  //     OFFSET must not be negative     (SQLSTATE 2201X)
  //
  // Verified against the production server rather than assumed. So a one-sided
  // clamp is not a cosmetic issue: `?limit=-1` is a 500 that any caller can
  // trigger from the query string, on sixteen endpoints as first found.
  //
  // `parseInt(x) || DEFAULT` does not save it. That catches NaN and 0, and a
  // negative is neither — `Number('-1')` is truthy, so the fallback never
  // fires and the value reaches SQL intact.
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'db') walk(p); }
      else if (e.name.endsWith('.js')) files.push(p);
    }
  };
  walk(SRC);

  it('reads a real set of files', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('every Math.min over a query-string limit or offset has a Math.max', () => {
    const offenders = [];
    for (const f of files) {
      const src = stripComments(fs.readFileSync(f, 'utf8'));
      src.split('\n').forEach((line, i) => {
        if (!/req\.query\.(limit|offset)/.test(line)) return;
        if (!/Math\.min\s*\(/.test(line)) return;
        if (/Math\.max\s*\(/.test(line)) return;
        offenders.push(`${f.replace(`${SRC}/`, 'src/')}:${i + 1} ${line.trim()}`);
      });
    }
    expect(offenders.sort()).toEqual([]);
  });

  it('an offset taken straight from the query string is floored', () => {
    const offenders = [];
    for (const f of files) {
      const src = stripComments(fs.readFileSync(f, 'utf8'));
      src.split('\n').forEach((line, i) => {
        const m = line.match(/\boffset\s*=\s*(parseInt|Number)\s*\(\s*req\.query\.offset/);
        if (!m) return;
        if (/Math\.max\s*\(/.test(line)) return;
        offenders.push(`${f.replace(`${SRC}/`, 'src/')}:${i + 1} ${line.trim()}`);
      });
    }
    expect(offenders.sort()).toEqual([]);
  });
});

describe('list endpoints clamp their page size at both ends', () => {
  // A clamp with only an upper bound still lets `?limit=0` or `?limit=-1`
  // through, and a negative LIMIT is a syntax error rather than an empty page.
  it.each([
    ['modules/command-center/command-center.routes.js', /Math\.min\(Math\.max\(Number\(req\.query\.limit\) \|\| 100, 1\), 500\)/],
    ['modules/command-center/alerts.service.js', /Math\.min\(Math\.max\(Number\(limit\) \|\| 100, 1\), 500\)/],
    ['modules/notifications/notifications.service.js', /Math\.min\(Math\.max\(Number\(limit\) \|\| 50, 1\), 200\)/],
    ['modules/pt-os/pt-os.routes.js', /Math\.min\(Math\.max\(parseInt\(req\.query\.limit, 10\) \|\| 200, 1\), 500\)/],
  ])('%s clamps', (rel, re) => {
    expect(fs.readFileSync(path.join(SRC, rel), 'utf8')).toMatch(re);
  });

  // Computing a clamp and using it are two facts, and a test for the first
  // proves nothing about the second. Deleting the `LIMIT` from the pt-os
  // sessions query left every clamp assertion above still passing, because the
  // clamped variable was simply no longer referenced by the SQL.
  it.each([
    ['modules/pt-os/pt-os.routes.js', /ORDER BY s\.session_date DESC, s\.start_time\s*\n\s*LIMIT \$\$\{params\.length\}/],
    ['modules/training/training.routes.js', /ORDER BY s\.session_date DESC, s\.created_at DESC LIMIT \$\$\{params\.length\}/],
    ['modules/command-center/alerts.service.js', /last_seen_at DESC\s*\n\s*LIMIT \$1/],
    ['modules/notifications/notifications.service.js', /ORDER BY created_at DESC LIMIT \$2/],
  ])('%s actually applies its LIMIT to the query', (rel, re) => {
    expect(stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'))).toMatch(re);
  });
});
