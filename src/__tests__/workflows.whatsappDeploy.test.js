// The WhatsApp gateway deploy workflow is a loaded gun, and these are its
// safety catches.
//
// deploy-whatsapp.yml SSHes into the production VPS and edits the compose file
// that serves the ERP. It is separate from deploy.yml precisely so that it is
// never automatic — but "never automatic" is a property of a few lines of YAML,
// and the failure mode of losing any of them is silent: a `push:` trigger added
// for convenience, a backup step dropped in a refactor, a published port added
// while debugging. Nothing would error. The gateway would simply become
// reachable, or an edit would become unrecoverable.
//
// workflows.deployGate.test.js exists for the same reason on the backend's own
// pipeline (audit finding H-1). This is the equivalent for a service whose
// volume holds full WhatsApp account access for every linked studio.

'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const WF = path.join(__dirname, '..', '..', '.github', 'workflows');
const doc = yaml.load(fs.readFileSync(path.join(WF, 'deploy-whatsapp.yml'), 'utf8'));

// `on` is the YAML 1.1 boolean true unless quoted — same note as deployGate.
const triggers = (d) => d[true] || d.on;

/** Every SSH step's remote script, keyed by the step name. */
function remoteScripts() {
  const out = {};
  for (const step of doc.jobs['run-stage'].steps) {
    if (step.uses && step.uses.startsWith('appleboy/ssh-action') && step.with && step.with.script) {
      out[step.name] = String(step.with.script);
    }
  }
  return out;
}

const scripts = remoteScripts();
const mutating = ['Install the gateway service', 'Point the ERP at the gateway'];

describe('it can never fire on its own', () => {
  it('is manual dispatch only', () => {
    // The whole reason this is not part of deploy.yml. A `push` or
    // `workflow_run` trigger here would install a WhatsApp gateway onto
    // production because somebody merged a README change.
    expect(Object.keys(triggers(doc))).toEqual(['workflow_dispatch']);
  });

  it('defaults to the read-only stage', () => {
    // A mis-click should inspect the box, not change it.
    const stage = triggers(doc).workflow_dispatch.inputs.stage;
    expect(stage.default).toBe('inspect');
    expect(stage.options).toContain('inspect');
  });

  it('shares deploy.yml’s concurrency group and does not cancel it', () => {
    // Both edit /opt/myptstudio/docker-compose.yml and run `compose up -d`.
    // Interleaving them leaves the box on a mixture of two states with no
    // error anywhere. Cancelling the older run is worse — it is the one that
    // may be mid-`compose up`.
    expect(doc.concurrency.group).toBe('deploy-vps-backend');
    expect(doc.concurrency['cancel-in-progress']).toBe(false);
  });
});

describe('every remote script fails loudly', () => {
  it('sets -e and script_stop on every SSH step', () => {
    // Without script_stop the run's exit code is the LAST command's, so a
    // failed edit reports a green deploy. deploy.yml documents this exact trap.
    const steps = doc.jobs['run-stage'].steps.filter(
      (s) => s.uses && s.uses.startsWith('appleboy/ssh-action'),
    );
    expect(steps.length).toBeGreaterThan(0);
    const results = steps.map((s) => ({
      name: s.name,
      script_stop: s.with.script_stop,
      setE: /^\s*set -e\s*$/m.test(String(s.with.script)),
    }));
    expect(results).toEqual(
      results.map((r) => ({ name: r.name, script_stop: true, setE: true })),
    );
  });
});

