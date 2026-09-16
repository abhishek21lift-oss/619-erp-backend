'use strict';
// An unhandled rejection has to be readable.
//
// The handler in server.js logged `{ reason }`. pino serializes by KEY, and
// lib/logger.js registers a serializer for `err` and none for `reason`. An
// Error's `message` and `stack` are non-enumerable, so JSON.stringify of one is
// `{}` — which is exactly what every unhandled rejection this process has ever
// had was recorded as:
//
//     {"level":50,"reason":{},"msg":"unhandledRejection"}
//
// No message. No stack. The sibling `uncaughtException` handler two lines below
// already used `{ err }`, which is why one of the two had usable output and the
// other did not.
//
// This asserts the pino behaviour directly rather than mocking the logger,
// because the behaviour IS the bug: a mock would have happily recorded
// `{ reason: <Error> }` and passed while production logged nothing.

const fs = require('fs');
const path = require('path');
const pino = require('pino');

/** Capture one pino line. */
function capture(fn) {
  const lines = [];
  const stream = { write: (s) => lines.push(JSON.parse(s)) };
  const logger = pino({ serializers: { err: pino.stdSerializers.err } }, stream);
  fn(logger);
  return lines[0];
}

describe('pino needs the err key', () => {
  const boom = new Error('database connection lost');

  it('records an Error under an unserialized key as an empty object', () => {
    const line = capture((log) => log.error({ reason: boom }, 'unhandledRejection'));
    expect(line.reason).toEqual({});
    expect(JSON.stringify(line)).not.toContain('database connection lost');
  });

  it('records the message and the stack under err', () => {
    const line = capture((log) => log.error({ err: boom }, 'unhandledRejection'));
    expect(line.err.message).toBe('database connection lost');
    expect(line.err.stack).toContain('Error: database connection lost');
  });

  it('passes a non-Error rejection through unchanged', () => {
    // `Promise.reject('nope')` and `Promise.reject({ code: 'X' })` are legal
    // and must not become {} either.
    expect(capture((log) => log.error({ err: 'nope' }, 'x')).err).toBe('nope');
    expect(capture((log) => log.error({ err: { code: 'X' } }, 'x')).err).toEqual({ code: 'X' });
  });
});

describe('server.js uses it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  it('logs the rejection reason under err', () => {
    expect(src).toMatch(/process\.on\('unhandledRejection'/);
    expect(src).toMatch(/logger\.error\(\{ err: reason \}, 'unhandledRejection'\)/);
  });

  it('does not log it under reason', () => {
    expect(src).not.toMatch(/logger\.error\(\{ reason \}/);
  });

  it('and the logger still registers no serializer for reason', () => {
    // The fix is the call site, not the logger: adding a `reason` serializer
    // would work too, and would leave the next `{ somethingElse }` silently
    // empty. One key, one meaning.
    const loggerSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'logger.js'), 'utf8');
    expect(loggerSrc).toMatch(/err: pino\.stdSerializers\.err/);
    expect(loggerSrc).not.toMatch(/\breason:\s*pino\./);
  });
});
