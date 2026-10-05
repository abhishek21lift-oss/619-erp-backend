'use strict';
// getRenewals SQL conventions: the conversion must be bias-free and match
// the canonical definition (metric-definitions.js).
//
// History: the cohort came from the live pt_clients row alone, so a client
// who expired in-window and renewed left the denominator (survivorship
// bias), and renewed_of_cohort carried a +30-day grace past the documented
// strict-window formula. Both are pinned here so neither drifts back.

const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'modules', 'insights', 'metric-engine.js'),
  'utf8'
);

describe('getRenewals cohort', () => {
  test('denominator unions live rows with renewal history', () => {
    expect(src).toMatch(/UNION\s+SELECT DISTINCT r\.client_id/);
    expect(src).toMatch(/r\.old_end_date::date BETWEEN \$1::date AND \$2::date/);
  });

  test('numerator uses the strict window, no grace period', () => {
    const renewedOfCohort = src.slice(src.indexOf('renewed_of_cohort AS ('));
    expect(renewedOfCohort.slice(0, 600)).not.toMatch(/INTERVAL '30 days'/);
    expect(renewedOfCohort.slice(0, 600)).toMatch(
      /r\.renewed_at::date BETWEEN \$1::date AND \$2::date/
    );
  });
});
