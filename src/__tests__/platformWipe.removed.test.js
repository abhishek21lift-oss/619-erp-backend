// The platform-wide data wipe endpoints are gone and must stay gone.
//
// routes/admin-reset.js served, at /api/admin:
//   POST /reset-all-data          DELETE every row of every studio's clients,
//                                 payments, sessions, assessments, consent and
//                                 PAR-Q records, attendance and invoices, plus
//                                 DROP TABLE outstanding_dues
//   POST /reset-outstanding-dues  set every studio's client balances to 0
//   POST /clear-dues-and-payments an alias of the above
// with no organization_id filter anywhere, no audit row, and only an emailed
// 6-digit code (from Math.random) between an operator session and all of it.
// It was once reachable by any studio owner (audit C-1). No screen called it
// and production had never used it (Command Center audit 2026-09-28, CC-2).
//
// A per-studio reset, if one is ever wanted, belongs in the console as a
// scoped, audited action with a typed confirmation, not back here.
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');

describe('platform-wide wipe endpoints', () => {
  it('the router file no longer exists', () => {
    expect(fs.existsSync(path.join(SRC, 'routes', 'admin-reset.js'))).toBe(false);
  });

  it('server.js mounts nothing at /api/admin', () => {
    const server = fs.readFileSync(path.join(SRC, 'server.js'), 'utf8');
    expect(server).not.toMatch(/app\.use\(\s*['"]\/api\/admin['"]/);
    expect(server).not.toMatch(/require\(\s*['"]\.\/routes\/admin-reset['"]\s*\)/);
  });

  it('no application code wipes a clinical or financial table without a studio filter', () => {
    // The shapes the removed router used. A DELETE/UPDATE across pt_clients or
    // pt_payments with no WHERE at all is a whole-platform operation.
    const offenders = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (!['__tests__', 'migrations'].includes(e.name)) walk(p); }
        else if (e.name.endsWith('.js')) {
          const src = fs.readFileSync(p, 'utf8');
          if (/DELETE FROM \$\{safe\}|DROP TABLE IF EXISTS \$\{|UPDATE pt_clients SET balance_amount = 0 WHERE COALESCE/.test(src)) {
            offenders.push(path.relative(SRC, p));
          }
        }
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });
});
