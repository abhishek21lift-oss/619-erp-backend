'use strict';
// The planner is a pure function from a member's question to the tools that
// may answer it. It is tested exhaustively because it is also the data
// minimisation boundary: a tool that does not match is a record the model
// never sees.
const { planMemberQuestion, MAX_TOOLS } = require('../modules/member-ai/member-ai.planner');

describe('planMemberQuestion', () => {
  it.each([
    ['What am I training today?', 'getMyWorkout'],
    ['What should I eat for lunch?', 'getMyDiet'],
    ['How did my week go?', 'getMyCheckins'],
    ['When is my next payment?', 'getMyPayments'],
    ['When does my membership expire?', 'getMyMembership'],
    ['When is my next session?', 'getMyBookings'],
    ['Is my PAR-Q done?', 'getMyForms'],
  ])('%s selects %s', (message, tool) => {
    expect(planMemberQuestion(message).tools).toContain(tool);
  });

  it('understands Hinglish', () => {
    expect(planMemberQuestion('aaj kya workout hai').tools).toContain('getMyWorkout');
    expect(planMemberQuestion('kitna paisa baki hai').tools).toContain('getMyPayments');
    expect(planMemberQuestion('mera membership kab tak hai').tools).toContain('getMyMembership');
  });

  it('a greeting runs no tools', () => {
    expect(planMemberQuestion('Hi')).toEqual({
      tools: [], allowDraft: false, intent: 'member_chat', matched: true,
    });
  });

  it('allows a draft only when the member wants to message the trainer', () => {
    const plan = planMemberQuestion('Tell my trainer I am travelling next week');
    expect(plan.allowDraft).toBe(true);
    expect(plan.tools).toContain('getMyProfile');
  });

  it('never returns more than four tools', () => {
    const plan = planMemberQuestion(
      'workout diet checkin weight attendance payment membership booking form message trainer',
    );
    expect(plan.tools.length).toBeLessThanOrEqual(MAX_TOOLS);
    expect(MAX_TOOLS).toBe(4);
  });

  it('an unrecognised question still gets the profile', () => {
    expect(planMemberQuestion('hmm')).toEqual({
      tools: ['getMyProfile'], allowDraft: false, intent: 'member_chat', matched: false,
    });
  });

  it('classifies lookups separately from analysis', () => {
    expect(planMemberQuestion('When is my next payment?').intent).toBe('member_lookup');
    expect(planMemberQuestion('Why is my progress slow?').intent).toBe('member_chat');
  });
});
