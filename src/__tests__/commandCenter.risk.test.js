import { describe, expect, test } from '@jest/globals';
import { evaluate, levelFor, WEIGHTS } from '../modules/command-center/risk.service.js';

describe('Command Center deterministic risk engine', () => {
  test('returns healthy when all observed domains are healthy', () => {
    const snapshot = {
      cards: {
        runtime: { status: 'ok' },
        database: { status: 'ok' },
        redis: { status: 'ok' },
        security: { status: 'ok' },
        queues: { status: 'ok' },
        http: { status: 'ok' },
        ai: { status: 'ok' },
      },
    };
    const result = evaluate(snapshot, { findings: [] });
    expect(result.score).toBe(0);
    expect(result.level).toBe('healthy');
    expect(result.unknown_domains).toContain('revenue');
    expect(result.unknown_domains).toContain('subscriptions');
    expect(result.unknown_domains).toContain('support');
  });

  test('critical infrastructure is reflected in the explainable score', () => {
    const snapshot = {
      cards: {
        runtime: { status: 'critical' },
        database: { status: 'ok' },
        redis: { status: 'ok' },
        security: { status: 'ok' },
        queues: { status: 'ok' },
        http: { status: 'ok' },
        ai: { status: 'ok' },
      },
    };
    const result = evaluate(snapshot, { findings: [] });
    const health = result.domains.find((d) => d.name === 'health');
    expect(health.weight).toBe(WEIGHTS.health);
    expect(health.score).toBe(100);
    expect(result.score).toBeGreaterThan(0);
    expect(result.methodology).toMatch(/Deterministic/);
  });

  test('Guardian corroboration cannot create a finding or mutate its severity', () => {
    const snapshot = {
      cards: {
        runtime: { status: 'ok' },
        database: { status: 'ok' },
        redis: { status: 'ok' },
        security: { status: 'ok' },
        queues: { status: 'ok' },
        http: { status: 'ok' },
        ai: { status: 'ok' },
      },
    };
    const guardian = {
      findings: [{ id: 'worker-starvation', title: 'Worker starvation', severity: 'critical', confidence: 0.9 }],
    };
    const result = evaluate(snapshot, guardian);
    expect(result.findings[0]).toEqual(guardian.findings[0]);
    expect(result.findings[0].severity).toBe('critical');
  });

  test('level thresholds remain deterministic', () => {
    expect(levelFor(20).key).toBe('healthy');
    expect(levelFor(21).key).toBe('watch');
    expect(levelFor(41).key).toBe('elevated');
    expect(levelFor(61).key).toBe('high');
    expect(levelFor(81).key).toBe('critical');
  });
});
