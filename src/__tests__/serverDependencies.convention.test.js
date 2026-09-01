'use strict';
// Every package server.js requires must be a declared dependency.
//
// ── Why this was invisible until something actually booted the process ──────
//
// `compression` was added to server.js's middleware chain (de0d0e8) without
// ever being added to package.json. Jest never caught it: almost nothing in
// this suite requires server.js itself — routes are imported and mounted
// directly, or the app is built through a test harness that never reaches
// server.js's own top-level requires. `poolRequiresEnv.test.js` requires it,
// but only far enough to hit the DATABASE_URL guard, which runs before line
// 306 where `require('compression')` lives.
//
// So `npm ci` (the lockfile's own declared tree) produced a server.js that
// crashed with MODULE_NOT_FOUND the moment anything actually ran `node
// src/server.js` against it — which is exactly what production's Dockerfile
// does, and exactly what 619-erp-frontend's cross-repo E2E job does. It found
// this; Jest never would have on its own.
//
// This scans server.js's own top-level requires (the file's entry-point
// dependencies) against package.json — not every file in src/, since a
// missing dependency anywhere else already breaks whichever test imports
// that file. server.js is the one file nothing else transitively requires
// in the normal test run, which is exactly why its own gap went unnoticed.

const fs = require('fs');
const path = require('path');

const pkg = require('../../package.json');
const declared = new Set([
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.devDependencies || {}),
]);

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// `require('name')` or `require('name/sub/path')`, single- or double-quoted,
// package specifiers only — no `./`, `../`, or bare node builtins (which
// start with a bare word too, but so does every npm package; the exclusion
// list below is the builtins server.js actually uses).
const NODE_BUILTINS = new Set(['fs', 'path', 'http', 'https', 'crypto', 'os', 'url', 'util', 'net', 'stream']);

function requiredPackages(source) {
  const names = new Set();
  const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(source))) {
    const spec = m[1];
    if (spec.startsWith('.') || spec.startsWith('/')) continue;
    // Scoped package (@scope/name) or plain package — the declared name is
    // everything up to the second slash for scoped, or the first slash
    // otherwise, matching how npm resolves and how package.json lists it.
    const parts = spec.split('/');
    const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    if (NODE_BUILTINS.has(name)) continue;
    names.add(name);
  }
  return names;
}

describe('server.js only requires packages that are actually declared', () => {
  it('every top-level require resolves to a dependency in package.json', () => {
    const used = requiredPackages(SERVER);
    const missing = [...used].filter((name) => !declared.has(name)).sort();
    expect(missing).toEqual([]);
  });

  it('the scanner itself finds real packages, so an empty result is not a broken regex', () => {
    // A guard against the test silently doing nothing — if the extraction
    // regex ever stops matching (a reformat of server.js's requires, say),
    // this fails loudly instead of the suite above passing for free. server.js
    // pulls most of its functionality through relative `./lib`, `./routes`
    // and `./middleware` requires (correctly excluded above), so its direct
    // npm-package requires are a short, specific list — not a large number.
    const used = requiredPackages(SERVER);
    expect(used.size).toBeGreaterThanOrEqual(5);
    expect(used.has('express')).toBe(true);
    expect(used.has('compression')).toBe(true);
  });
});
