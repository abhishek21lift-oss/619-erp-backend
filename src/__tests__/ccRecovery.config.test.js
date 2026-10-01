'use strict';
// The socket-proxy configuration, held to the security requirements it exists
// to meet. Both places that describe it are checked: docker-compose.yml (the
// repo's reference topology) and scripts/deploy/cc-recovery.sh (what writes
// the override on the VPS). Either drifting into "generic Docker access" fails
// here rather than in production.

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..', '..');
const compose = yaml.load(fs.readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8'));
const script = fs.readFileSync(path.join(ROOT, 'scripts', 'deploy', 'cc-recovery.sh'), 'utf8');
const proxy = compose.services['docker-socket-proxy'];

const PINNED = /^wollomatic\/socket-proxy:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/;

describe('docker-compose.yml socket-proxy', () => {
  test('exists, opt-in through the recovery profile', () => {
    expect(proxy).toBeTruthy();
    expect(proxy.profiles).toEqual(['recovery']);
  });

  test('is pinned by version and digest, never :latest or a floating major', () => {
    expect(proxy.image).toMatch(PINNED);
  });

  test('is hardened: read-only, no capabilities, no new privileges', () => {
    expect(proxy.read_only).toBe(true);
    expect(proxy.cap_drop).toEqual(['ALL']);
    expect(proxy.security_opt).toContain('no-new-privileges:true');
  });

  test('publishes no port — reachable only on the compose network', () => {
    expect(proxy.ports).toBeUndefined();
    expect(proxy.expose).toEqual(['2375']);
  });

  test('allows exactly one method and one path shape: POST restart of the two named containers', () => {
    const allow = proxy.command.filter((c) => /^-allow[A-Z]+=/.test(c));
    expect(allow).toEqual([
      '-allowPOST=(/v[0-9.]+)?/containers/(${CC_API_CONTAINER:-erp-api}|${CC_WORKER_CONTAINER:-erp-worker})/restart',
    ]);
    expect(proxy.command).toContain('-allowfrom=api');
  });

  test('only the proxy holds the Docker socket', () => {
    for (const [name, svc] of Object.entries(compose.services)) {
      const mounts = (svc.volumes || []).filter((v) => String(v).includes('docker.sock'));
      if (name === 'docker-socket-proxy') {
        expect(mounts).toEqual(['/var/run/docker.sock:/var/run/docker.sock:ro']);
      } else {
        expect({ name, mounts }).toEqual({ name, mounts: [] });
      }
    }
  });

  test('the API gets the proxy URL and both target names from the environment', () => {
    const env = compose.services.api.environment;
    expect(env.DOCKER_PROXY_URL).toBe('${DOCKER_PROXY_URL:-}');
    expect(env.CC_API_CONTAINER).toBe('${CC_API_CONTAINER:-erp-api}');
    expect(env.CC_WORKER_CONTAINER).toBe('${CC_WORKER_CONTAINER:-erp-worker}');
    expect(compose.services.api.container_name).toBe('${CC_API_CONTAINER:-erp-api}');
    expect(compose.services.worker.container_name).toBe('${CC_WORKER_CONTAINER:-erp-worker}');
  });
});

describe('scripts/deploy/cc-recovery.sh (the VPS override)', () => {
  const imageLine = script.match(/^PROXY_IMAGE='([^']+)'/m);
  const allowLines = script.match(/^ *- '-allow[A-Z]+=.*$/gm) || [];

  test('pins the same image and digest as docker-compose.yml', () => {
    expect(imageLine[1]).toMatch(PINNED);
    expect(imageLine[1]).toBe(proxy.image);
  });

  test('writes the same single allow rule, built from the containers it discovered', () => {
    expect(allowLines.map((l) => l.trim())).toEqual([
      "- '-allowPOST=(/v[0-9.]+)?/containers/($API_CONTAINER|$WORKER_CONTAINER)/restart'",
    ]);
  });

  test('writes the same hardening, an expose and no ports', () => {
    expect(script).toMatch(/read_only: true/);
    expect(script).toMatch(/cap_drop: \[ALL\]/);
    expect(script).toMatch(/no-new-privileges:true/);
    expect(script).toMatch(/expose:\n\s+- '2375'/);
    expect(script).not.toMatch(/^\s+ports:/m);
  });

  test('refuses names the proxy regex cannot carry safely (no dots)', () => {
    expect(script).toContain("NAME_RE='^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$'");
  });

  test('never overwrites an existing override, and recreates only the API', () => {
    expect(script).toMatch(/already exists; merge by hand/);
    // Commands the script runs (not the undo hint it writes into the file).
    const run = script.split('\n').filter((l) => /^\s*docker compose /.test(l)).map((l) => l.trim());
    const ups = run.filter((l) => l.startsWith('docker compose up'));
    expect(ups).toEqual([
      'docker compose up -d --no-deps "$PROXY_SERVICE"',
      'docker compose up -d --no-deps "$API_SERVICE"',
    ]);
    expect(run.filter((l) => /docker compose (down|rm|stop|kill|restart)\b/.test(l))).toEqual([]);
    expect(script).not.toMatch(/docker volume rm|system prune|compose down -v/);
  });
});
