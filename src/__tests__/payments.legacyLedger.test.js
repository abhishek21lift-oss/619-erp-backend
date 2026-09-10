'use strict';
// No runtime code may read or write the legacy `payments` ledger.
//
// ── Why that table was different from every other legacy one ────────────────
//
// `payments` had no organization_id column. Not "was missing a filter" — there
// was nothing to filter ON, so any row it held was unattributable to a studio
// and unreachable by a tenant-scoped read. Money in a multi-tenant system with
// no tenant on it.
//
// It held 0 rows, and that is the only reason nothing leaked. The safety came
// from the data, not the code: routes/payments.js UNION'd it into the ledger
// read with `NULL::uuid AS organization_id`, and its DELETE/UPDATE fallback
// carried no org clause at all. One inserted row would have turned a payment
// list into a cross-tenant financial read and a delete-by-id into a
// cross-tenant write.
//
// Migration 191 drops the table. This is what keeps it from coming back — and
// what would have caught the four writers that outlived their own usefulness:
//
//   invoices.js         INSERT of an unscopable row on invoice settlement
//   trainers.js         revenue trend reading the empty table (a flat-zero chart)
//   razorpay-webhook.js three UPDATEs naming columns that never existed
//   renewal.worker.js   INSERT for the gym-era membership model
//
// ── Why a source scan and not a request test ────────────────────────────────
//
// The defect is not "returns the wrong answer", it is "this query exists at
// all". After 191 the table is gone, so any statement naming it is a
// guaranteed error rather than merely an unscopable read — there is no file
// left where it would be acceptable.

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');

/**
 * `payments` as a table name, never `pt_payments`, `subscription_payments`,
 * `payment_orders` or any other table whose name merely contains it.
 *
 * The negative lookbehind on `_` is what separates it from pt_payments and
 * subscription_payments, both of which are legitimate and heavily used.
 */
const LEGACY_SQL = /\b(?:FROM|UPDATE|INTO|JOIN)\s+(?:public\.)?(?<![_a-z])payments\b/i;

/** Runtime .js under src/, excluding tests and migrations. */
function runtimeFiles(dir = SRC, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === 'migrations' || e.name === 'node_modules') continue;
      runtimeFiles(full, out);
    } else if (e.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

/** Source with comment lines stripped — comments are the record of WHY these
 *  were removed and quote the very SQL this forbids. */
function executableLines(file) {
  return fs.readFileSync(file, 'utf8').split('\n').map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return '';
    return line.replace(/\/\/.*$/, '');
  });
}

