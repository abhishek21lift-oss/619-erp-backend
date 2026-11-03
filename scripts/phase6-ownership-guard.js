#!/usr/bin/env node
'use strict';
// Phase 6 — CI ownership guard.
//
// Three rules, each aimed at a failure the Phase 4/5 work found:
//
//   1. No new write to a retired table (`pt_os_measurements`,
//      `client_fitness_profiles`) and no new write to a legacy `pt_clients`
//      fact. The one permitted write is the Fitness Testing cache sync in
//      `progress/assessments.repo.js`, which derives weight/height from the
//      newest owned assessment.
//   2. No new read of a retired table. Existing fallbacks are registered with
//      an owner, a reason and a sunset condition in
//      `phase6-legacy-read-baseline.json`.
//   3. No new direct client-fact SQL in an AI surface. AI code loads facts
//      through `authoritative-client.js` / `client-facts.js`; the few bounded
//      history reads that predate that loader are registered in the same
//      baseline.
//
// A registered item that no longer appears is also a failure: a baseline that
// only grows stops describing the code. Remove the entry in the same change
// that removes the read.
//
//   node scripts/phase6-ownership-guard.js [--json report.json]
//
// Exit codes: 0 clean, 1 violation or stale baseline, 2 usage.

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const BASELINE = path.join(__dirname, 'phase6-legacy-read-baseline.json');

const LEGACY_TABLES = ['pt_os_measurements', 'client_fitness_profiles'];
const LEGACY_CLIENT_COLUMNS = [
  'weight', 'height', 'goal', 'health_conditions', 'injuries', 'occupation',
  'workout_experience_level',
];
const FACT_TABLES = [
  'pt_assessments', 'pt_goals', 'weekly_checkins', 'pt_lifestyle_assessments',
  'pt_nutrition_assessments', 'pt_parq_forms', 'pt_client_interviews',
  'pt_mobility_performance_assessments', 'strength_logs',
];
// Files that ask a model about a client. They may use the canonical loaders;
// they may not invent a second query for a fact the loaders already own.
const AI_SURFACES = [
  'src/routes/ai.js',
  'src/routes/aiClientAgent.js',
  'src/lib/ai',
  'src/modules/pt-os/coach-ai.js',
  'src/modules/pt-os/checkin-ai.js',
  'src/modules/pt-os/client-context.js',
  'src/modules/pt-os/client-snapshot.js',
  'src/modules/pt-os/training-brief.js',
  'src/modules/pt-os/workout-generator.js',
  'src/modules/pt-os/workout-generator.repo.js',
  'src/modules/pt-os/plan-critic.js',
  'src/modules/nutrition/ai-diet.service.js',
];

/** Strip comments so documentation that names a retired table is not a read. */
function stripComments(text) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') { out += text[i + 1] || ''; i += 2; continue; }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; i += 1; continue; }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '\n') out += '\n';
        i += 1;
      }
      i += 2;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function listFiles(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) return target.endsWith('.js') ? [target] : [];
  const out = [];
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function sourceFiles(root = REPO) {
  return listFiles(path.join(root, 'src'))
    .filter((file) => !file.includes(`${path.sep}__tests__${path.sep}`))
    .filter((file) => !file.includes(`${path.sep}migrations${path.sep}`))
    .filter((file) => !file.includes(`${path.sep}architecture${path.sep}`));
}

function aiFiles(root = REPO) {
  return AI_SURFACES.flatMap((entry) => {
    const full = path.join(root, entry);
    return fs.existsSync(full) ? listFiles(full) : [];
  });
}

function rel(file, root = REPO) {
  return path.relative(root, file).split(path.sep).join('/');
}

