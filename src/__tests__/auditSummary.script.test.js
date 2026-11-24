'use strict';
// The audit summary is the only place a moderate advisory becomes visible: the
// CI gate blocks on `high`, so anything lower passes the job silently.
//
// Hence these tests are about two properties:
//   1. nothing in the report is dropped from the summary, and
//   2. a report that cannot be read produces a line, not a failed build.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { summarise } = require('../../scripts/audit-summary');

const SCRIPT = path.join(__dirname, '../../scripts/audit-summary.js');

const REPORT = {
  auditReportVersion: 2,
  vulnerabilities: {
    minimatch: {
      name: 'minimatch',
      severity: 'moderate',
      isDirect: false,
      via: [{ source: 1111234, name: 'minimatch', title: 'ReDoS via globparts amplification', url: 'https://example.test/1' }],
      fixAvailable: { name: 'glob', version: '13.0.7', isSemVerMajor: false },
    },
    glob: {
      name: 'glob',
      severity: 'moderate',
      isDirect: false,
      via: ['minimatch'],
      fixAvailable: false,
    },
    '@sentry/node': {
      name: '@sentry/node',
      severity: 'high',
      isDirect: true,
      via: ['glob', 'minimatch'],
      fixAvailable: { name: '@sentry/node', version: '12.0.0', isSemVerMajor: true },
    },
    'something-low': {
      name: 'something-low',
      severity: 'low',
      isDirect: false,
      via: [],
      fixAvailable: true,
    },
  },
  metadata: {
    vulnerabilities: { info: 0, low: 1, moderate: 2, high: 1, critical: 0, total: 4 },
  },
};

function runOn(filePath) {
  return execFileSync(process.execPath, [SCRIPT, filePath], { encoding: 'utf8' });
}

describe('the dependency-audit summary', () => {
  test('lists every advisory, including the ones the gate let through', () => {
    const md = summarise(REPORT);

    expect(md).toContain('2 moderate');
    expect(md).toContain('1 high');
    for (const name of ['minimatch', 'glob', '@sentry/node', 'something-low']) {
      expect(md).toContain(`\`${name}\``);
    }
  });

  test('carries the advisory title, not just a package name', () => {
    // A table of names only would make the reader open the npm advisory by
    // hand to find out what the risk is.
    expect(summarise(REPORT)).toContain('ReDoS via globparts amplification');
  });

  test('says whether a fix exists, and whether taking it is a major bump', () => {
    const md = summarise(REPORT);
    expect(md).toContain('glob@13.0.7');
    expect(md).toContain('@sentry/node@12.0.0 (major)');
    // `fixAvailable: false` must read as "no", not as "unknown": the
    // difference decides whether an override is worth attempting.
    const globRow = md.split('\n').find((l) => l.startsWith('| `glob`'));
    expect(globRow).toMatch(/\| no \|$/);
  });

  test('puts the worst first', () => {
    const md = summarise(REPORT);
    // Severity descends; within a severity the order is alphabetical so two
    // runs of the same report never disagree.
    const order = ['@sentry/node', 'glob', 'minimatch', 'something-low']
      .map((n) => md.indexOf(`| \`${n}\``));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test('says so when the audit reported nothing', () => {
    expect(summarise({ vulnerabilities: {} })).toContain('reported none');
  });

  test('a missing report file is a line of text, not a failure', () => {
    const out = runOn(path.join(os.tmpdir(), 'definitely-not-here-audit.json'));
    expect(out).toContain('Could not read the audit report');
  });

  test('malformed JSON does not fail the job that reports it', () => {
    const file = path.join(os.tmpdir(), `audit-bad-${process.pid}.json`);
    fs.writeFileSync(file, '{ not json');
    try {
      expect(runOn(file)).toContain('Could not read the audit report');
    } finally {
      fs.unlinkSync(file);
    }
  });

  test('a real report file is rendered from disk', () => {
    const file = path.join(os.tmpdir(), `audit-good-${process.pid}.json`);
    fs.writeFileSync(file, JSON.stringify(REPORT));
    try {
      const out = runOn(file);
      expect(out).toContain('| `minimatch` | moderate | no |');
    } finally {
      fs.unlinkSync(file);
    }
  });
});
