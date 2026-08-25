'use strict';
// POST /api/ai/chat — bounded conversation history (audit F-5).
//
// The chat prompt must never grow without limit: the handler reads only the
// most recent AI_CHAT_HISTORY_LIMIT messages (database-applied LIMIT, newest
// first), reverses them back into chronological order, and sends those to the
// model. The current user message is inserted BEFORE the history read, so it
// arrives as the newest history row — included exactly once, never appended
// separately. Regenerate still deletes only the latest assistant message.

jest.mock('../db/pool', () => ({ query: jest.fn() }));
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => {
    req.user = { id: 'usr-1', role: 'trainer', organization_id: 'org-1' };
    next();
  },
  adminOnly: (_req, _res, next) => next(),
}));
jest.mock('../lib/ai/router', () => ({
  routedChat: jest.fn(),
  routedStream: jest.fn(),
}));
jest.mock('../lib/ai/knowledgeBase', () => ({ retrieveContext: jest.fn() }));
jest.mock('../lib/ai/tools', () => ({ runTools: jest.fn() }));
jest.mock('../lib/ai/usage', () => ({
  logUsage: jest.fn().mockResolvedValue(undefined),
  getUserUsage: jest.fn(),
  getModelStats: jest.fn(),
}));
jest.mock('../lib/sse-heartbeat', () => ({ startSseHeartbeat: jest.fn(() => () => {}) }));
jest.mock('../lib/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));

const request = require('supertest');
const express = require('express');
const pool = require('../db/pool');
const { routedStream } = require('../lib/ai/router');
const { retrieveContext } = require('../lib/ai/knowledgeBase');
const { runTools } = require('../lib/ai/tools');
const logger = require('../lib/logger');

process.env.OPENROUTER_API_KEY = 'test-key';
const aiRouter = require('../routes/ai');

const app = express();
app.use(express.json());
app.use('/api/ai', aiRouter);

// History fixture, oldest → newest (what the DB would hold). The mock
// emulates the route's SQL exactly: it slices the newest `limit` rows and
// hands them back newest-first, as `ORDER BY created_at DESC, id DESC LIMIT`
// would — the ROUTE must then reverse them into chronological order.
function makeHistory(count, { lastContent = 'Q' + count, lastRole = 'user' } = {}) {
  const rows = [];
  for (let i = 1; i <= count; i++) {
    const isLast = i === count;
    rows.push({
      role: isLast ? lastRole : (i % 2 === 1 ? 'user' : 'assistant'),
      content: isLast ? lastContent : 'msg-' + i,
    });
  }
  return rows;
}

function historyDispatch(historyRows, { clientId } = {}) {
  return jest.fn((sql, params) => {
    if (sql.includes('ai_conversations WHERE id')) return Promise.resolve({ rows: [{ id: 'conv-1' }] });
    if (sql.includes('pt_clients WHERE')) return Promise.resolve({ rows: [{ id: clientId }] });
    if (sql.includes('LIMIT $2')) {
      const limit = params[1];
      return Promise.resolve({ rows: historyRows.slice(-limit).reverse() }); // DB: newest N, DESC
    }
    if (sql.includes('DELETE FROM ai_messages')) return Promise.resolve({ rows: [] });
    if (sql.includes("VALUES ($1,'user',$2)")) return Promise.resolve({ rows: [] });
    if (sql.includes("'assistant'")) return Promise.resolve({ rows: [] });
    return Promise.resolve({ rows: [] });
  });
}

const historyQuery = () => {
  const calls = pool.query.mock.calls.filter(([sql]) => sql.includes('LIMIT $2'));
  return calls[calls.length - 1] || [];
};

const modelMessages = () => {
  const calls = routedStream.mock.calls;
  return calls.length ? calls[calls.length - 1][0].messages : null;
};

const historyMessages = () => modelMessages().slice(1); // drop system prompt

let streamOk;
beforeEach(() => {
  streamOk = jest.fn().mockImplementation(async function* () {
    yield 'Answer';
  });
  pool.query.mockReset();
  retrieveContext.mockReset().mockResolvedValue([]);
  runTools.mockReset().mockResolvedValue({ toolNames: [], contextText: '' });
  routedStream.mockReset().mockImplementation(streamOk);
  logger.warn.mockClear();
  delete process.env.AI_CHAT_HISTORY_LIMIT;
});

describe('POST /api/ai/chat — bounded conversation history (F-5)', () => {
  it('TEST 1: the history query is bounded (LIMIT in SQL, newest-first, stable tiebreak)', async () => {
    pool.query.mockImplementation(historyDispatch(makeHistory(5)));

    await request(app).post('/api/ai/chat').send({ message: 'hi', conversation_id: 'conv-1' });

    const [sql, params] = historyQuery();
    expect(sql).toContain('ORDER BY created_at DESC, id DESC');
    expect(sql).toContain('LIMIT $2');
    expect(params[0]).toBe('conv-1');
    expect(params[1]).toBe(20); // default window
  });

  it('TEST 2: the newest N messages are selected (database applies the LIMIT)', async () => {
    const history = makeHistory(60);
    process.env.AI_CHAT_HISTORY_LIMIT = '40';
    pool.query.mockImplementation(historyDispatch(history));

    await request(app).post('/api/ai/chat').send({ message: 'hi', conversation_id: 'conv-1' });

    const [, params] = historyQuery();
    expect(params[1]).toBe(40);
    const sent = historyMessages();
    expect(sent).toHaveLength(40);
    expect(sent[0].content).toBe('msg-21'); // window starts at message 21
    expect(sent[39].content).toBe('Q60');
  });

  it('TEST 3: selected rows are restored to chronological order before the model', async () => {
    const history = makeHistory(8);
    pool.query.mockImplementation(historyDispatch(history)); // mock returns newest-first

    await request(app).post('/api/ai/chat').send({ message: 'hi', conversation_id: 'conv-1' });

    const sent = historyMessages();
    expect(sent.map(m => m.content)).toEqual([
      'msg-1', 'msg-2', 'msg-3', 'msg-4', 'msg-5', 'msg-6', 'msg-7', 'Q8',
    ]);
    expect(sent[0].role).toBe('user');
    expect(sent[1].role).toBe('assistant');
  });

  it('TEST 4: old messages outside the window are never sent to the model', async () => {
    const history = makeHistory(100);
    pool.query.mockImplementation(historyDispatch(history));

    await request(app).post('/api/ai/chat').send({ message: 'hi', conversation_id: 'conv-1' });

    const sent = historyMessages();
    expect(sent).toHaveLength(20); // default window
    expect(sent[0].content).toBe('msg-81');
    expect(sent.map(m => m.content)).not.toContain('msg-1');
    expect(sent.map(m => m.content)).not.toContain('msg-80');
  });

  it('TEST 5: the current user message is not duplicated (newest row, sent once)', async () => {
    const history = makeHistory(60, { lastContent: 'Where is my workout?', lastRole: 'user' });
    pool.query.mockImplementation(historyDispatch(history));

    await request(app).post('/api/ai/chat').send({
      message: 'Where is my workout?',
      conversation_id: 'conv-1',
    });

    const sent = historyMessages();
    const occurrences = sent.filter(m => m.content === 'Where is my workout?');
    expect(occurrences).toHaveLength(1);
    expect(sent[sent.length - 1]).toEqual({ role: 'user', content: 'Where is my workout?' });
  });

  it('TEST 6: empty and single-message history still work', async () => {
    pool.query.mockImplementation(historyDispatch([])); // empty history

    const res = await request(app).post('/api/ai/chat').send({ message: 'hi', conversation_id: 'conv-1' });

    expect(res.status).toBe(200);
    expect(historyMessages()).toEqual([]); // system prompt only
    expect(res.text).toContain('"type":"done"');

    // Conversation with only the current user message (new conversation shape)
    pool.query.mockImplementation(historyDispatch(makeHistory(1)));
    const res2 = await request(app).post('/api/ai/chat').send({ message: 'hi', conversation_id: 'conv-1' });

    expect(res2.status).toBe(200);
    expect(historyMessages()).toEqual([{ role: 'user', content: 'Q1' }]);
    expect(res2.text).toContain('"type":"done"');
  });

  it('TEST 7: normal short history is unchanged (all messages, in order)', async () => {
    const history = makeHistory(6);
    pool.query.mockImplementation(historyDispatch(history));

    await request(app).post('/api/ai/chat').send({ message: 'hi', conversation_id: 'conv-1' });

    expect(historyMessages().map(m => m.content)).toEqual([
      'msg-1', 'msg-2', 'msg-3', 'msg-4', 'msg-5', 'Q6',
    ]);
  });

  it('TEST 8: regenerate deletes only the latest assistant, then generates from bounded history', async () => {
    // Post-DELETE DB state: the old answer is gone, history ends on the user
    // question (59 rows: 58 + the question).
    const history = makeHistory(59, { lastContent: 'Should I add more volume?', lastRole: 'user' });
    pool.query.mockImplementation(historyDispatch(history));

    await request(app).post('/api/ai/chat').send({
      message: 'Should I add more volume?',
      conversation_id: 'conv-1',
      regenerate: true,
    });

    // Exactly one DELETE, targeting only the latest assistant message.
    const deletes = pool.query.mock.calls.filter(([sql]) => sql.includes('DELETE FROM ai_messages'));
    expect(deletes).toHaveLength(1);
    expect(deletes[0][0]).toContain("role = 'assistant'");
    expect(deletes[0][0]).toContain('ORDER BY created_at DESC LIMIT 1');

    // No user INSERT on regenerate.
    expect(pool.query.mock.calls.some(([sql]) => sql.includes("VALUES ($1,'user',$2)"))).toBe(false);

    // Bounded window applies to regenerate too (default 20): history ends on
    // the user question, and no message appears after it.
    const sent = historyMessages();
    expect(sent).toHaveLength(20);
    expect(sent[0].content).toBe('msg-40'); // window bound enforced
    expect(sent[sent.length - 1]).toEqual({ role: 'user', content: 'Should I add more volume?' });

    // New assistant answer persisted, conversation touched, done event.
    const assistantInsert = pool.query.mock.calls.find(
      ([sql]) => sql.includes('VALUES') && sql.includes("'assistant'")
    );
    expect(assistantInsert).toBeTruthy();
    expect(assistantInsert[1][1]).toBe('Answer');
    expect(pool.query.mock.calls.some(([sql]) => sql.includes('UPDATE ai_conversations'))).toBe(true);
  });

  it('TEST 9: conversation ownership is enforced before history access', async () => {
    pool.query.mockImplementation(historyDispatch(makeHistory(10)));

    await request(app).post('/api/ai/chat').send({ message: 'hi', conversation_id: 'conv-1' });

    const ownershipIdx = pool.query.mock.calls.findIndex(([sql]) => sql.includes('ai_conversations WHERE id'));
    const historyIdx = pool.query.mock.calls.findIndex(([sql]) => sql.includes('LIMIT $2'));
    expect(ownershipIdx).toBeGreaterThanOrEqual(0);
    expect(historyIdx).toBeGreaterThan(ownershipIdx);
  });

  it('TEST 10: foreign conversation → 404 with NO history query, RAG, tools, or model', async () => {
    const dispatch = jest.fn(() => Promise.resolve({ rows: [] })); // ownership gate fails
    pool.query.mockImplementation(dispatch);

    const res = await request(app)
      .post('/api/ai/chat')
      .send({ message: 'hi', conversation_id: 'foreign-conv' });

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(pool.query.mock.calls.every(([sql]) => !sql.includes('LIMIT $2'))).toBe(true);
    expect(retrieveContext).not.toHaveBeenCalled();
    expect(runTools).not.toHaveBeenCalled();
    expect(routedStream).not.toHaveBeenCalled();
  });

  it('TEST 11: tenant/client authorization is unchanged (org-scoped parent gate still runs)', async () => {
    pool.query.mockImplementation(historyDispatch(makeHistory(4), { clientId: 'cli-1' }));

    await request(app)
      .post('/api/ai/chat')
      .send({ message: 'hi', conversation_id: 'conv-1', client_id: 'cli-1' });

    // Phase 2C: buildClientState uses multiline SQL — check for pt_clients + WHERE separately
    const clientGate = pool.query.mock.calls.find(([sql]) => sql.includes('pt_clients') && sql.includes('WHERE id') && sql.includes('deleted_at IS NULL'));
    expect(clientGate).toBeTruthy();
    expect(clientGate[0]).toContain('organization_id');
    expect(clientGate[1]).toContain('cli-1');
    expect(clientGate[1]).toContain('org-1');
    expect(historyMessages().map(m => m.content)).toEqual(['msg-1', 'msg-2', 'msg-3', 'Q4']);
  });

  it('TEST 12: the configured/default history limit is actually respected', async () => {
    const history = makeHistory(100);

    // Default (unset) → 20.
    pool.query.mockImplementation(historyDispatch(history));
    await request(app).post('/api/ai/chat').send({ message: 'hi', conversation_id: 'conv-1' });
    expect(historyQuery()[1][1]).toBe(20);

    // Configured in-range value → used verbatim.
    process.env.AI_CHAT_HISTORY_LIMIT = '25';
    pool.query.mockImplementation(historyDispatch(history));
    await request(app).post('/api/ai/chat').send({ message: 'hi', conversation_id: 'conv-1' });
    expect(historyQuery()[1][1]).toBe(25);

    // Out-of-range and non-numeric values → warned, default used.
    for (const bad of ['0', '500', 'abc', '']) {
      process.env.AI_CHAT_HISTORY_LIMIT = bad;
      pool.query.mockImplementation(historyDispatch(history));
      await request(app).post('/api/ai/chat').send({ message: 'hi', conversation_id: 'conv-1' });
      expect(historyQuery()[1][1]).toBe(20);
    }
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ value: expect.any(String) }),
      'ai_chat_history_limit_invalid'
    );
  });
});