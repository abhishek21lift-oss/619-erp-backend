'use strict';

const s = require('../modules/progress/retest-scheduling');

describe('Module 5 re-test scheduling', () => {
  it('adds months without JavaScript date rollover', () => {
    expect(s.addMonthsClamped('2026-01-31', 4)).toBe('2026-05-31');
    expect(s.addMonthsClamped('2026-11-30', 4)).toBe('2027-03-30');
    expect(s.addMonthsClamped('2026-01-31', 1)).toBe('2026-02-28');
    expect(s.addMonthsClamped('2024-01-31', 1)).toBe('2024-02-29');
    expect(s.addMonthsClamped('2026-08-31', 6)).toBe('2027-02-28');
  });

  it('supports the configured 4, 5 and 6 month cadences', () => {
    expect(s.scheduleFromBaseline('2026-01-15', 4)).toBe('2026-05-15');
    expect(s.scheduleFromBaseline('2026-01-15', 5)).toBe('2026-06-15');
    expect(s.scheduleFromBaseline('2026-01-15', 6)).toBe('2026-07-15');
    expect(() => s.scheduleFromBaseline('2026-01-15', 3)).toThrow(/4, 5 or 6/);
    expect(() => s.scheduleFromBaseline('2026-01-15', 7)).toThrow(/4, 5 or 6/);
  });

  it('reports a missing baseline instead of inventing a date', () => {
    expect(s.deriveState({ status: 'upcoming', scheduledDate: null, today: '2026-10-19' }))
      .toEqual({ state: 'missing_baseline', days_until: null, label: 'No baseline assessment' });
  });

  it('derives upcoming, due, overdue and rescheduled states', () => {
    expect(s.deriveState({ status: 'upcoming', scheduledDate: '2026-11-18', today: '2026-10-19' }))
      .toMatchObject({ state: 'upcoming', days_until: 30 });
    expect(s.deriveState({ status: 'upcoming', scheduledDate: '2026-10-19', today: '2026-10-19' }))
      .toMatchObject({ state: 'due', days_until: 0 });
    expect(s.deriveState({ status: 'upcoming', scheduledDate: '2026-10-01', today: '2026-10-19' }))
      .toMatchObject({ state: 'overdue', days_until: -18 });
    expect(s.deriveState({ status: 'rescheduled', scheduledDate: '2026-12-01', today: '2026-10-19' }))
      .toMatchObject({ state: 'rescheduled', days_until: 43 });
    expect(s.deriveState({ status: 'completed', scheduledDate: '2026-12-01', today: '2026-10-19' }))
      .toMatchObject({ state: 'completed' });
  });

  it('fires only the configured reminder stages, then due and overdue', () => {
    const reminderDays = [30, 14, 7];
    expect(s.reminderFor({ scheduledDate: '2026-11-18', today: '2026-10-19', reminderDays }))
      .toEqual({ kind: 'reminder', stage_days: 30 });
    expect(s.reminderFor({ scheduledDate: '2026-11-02', today: '2026-10-19', reminderDays }))
      .toEqual({ kind: 'reminder', stage_days: 14 });
    expect(s.reminderFor({ scheduledDate: '2026-10-26', today: '2026-10-19', reminderDays }))
      .toEqual({ kind: 'reminder', stage_days: 7 });
    expect(s.reminderFor({ scheduledDate: '2026-10-20', today: '2026-10-19', reminderDays })).toBeNull();
    expect(s.reminderFor({ scheduledDate: '2026-10-19', today: '2026-10-19', reminderDays }))
      .toEqual({ kind: 'due', stage_days: 0 });
    expect(s.reminderFor({ scheduledDate: '2026-10-01', today: '2026-10-19', reminderDays }))
      .toEqual({ kind: 'overdue', stage_days: -1 });
  });

  it('normalises reminder days to unique, descending, bounded values', () => {
    expect(s.normalizeReminderDays([7, 30, 14, 30, 0, 999])).toEqual([30, 14, 7]);
    expect(() => s.normalizeReminderDays([])).toThrow(/At least one/);
    expect(() => s.normalizeReminderDays(undefined)).not.toThrow();
  });

  it('uses the studio timezone at the midnight boundary', () => {
    const instant = new Date('2026-10-18T18:31:00Z'); // 00:01 on 19 Oct in IST
    expect(s.todayInZone('Asia/Kolkata', instant)).toBe('2026-10-19');
    expect(s.todayInZone('America/New_York', instant)).toBe('2026-10-18');
    expect(s.todayInZone('Not/AZone', instant)).toBe('2026-10-19');
  });

  it('reports the next countdown reminder', () => {
    expect(s.nextReminder({ scheduledDate: '2026-11-18', today: '2026-10-19', reminderDays: [30, 14, 7] }))
      .toEqual({ stage_days: 14, in_days: 16, on_date: '2026-11-04' });
    expect(s.nextReminder({ scheduledDate: '2026-10-29', today: '2026-10-19', reminderDays: [30, 14, 7] }))
      .toEqual({ stage_days: 7, in_days: 3, on_date: '2026-10-22' });
  });
});