describe('an edit to the production compose file is always recoverable', () => {
  it.each(mutating)('%s backs up before editing and restores on failure', (name) => {
    const s = scripts[name];
    expect(s).toBeDefined();
    // A timestamped copy taken BEFORE the compose file is written.
    //
    // Anchored to the WRITE, not to the first `up -d`: install's idempotent
    // early exit runs `up -d whatsapp` and returns when the service is already
    // there, and that path edits nothing, so it needs no backup. An earlier
    // version of this test anchored to `up -d` and failed on exactly that.
    expect(s).toMatch(/cp docker-compose\.yml "\$BAK"/);
    const write = s.search(/cp \/tmp\/wa-\S+\.yml docker-compose\.yml/);
    expect(write).toBeGreaterThan(-1);
    expect(s.indexOf('cp docker-compose.yml "$BAK"')).toBeLessThan(write);
    // ...and put back if `docker compose config` rejects the result.
    expect(s).toMatch(/if ! docker compose config >\/dev\/null; then[\s\S]*cp "\$BAK" docker-compose\.yml/);
  });

  it('restarting the API rolls itself back when health does not return', () => {
    // The one stage that can take the ERP down. A failed wire-up must not
    // leave the API stopped while somebody reads the log.
    const s = scripts['Point the ERP at the gateway'];
    expect(s).toMatch(/api\/health/);
    expect(s).toMatch(/cp "\$BAK" docker-compose\.yml\s*\n\s*docker compose up -d "\$SVC"/);
  });

  it('migrations run in a throwaway container, before the API restarts', () => {
    const s = scripts['Point the ERP at the gateway'];
    expect(s).toMatch(/compose run --rm --no-deps "\$SVC" npm run migrate/);
    expect(s.indexOf('npm run migrate')).toBeLessThan(s.indexOf('docker compose up -d "$SVC"'));
  });
});

describe('the gateway must never become reachable from outside', () => {
  it('install refuses to start a service that publishes a host port', () => {
    // The primary security control (architecture §16.1). A published port puts
    // full WhatsApp account access behind one shared header value. The check
    // restores the backup rather than starting it anyway.
    const s = scripts['Install the gateway service'];
    expect(s).toMatch(/grep -q 'published'/);
    expect(s).toMatch(/REFUSING: the whatsapp service publishes a host port/);
  });

  it('the uninstall stage keeps the session volume', () => {
    // Deleting it forces every linked studio to re-scan a QR, and there is no
    // other copy of those credentials.
    const s = scripts['Remove the gateway service'];
    expect(s).toMatch(/tar czf/);            // backs it up first

    // `docker volume rm` must not appear as a COMMAND. The script does mention
    // it inside a warning it prints ("Never 'docker volume rm' this on a
    // rollback"), so a bare regex over the whole script matches the safety
    // notice and fails — which is how this assertion was first written.
    const commands = s
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('echo '));
    expect(commands.filter((l) => /docker volume rm/.test(l))).toEqual([]);
  });
});

describe('secrets stay on the box', () => {
  it('the two shared secrets are generated remotely, not passed in', () => {
    // They are not GitHub secrets and must not become them: `install`
    // generates them with openssl ON the VPS and appends them to .env.
    const s = scripts['Install the gateway service'];
    expect(s).toMatch(/WA_GATEWAY_KEY=\$\(openssl rand -hex 32\)/);
    expect(s).toMatch(/WA_WEBHOOK_SECRET=\$\(openssl rand -hex 32\)/);
    // Only appended when absent — regenerating would break the backend's copy
    // and the webhook would start rejecting every event, silently.
    expect(s).toMatch(/grep -q '\^WA_GATEWAY_KEY=' *\.env \|\| echo/);
  });

  it('no stage prints a secret value', () => {
    // .env is read for variable NAMES only. A `cat .env` here would put every
    // credential on the box — database URL, JWT secret — into a GitHub Actions
    // log that anyone with repo read access can download.
    const offenders = [];
    for (const [name, s] of Object.entries(scripts)) {
      if (/\bcat\s+\.env\b/.test(s)) offenders.push(`${name}: cat .env`);
      if (/echo\s+"?\$WA_GATEWAY_KEY/.test(s)) offenders.push(`${name}: echoes WA_GATEWAY_KEY`);
      if (/echo\s+"?\$WA_WEBHOOK_SECRET/.test(s)) offenders.push(`${name}: echoes WA_WEBHOOK_SECRET`);
    }
    expect(offenders).toEqual([]);
  });

  it('reads .env with a name-only sed, in every stage that reads it at all', () => {
    for (const [, s] of Object.entries(scripts)) {
      if (!/\.env/.test(s)) continue;
      if (!/sed -n 's\/\^/.test(s)) continue;
      // The capture group ends before the `=`, so no value can be printed.
      expect(s).toMatch(/sed -n 's\/\^\\\(WA_\[A-Za-z0-9_\]\*\\\)=\.\*\//);
    }
  });
});
