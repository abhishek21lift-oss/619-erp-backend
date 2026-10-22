'use strict';
// planner pure-function contract tests.
//
// Copied from mps-ai/__tests__/planner.test.js with additions for:
// - MAX_TOOLS cap (4 tools)
// - knowledge/policy question picks search_knowledge
// - unrecognised question falls back to the two summary tools
// - planIntent classification

const { planTools, planIntent, RULES, DEFAULT_TOOLS, MAX_TOOLS } = require('../lib/ai/agent/planner');

describe('planTools — methodology and policy questions select search_knowledge (P1-1)', () => {
  const cases = [
    'What is our policy on refunds?',
    'Which protocol do we follow for a returning injury?',
    'SOP for onboarding a new client',
    'What guideline do we use for squat depth?',
    'Is there a standard procedure for a missed session?',
  ];

  test.each(cases)('%s', (message) => {
    const { tools, matched } = planTools(message);
    expect(matched).toBe(true);
    expect(tools).toContain('search_knowledge');
  });

  test('the knowledge read survives the tool cap when other rules also match', () => {
    // Four matching families: knowledge, renewal, payment, training.
    const { tools } = planTools(
      'What is our policy on renewals when a payment is due and the package expired?',
    );
    expect(tools).toHaveLength(4);
    expect(tools[0]).toBe('search_knowledge');
  });

  test('a client question does not silently become a knowledge search', () => {
    const { tools } = planTools('How is this client doing?');
    expect(tools).not.toContain('search_knowledge');
  });
});

describe('planTools — MAX_TOOLS cap', () => {
  test('MAX_TOOLS constant is 4', () => {
    expect(MAX_TOOLS).toBe(4);
  });

  test('never returns more than 4 tools even when many rules match', () => {
    // This message matches: policy, package, payment, attendance, workout, injury, measures, goals, contact, summary
    const { tools } = planTools(
      'What is our policy on refunds when a package expires and payment is due, also check attendance, workout, injury, measurements, goals, and contact them',
    );
    expect(tools.length).toBeLessThanOrEqual(4);
  });

  test('preserves order of first match when capping', () => {
    // knowledge rule is first in RULES, so search_knowledge should be first when capped
    const { tools } = planTools(
      'policy protocol guideline standard procedure sop rule package payment attendance workout',
    );
    expect(tools[0]).toBe('search_knowledge');
    expect(tools.length).toBe(4);
  });
});

describe('planTools — unrecognised questions fall back to DEFAULT_TOOLS', () => {
  test('DEFAULT_TOOLS are getClientSummary and getClientProfile', () => {
    expect(DEFAULT_TOOLS).toEqual(['getClientSummary', 'getClientProfile']);
  });

  test('unrecognised question returns DEFAULT_TOOLS with matched=false', () => {
    const { tools, matched } = planTools('What is the meaning of life?');
    expect(matched).toBe(false);
    expect(tools).toEqual(DEFAULT_TOOLS);
  });

  test('empty string returns DEFAULT_TOOLS', () => {
    const { tools, matched } = planTools('');
    expect(matched).toBe(false);
    expect(tools).toEqual(DEFAULT_TOOLS);
  });

  test('null/undefined returns DEFAULT_TOOLS', () => {
    expect(planTools(null).tools).toEqual(DEFAULT_TOOLS);
    expect(planTools(undefined).tools).toEqual(DEFAULT_TOOLS);
  });
});

