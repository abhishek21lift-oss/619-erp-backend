'use strict';
// Free-slot computation. Pure function: no DB, no clock, so the arithmetic
// that decides what a client can see is pinned exactly.

const {
  computeSlots, DEFAULT_SETTINGS, toMinutes, toTime, istNow,
} = require('../modules/pt-os/availability.service');

const base = {
  fromDate: '2026-11-02', days: 1, nowDate: '2026-11-01', nowMinutes: 0,
  availability: [{ weekday: 1, start_time: '07:00', end_time: '10:00' }],
  timeOff: [], sessions: [],
  settings: { slot_minutes: 60, buffer_minutes: 0, min_notice_hours: 0 },
};

describe('computeSlots', () => {
  it('steps slots from the window start and stops at the window end', () => {
    expect(computeSlots(base)[0].slots.map((s) => s.start)).toEqual(['07:00', '08:00', '09:00']);
  });

  it('drops a slot that would run past the window', () => {
    const r = computeSlots({
      ...base,
      availability: [{ weekday: 1, start_time: '07:00', end_time: '09:30' }],
    });
    expect(r[0].slots.map((s) => s.start)).toEqual(['07:00', '08:00']);
  });

  it('removes slots that collide with a booked session', () => {
    const r = computeSlots({
      ...base,
      sessions: [{ session_date: '2026-11-02', start_time: '08:00', end_time: '09:00' }],
    });
    expect(r[0].slots.map((s) => s.start)).toEqual(['07:00', '09:00']);
  });

  it('keeps the buffer after a booked session unusable', () => {
    const r = computeSlots({
      ...base,
      settings: { ...base.settings, buffer_minutes: 30 },
      sessions: [{ session_date: '2026-11-02', start_time: '08:00', end_time: '09:00' }],
    });
    expect(r[0].slots.map((s) => s.start)).toEqual(['07:00']);
  });

  it('applies min notice only to today', () => {
    const notice = { ...base.settings, min_notice_hours: 12 };
    const today = computeSlots({
      ...base, fromDate: '2026-11-01', nowDate: '2026-11-01', nowMinutes: 6 * 60 + 30,
      settings: notice,
      availability: [{ weekday: 0, start_time: '07:00', end_time: '10:00' }],
    });
    expect(today[0].slots).toEqual([]); // 12 h notice leaves nothing after 06:30
    const future = computeSlots({
      ...base, days: 2, nowDate: '2026-11-01', nowMinutes: 6 * 60 + 30,
      settings: notice,
      availability: [
        { weekday: 0, start_time: '07:00', end_time: '10:00' },
        { weekday: 1, start_time: '07:00', end_time: '10:00' },
      ],
    });
    // fromDate is tomorrow relative to nowDate, so notice does not apply.
    expect(future[0].slots.map((s) => s.start)).toEqual(['07:00', '08:00', '09:00']);
  });

  it('skips days covered by time off and returns `days` entries', () => {
    const r = computeSlots({
      ...base,
      days: 3,
      timeOff: [{ starts_on: '2026-11-02', ends_on: '2026-11-02' }],
      availability: [
        { weekday: 1, start_time: '07:00', end_time: '10:00' },
        { weekday: 2, start_time: '07:00', end_time: '10:00' },
      ],
    });
    expect(r).toHaveLength(3);
    expect(r[0].slots).toHaveLength(0);
    expect(r[1].slots.map((s) => s.start)).toEqual(['07:00', '08:00', '09:00']);
  });
});

describe('time helpers', () => {
  it('round-trips HH:MM minutes', () => {
    expect(toMinutes('08:30')).toBe(510);
    expect(toTime(510)).toBe('08:30');
    expect(toTime(7 * 60)).toBe('07:00');
  });

  it('reads the clock as IST wall time', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-01T01:00:00Z')); // 06:30 IST
    expect(istNow()).toEqual({ date: '2026-11-01', minutes: 390 });
    jest.useRealTimers();
  });

  it('pins the documented defaults', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      slot_minutes: 60, buffer_minutes: 0, min_notice_hours: 12,
      horizon_days: 30, cancel_cutoff_hours: 12,
    });
  });
});
