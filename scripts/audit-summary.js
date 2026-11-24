'use strict';
// The CI audit job gates on `high`, so a moderate advisory never fails a build.
// That is deliberate — an unfixable transitive advisory should not block every
// pull request — but it also meant nobody saw them: they sat in the log of a
// passing job. This turns `npm audit --json` into a few lines of markdown for
// the job summary, where a new one is visible on the pull request.
//
// Pure formatting, no network, no exit codes: a summary that cannot be built
// must never fail the job that is only trying to report.

const fs = require('fs');

const RANK = { critical: 0, high: 1, moderate: 2, low: 3, info: 4 };

function advisoriesFor(entry) {
  return (entry.via || [])
    .filter((v) => v && typeof v === 'object')
    .map((v) => v.title || v.name || v.source || 'advisory');
}

function fixLabel(entry) {
  const fix = entry.fixAvailable;
  if (fix === true) return 'yes';
  if (fix === false) return 'no';
  if (fix && typeof fix === 'object') {
    return `yes — ${fix.name}@${fix.version}${fix.isSemVerMajor ? ' (major)' : ''}`;
  }
  return 'unknown';
}

function summarise(report) {
  const vulns = (report && report.vulnerabilities) || {};
  const entries = Object.entries(vulns);
  if (!entries.length) {
    return [
      '### Production dependency advisories',
      '',
      '_npm audit reported none._',
      '',
    ].join('\n');
  }

  const counts = { critical: 0, high: 0, moderate: 0, low: 0, info: 0 };
  for (const [, entry] of entries) {
    if (counts[entry.severity] !== undefined) counts[entry.severity] += 1;
  }

  const sorted = entries.sort((a, b) => {
    const rank = (RANK[a[1].severity] ?? 9) - (RANK[b[1].severity] ?? 9);
    return rank !== 0 ? rank : a[0].localeCompare(b[0]);
  });

  const lines = [
    '### Production dependency advisories',
    '',
    `${counts.critical} critical · ${counts.high} high · ${counts.moderate} moderate · ${counts.low} low`,
    '',
    '`high` and above already failed the blocking step above. The rest are recorded here so they are',
    'seen on the pull request rather than only inside a green log.',
    '',
    '| Package | Severity | Direct | Advisory | Fix available |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const [name, entry] of sorted) {
    const titles = advisoriesFor(entry).join('; ') || '—';
    const direct = entry.isDirect ? 'yes' : 'no';
    lines.push(`| \`${name}\` | ${entry.severity} | ${direct} | ${titles} | ${fixLabel(entry)} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function main(argv) {
  const file = argv[2];
  try {
    const report = JSON.parse(fs.readFileSync(file, 'utf8'));
    process.stdout.write(summarise(report));
  } catch (err) {
    process.stdout.write([
      '### Production dependency advisories',
      '',
      `_Could not read the audit report (${err.code || err.name}). See the job log._`,
      '',
    ].join('\n'));
  }
}

if (require.main === module) main(process.argv);

module.exports = { summarise };