describe('planTools — specific tool selections', () => {
  test('package/expiry/renewal questions pick profile + subscriptions', () => {
    const { tools } = planTools('When does their package expire?');
    expect(tools).toContain('getClientProfile');
    expect(tools).toContain('getClientSubscriptions');
  });

  test('payment/due/balance questions pick profile + payments', () => {
    const { tools } = planTools('What is their outstanding balance?');
    expect(tools).toContain('getClientProfile');
    expect(tools).toContain('getClientPayments');
  });

  test('renewal history picks getClientRenewals', () => {
    const { tools } = planTools('Show past renewals');
    expect(tools).toContain('getClientRenewals');
  });

  test('attendance questions pick getClientAttendance', () => {
    const { tools } = planTools('What is their attendance like?');
    expect(tools).toContain('getClientAttendance');
  });

  test('workout/training questions pick getClientTrainingBrief', () => {
    const { tools } = planTools('What is their current workout program?');
    expect(tools).toContain('getClientTrainingBrief');
  });

  test('injury/medical questions pick getClientTrainingBrief', () => {
    const { tools } = planTools('Any pain or medical limitation?');
    expect(tools).toContain('getClientTrainingBrief');
  });

  test('measurement/assessment questions pick getClientSummary', () => {
    const { tools } = planTools('What is their latest weight and body fat?');
    expect(tools).toContain('getClientSummary');
  });

  test('goal questions pick getClientSummary', () => {
    const { tools } = planTools('What are their targets?');
    expect(tools).toContain('getClientSummary');
  });

  test('progress/trend questions pick summary + attendance', () => {
    const { tools } = planTools('Are they improving since last month?');
    expect(tools).toContain('getClientSummary');
    expect(tools).toContain('getClientAttendance');
  });

  test('contact/communication questions pick profile + communication', () => {
    const { tools } = planTools('When did we last message them?');
    expect(tools).toContain('getClientProfile');
    expect(tools).toContain('getClientCommunication');
  });

  test('summary/overview questions pick the four main tools', () => {
    const { tools } = planTools('Give me a full picture of this client');
    expect(tools).toContain('getClientSummary');
    expect(tools).toContain('getClientProfile');
    expect(tools).toContain('getClientAttendance');
    expect(tools).toContain('getClientTrainingBrief');
  });

  test('focus/concern/advice questions pick summary + attendance + training', () => {
    const { tools } = planTools('What should I focus on next session?');
    expect(tools).toContain('getClientSummary');
    expect(tools).toContain('getClientAttendance');
    expect(tools).toContain('getClientTrainingBrief');
  });
});

describe('planTools — deduplication', () => {
  test('duplicate tools from multiple matching rules are deduplicated', () => {
    // Both payment and renewal rules include getClientProfile
    const { tools } = planTools('Payment due and renewal history');
    const profiles = tools.filter(t => t === 'getClientProfile');
    expect(profiles.length).toBe(1);
  });
});

describe('planIntent', () => {
  test('summary intent for summar/overview/status report/full picture/brief me', () => {
    expect(planIntent('Give me a summary of this client')).toBe('summary');
    expect(planIntent('Give me an overview')).toBe('summary');
    expect(planIntent('Status report please')).toBe('summary');
    expect(planIntent('Full picture of their progress')).toBe('summary');
    expect(planIntent('Brief me on them')).toBe('summary');
  });

  test('analysis intent for progress/analy/why/should i/focus/concern/compare/trend', () => {
    expect(planIntent('Analyze their progress')).toBe('analysis');
    expect(planIntent('Why are they not improving?')).toBe('analysis');
    expect(planIntent('Should I change their program?')).toBe('analysis');
    expect(planIntent('What should I focus on?')).toBe('analysis');
    expect(planIntent('Any concerns?')).toBe('analysis');
    expect(planIntent('Compare this month to last')).toBe('analysis');
    expect(planIntent('What is the trend?')).toBe('analysis');
  });

  test('lookup intent for when/what is/who/how many/expire/due/balance/number', () => {
    expect(planIntent('When does their package expire?')).toBe('lookup');
    expect(planIntent('What is their weight?')).toBe('lookup');
    expect(planIntent('How many sessions attended?')).toBe('lookup');
    expect(planIntent('Who is their trainer?')).toBe('lookup');
    expect(planIntent('What is the due balance?')).toBe('lookup');
    expect(planIntent('Number of renewals?')).toBe('lookup');
  });

  test('defaults to analysis for unrecognised', () => {
    expect(planIntent('Random text nobody anticipated')).toBe('analysis');
    expect(planIntent('')).toBe('analysis');
  });
});

describe('RULES structure', () => {
  test('every rule has a regex and tools array', () => {
    for (const rule of RULES) {
      expect(rule.re).toBeInstanceOf(RegExp);
      expect(Array.isArray(rule.tools)).toBe(true);
      expect(rule.tools.length).toBeGreaterThan(0);
    }
  });

  test('search_knowledge appears in at least one rule', () => {
    const hasKnowledge = RULES.some(r => r.tools.includes('search_knowledge'));
    expect(hasKnowledge).toBe(true);
  });
});