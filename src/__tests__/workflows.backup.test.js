// The nightly backup has to be able to find the database.
//
// Runs #1–#13 all failed. After "node: command not found" was fixed by the
// backup image, every run died at "None of BACKUP_DATABASE_URL,
// ADMIN_DATABASE_URL or DATABASE_URL is set": the workflow sourced
// /opt/myptstudio/.env, and that is not where the API gets its connection
// string. The workflow now reads the variables from the running backend
// container. These assertions pin that — and that the secrets never reach
// argv or the log on the way.
'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const wf = yaml.load(fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'backup.yml'), 'utf8'));
const script = wf.jobs.backup.steps[0].with.script;

describe('nightly backup workflow', () => {
  it('takes the connection string from the running backend container', () => {
    expect(script).toMatch(/docker compose ps -q backend/);
    expect(script).toMatch(/docker inspect --format '\{\{range \.Config\.Env\}\}/);
    expect(script).toMatch(/DATABASE_URL\|ADMIN_DATABASE_URL/);
  });

  it('passes secrets by a 0600 env file that is removed, never by argv', () => {
    expect(script).toMatch(/chmod 600 "\$ENV_FILE"/);
    expect(script).toMatch(/trap 'rm -f "\$ENV_FILE"' EXIT/);
    expect(script).toMatch(/--env-file "\$ENV_FILE"/);
    expect(script).not.toMatch(/-e DATABASE_URL=/);
    expect(script).not.toMatch(/echo .*\$DATABASE_URL/);
  });

  it('fails loudly when there is no database to dump, and keeps a local dump without R2', () => {
    expect(script).toMatch(/backend container is not running/);
    expect(script).toMatch(/has no DATABASE_URL either/);
    expect(script).toMatch(/::warning::R2 credentials are not set/);
    expect(wf.jobs.backup.steps[0].with.script_stop).toBe(true);
  });

  it('keeps the dump outside the repository checkout', () => {
    expect(script).toMatch(/BACKUP_HOST_DIR="\$\{BACKUP_DIR:-\/var\/backups\/619\}"/);
    expect(script).toMatch(/-e BACKUP_DIR=\/backups/);
  });
});
