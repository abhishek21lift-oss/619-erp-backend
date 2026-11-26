'use strict';

// Every statement in the queue repository is tenant-scoped and parameterised.
// These tests assert SQL shape, not call order, so a refactor that keeps the
// contract passes and one that drops the org predicate fails.

const mockQuery = jest.fn();
const mockConnect = jest.fn();
jest.mock('../db/pool', () => ({ query: mockQuery, connect: mockConnect }));

const repo = require('../modules/ai-ops/ops.repository');

const ORG = 'org-1';

function sql() {
  return mockQuery.mock.calls.map((call) => String(call[0]));
}

function paramsOf(marker) {
  const index = mockQuery.mock.calls.findIndex((call) => String(call[0]).includes(marker));
  if (index === -1) throw new Error(`no query containing ${marker}`);
  return mockQuery.mock.calls[index][1];
}

beforeEach(() => {
  mockQuery.mockReset();
  mockConnect.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
});

describe('tenant scoping', () => {
  it('binds the org id, never interpolates it, in every read', async () => {
    await repo.orgName(ORG);
    await repo.findItems(ORG);
    await repo.findOpenItems(ORG);
    await repo.findItem(ORG, 'item-1');
    await repo.findEvents(ORG, 'item-1');
    await repo.latestBrief(ORG, '2026-11-25');
    await repo.latestBriefAt(ORG);
    await repo.findByDedupeKey(ORG, 'client:c1');
    await repo.findClientForSend(ORG, 'c1');
    await repo.findLeadForSend(ORG, 'l1');

    for (const statement of sql()) {
      expect(statement).not.toContain(ORG);
      expect(statement).not.toMatch(/x-org-id|req\.body\.organization_id/);
    }
    expect(paramsOf('FROM ai_ops_items')).toContain(ORG);
    expect(paramsOf('FROM pt_clients')).toContain(ORG);
    expect(paramsOf('FROM pt_leads')).toContain(ORG);
  });

  it('names organizations by primary key only', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ name: 'Iron House' }] });
    await expect(repo.orgName(ORG)).resolves.toBe('Iron House');
    expect(sql()[0]).toContain('FROM organizations WHERE id = $1');
    expect(paramsOf('FROM organizations')).toEqual([ORG]);
  });
});

describe('items', () => {
  it('inserts idempotently on the org + dedupe key', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'item-1' }] });

    await repo.insertItem(ORG, {
      client_id: 'c1', lead_id: null, dedupe_key: 'client:c1', status: 'open',
      priority_score: 50, priority_band: 'high', reasons: [], next_due_at: null,
      recommended_action: null, closed_reasons: [], closed_score: 0,
    });

    expect(sql()[0]).toContain('ON CONFLICT (organization_id, dedupe_key) DO NOTHING');
    expect(sql()[0]).toContain('RETURNING *');
  });

  it('updates only allow-listed columns under a status guard', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'item-1' }] });

    await repo.updateItem(ORG, 'item-1', 'open', {
      status: 'snoozed', priority_score: 60, reasons: [], draft: null,
      nonsense_column: 'DROP TABLE',
    });

    const statement = sql()[0];
    expect(statement).toContain('status = $');
    expect(statement).toContain('priority_score = $');
    expect(statement).not.toContain('nonsense_column');
    expect(statement).toMatch(/AND status = \$\d+/);
    expect(statement).toContain('RETURNING *');
    expect(paramsOf('UPDATE ai_ops_items')).toEqual(
      expect.arrayContaining([ORG, 'item-1', 'open']),
    );
  });

  it('claims only open or snoozed items and returns the row', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'item-1' }] });

    await repo.claimItem(ORG, 'item-1', { status: 'actioned' });

    const statement = sql()[0];
    expect(statement).toContain("status IN ('open','snoozed')");
    expect(statement).toContain('RETURNING *');
  });

  it('reopens an actioned item only after seven days', async () => {
    await repo.reopenActionedItem(ORG, 'item-1', { status: 'open' });

    const statement = sql()[0];
    expect(statement).toContain("status = 'actioned'");
    expect(statement).toContain("last_actioned_at < NOW() - INTERVAL '7 days'");
  });

  it('resolves an item that is no longer collected, from any live status', async () => {
    await repo.resolveMissingItem(ORG, 'item-1');

    const statement = sql()[0];
    expect(statement).toContain("status = 'resolved'");
    expect(statement).toContain("status IN ('open','snoozed','actioned')");
    expect(statement).toContain('resolved_at = NOW()');
  });

  it('reopens a closed item under its expected status', async () => {
    await repo.reopenClosedItem(ORG, 'item-1', 'dismissed', { status: 'open' });

    const statement = sql()[0];
    expect(statement).toContain('status = $');
    expect(paramsOf('UPDATE ai_ops_items')).toEqual(
      expect.arrayContaining([ORG, 'item-1', 'dismissed']),
    );
  });
});

