'use strict';
// The daily at-risk digest: the parts that decide what happens.
//
// The two rules worth pinning are what this test exists for:
//   - the member is never a recipient, and
//   - a studio is never told twice about the same day.

jest.mock('../db/pool', () => ({ query: jest.fn() }));
jest.mock('../modules/pt-os/churn.service', () => ({ buildChurnList: jest.fn() }));

const pool = require('../db/pool');
const { buildChurnList } = require('../modules/pt-os/churn.service');
const notifier = require('../modules/notifications/notifications.service');
const { runChurnDigestSweep, digestOutcome, channelsFor } = require('../modules/pt-os/churn.sweep');

const ORG = '11111111-1111-1111-1111-111111111111';
const TRAINER = {
  user_id: 'u1', name: 'Priya', email: 'priya@studio.test',
  phone: '+919000000000', organization_id: ORG,
};

/** Route pool queries by what they are for, not by call order. */
function routePool({ orgs = [ORG], claimId = 'd1' } = {}) {
  pool.query.mockImplementation((sql) => {
    if (sql.includes('SELECT DISTINCT organization_id')) return Promise.resolve({ rows: orgs.map((id) => ({ organization_id: id })) });
    if (sql.includes('INSERT INTO churn_digest_deliveries')) return Promise.resolve({ rows: claimId ? [{ id: claimId }] : [] });
    if (sql.includes('UPDATE churn_digest_deliveries')) return Promise.resolve({ rows: [] });
    throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
  });
}

const row = (name, band) => ({ client_id: name.toLowerCase(), client_name: name, band });

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(notifier, 'recipientFromStudioTrainer').mockResolvedValue(TRAINER);
  jest.spyOn(notifier, 'send').mockResolvedValue({ inapp: { status: 'delivered' } });
});

describe('channelsFor', () => {
  it('uses every channel the trainer can receive on', () => {
    expect(channelsFor(TRAINER)).toEqual(['inapp', 'email', 'whatsapp']);
  });

  it('drops WhatsApp when the trainer has no mobile', () => {
    expect(channelsFor({ ...TRAINER, phone: null })).toEqual(['inapp', 'email']);
  });
});

describe('digestOutcome', () => {
  it('is sent when any one channel left the building', () => {
    expect(digestOutcome({
      email: { status: 'failed', error: 'smtp' },
      whatsapp: { status: 'sent' },
    })).toEqual({ status: 'sent', error: null });
  });

  it('is failed when every channel failed', () => {
    expect(digestOutcome({
      email: { status: 'failed', error: 'smtp' },
      whatsapp: { status: 'failed', error: 'no recipient' },
    })).toEqual({ status: 'failed', error: 'smtp; no recipient' });
  });

  it('is failed when nothing was attempted', () => {
    expect(digestOutcome({})).toEqual({ status: 'failed', error: 'no_channel_attempted' });
  });
});

describe('runChurnDigestSweep', () => {
  it('sends nothing when no client is high or critical', async () => {
    routePool();
    buildChurnList.mockResolvedValue({ as_of: '2026-11-01', rows: [row('Rahul', 'medium')] });

    const summary = await runChurnDigestSweep();

    expect(notifier.send).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(1);
  });

  it('leaves the day to whichever replica claimed it', async () => {
    routePool({ claimId: null });
    buildChurnList.mockResolvedValue({ as_of: '2026-11-01', rows: [row('Rahul', 'high')] });

    const summary = await runChurnDigestSweep();

    expect(notifier.send).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(1);
  });

  it('sends one digest for the urgent clients and settles it', async () => {
    routePool();
    buildChurnList.mockResolvedValue({
      as_of: '2026-11-01',
      rows: [row('Rahul', 'critical'), row('Anita', 'high'), row('Vikram', 'medium')],
    });

    const summary = await runChurnDigestSweep();

    expect(notifier.send).toHaveBeenCalledTimes(1);
    const [type, recipient, data] = notifier.send.mock.calls[0];
    expect(type).toBe('churn_digest');
    expect(recipient.user_id).toBe('u1');
    expect(data).toMatchObject({ count: 2, client_names: 'Rahul, Anita', link: '/pt-os/clients/at-risk' });
    expect(summary.sent).toBe(1);

    const settle = pool.query.mock.calls.find(([sql]) => sql.includes('UPDATE churn_digest_deliveries'));
    expect(settle[1]).toEqual(['d1', 'sent', 2, null]);
  });

  it('never addresses the client about their own risk', async () => {
    routePool();
    buildChurnList.mockResolvedValue({ as_of: '2026-11-01', rows: [row('Rahul', 'critical')] });

    await runChurnDigestSweep();

    const [, recipient] = notifier.send.mock.calls[0];
    expect(recipient).toEqual(TRAINER);
    expect(recipient.client_id).toBeUndefined();
  });

  it('skips the studio when it has no trainer account', async () => {
    routePool();
    notifier.recipientFromStudioTrainer.mockResolvedValue(null);
    buildChurnList.mockResolvedValue({ as_of: '2026-11-01', rows: [row('Rahul', 'high')] });

    const summary = await runChurnDigestSweep();

    expect(notifier.send).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(1);
    const settle = pool.query.mock.calls.find(([sql]) => sql.includes('UPDATE churn_digest_deliveries'));
    expect(settle[1][1]).toBe('skipped');
    expect(settle[1][3]).toBe('trainer_not_found');
  });
});
