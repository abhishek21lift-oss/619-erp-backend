'use strict';
// Abort the model call when the reader goes away before the response ends.

const { EventEmitter } = require('node:events');
const { abortOnClose } = require('../lib/sse-abort');

function fakeRes({ writableEnded = false } = {}) {
  const res = new EventEmitter();
  res.writableEnded = writableEnded;
  res.destroyed = false;
  return res;
}

describe('abortOnClose', () => {
  it('aborts when the client closes before the response ends', () => {
    const res = fakeRes();
    const controller = abortOnClose(res);

    res.emit('close');

    expect(controller.signal.aborted).toBe(true);
  });

  it('does not abort on the close event that follows a completed response', () => {
    const res = fakeRes();
    const controller = abortOnClose(res);

    res.writableEnded = true;
    res.emit('close');

    expect(controller.signal.aborted).toBe(false);
  });
});