describe('the legacy payments ledger is gone and stays gone', () => {
  test('the scan can see a meaningful number of files', () => {
    // Without this a broken walk would make every assertion below pass against
    // nothing at all.
    expect(runtimeFiles().length).toBeGreaterThan(50);
  });

  test('no runtime file reads or writes the legacy `payments` table', () => {
    const offenders = [];
    for (const file of runtimeFiles()) {
      const rel = path.relative(SRC, file);
      executableLines(file).forEach((code, i) => {
        if (LEGACY_SQL.test(code)) offenders.push(`${rel}:${i + 1}  ${code.trim().slice(0, 90)}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  test('nothing writes to it in particular — no INSERT, UPDATE or DELETE', () => {
    // Stated separately from the read scan because a write to an unscopable
    // ledger is the worse half: it creates money nobody can attribute.
    const WRITE = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:public\.)?(?<![_a-z])payments\b/i;
    const offenders = [];
    for (const file of runtimeFiles()) {
      executableLines(file).forEach((code, i) => {
        if (WRITE.test(code)) offenders.push(`${path.relative(SRC, file)}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  test('the pattern distinguishes `payments` from every table that contains it', () => {
    // The whole guard rests on this regex. Matching pt_payments would make the
    // suite unpassable; missing `payments` would make it useless.
    expect(LEGACY_SQL.test('SELECT * FROM payments WHERE id=$1')).toBe(true);
    expect(LEGACY_SQL.test('INSERT INTO payments (id) VALUES ($1)')).toBe(true);
    expect(LEGACY_SQL.test('UPDATE payments SET deleted_at = NOW()')).toBe(true);
    expect(LEGACY_SQL.test('JOIN payments p ON p.trainer_id = t.id')).toBe(true);
    expect(LEGACY_SQL.test('FROM public.payments lp')).toBe(true);

    expect(LEGACY_SQL.test('SELECT * FROM pt_payments WHERE id=$1')).toBe(false);
    expect(LEGACY_SQL.test('UPDATE pt_payments SET deleted_at = NOW()')).toBe(false);
    expect(LEGACY_SQL.test('JOIN subscription_payments sp ON sp.id = si.payment_id')).toBe(false);
    expect(LEGACY_SQL.test('FROM payment_orders WHERE id = $1')).toBe(false);
    expect(LEGACY_SQL.test('FROM payment_submissions')).toBe(false);
  });

  test('migration 191 exists and refuses to drop a non-empty table', () => {
    // The guarantee that makes dropping a financial table acceptable. If the
    // count check is ever removed, this migration stops being safe to run.
    const mig = fs.readFileSync(
      path.join(SRC, 'db', 'migrations', '191_drop_legacy_payments.sql'), 'utf8');
    expect(mig).toMatch(/SELECT count\(\*\) FROM public\.payments/i);
    // The count and the ABORT must be tied together. Asserting `RAISE
    // EXCEPTION` alone was too loose to be a guard: the file carries other
    // exceptions in its verification block, so downgrading this one to a
    // NOTICE — which would let the migration drop a ledger with money in it —
    // left the assertion passing. Found by mutation. Pin the refusal itself.
    expect(mig).toMatch(/RAISE EXCEPTION\s*\n?\s*'191 refused/);
    const guardBlock = mig.slice(
      mig.indexOf('SELECT count(*) FROM public.payments'),
      mig.indexOf('DROP VIEW'));
    expect(guardBlock).toMatch(/RAISE EXCEPTION/);
    expect(guardBlock).not.toMatch(/RAISE NOTICE\s*\n?\s*'191 (refused|proceeding)/);
    expect(mig).toMatch(/DROP TABLE IF EXISTS public\.payments/i);
    // And it must leave the canonical ledger alone.
    expect(mig).not.toMatch(/DROP TABLE[^\n]*pt_payments/i);
  });

  test('nothing selects the legacy ledger\'s column names off pt_payments', () => {
    // The bug this catches was live: routes/trainers.js selected client_name,
    // method and receipt_no FROM pt_payments — the legacy ledger's names,
    // left behind when the FROM was repointed and the column list was not.
    // pt_payments has none of them (it has client_id, payment_method,
    // payment_ref), so the trainer page raised on every load.
    //
    // Matched within a single statement rather than per line, because these
    // queries are template literals spanning many lines.
    const LEGACY_COLS = /\bFROM\s+pt_payments\b/i;
    const offenders = [];
    for (const file of runtimeFiles()) {
      const src = executableLines(file).join('\n');
      // Each `SELECT ... FROM pt_payments` chunk, projection only.
      for (const m of src.matchAll(/SELECT\s([\s\S]{0,900}?)FROM\s+pt_payments\b/gi)) {
        const projection = m[1];
        // Unqualified only: `c.name AS client_name` and `p.payment_ref AS
        // receipt_no` are aliases OUT, which is the correct fix, not the bug.
        for (const col of ['client_name', 'receipt_no']) {
          const bare = new RegExp(`(^|[,\\s(])${col}\\s*(,|$|\\s)`, 'm');
          if (bare.test(projection) && !new RegExp(`AS\\s+${col}`, 'i').test(projection)) {
            offenders.push(`${path.relative(SRC, file)}: selects bare ${col} from pt_payments`);
          }
        }
      }
    }
    expect(LEGACY_COLS.test('FROM pt_payments')).toBe(true);   // the matcher works
    expect(offenders).toEqual([]);
  });

  test('the domain manifest no longer claims the table', () => {
    const { DOMAINS } = require('../architecture/domains');
    const finance = DOMAINS['payments-finance'] || DOMAINS.finance
      || Object.values(DOMAINS).find((d) => (d.tables || []).includes('pt_payments'));
    expect(finance).toBeDefined();
    expect(finance.tables).toContain('pt_payments');
    expect(finance.tables).not.toContain('payments');
    expect(finance.legacyTables || []).not.toContain('payments');
  });
});
