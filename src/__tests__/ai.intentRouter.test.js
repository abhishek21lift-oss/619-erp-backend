'use strict';

const { inferToolHints } = require('../lib/ai/intentRouter');

describe('AI deterministic intent routing', () => {
  test('maps natural attendance language', () => {
    expect(inferToolHints('Who came to the gym today?')).toContain('attendance_summary');
  });

  test('maps natural revenue language', () => {
    expect(inferToolHints('How much money did we collect this month?')).toContain('revenue_summary');
  });

  test('maps pending payment language', () => {
    expect(inferToolHints('Who still has not paid?')).toContain('dues_summary');
  });

  test('maps trainer roster language', () => {
    expect(inferToolHints('Show me all trainers')).toContain('trainer_roster');
  });

  test('maps client-count language', () => {
    expect(inferToolHints('How many active members do we have?')).toContain('client_stats');
  });

  test('does not route ordinary coaching questions to business tools', () => {
    expect(inferToolHints('Give me a chest workout for hypertrophy')).toContain('search_exercises');
    expect(inferToolHints('What is progressive overload?')).toEqual([]);
  });
});
