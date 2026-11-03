'use strict';
// The four-state clearance decision. `unknown` is the state this file exists
// for: it is the absence of a screen, not a pass, and it must never be read as
// `cleared` by a default.

const { STATUS, normaliseStatus, restrictionsFrom, decision } = require('../modules/pt-os/clearance');
const { evaluate } = require('../modules/pt-os/programming-rules');

describe('normaliseStatus', () => {
  it('reads no form as unknown', () => {
    expect(normaliseStatus(null)).toBe(STATUS.UNKNOWN);
  });

  it('keeps the three explicit states', () => {
    for (const s of ['cleared', 'conditional', 'blocked']) {
      expect(normaliseStatus({ workout_gate_status: s })).toBe(s);
    }
  });

  it('treats any other explicit value as blocked, never cleared', () => {
    expect(normaliseStatus({ workout_gate_status: 'referred' })).toBe('blocked');
    expect(normaliseStatus({ workout_gate_status: 'pending' })).toBe('blocked');
  });
});

describe('decision', () => {
  it('cleared may programme without an acknowledgement', () => {
    expect(decision({ parq: { workout_gate_status: 'cleared' } })).toMatchObject({
      status: 'cleared', may_program: true, requires_ack: false, code: null, restrictions: [],
    });
  });

  it('conditional may programme only while carrying its restrictions', () => {
    const d = decision({
      parq: {
        workout_gate_status: 'conditional',
        parq_answers: [
          { question_id: 7, answer: 'yes', explanation: 'knee pain on stairs' },
          { question_id: 2, answer: 'no' },
        ],
      },
    });
    expect(d.status).toBe('conditional');
    expect(d.may_program).toBe(true);
    expect(d.restrictions).toEqual(['PAR-Q question 7 answered yes: knee pain on stairs']);
  });

  it('conditional with no recorded explanation still carries a restriction', () => {
    const d = decision({ parq: { workout_gate_status: 'conditional' } });
    expect(d.restrictions).toHaveLength(1);
    expect(d.restrictions[0]).toMatch(/Conditional clearance/);
  });

  it('blocked may not programme', () => {
    expect(decision({ parq: { workout_gate_status: 'blocked' } })).toMatchObject({
      status: 'blocked', may_program: false, requires_ack: false, code: 'NOT_CLEARED',
    });
  });

  it('unknown may not programme and asks for an explicit acknowledgement', () => {
    expect(decision({})).toMatchObject({
      status: 'unknown', may_program: false, requires_ack: true, code: 'CLEARANCE_REQUIRED',
    });
  });
});

describe('restrictionsFrom', () => {
  it('does not turn a no answer into a restriction', () => {
    const out = restrictionsFrom({ parq_answers: [{ question_id: 1, answer: 'no' }] });
    expect(out).toHaveLength(1);
    expect(out[0]).not.toMatch(/question 1/i);
    expect(out[0]).toMatch(/Conditional clearance/);
  });
});

describe('programming-rules gate', () => {
  const run = (parq) => evaluate({ parq, exercises: [] });

  it('maps conditional to may_program true but cleared false', () => {
    const out = run({ workout_gate_status: 'conditional', risk_level: 'medium' });
    expect(out.gate.status).toBe('conditional');
    expect(out.gate.may_program).toBe(true);
    expect(out.gate.cleared).toBe(false);
    expect(out.may_program).toBe(true);
  });

  it('maps unknown to may_program false', () => {
    const out = run(null);
    expect(out.gate.status).toBe('unknown');
    expect(out.may_program).toBe(false);
    expect(out.gate.requires_ack).toBe(true);
  });
});
