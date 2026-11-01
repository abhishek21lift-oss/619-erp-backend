'use strict';

/**
 * summarize() builds the `queues` block of /api/health.
 *
 * The field this pins is `completed`. Every other number there comes from a
 * BullMQ Redis counter that reads the same whether a worker is draining or
 * dead: waiting 0 / active 0 is both "idle" and "nothing is listening". A
 * non-zero completed count is the only one that proves work was actually
 * processed (jobs are retained 24h — jobs/queue.js removeOnComplete).
 *
 * Found because production ran with no worker container and RUN_WORKERS
 * unset, and the health endpoint could not say which of the two states it was
 * in. It looks healthy either way.
 */

jest.mock('../jobs/queue', () => ({ QUEUE_NAMES: [] }));

const { summarize } = require('../lib/queueHealth');

describe('queue health summary', () => {
  // Mirrors queueStats(): backlog is waiting + delayed, not passed in.
  const queue = (over) => {
    const q = { name: 'email', waiting: 0, active: 0, delayed: 0, completed: 0, failed: 0, paused: false, ...over };
    return { ...q, backlog: q.waiting + q.delayed };
  };

  it('sums completed across queues so liveness is one number', () => {
    const s = summarize([
      queue({ completed: 12 }),
      queue({ name: 'whatsapp', completed: 3 }),
    ]);
    expect(s.completed).toBe(15);
  });

  it('keeps completed per queue, next to the counters it is read against', () => {
    const s = summarize([queue({ completed: 7 })]);
    expect(s.counts.email).toMatchObject({ waiting: 0, completed: 7 });
  });

  it('reads a starved queue as degraded, not healthy', () => {
    const s = summarize([queue({ waiting: 5, completed: 0 })]);
    expect(s.status).toBe('degraded');
    expect(s.backlog).toBe(5);
  });

  it('never throws on an empty list', () => {
    expect(summarize([])).toMatchObject({ status: 'unknown', detail: 'queues unreachable' });
  });
});
