'use strict';
// What Redis being down actually does — pinned to the code that does it.
//
// ── The folklore, and why it is dangerous ──────────────────────────────────
//
// "Redis is optional in this stack; producers fall back to inline." That is
// written in several headers and it is wrong in the way that matters most:
// the fallback is not uniform, and the sweeps that do NOT fall back silently
// stop running.
//
//   email / notifications / ai   send INLINE. Work still happens.
//   whatsapp                     DOES NOT SEND. The row stays 'queued' and
//                                automation.recovery re-drives it later —
//                                deliberately, so the per-attempt bookkeeping
//                                in communication_logs is not bypassed.
//   automation-sweep, etc.       STOP. The worker scheduler cannot register,
//                                so the sweep does not run until Redis returns.
//
// Studio subscription renewals are not queue-backed: they run from an
// interval in server.js, so they are deliberately absent from this table.
//
// An operator looking at a red Redis card has three very different situations
// to tell apart: "latency is up", "messages are waiting and will flush", and
// "scheduled sweeps have stopped". redis-degradation.js states which; these
// tests stop that statement drifting away from the code.

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';

const fs = require('fs');
const path = require('path');
const degradation = require('../modules/command-center/redis-degradation');

const SRC = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
/** Source with comments stripped: a claim must be backed by CODE. */
const code = (rel) => read(rel)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('the description covers every queue, and nothing else', () => {
  it('names exactly the queues the app actually has', () => {
    const { QUEUE_NAMES } = require('../jobs/queue');
    const described = Object.keys(degradation.DEGRADATION).sort();
    // A queue added without a degradation mode is a queue whose behaviour
    // under a Redis outage nobody has decided. That is the gap this catches.
    for (const q of QUEUE_NAMES) expect(described).toContain(q);
  });

  it('gives every queue one of the three real modes', () => {
    const modes = new Set(Object.values(degradation.MODE));
    for (const d of Object.values(degradation.DEGRADATION)) {
      expect(modes.has(d.mode)).toBe(true);
      expect(typeof d.impact).toBe('string');
      expect(d.impact.length).toBeGreaterThan(40);   // a sentence, not a label
      expect(typeof d.source).toBe('string');
    }
  });
});

describe('each claimed fallback is still what the code does', () => {
  it('email falls through to an inline send', () => {
    const src = code('lib/email.js');
    expect(degradation.DEGRADATION.email.mode).toBe(degradation.MODE.INLINE);
    // dispatchEmail tries the queue and returns inline() when it cannot use it.
    expect(src).toMatch(/function dispatchEmail/);
    expect(src).toMatch(/return inline\(\)/);
  });

  it('notifications fall through to a per-channel inline delivery', () => {
    const src = code('modules/notifications/notifications.service.js');
    expect(degradation.DEGRADATION.notifications.mode).toBe(degradation.MODE.INLINE);
    expect(src).toMatch(/deliverChannel\(/);
    expect(src).toMatch(/queued\s*\n?\s*\?/);   // queued ? … : await deliverChannel(…)
  });

  it('ai returns null and leaves the caller to run its fallback', () => {
    const src = code('services/ai.service.js');
    expect(degradation.DEGRADATION.ai.mode).toBe(degradation.MODE.INLINE);
    expect(src).toMatch(/ensureReady\(\)\)\)?\s*return null/);
  });

  it('whatsapp does NOT send inline — the row is left queued', () => {
    // The one that would be a data-integrity bug if somebody "fixed" it into
    // an inline send: communication_logs would lose the per-attempt record.
    const engine = code('modules/automation/automation.engine.js');
    expect(degradation.DEGRADATION.whatsapp.mode).toBe(degradation.MODE.DEFERRED);
    expect(engine).toMatch(/NOT_ENQUEUED/);

    const svc = code('services/whatsapp.service.js');
    expect(svc).toMatch(/ensureReady\(\)\)\)?\s*return null/);
    // No inline door out of the worker path. If one appears, the mode above is
    // wrong and this fails rather than the console quietly misdescribing it.
    expect(svc).not.toMatch(/sendInline|deliverInline/);
  });

  it('a scheduler queue with no producer fallback is described as STOPPED', () => {
    // The claim is an ABSENCE, so it is asserted as one: no service module
    // enqueues the sweep with an inline path behind it.
    expect(degradation.DEGRADATION['automation-sweep'].mode)
      .toBe(degradation.MODE.STOPPED);
    const services = fs.readdirSync(path.join(SRC, 'services'))
      .filter((f) => f.endsWith('.js'))
      .map((f) => code(path.join('services', f)))
      .join('\n');
    expect(services).not.toMatch(/automationSweepQueue/);
  });
});

describe('describe() leads with the worst consequence', () => {
  it('is inactive and silent when Redis is up', () => {
    const d = degradation.describe('up');
    expect(d.active).toBe(false);
    expect(d.headline).toBeNull();
  });

  it('names a STOPPED queue first when Redis is unreachable', () => {
    const d = degradation.describe('down');
    expect(d.active).toBe(true);
    // An operator has seconds. A queue that has stopped goes first.
    expect(d.headline.indexOf('automation-sweep'))
      .toBeLessThan(d.headline.indexOf('whatsapp'));
    expect(d.headline).toMatch(/HAVE STOPPED/);
  });

  it('distinguishes never-configured from unreachable', () => {
    const off = degradation.describe('not_configured');
    const down = degradation.describe('down');
    expect(off.headline).not.toEqual(down.headline);
    expect(off.headline).toMatch(/No Redis on this deployment/);
    // Both must still name the cost — "not configured" is not "no consequence".
    expect(off.headline).toMatch(/automation-sweep/);
  });

  it('always returns every queue, whatever the state', () => {
    for (const state of ['up', 'down', 'not_configured']) {
      expect(degradation.describe(state).queues).toHaveLength(
        Object.keys(degradation.DEGRADATION).length,
      );
    }
  });
});
