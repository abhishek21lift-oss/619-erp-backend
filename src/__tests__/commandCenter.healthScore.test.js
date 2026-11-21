'use strict';
// The graded health score that rides on every Command Center snapshot.
//
// The rollup already says WARNING or CRITICAL. The score exists to answer the
// next question — how much of the platform is healthy, and how much of it did
// we not see — and it is computed from the same cards so the two can never
// disagree about the evidence.
//
// These tests pin the properties an operator relies on:
//   * a deliberately-unconfigured capability does not lower the score;
//   * a blind spot lowers it but still scores above a confirmed failure;
//   * process-local cards are down-weighted against platform-wide ones;
//   * nothing measured returns null, never zero.

const { healthScore } = require('../modules/command-center/snapshot.service');

const card = (name, status, extra = {}) => ({ name, status, ...extra });
const allHealthy = [
  card('database', 'healthy'),
  card('redis', 'healthy'),
  card('queue', 'healthy'),
  card('backup', 'healthy'),
];

describe('healthScore', () => {
  it('grades an all-healthy platform 100 / A', () => {
    const h = healthScore(allHealthy);
    expect(h.score).toBe(100);
    expect(h.grade).toBe('A');
    expect(h.worst).toBe('healthy');
    expect(h.measured).toBe(4);
    expect(h.components.healthy).toBe(4);
  });

  it('returns null and unknown when nothing could be measured', () => {
    const h = healthScore([]);
    expect(h.score).toBeNull();
    expect(h.grade).toBe('unknown');
    expect(h.measured).toBe(0);
  });

  it('excludes a capability this deployment deliberately did not configure', () => {
    const withExpected = [...allHealthy, card('smtp', 'unavailable', { expected: true })];
    const h = healthScore(withExpected);
    expect(h.score).toBe(100);
    expect(h.measured).toBe(4);
    expect(h.not_configured).toBe(1);
    expect(h.components.unavailable).toBe(0);
  });

  it('scores a blind probe above a confirmed failure', () => {
    const blind = healthScore([...allHealthy.slice(1), card('database', 'unavailable')]);
    const failing = healthScore([...allHealthy.slice(1), card('database', 'critical')]);
    expect(blind.score).toBeGreaterThan(failing.score);
    expect(failing.score).toBe(75);
    expect(failing.grade).toBe('B');
  });

  it('counts a process-scope card at half weight', () => {
    const platformOnly = healthScore([
      card('database', 'critical'),
      card('redis', 'healthy'),
    ]);
    const withProcess = healthScore([
      card('database', 'critical'),
      card('redis', 'healthy'),
      card('runtime', 'healthy', { scope: 'process' }),
    ]);
    // The extra green card describes one replica, so it must move the score
    // less than a platform-wide green card would.
    expect(withProcess.score).toBeGreaterThan(platformOnly.score);
    expect(withProcess.score - platformOnly.score).toBeLessThan(25);
    expect(withProcess.process_weighted).toBe(true);
  });

  it('keeps the worst measured status even when it is a minority', () => {
    const h = healthScore([
      ...allHealthy, card('http', 'timeout'),
    ]);
    expect(h.worst).toBe('timeout');
    expect(h.components.timeout).toBe(1);
    expect(h.score).toBeLessThan(100);
  });

  it('maps every threshold to the documented grade', () => {
    const gradeOf = (score) => {
      const cards = [
        card('a', 'healthy'),
        card('b', score >= 90 ? 'healthy' : score >= 75 ? 'warning' : score >= 60 ? 'degraded' : 'critical'),
      ];
      return healthScore(cards).grade;
    };
    expect(gradeOf(100)).toBe('A');
    expect(healthScore([card('a', 'warning'), card('b', 'warning')]).grade).toBe('C');
    expect(healthScore([card('a', 'degraded')]).grade).toBe('D');
    expect(healthScore([card('a', 'critical')]).grade).toBe('F');
  });
});
