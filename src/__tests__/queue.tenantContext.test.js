// Tenant context on queued work.
//
// The rule, borrowed from the AI queue (lib/ai/knowledgeBase.js, which loads
// the document row and takes the organization from THAT rather than from the
// job): a job payload is a claim, not evidence. Where a recipient has a row,
// the organization stamped on the job must agree with the organization that
// row actually belongs to, re-read at processing time.
//
// What these tests pin down:
//   · matching organization      -> delivered
//   · mismatched organization    -> refused AND audited
//   · declared platform job      -> delivered (the renewal sweep is meant to
//                                   cross studios)
//   · legacy job with no org     -> delivered (jobs already on the queue during
//                                   a deploy are no less trustworthy than they
//                                   were before it; refusing them would drop
//                                   real messages for no security gain)
//   · unverifiable recipient     -> delivered (an email address has no row, so
//                                   there is no mismatch to detect)
//   · broadcast resolution       -> confined to the caller's own studio
//   · pre-auth email             -> never gated on an organization

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'https://example.com';

jest.mock('../db/pool', () => ({ query: jest.fn(async () => ({ rows: [] })), connect: jest.fn() }));

const pool = require('../db/pool');
const svc = require('../modules/notifications/notifications.service');

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';

/** A job as notificationFanout would have enqueued it. */
function job(data) {
  return { id: 'job-1', data: { ch: 'inapp', type: 'membership_expiring', ...data } };
}

beforeEach(() => {
  pool.query.mockReset();
  pool.query.mockResolvedValue({ rows: [] });
});

describe('assertJobTenant — the check that runs before delivery', () => {
  it('ALLOWS when the job organization matches the recipient row', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ organization_id: ORG_A }] });
    await expect(svc.assertJobTenant(job({
      organizationId: ORG_A, scope: 'tenant', recipient: { member_id: 'cl-1' },
    }))).resolves.toBeUndefined();
  });

  it('DENIES when the recipient belongs to another studio', async () => {
    // 1st query: the recipient lookup. 2nd: the audit insert.
    pool.query.mockResolvedValueOnce({ rows: [{ organization_id: ORG_B }] });
    pool.query.mockResolvedValueOnce({ rows: [] });

    await expect(svc.assertJobTenant(job({
      organizationId: ORG_A, scope: 'tenant', recipient: { member_id: 'cl-of-b' },
    }))).rejects.toThrow(/tenant mismatch/i);
  });

  it('AUDITS the mismatch before throwing, so a retry cannot erase the attempt', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ organization_id: ORG_B }] });
    pool.query.mockResolvedValueOnce({ rows: [] });

    await expect(svc.assertJobTenant(job({
      organizationId: ORG_A, scope: 'tenant', recipient: { member_id: 'cl-of-b' },
    }))).rejects.toThrow();

    const auditCall = pool.query.mock.calls.find(([sql]) => /INSERT INTO activity_log/i.test(sql));
    expect(auditCall).toBeDefined();
    expect(auditCall[1]).toContain('notification.tenant_mismatch_rejected');
  });

  it('falls back to the users table when the recipient is a user rather than a client', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ organization_id: ORG_B }] });
    pool.query.mockResolvedValueOnce({ rows: [] });

    await expect(svc.assertJobTenant(job({
      organizationId: ORG_A, scope: 'tenant', recipient: { user_id: 'usr-of-b' },
    }))).rejects.toThrow(/tenant mismatch/i);

    expect(pool.query.mock.calls[0][0]).toMatch(/FROM users/i);
  });

  it('ALLOWS a declared platform job and does not even look the recipient up', async () => {
    await expect(svc.assertJobTenant(job({
      scope: 'platform', recipient: { member_id: 'anyone' },
    }))).resolves.toBeUndefined();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('ALLOWS a legacy job that carries no organization at all', async () => {
    await expect(svc.assertJobTenant(job({
      recipient: { member_id: 'cl-1' },
    }))).resolves.toBeUndefined();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('ALLOWS an email-only recipient, which has no row to contradict the job', async () => {
    await expect(svc.assertJobTenant(job({
      organizationId: ORG_A, scope: 'tenant', recipient: { email: 'someone@example.com' },
    }))).resolves.toBeUndefined();
  });

  it('ALLOWS when the identifier matches no row (nothing to compare against)', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    await expect(svc.assertJobTenant(job({
      organizationId: ORG_A, scope: 'tenant', recipient: { member_id: 'ghost' },
    }))).resolves.toBeUndefined();
  });
});

describe('processNotificationJob runs the check before delivering', () => {
  it('does not deliver a cross-tenant job', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ organization_id: ORG_B }] });
    pool.query.mockResolvedValueOnce({ rows: [] });

    const spy = jest.spyOn(svc, 'deliverChannel');
    await expect(svc.processNotificationJob(job({
      organizationId: ORG_A, scope: 'tenant', recipient: { member_id: 'cl-of-b' },
    }))).rejects.toThrow(/tenant mismatch/i);
    spy.mockRestore();
  });
});

describe('recipientFromMember — resolution is confined to one studio', () => {
  it('refuses to resolve without an organization context', async () => {
    await expect(svc.recipientFromMember('cl-1')).rejects.toThrow(/organization/i);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('scopes the lookup to the caller organization', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ member_id: 'cl-1', organization_id: ORG_A }] });
    await svc.recipientFromMember('cl-1', ORG_A);

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/FROM pt_clients/i);
    expect(sql).toMatch(/organization_id\s*=\s*\$2/i);
    expect(params).toEqual(['cl-1', ORG_A]);
  });

  it('never reads the un-scopable legacy clients/members tables', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ member_id: 'cl-1' }] });
    await svc.recipientFromMember('cl-1', ORG_A);

    for (const [sql] of pool.query.mock.calls) {
      expect(sql).not.toMatch(/\b(?:FROM|JOIN)\s+(?<!_)clients\b/i);
      expect(sql).not.toMatch(/\b(?:FROM|JOIN)\s+members\b/i);
    }
  });

  it("gives the same answer for another studio's id as for one that does not exist", async () => {
    pool.query.mockResolvedValue({ rows: [] });
    const foreign = svc.recipientFromMember('cl-of-b', ORG_A);
    const missing = svc.recipientFromMember('does-not-exist', ORG_A);
    await expect(foreign).rejects.toThrow('Recipient not found');
    await expect(missing).rejects.toThrow('Recipient not found');
  });
});

describe('pre-authentication email is never gated on an organization', () => {
  // password_reset / admin_otp / admin_invitation are sent to people who have
  // no session, and in the invitation case no account. Requiring an org here
  // would lock people out of their own accounts.
  const { EMAIL_TYPES } = require('../services/email.service');

  it.each(['password_reset', 'admin_otp', 'admin_invitation'])(
    '%s is still an accepted job type',
    (type) => { expect(EMAIL_TYPES.has(type)).toBe(true); },
  );

  it('the email service exposes no tenant assertion to gate on', () => {
    const email = require('../services/email.service');
    expect(email.assertJobTenant).toBeUndefined();
  });
});
