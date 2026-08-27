'use strict';
const { startSseHeartbeat } = require('../lib/sse-heartbeat');

describe('sse-heartbeat', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const makeRes = (overrides = {}) => ({
    writableEnded: false,
    destroyed:     false,
    write:         jest.fn(),
    ...overrides,
  });

  it('writes an SSE comment line on each tick while the stream is open', () => {
    const res = makeRes();
    const stop = startSseHeartbeat(res, 15000);

    jest.advanceTimersByTime(15000);
    expect(res.write).toHaveBeenCalledTimes(1);
    expect(res.write).toHaveBeenCalledWith(': ping\n\n');

    jest.advanceTimersByTime(15000);
    expect(res.write).toHaveBeenCalledTimes(2);

    stop();
  });

  it('stop() clears the timer and stops further writes', () => {
    const res = makeRes();
    const stop = startSseHeartbeat(res, 15000);

    jest.advanceTimersByTime(15000);
    expect(res.write).toHaveBeenCalledTimes(1);

    stop();
    jest.advanceTimersByTime(60000);
    expect(res.write).toHaveBeenCalledTimes(1);
  });

  it('stops automatically once the response has ended (no write after end)', () => {
    const res = makeRes({ writableEnded: true });
    const stop = startSseHeartbeat(res, 15000);

    jest.advanceTimersByTime(60000);
    expect(res.write).not.toHaveBeenCalled();

    stop();
  });

  it('stops automatically on a write failure', () => {
    const res = makeRes();
    res.write.mockImplementation(() => {
      throw new Error('ERR_STREAM_WRITE_AFTER_END');
    });

    const stop = startSseHeartbeat(res, 15000);
    jest.advanceTimersByTime(15000);
    expect(res.write).toHaveBeenCalledTimes(1);

    // First write threw, so the timer cleared itself: no further attempts.
    jest.advanceTimersByTime(60000);
    expect(res.write).toHaveBeenCalledTimes(1);

    stop();
  });

  it('respects a custom interval', () => {
    const res = makeRes();
    const stop = startSseHeartbeat(res, 1000);

    jest.advanceTimersByTime(999);
    expect(res.write).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(res.write).toHaveBeenCalledTimes(1);

    stop();
  });
});