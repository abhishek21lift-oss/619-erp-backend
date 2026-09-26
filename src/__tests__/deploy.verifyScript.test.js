// The deploy gate, exercised as the box runs it.
//
// This script replaced a `for` loop that lived inside deploy.yml and never
// executed: production logs showed the container start and the script exit 1
// 41ms later, with none of the loop's output. That failure was invisible to
// every test in this repository because the logic lived in a YAML string.
//
// It does not any more. These tests run the real file, against a real HTTP
// server, and cover the two ways it can be wrong: saying a deploy is good when
// it is not, and saying it is bad when it is fine.
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'deploy', 'verify-serving.sh');
const SHA = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
const OTHER_SHA = '0000111122223333444455556666777788889999';

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// The failure path runs `docker compose logs` and the success path `docker
// image prune`. On a CI runner that is the REAL docker, which can take several
// seconds to answer — enough to push a failure-path test past Jest's default
// 5s and fail CI on main, skipping a deploy. A stub `docker` first on PATH
// keeps the test hermetic and fast; the calls are `|| true` in the script, so
// what docker says never decides the outcome being tested.
const FAKE_BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'deployverify-bin-'));
fs.writeFileSync(path.join(FAKE_BIN, 'docker'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

// The script itself is allowed 30s (execFile's timeout below); the test is
// given the same, so a slow runner fails on the script's limit, not Jest's.
jest.setTimeout(30000);

function runScript(args, env = {}) {
  return new Promise((resolve) => {
    execFile('bash', [SCRIPT, ...args], {
      env: {
        ...process.env,
        PATH: `${FAKE_BIN}${path.delimiter}${process.env.PATH}`,
        VERIFY_ATTEMPTS: '2',
        VERIFY_INTERVAL: '0',
        ...env,
      },
      timeout: 30000,
    }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

describe('deploy verification script', () => {
  let server;
  let marker;
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deployverify-'));
    marker = path.join(tmp, '.backend-deployed-sha');
    fs.writeFileSync(`${marker}.new`, `${SHA}\n`);
  });

  afterEach(() => {
    if (server) { server.close(); server = undefined; }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function verifyAgainst(payload) {
    server = await serve((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(payload);
    });
    const url = `http://127.0.0.1:${server.address().port}/api/health`;
    return runScript([SHA, tmp, 'backend', url, marker]);
  }

  it('accepts the compact JSON that res.json() actually emits', async () => {
    const r = await verifyAgainst(JSON.stringify({ status: 'ok', release: { sha: SHA } }));
    expect(r.stdout).toContain('deploy verified');
    expect(r.code).toBe(0);
  });

  it('accepts a pretty-printed payload too', async () => {
    // The original pattern required exactly `"sha":"..."`. Reformatting the
    // health response would have broken the deploy gate, for no other reason.
    const r = await verifyAgainst(JSON.stringify({ status: 'ok', release: { sha: SHA } }, null, 2));
    expect(r.stdout).toContain('deploy verified');
    expect(r.code).toBe(0);
  });

  it('advances the marker only on success', async () => {
    await verifyAgainst(JSON.stringify({ release: { sha: SHA } }));
    expect(fs.readFileSync(marker, 'utf8').trim()).toBe(SHA);
    expect(fs.existsSync(`${marker}.new`)).toBe(false);
  });

  it('fails when the container serves a DIFFERENT commit', async () => {
    const r = await verifyAgainst(JSON.stringify({ release: { sha: OTHER_SHA } }));
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('::error::deploy verification failed');
    expect(r.stdout).toContain(OTHER_SHA);
  });

  it('leaves the marker naming the last good commit when verification fails', async () => {
    fs.writeFileSync(marker, `${OTHER_SHA}\n`);
    await verifyAgainst(JSON.stringify({ release: { sha: OTHER_SHA } }));
    // Not advanced to the commit we tried to deploy.
    expect(fs.readFileSync(marker, 'utf8').trim()).toBe(OTHER_SHA);
    expect(fs.existsSync(`${marker}.new`)).toBe(false);
  });

  it('fails, rather than hanging, when nothing is listening at all', async () => {
    // Port 1 is not served by anything; curl refuses immediately.
    const r = await runScript([SHA, tmp, 'backend', 'http://127.0.0.1:1/api/health', marker]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('no answer');
  });

  it('fails when the payload carries no sha at all', async () => {
    const r = await verifyAgainst(JSON.stringify({ status: 'ok' }));
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('no answer');
  });

  it('polls rather than giving up on the first miss', async () => {
    // The container is not serving yet on the first ask, and is on the second.
    let asked = 0;
    server = await serve((req, res) => {
      asked += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ release: { sha: asked === 1 ? OTHER_SHA : SHA } }));
    });
    const url = `http://127.0.0.1:${server.address().port}/api/health`;
    const r = await runScript([SHA, tmp, 'backend', url, marker], { VERIFY_ATTEMPTS: '5' });
    expect(r.code).toBe(0);
    expect(asked).toBeGreaterThan(1);
  });
});
