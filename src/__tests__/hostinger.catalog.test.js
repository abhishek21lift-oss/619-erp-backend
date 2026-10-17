'use strict';
// The catalogue, checked against the official specification snapshot.
//
// ── Why this is the most important test in the module ──────────────────────
//
// Every other file trusts this table. If a path is misspelled, a parameter is
// named differently, or a required flag is inverted, the failure surfaces as a
// 404 or a silently ignored filter on a call that can recreate a production
// VPS — and it surfaces in production, weeks later, as "the console is wrong".
//
// So the assertions here are mechanical and complete: path, method, parameter
// names, parameter locations, required flags and every `{placeholder}` in the
// path. spec.json is generated from Hostinger's published OpenAPI document by
// scripts/hostinger-extract-spec.js; refresh it, and this test tells you
// exactly which catalogue entries need to move with it.

const fs = require('fs');
const path = require('path');
const catalog = require('../lib/hostinger/catalog');

const spec = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'lib', 'hostinger', 'spec.json'), 'utf8')
);

const entries = Object.entries(catalog.OPERATIONS);
const specParams = (key) => spec.operations[key].parameters || [];

/** The parameters a spec operation declares in one location. */
function paramsIn(key, where) {
  return specParams(key).filter((p) => p.in === where);
}

const SAFETY = new Set(['read', 'mutate', 'destructive']);