function writeViolations(file, text, root = REPO) {
  const out = [];
  const re = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:ONLY\s+)?([a-z_][a-z0-9_]*)/gi;
  let match;
  while ((match = re.exec(text)) !== null) {
    const table = match[2].toLowerCase();
    if (LEGACY_TABLES.includes(table)) {
      out.push({ kind: 'legacy_write', file: rel(file, root), source: table });
      continue;
    }
    if (table !== 'pt_clients' || !/^UPDATE\b/i.test(match[1])) continue;
    // The statement ends at the SQL template's closing backtick or a semicolon.
    const tail = text.slice(match.index, match.index + 4000);
    const end = tail.search(/[`;]/);
    const statement = end >= 0 ? tail.slice(0, end) : tail;
    for (const column of LEGACY_CLIENT_COLUMNS) {
      if (new RegExp(`\\b${column}\\s*=`).test(statement)) {
        out.push({ kind: 'legacy_write', file: rel(file, root), source: `pt_clients.${column}` });
      }
    }
  }
  return out;
}

function legacyReadViolations(file, text, root = REPO) {
  return LEGACY_TABLES
    .filter((table) => text.includes(table))
    .map((table) => ({ kind: 'legacy_read', file: rel(file, root), source: table }));
}

function aiReadViolations(file, text, root = REPO) {
  const out = [];
  for (const table of FACT_TABLES) {
    const re = new RegExp(`\\b(?:FROM|JOIN)\\s+${table}\\b`, 'i');
    if (re.test(text)) out.push({ kind: 'ai_direct_read', file: rel(file, root), source: table });
  }
  const selectRe = /SELECT([\s\S]{0,800}?)\bFROM\s+pt_clients\b/gi;
  let match;
  while ((match = selectRe.exec(text)) !== null) {
    for (const column of LEGACY_CLIENT_COLUMNS) {
      if (new RegExp(`\\b${column}\\b`, 'i').test(match[1])) {
        out.push({ kind: 'ai_direct_read', file: rel(file, root), source: `pt_clients.${column}` });
      }
    }
  }
  return out;
}

function loadBaseline(file = BASELINE) {
  if (!fs.existsSync(file)) return { legacy_reads: [], legacy_writes: [], ai_direct_reads: [] };
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function key(kind, file, source) {
  return `${kind}|${file}|${source}`;
}

function scan({ root = REPO, baseline = loadBaseline() } = {}) {
  const violations = [];
  const scans = new Map();
  const scannedNames = new Set();
  for (const file of sourceFiles(root)) {
    const text = stripComments(fs.readFileSync(file, 'utf8'));
    scans.set(rel(file, root), text);
    scannedNames.add(rel(file, root));
    violations.push(...writeViolations(file, text, root));
    violations.push(...legacyReadViolations(file, text, root));
  }
  for (const file of aiFiles(root)) {
    const name = rel(file, root);
    const text = scans.get(name) || stripComments(fs.readFileSync(file, 'utf8'));
    scannedNames.add(name);
    violations.push(...aiReadViolations(file, text, root));
  }

  const registered = new Set();
  for (const section of ['legacy_writes', 'legacy_reads', 'ai_direct_reads']) {
    for (const entry of baseline[section] || []) {
      registered.add(key(section.replace(/s$/, ''), entry.file, entry.source));
    }
  }

  const used = new Set();
  const newViolations = [];
  for (const v of violations) {
    const k = key(v.kind, v.file, v.source);
    if (registered.has(k)) used.add(k);
    else newViolations.push(v);
  }

  const stale = [];
  for (const section of ['legacy_writes', 'legacy_reads', 'ai_direct_reads']) {
    for (const entry of baseline[section] || []) {
      const k = key(section.replace(/s$/, ''), entry.file, entry.source);
      if (!used.has(k)) stale.push({ kind: section, ...entry });
    }
  }

  return {
    ok: newViolations.length === 0 && stale.length === 0,
    scanned_files: scannedNames.size,
    registered: registered.size,
    violations: newViolations,
    stale,
  };
}

function main() {
  const i = process.argv.indexOf('--json');
  const jsonOut = i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
  let result;
  try {
    result = scan();
  } catch (err) {
    console.error(`Ownership guard could not run: ${err.message}`);
    process.exit(2);
  }

  if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify(result, null, 2));
  }

  console.log('# Phase 6 ownership guard');
  console.log(`Files scanned: ${result.scanned_files}`);
  console.log(`Registered legacy reads/writes/AI reads: ${result.registered}`);
  if (result.violations.length) {
    console.log(`\nNew unregistered ownership violations: ${result.violations.length}`);
    for (const v of result.violations) {
      console.log(`  ${v.kind} ${v.file}: ${v.source}`);
    }
    console.log('\nUse the canonical owner or add a reviewed baseline entry with owner, reason and sunset.');
  }
  if (result.stale.length) {
    console.log(`\nStale baseline entries (the code no longer has them): ${result.stale.length}`);
    for (const v of result.stale) {
      console.log(`  ${v.kind} ${v.file}: ${v.source}`);
    }
    console.log('\nRemove the stale entry in the same change that removed the read/write.');
  }
  console.log(`\nResult: ${result.ok ? 'PASS' : 'FAIL'}`);
  if (!result.ok) process.exit(1);
}

module.exports = {
  stripComments, scan, loadBaseline, LEGACY_TABLES, LEGACY_CLIENT_COLUMNS, FACT_TABLES,
};

if (require.main === module) main();
