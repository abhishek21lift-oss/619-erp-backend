'use strict';
// The two rules a message row has to obey, held as assertions.
//
//   1. No row may claim it was SENT without evidence.
//   2. No message may leave this building without an organization and a row.
//
// Both were one careless line away from being violated, and in each case the
// violation would have been invisible — that is what makes them worth pinning
// rather than reviewing for.
//
// ── 1. The default that claimed delivery ───────────────────────────────────
//
// Migration 012 created communication_logs with `status TEXT NOT NULL DEFAULT
// 'sent'`, so an INSERT omitting the column asserted the client received the
// message. Nothing relied on it — both live statements write 'queued'
// explicitly — but the roadmap adds campaign, manual, AI-action and report
// sends to this same table, and each one is an author who has to remember.
// Migration 200 changes the default; the test below is what stops a new
// statement from leaning on it either way.
//
// ── 2. The transport with no tenant ────────────────────────────────────────
//
// The whatsapp queue accepted three job types. 'automation' resolves the
// studio's own WhatsApp through modules/messaging/transport and writes a
// communication_logs row for every attempt. 'text' and 'template' did neither:
// no organization in the payload at all, delivery through a single
// platform-wide Twilio number, and no row written anywhere. A studio's client
// messaged from a number that studio has never heard of, with nothing in the
// database to show it happened.
//
// Nothing produced them. But `WHATSAPP_TYPES` was the only thing standing
// between that path and a caller who passed the wrong string.

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');

describe('a message row never begins life claiming it was sent', () => {
  const migration = fs.readFileSync(
    path.join(SRC, 'db', 'migrations', '200_communication_logs_default_queued.sql'),
    'utf8',
  );

  it('sets the column default to queued', () => {
    expect(migration).toMatch(/ALTER COLUMN status SET DEFAULT 'queued'/);
  });

  it('verifies the change rather than trusting its own exception handler', () => {
    // 199 nearly shipped without its RLS policy because a DO block swallowed
    // the failure. Every migration that matters now proves its own outcome.
    expect(migration).toMatch(/RAISE EXCEPTION/);
    expect(migration).toMatch(/information_schema\.columns/);
  });

  /**
   * Every INSERT into communication_logs in the codebase, with the column list
   * it names. Read from source rather than mocked, because the property is
   * about what is written down, not about what runs in one test.
   */
  function communicationLogInserts() {
    const found = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__' && entry.name !== 'node_modules') walk(p);
          continue;
        }
        if (!entry.name.endsWith('.js')) continue;
        const src = fs.readFileSync(p, 'utf8');
        const re = /INSERT\s+INTO\s+communication_logs\s*\(([^)]*)\)/gi;
        let m;
        while ((m = re.exec(src))) {
          found.push({ file: path.relative(SRC, p), columns: m[1] });
        }
      }
    };
    walk(SRC);
    return found;
  }

  const inserts = communicationLogInserts();

  it('found the statements, so this cannot pass vacuously', () => {
    expect(inserts.length).toBeGreaterThanOrEqual(2);
  });

  it('every INSERT names status explicitly rather than inheriting a default', () => {
    // The default is now 'queued' and harmless, but a statement that relies on
    // it is one migration away from being wrong again. Naming the column keeps
    // the claim where a reviewer can see it.
    const silent = inserts
      .filter((i) => !/\bstatus\b/.test(i.columns))
      .map((i) => i.file);
    expect(silent).toEqual([]);
  });
});

describe('no message leaves without an organization and a row', () => {
  // Required so requiring the service does not open a pool.
  const svc = (() => {
    jest.resetModules();
    return require('../services/whatsapp.service');
  })();

  it('accepts exactly one job type', () => {
    expect([...svc.WHATSAPP_TYPES]).toEqual(['automation']);
  });

  it.each(['text', 'template'])(
    'refuses to enqueue the org-less legacy type %s',
    async (type) => {
      // These reached services/whatsappDelivery directly: a platform-wide
      // Twilio number, no tenancy in the call, and no communication_logs row.
      await expect(svc.enqueueWhatsapp(type, {})).rejects.toThrow(/Unknown whatsapp job type/);
    },
  );

  it.each(['text', 'template', 'broadcast', undefined])(
    'refuses to process job type %s',
    async (type) => {
      await expect(svc.processWhatsappJob({ data: { type } }))
        .rejects.toThrow(/Unknown whatsapp job type/);
    },
  );

  it('no longer reaches the shared-number transport from the worker at all', () => {
    // transport.js still requires whatsappDelivery under `allowSharedProvider`,
    // which is a caller that HAS an organization and writes a row. The worker
    // must not have its own door to it.
    const src = fs.readFileSync(path.join(SRC, 'services', 'whatsapp.service.js'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/whatsappDelivery/);
  });
});
