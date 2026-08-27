// The commission and payout system reads the trainer table the product writes to.
//
// ── BIZ-01 ──────────────────────────────────────────────────────────────────
//
// `pt_trainers` is a fork of `trainers` created by migration 018 and written to
// by nothing, ever. There is no `INSERT INTO pt_trainers` in the repository;
// migration 145 checked production and found `trainers` 6 rows, `pt_trainers` 0.
//
// Fifteen queries across pt-os.routes.js and pt-os.service.js read the fork as
// their only source. The one that mattered most is an INNER JOIN, so the effect
// was never an error — it was absence:
//
//   · calculateMonthlyCommissions produced no pt_commissions row for anyone
//   · the payout roll-up was always empty
//   · PUT /commissions/:id and PUT /payouts/:id 404'd for every trainer
//   · the PT dashboard's trainer stats and the session leaderboard were empty
//
// Migration 145 had already repointed the pt_commissions / pt_payouts foreign
// keys at `trainers`, so the writes were no longer rejected — but nothing
// produced any writes to reject. This file guards the query half.
//
// ── Why it is written against the source text ───────────────────────────────
//
// A behavioural test needs a mocked pool, and a mock returns whatever it is
// told to for `FROM pt_trainers` just as happily as for `FROM trainers` — which
// is exactly why the existing suite had ten tests over these handlers and none
// of them noticed. The defect is which table the SQL names, so that is what is
// asserted.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MODULE_DIR = path.join(__dirname, '..', 'modules', 'pt-os');
const FILES = ['pt-os.routes.js', 'pt-os.service.js'];

/** Source with comments stripped — a table named in prose is not a query. */
function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/--[^\n]*/g, '');
}

const sources = Object.fromEntries(
  FILES.map((f) => [f, code(fs.readFileSync(path.join(MODULE_DIR, f), 'utf8'))]),
);

describe('pt_trainers is not a data source', () => {
  it.each(FILES)('%s names it in no FROM, JOIN, UPDATE or INSERT', (file) => {
    const hits = sources[file].match(/\b(?:FROM|JOIN|UPDATE|INTO)\s+pt_trainers\b/gi) || [];
    expect(hits).toEqual([]);
  });

  it('nothing anywhere in src/ writes to it, which is what made reading it fatal', () => {
    // The property the whole finding rests on. If an INSERT INTO pt_trainers
    // ever appears, the table is alive again and this consolidation needs
    // revisiting rather than silently diverging a second time.
    const found = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === '__tests__' || e.name === 'migrations') continue;
          walk(p);
        } else if (e.name.endsWith('.js')) {
          if (/\bINSERT\s+INTO\s+pt_trainers\b/i.test(code(fs.readFileSync(p, 'utf8')))) found.push(p);
        }
      }
    })(path.join(__dirname, '..'));
    expect(found).toEqual([]);
  });
});

const service = () => sources['pt-os.service.js'];
const routes = () => sources['pt-os.routes.js'];

describe('the money paths read `trainers`', () => {
  it('commission generation joins trainers, and it is still an INNER JOIN', () => {
    // The INNER JOIN is correct — a commission needs a trainer to owe it to.
    // It is only dangerous when it points at an empty table, which is the whole
    // of the bug: an INNER JOIN against nothing silently produces nothing.
    expect(service()).toMatch(/FROM pt_clients c\s+JOIN trainers t ON t\.id = c\.trainer_id/);
  });

  it('the payout roll-up is driven from trainers', () => {
    expect(service()).toMatch(/FROM trainers t\s+LEFT JOIN pt_commissions pc/);
  });

  it('the payout ownership check and bulk scope resolve against trainers', () => {
    expect(routes()).toMatch(/SELECT 1 FROM trainers WHERE id = \$1 AND organization_id = \$2/);
    expect(routes()).toMatch(/SELECT id FROM trainers WHERE organization_id = \$\$\{params\.length\}/);
  });

  it('the commission-rate editor reads and writes trainers', () => {
    expect(routes()).toMatch(/SELECT id, name, incentive_rate FROM trainers WHERE id = \$1/);
    expect(routes()).toMatch(/UPDATE trainers SET incentive_rate = \$1/);
  });
});

describe('the consolidation is complete, not partial', () => {
  it('the trainer picker is a single-table read', () => {
    // A UNION here is what let the two id spaces coexist. While it stood, a
    // booked session could carry an id from either table and every downstream
    // lookup had to know that.
    const picker = routes().slice(routes().indexOf("router.get('/trainers'"));
    const body = picker.slice(0, picker.indexOf('}));'));
    expect(body).toMatch(/FROM\s+trainers/);
    expect(body).not.toMatch(/UNION/i);
  });

  it('the picker returns a real photo_url rather than a NULL literal', () => {
    // The UNION selected `NULL::text AS photo_url` for the trainers arm even
    // though that table has the column, so a trainer's photo never rendered.
    expect(routes()).not.toMatch(/NULL::text AS photo_url/i);
  });
});