describe('hostinger catalogue', () => {
  it('is not empty and has an id for every operation', () => {
    expect(entries.length).toBeGreaterThan(50);
    for (const [id, op] of entries) {
      expect(typeof id).toBe('string');
      expect(id).toMatch(/^[a-z0-9]+(?:_?[a-z0-9]+)*(\.[a-z0-9]+(?:_?[a-z0-9]+)*)+$/);
      expect(op.summary).toBeTruthy();
      expect(SAFETY.has(op.safety)).toBe(true);
      expect(catalog.GROUPS).toContain(op.group);
    }
  });

  it('covers exactly the operations the spec snapshot carries', () => {
    // The snapshot is built FROM the same allow-list, so this is a check that
    // nobody edited one without the other — the failure it prevents is a
    // catalogue entry whose endpoint was never verified to exist.
    const cataloguePaths = new Set(entries.map(([, op]) => `${op.method} ${op.path}`));
    const specPaths = new Set(Object.keys(spec.operations));
    expect([...cataloguePaths].sort()).toEqual([...specPaths].sort());
  });

  it('names the API revision the allow-list was written against', () => {
    // The console prints these, and its "the API has no terminal endpoint"
    // claim is only checkable against a named revision. Asserted here so the
    // constant cannot drift from the snapshot it claims to describe.
    expect(catalog.SPEC_VERSION).toBe(spec.spec_version);
    expect(catalog.SPEC_SOURCE).toBe(spec.source);
  });

  it('uses each API path once', () => {
    const seen = new Set();
    for (const [, op] of entries) {
      const key = `${op.method} ${op.path}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it.each(entries)('%s matches the spec: method, path and parameters', (id, op) => {
    const key = `${op.method} ${op.path}`;
    const inSpec = spec.operations[key];
    expect(inSpec).toBeDefined();
    expect(op.method).toBe(key.split(' ')[0]);

    // ── path: every placeholder is declared, and every declaration is used ──
    const placeholders = [...op.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    const declared = Object.keys(op.pathParams || {});
    expect(placeholders.sort()).toEqual(declared.sort());

    const specPath = paramsIn(key, 'path').map((p) => p.name);
    expect([...declared].sort()).toEqual([...specPath].sort());
    for (const p of paramsIn(key, 'path')) {
      expect(p.required).toBe(true);
    }

    // ── query: names AND required flags, because an inverted flag is silent ──
    const queryKeys = Object.keys(op.query?.shape || {});
    const specQuery = paramsIn(key, 'query');
    expect([...queryKeys].sort()).toEqual(specQuery.map((p) => p.name).sort());
    for (const p of specQuery) {
      const optional = op.query.shape[p.name].isOptional();
      expect({ name: p.name, required: !optional }).toEqual({ name: p.name, required: !!p.required });
    }

    // ── body: names AND required flags ────────────────────────────────────
    const bodyKeys = Object.keys(op.body?.shape || {});
    const specBody = spec.operations[key].body;
    if (!specBody) {
      expect(op.body).toBeUndefined();
      return;
    }
    expect(op.body).toBeDefined();
    expect([...bodyKeys].sort()).toEqual(specBody.properties.map((p) => p.name).sort());
    for (const p of specBody.properties) {
      const required = !op.body.shape[p.name].isOptional();
      expect({ name: p.name, required }).toEqual({
        name: p.name,
        required: specBody.required_properties.includes(p.name),
      });
    }
  });

  it('flags every write-only credential the spec documents', () => {
    // These three are the only body properties in the whole snapshot that carry
    // a password. If Hostinger adds a fourth, this test fails and somebody has
    // to decide whether it is a secret — which is the point.
    const secretish = [];
    for (const [key, op] of Object.entries(spec.operations)) {
      for (const p of op.body?.properties || []) {
        if (/password/i.test(p.name)) secretish.push([key, p.name]);
      }
    }
    const declared = new Set(entries.flatMap(([, op]) => op.secrets || []));
    for (const [, name] of secretish) expect(declared.has(name)).toBe(true);
    expect([...declared].sort()).toEqual(['panel_password', 'password', 'root_password']);
  });

  it('never stores a secret in the catalogue itself', () => {
    const serialised = JSON.stringify(catalog.describe());
    for (const word of ['randomBytes', 'safeParse', 'isOptional', 'zod']) {
      expect(serialised).not.toContain(word);
    }
    // No value that looks like a credential, either.
    expect(serialised).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
  });

  it('publishes secret parameters as secret and the rest as not', () => {
    const described = Object.fromEntries(catalog.describe().map((op) => [op.id, op]));
    const recreate = described['vps.recreate'];
    expect(recreate.safety).toBe('destructive');
    expect(recreate.params.find((p) => p.name === 'password').secret).toBe(true);
    expect(recreate.params.find((p) => p.name === 'panel_password').secret).toBe(true);
    expect(recreate.params.find((p) => p.name === 'template_id').secret).toBe(false);
    expect(described['vps.recovery'].params.find((p) => p.name === 'root_password').secret).toBe(true);
    // A read never has one.
    for (const op of catalog.describe().filter((o) => o.safety === 'read')) {
      expect(op.params.filter((p) => p.secret)).toEqual([]);
    }
  });

  it('gives every destructive operation a reason to be one', () => {
    // A guard against classify-by-vibe: each destructive entry names the
    // irreversible consequence in its comment block, and this test asserts the
    // SET has not grown without somebody looking at it.
    const destructive = entries.filter(([, op]) => op.safety === 'destructive').map(([id]) => id).sort();
    expect(destructive).toEqual([
      'billing.autorenewal.disable',
      'dns.records.delete',
      'dns.snapshot.restore',
      'dns.zone.update',
      'firewall.rule.delete',
      'hosting.ssl.delete',
      'hosting.website.delete',
      'vps.backup.restore',
      'vps.docker.down',
      'vps.recovery',
      'vps.recreate',
      'vps.snapshot.delete',
      'vps.snapshot.restore',
    ]);
  });

  it('never classifies a GET as anything but a read', () => {
    for (const [id, op] of entries) {
      if (op.method === 'GET') expect({ id, safety: op.safety }).toEqual({ id, safety: 'read' });
    }
  });

  it('refuses parameters that are not in the catalogue', () => {
    // Unknown keys are stripped, not passed through — the request cannot smuggle
    // a parameter the catalogue does not know about.
    const op = catalog.get('hosting.website.list');
    const parsed = op.query.parse({ per_page: '5', api_key: 'smuggled', token: 'x' });
    expect(parsed).toEqual({ per_page: 5 });
  });

  it('coerces query booleans without turning "false" into true', () => {
    const op = catalog.get('hosting.website.list');
    expect(op.query.parse({ is_enabled: 'false' }).is_enabled).toBe(false);
    expect(op.query.parse({ is_enabled: '0' }).is_enabled).toBe(false);
    expect(op.query.parse({ is_enabled: true }).is_enabled).toBe(true);
    expect(op.query.safeParse({ is_enabled: 'nope' }).success).toBe(false);
  });

  it('accepts repeated and comma-separated lists, and rejects junk', () => {
    const op = catalog.get('hosting.order.list');
    expect(op.query.parse({ statuses: 'active,suspended' }).statuses).toEqual(['active', 'suspended']);
    expect(op.query.parse({ statuses: ['active', 'deleted'] }).statuses).toEqual(['active', 'deleted']);
    expect(op.query.safeParse({ statuses: 'active,whatever' }).success).toBe(false);
    expect(op.query.safeParse({ statuses: [] }).success).toBe(false);
  });

  it('rejects non-domains', () => {
    const op = catalog.get('domains.portfolio.get');
    for (const bad of ['localhost', '-bad.com', 'a..b', 'a.com/x', 'a.com?x=1', '']) {
      expect(op.pathParams.domain.safeParse(bad).success).toBe(false);
    }
    expect(op.pathParams.domain.parse('Sub.Example.COM')).toBe('sub.example.com');
  });

  it('rejects path traversal in file paths and credentials in git remotes', () => {
    const files = catalog.get('hosting.files.content');
    expect(files.query.safeParse({ path: 'a/../../etc/passwd' }).success).toBe(false);
    expect(files.query.safeParse({ path: 'wp-config.php' }).success).toBe(true);

    const deploy = catalog.get('hosting.git.deploy');
    expect(deploy.body.safeParse({ repository_url: 'https://user:tok@github.com/o/r.git', branch: 'main' }).success).toBe(false);
    expect(deploy.body.safeParse({ repository_url: 'https://github.com/o/r.git', branch: 'main' }).success).toBe(true);
    expect(deploy.body.safeParse({ repository_url: 'git@github.com:o/r.git', branch: 'main' }).success).toBe(true);
    expect(deploy.body.safeParse({ repository_url: 'file:///etc/shadow', branch: 'main' }).success).toBe(false);
  });

  it('requires the documented date window on metrics', () => {
    const op = catalog.get('vps.metrics');
    expect(op.query.safeParse({}).success).toBe(false);
    expect(op.query.safeParse({ date_from: '2026-01-01', date_to: '2026-01-02' }).success).toBe(true);
  });

  it('requires the source options that match the build source type', () => {
    const op = catalog.get('hosting.nodejs.build.create');
    const base = {
      node_version: 20,
      app_type: 'next',
      root_directory: 'app',
      output_directory: 'out',
      build_script: 'npm run build',
      source_type: 'archive',
    };
    expect(op.body.safeParse({ ...base, source_options: { archive_path: 'a.zip' } }).success).toBe(true);
    expect(op.body.safeParse({ ...base, source_options: {} }).success).toBe(false);
    expect(op.body.safeParse({ ...base, source_type: 'git', source_options: { owner: 'o', repository: 'r', branch: 'main' } }).success).toBe(false);
  });
});
