// The one-time link that lets a client sign their screening remotely.
//
// Two rules decide whether this is safe, and both live in lib/formLinks.js:
// the raw token is never stored, and a link works exactly once. A regression
// in either turns a forwarded WhatsApp message into a second signed medical
// record — or a database dump into a set of working links.

process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long!!';

jest.mock('../db/pool', () => ({ query: jest.fn(), connect: jest.fn() }));

const pool = require('../db/pool');
const links = require('../lib/formLinks');
const { hashToken } = require('../lib/clientInvitations');

const RAW = 'a'.repeat(64);

describe('issuing a signing link', () => {
  beforeEach(() => pool.query.mockReset());

  it('expires the client\'s previous live link before creating a new one', async () => {
    // Resending must kill the old link, otherwise "the first message went to
    // the wrong number" leaves that message working.
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'link-1', expires_at: new Date() }] });

    await links.create({ clientId: 'ptc-1', organizationId: 'org-a', createdBy: 'usr-1' });

    const [updateSql, updateParams] = pool.query.mock.calls[0];
    expect(updateSql).toMatch(/UPDATE pt_form_links/);
    expect(updateSql).toMatch(/expires_at = NOW\(\)/);
    expect(updateParams).toEqual(['ptc-1', 'org-a']);
  });

  it('stores only the hash, never the raw token', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'link-1', expires_at: new Date() }] });

    const { token } = await links.create({ clientId: 'ptc-1', organizationId: 'org-a' });

    const [, insertParams] = pool.query.mock.calls[1];
    expect(insertParams).not.toContain(token);
    expect(insertParams).toContain(hashToken(token));
    expect(token).toHaveLength(64);
  });
});

describe('using a signing link', () => {
  beforeEach(() => pool.query.mockReset());

  it('looks the token up by its hash, never the raw value', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    await links.resolve(RAW);
    expect(pool.query.mock.calls[0][1][0]).toBe(hashToken(RAW));
    expect(pool.query.mock.calls[0][1][0]).not.toBe(RAW);
  });

  it('refuses a used or expired link in the query itself', async () => {
    // One predicate means "expired", "used" and "never existed" are the same
    // answer to anyone probing tokens.
    pool.query.mockResolvedValueOnce({ rows: [] });
    await links.resolve(RAW);
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toMatch(/used_at IS NULL/);
    expect(sql).toMatch(/expires_at > NOW\(\)/);
  });

  it('rejects an absent or non-string token without touching the database', async () => {
    for (const bad of [null, undefined, '', 123, {}]) {
      expect(await links.resolve(bad)).toBeNull();
    }
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('spends the link only once', async () => {
    // The guarded UPDATE is what makes a double-tapped submit write one
    // screening, not two.
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'link-1' }] });
    expect(await links.markUsed('link-1')).toBe(true);

    pool.query.mockResolvedValueOnce({ rows: [] });
    expect(await links.markUsed('link-1')).toBe(false);

    const [sql] = pool.query.mock.calls[0];
    expect(sql).toMatch(/WHERE id = \$1 AND used_at IS NULL/);
  });
});
