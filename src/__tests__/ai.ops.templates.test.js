'use strict';

// Templates are the floor under the AI. When the model is unavailable, quota
// is spent, or a draft fails validation, the trainer must still have sendable
// copy. These bodies are asserted, not generated, so a prompt change cannot
// silently change what a client receives.

const { MESSAGE_CODES, reasonIdentity } = require('../modules/ai-ops/priority');
const { templateDraft } = require('../modules/ai-ops/templates');

const subject = { type: 'client', id: 'c1', name: 'Ravi Kumar', photo_url: null };

const evidenceByCode = {
  never_started: { never_started: true },
  silent_21: { last_session: '2026-11-03' },
  silent_10: { last_session: '2026-11-13' },
  term_ending_7: { pt_end_date: '2026-11-30' },
  term_ending_30: { pt_end_date: '2026-12-20' },
  term_ended: { pt_end_date: '2026-11-01' },
  dues: { balance_amount: 4500 },
  no_show_recent: { session_id: 's1', session_date: '2026-11-22' },
  checkin_missing_7: { last_checkin: '2026-11-17' },
  checkin_missing_14: { last_checkin: '2026-11-10' },
  lead_due: { follow_up_date: '2026-11-25' },
  lead_stale: { created_at: '2026-11-21' },
};

function reasonFor(code, over = {}) {
  return {
    code,
    label: 'label that must not leak',
    evidence: evidenceByCode[code] || {},
    ...over,
  };
}

describe('templateDraft', () => {
  it('covers every message reason with sendable copy', () => {
    for (const code of MESSAGE_CODES) {
      const draft = templateDraft({ subject, primaryReason: reasonFor(code), studioName: 'Iron House' });

      expect(draft).not.toBeNull();
      expect(draft.body.length).toBeGreaterThan(0);
      expect(draft.body.length).toBeLessThanOrEqual(1200);
      expect(draft.body).not.toMatch(/\b(undefined|null)\b/);
      expect(draft.body).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    }
  });

  it('produces no message for internal-only reasons', () => {
    for (const code of ['form_check_pending', 'parq_missing', 'consent_missing', 'clearance_expired']) {
      expect(templateDraft({ subject, primaryReason: reasonFor(code), studioName: 'Iron House' })).toBeNull();
    }
  });

  it('formats dues with Indian grouping', () => {
    const draft = templateDraft({ subject, primaryReason: reasonFor('dues'), studioName: 'Iron House' });
    expect(draft.body).toContain('₹4,500');
  });

  it('addresses the client by first name only', () => {
    const draft = templateDraft({ subject, primaryReason: reasonFor('silent_10'), studioName: 'Iron House' });
    expect(draft.body.startsWith('Hi Ravi,')).toBe(true);
  });

  it('neutralises a name carrying markup, newlines or absurd length', () => {
    for (const name of [
      'Ravi\n<script>alert(1)</script>',
      'A'.repeat(500),
      '<b>Ravi</b>',
    ]) {
      const draft = templateDraft({
        subject: { ...subject, name },
        primaryReason: reasonFor('silent_10'),
        studioName: 'Iron House',
      });
      expect(draft.body).not.toContain('<');
      expect(draft.body).not.toContain('\n');
      expect(draft.body).not.toMatch(/undefined|null/);
    }
  });

  it('uses the studio name for lead messages and caps it', () => {
    const lead = { type: 'lead', id: 'l1', name: 'Priya', photo_url: null };
    const draft = templateDraft({
      subject: lead,
      primaryReason: reasonFor('lead_due'),
      studioName: 'Iron House',
    });
    expect(draft.body).toContain('Iron House');

    const long = templateDraft({
      subject: lead,
      primaryReason: reasonFor('lead_stale'),
      studioName: 'S'.repeat(200),
    });
    expect(long.body.length).toBeLessThanOrEqual(1200);
    expect(long.body).not.toContain('S'.repeat(61));
  });

  it('marks the draft as a template with no model or confidence', () => {
    const draft = templateDraft({ subject, primaryReason: reasonFor('dues'), studioName: 'Iron House' });

    expect(draft).toMatchObject({
      channel: 'whatsapp', source: 'template', model: null, confidence: null,
    });
    expect(typeof draft.generated_at).toBe('string');
    expect(Number.isFinite(Date.parse(draft.generated_at))).toBe(true);
  });

  it('ties the reason key to evidence, not to the label', () => {
    const monday = reasonFor('silent_21', { label: 'Last trained 21 days ago' });
    const tuesday = reasonFor('silent_21', { label: 'Last trained 22 days ago' });
    const changed = reasonFor('silent_21', { evidence: { last_session: '2026-10-01' } });

    const a = templateDraft({ subject, primaryReason: monday, studioName: 'Iron House' });
    const b = templateDraft({ subject, primaryReason: tuesday, studioName: 'Iron House' });
    const c = templateDraft({ subject, primaryReason: changed, studioName: 'Iron House' });

    expect(a.reason_key).toBe(reasonIdentity(monday));
    expect(a.reason_key).toBe(b.reason_key);
    expect(a.reason_key).not.toBe(c.reason_key);
  });
});
