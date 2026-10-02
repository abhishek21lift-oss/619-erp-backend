'use strict';
// A malformed value is the caller's error, not the server's (Phase 3).
//
// Postgres rejects text it cannot read as the column's type — 'lots' for a
// numeric, 'tomorrow-ish' for a date, a 30-digit number for an integer — with
// SQLSTATE class 22. The handler mapped the integrity classes (23xxx) to 4xx
// but not these, so every one of them answered 500 "An internal error
// occurred": an alert for a server fault that never happened, and no hint to
// the caller of what to fix. The message must not echo the value either:
// Postgres quotes it ("invalid input syntax for type numeric: \"lots\"").

jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const logger = require('../lib/logger');
const { errorHandler } = require('../middleware/errorHandler');

function run(err) {
  const req = { method: 'POST', originalUrl: '/api/expenses', path: '/' };
  const res = {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  errorHandler(err, req, res, () => {});
  return res;
}

describe('invalid input from the database is a 400', () => {
  it.each([
    ['22P02', 'invalid input syntax for type numeric: "lots"'],
    ['22003', 'value "99999999999999999999" is out of range for type integer'],
    ['22007', 'invalid input syntax for type date: "tomorrow-ish"'],
    ['22008', 'date/time field value out of range: "2026-13-45"'],
  ])('%s answers 400 without echoing the value', (code, message) => {
    logger.error.mockClear();
    logger.warn.mockClear();
    const res = run({ code, message });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/lots|9999|tomorrow|2026-13/);
    expect(logger.error).not.toHaveBeenCalled();
    // Still logged: the same codes come from server-side SQL bugs (Phase 5's
    // UPI approval), and a 400 must not make one invisible.
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ code }), 'db_invalid_input');
  });

  it('an unknown database error is still a 500', () => {
    const res = run({ code: '57P01', message: 'terminating connection' });
    expect(res.statusCode).toBe(500);
  });
});
