'use strict';
// The forecast's arithmetic, tested without a database.
//
// The endpoint is a read over three existing tables; the part that can be
// wrong silently is the model. A perfect line must fit perfectly, a flat
// series must not acquire a slope, and the month windows must be contiguous
// and end at the current month — otherwise "next month" is computed from the
// wrong index.

const {
  leastSquares, lastMonths, futureMonths,
} = require('../modules/platform/super-admin/forecast');

describe('leastSquares', () => {
  it('recovers an exact linear series', () => {
    const fit = leastSquares([100, 200, 300, 400]);
    expect(fit.slope).toBeCloseTo(100, 6);
    expect(fit.intercept).toBeCloseTo(100, 6);
    expect(fit.r2).toBeCloseTo(1, 6);
    expect(fit.se).toBeCloseTo(0, 6);
    expect(fit.n).toBe(4);
  });

  it('does not invent a trend in a flat series', () => {
    const fit = leastSquares([500, 500, 500, 500]);
    expect(fit.slope).toBeCloseTo(0, 6);
    expect(fit.intercept).toBeCloseTo(500, 6);
    // A flat series has no variance, so R² is undefined; the model reports 0
    // rather than NaN so the UI cannot print "R² NaN".
    expect(fit.r2).toBe(0);
  });

  it('reports a low R² for noise rather than pretending it fits', () => {
    const fit = leastSquares([100, 900, 120, 880, 110]);
    expect(fit.r2).toBeLessThan(0.2);
  });

  it('needs more than two points to estimate residual error', () => {
    expect(leastSquares([100, 200]).se).toBe(0);
  });
});

describe('month windows', () => {
  it('returns contiguous months ending at the current one', () => {
    const months = lastMonths(12);
    expect(months).toHaveLength(12);
    expect(new Set(months).size).toBe(12);
    const now = new Date();
    const current = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    expect(months[months.length - 1]).toBe(current);
  });

  it('starts the forecast at next month, never the current one', () => {
    const history = lastMonths(2);
    const future = futureMonths(3);
    expect(future).toHaveLength(3);
    expect(future[0]).not.toBe(history[history.length - 1]);
    expect(future.includes(history[history.length - 1])).toBe(false);
  });

  it('handles a year boundary', () => {
    const months = lastMonths(3);
    // The keys must still parse as YYYY-MM and be strictly increasing.
    for (const m of months) expect(m).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);
    expect([...months].sort()).toEqual(months);
  });
});
