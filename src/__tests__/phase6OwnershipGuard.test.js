'use strict';
// Phase 6 — the ownership guard must catch a new legacy write/read or a new
// direct AI fact query, and must still pass on the committed baseline.
//
// The fixture cases are deliberately small: each one is a shape the Phase 4/5
// work found (a retired table read, a direct pt_clients fact write, an AI
// progress query) rather than a generic SQL parser test.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { scan, stripComments, loadBaseline } = require('../../scripts/phase6-ownership-guard');

function write(root, file, text) {
  const full = path.join(root, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
}

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phase6-guard-'));
  for (const [file, text] of Object.entries(files)) write(root, file, text);
  return root;
}

describe('Phase 6 ownership guard', () => {
  test('the committed source and baseline pass together', () => {
    const result = scan();
    expect(result.violations).toEqual([]);
    expect(result.stale).toEqual([]);
    expect(result.registered).toBeGreaterThan(0);
    expect(result.ok).toBe(true);
  });

  test('all 23 registered dependencies carry an owner, reason and sunset and are unique', () => {
    const baseline = loadBaseline();
    const sections = ['legacy_writes', 'legacy_reads', 'ai_direct_reads'];
    const entries = sections.flatMap((section) => (baseline[section] || []).map((entry) => ({
      section, ...entry,
    })));
    expect(entries).toHaveLength(23);
    const keys = entries.map((entry) => `${entry.section}|${entry.file}|${entry.source}`);
    expect(new Set(keys).size).toBe(23);
    for (const entry of entries) {
      expect(entry.owner).toBeTruthy();
      expect(entry.reason).toBeTruthy();
      expect(entry.sunset).toBeTruthy();
    }
    expect(scan().registered).toBe(23);
  });

  test('comments naming a retired table are not a read', () => {
    const root = fixture({
      'src/modules/example.js': '// client_fitness_profiles was retired\nconst x = 1;\n',
    });
    const result = scan({ root, baseline: { legacy_reads: [], legacy_writes: [], ai_direct_reads: [] } });
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('a new retired-table read fails unless it is registered', () => {
    const root = fixture({
      'src/modules/example.js': "const q = 'SELECT * FROM client_fitness_profiles';\n",
    });
    const denied = scan({ root, baseline: { legacy_reads: [], legacy_writes: [], ai_direct_reads: [] } });
    expect(denied.ok).toBe(false);
    expect(denied.violations).toContainEqual({
      kind: 'legacy_read', file: 'src/modules/example.js', source: 'client_fitness_profiles',
    });

    const allowed = scan({
      root,
      baseline: {
        legacy_reads: [{
          file: 'src/modules/example.js', source: 'client_fitness_profiles',
          owner: 'test', reason: 'test', sunset: 'test',
        }],
        legacy_writes: [],
        ai_direct_reads: [],
      },
    });
    expect(allowed.ok).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('a write to a legacy pt_clients fact fails', () => {
    const root = fixture({
      'src/modules/example.js': 'UPDATE pt_clients SET weight = $2 WHERE id = $1\n',
    });
    const result = scan({ root, baseline: { legacy_reads: [], legacy_writes: [], ai_direct_reads: [] } });
    expect(result.violations).toContainEqual({
      kind: 'legacy_write', file: 'src/modules/example.js', source: 'pt_clients.weight',
    });
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('a direct AI client-fact query fails', () => {
    const root = fixture({
      'src/routes/ai.js': 'const q = `SELECT goal FROM pt_clients WHERE id=$1`;\n',
    });
    const result = scan({ root, baseline: { legacy_reads: [], legacy_writes: [], ai_direct_reads: [] } });
    expect(result.violations).toContainEqual({
      kind: 'ai_direct_read', file: 'src/routes/ai.js', source: 'pt_clients.goal',
    });
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('a registered read that disappeared is a stale baseline entry', () => {
    const root = fixture({ 'src/modules/empty.js': 'const x = 1;\n' });
    const result = scan({
      root,
      baseline: {
        legacy_reads: [{
          file: 'src/modules/empty.js', source: 'pt_os_measurements',
          owner: 'test', reason: 'test', sunset: 'test',
        }],
        legacy_writes: [],
        ai_direct_reads: [],
      },
    });
    expect(result.ok).toBe(false);
    expect(result.stale).toHaveLength(1);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('stripComments keeps SQL strings and removes both comment forms', () => {
    const text = "/* client_fitness_profiles */\n// pt_os_measurements\nconst q = 'SELECT * FROM client_fitness_profiles';\n";
    const stripped = stripComments(text);
    expect(stripped).toContain("'SELECT * FROM client_fitness_profiles'");
    expect(stripped).not.toContain('/* client_fitness_profiles */');
    expect(stripped).not.toContain('// pt_os_measurements');
  });
});
