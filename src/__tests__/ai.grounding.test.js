'use strict';
// Grounding provenance: what the model is TOLD when a lookup did not happen.
//
// ── The class of bug this file exists for ────────────────────────────────
//
// Three places in the AI path collapsed "we could not check" into "we
// checked and there was nothing":
//
//   · retrieveContext() caught an embed failure and returned [], the same
//     value an empty knowledge base returns (see ai.knowledge.tenant.test.js);
//   · runTools() caught a failing tool, logged a warning, and passed the
//     model no line at all — indistinguishable from a tool that never
//     triggered;
//   · buildCoachSystemPrompt() had two branches where three states exist.
//
// Each one ends the same way: the model answers a question about this
// studio's data without the data, and nothing in the reply says so. For
// "how many active clients do I have?" that is a fabricated number presented
// as the studio's own figure.
//
// These tests assert the model is told the truth about what was retrieved.
// They are about the INSTRUCTION the model receives, because that is the only
// lever we have over what it says next.

jest.mock('../db/pool', () => ({ query: jest.fn() }));

const pool = require('../db/pool');
const { runTools } = require('../lib/ai/tools');
const { buildCoachSystemPrompt } = require('../lib/ai/prompts/system');

function reqAs(role, overrides = {}) {
  return { user: { id: 'usr-1', role, organization_id: 'org-1', trainer_id: 'trn-1', ...overrides } };
}

beforeEach(() => pool.query.mockReset());

describe('the prompt distinguishes three grounding states', () => {
  it('ok: cites the studio documents that were retrieved', () => {
    const p = buildCoachSystemPrompt(null, '[1] (Refund SOP) 14 days.', '', 'ok');
    expect(p).toContain("Reference material from this studio's own documents");
    expect(p).not.toMatch(/could NOT be searched/);
  });

  it('no_match: says nothing matched, and scopes that claim to documents', () => {
    const p = buildCoachSystemPrompt(null, '', '', 'no_match');
    expect(p).toMatch(/No uploaded policy\/SOP document matched/);
    expect(p).not.toMatch(/could NOT be searched/);
  });

  it('unavailable: forbids claiming the studio has no such document', () => {
    // The whole point. During an outage the model previously received the
    // no_match text, which tells it the base was consulted and was empty.
    const p = buildCoachSystemPrompt(null, '', '', 'unavailable');
    expect(p).toMatch(/could NOT be searched/);
    expect(p).toMatch(/Do not say the studio has no document/);
    expect(p).not.toMatch(/No uploaded policy\/SOP document matched/);
  });

  it('defaults to no_match, so an un-migrated caller cannot claim an outage', () => {
    const p = buildCoachSystemPrompt(null, '', '');
    expect(p).toMatch(/No uploaded policy\/SOP document matched/);
  });
});

describe('a failing tool is reported to the model, not only to the log', () => {
  it('tells the model the lookup failed instead of passing nothing', async () => {
    pool.query.mockRejectedValueOnce(new Error('connection reset'));

    const result = await runTools(reqAs('trainer'), 'How many active clients do we have?');

    expect(result.contextText).toMatch(/lookup failed just now/i);
    expect(result.contextText).toMatch(/rather than answering from memory or estimating/i);
    // Named too: the UI's "consulted" list must not silently drop it either.
    expect(result.toolNames).toContain('Client Stats');
  });

  it('a failure and a no-trigger are no longer the same empty string', async () => {
    pool.query.mockRejectedValueOnce(new Error('connection reset'));
    const failed = await runTools(reqAs('trainer'), 'How many active clients do we have?');
    const never = await runTools(reqAs('trainer'), 'What is a good warm-up routine?');

    expect(never.contextText).toBe('');
    expect(failed.contextText).not.toBe('');
  });

  it('still denies an unauthorized tool in the same honest shape', async () => {
    // Regression guard: the failure branch was modelled on this one, and
    // must not have displaced it.
    const result = await runTools(reqAs('reception'), 'What is our revenue this month?');
    expect(result.contextText).toMatch(/not permitted/i);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('a successful tool is unchanged', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ active: '12', inactive: '3', frozen: '1', expiring_soon: '2', total: '16' }],
    });
    const result = await runTools(reqAs('trainer'), 'How many active clients do we have?');
    expect(result.contextText).toMatch(/16 total/);
    expect(result.contextText).not.toMatch(/failed/i);
  });
});