describe('open list', () => {
  it('joins both subject tables with the org predicate on each side', async () => {
    await repo.findOpenItems(ORG);

    const statement = sql()[0];
    expect(statement).toContain('LEFT JOIN pt_clients c');
    expect(statement).toContain('LEFT JOIN pt_leads l');
    expect(statement).toContain('c.organization_id = i.organization_id');
    expect(statement).toContain('l.organization_id = i.organization_id');
    expect(statement).toContain('c.mobile');
    expect(statement).toContain('c.whatsapp_opt_out');
    expect(statement).toContain('l.mobile');
    expect(statement).toContain("i.status = 'open'");
  });
});

describe('brief', () => {
  it('reads only today brief events', async () => {
    await repo.latestBrief(ORG, '2026-11-25');

    const statement = sql()[0];
    expect(statement).toContain("event_type = 'brief_generated'");
    expect(statement).toContain('created_at >= $2::date');
    expect(paramsOf('brief_generated')).toEqual([ORG, '2026-11-25']);
  });

  it('returns null when there is no brief', async () => {
    await expect(repo.latestBrief(ORG, '2026-11-25')).resolves.toBeNull();
  });
});

describe('communication log', () => {
  it('writes a queued WhatsApp row with the recipient snapshot', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'log-1' }] });

    const id = await repo.insertCommunicationLog(ORG, {
      recipientType: 'client', recipientId: 'c1', recipientName: 'Ravi',
      recipientPhone: '+919000000001', message: 'Hi Ravi',
    });

    expect(id).toBe('log-1');
    const statement = sql()[0];
    for (const column of [
      'organization_id', 'recipient_type', 'recipient_id', 'recipient_name',
      'recipient_phone', 'channel', 'direction', 'template', 'message', 'status', 'provider',
    ]) {
      expect(statement).toContain(column);
    }
    expect(paramsOf('INSERT INTO communication_logs')).toEqual(
      expect.arrayContaining(['whatsapp', 'outgoing', 'ai_ops', 'queued', ORG, 'c1']),
    );
  });

  it('marks a send sent or failed without faking a sent timestamp', async () => {
    await repo.markCommunicationSent(ORG, 'log-1', { external_id: 'wamid', provider: 'meta' });
    await repo.markCommunicationFailed(ORG, 'log-1', { failure_reason: 'gateway_timeout' });

    const [sent, failed] = sql();
    expect(sent).toContain("status = 'sent'");
    expect(sent).toContain('external_id = $');
    expect(sent).toContain('sent_at = $');
    expect(failed).toContain("status = 'failed'");
    expect(failed).toContain('failure_reason = $');
    expect(failed).not.toContain('sent_at');
  });
});

describe('events', () => {
  it('inserts an event through the caller transaction client', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [{ id: 'evt-1' }] }) };

    await repo.insertEvent(ORG, {
      itemId: 'item-1', eventType: 'created', actorUserId: 'u1', actorRole: 'trainer',
      payload: { reason_codes: ['dues'] },
    }, client);

    expect(mockQuery).not.toHaveBeenCalled();
    expect(String(client.query.mock.calls[0][0])).toContain('INSERT INTO ai_ops_events');
    expect(client.query.mock.calls[0][1]).toEqual(
      expect.arrayContaining([ORG, 'item-1', 'created', 'u1', 'trainer']),
    );
  });
});

describe('withTransaction', () => {
  it('commits and always releases the client', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() };
    mockConnect.mockResolvedValue(client);

    await repo.withTransaction(async (tx) => {
      expect(tx).toBe(client);
      return 'ok';
    });

    const statements = client.query.mock.calls.map((call) => String(call[0]));
    expect(statements[0]).toBe('BEGIN');
    expect(statements).toContain('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back and rethrows on failure', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() };
    mockConnect.mockResolvedValue(client);

    await expect(repo.withTransaction(async () => { throw new Error('boom'); })).rejects.toThrow('boom');

    const statements = client.query.mock.calls.map((call) => String(call[0]));
    expect(statements).toContain('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
