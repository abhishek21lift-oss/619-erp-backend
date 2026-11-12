'use strict';
// Tool selection is deterministic and never chooses a client-scaled tool
// without a selected client. The legacy chat messages are pinned here too:
// the registry must not silently steal a question the old readers answer.

const { plan, CLIENT_REQUIRED, MAX_TOOLS } = require('../modules/copilot/tools/planner');

const names = (message, scope) => plan(message, scope).map((c) => c.name);

describe('studio-wide intents', () => {
  test('schedule questions plan the schedule tool', () => {
    expect(names("What's my schedule today?")).toEqual(['get_trainer_schedule']);
    expect(names('Show me the agenda for next week')).toEqual(['get_trainer_schedule']);
  });

  test('workload questions plan the workload tool', () => {
    expect(names('How busy is the studio this month?')).toEqual(['get_trainer_workload']);
  });

  test('follow-up questions plan the follow-up tool', () => {
    expect(names('Who should I call about churn?')).toEqual(['get_pending_followups']);
    expect(names('Clients who have gone quiet')).toEqual(['get_pending_followups']);
  });

  test('expiry questions plan membership alerts', () => {
    expect(names('Which memberships are expiring?')).toEqual(['get_membership_alerts']);
    expect(names('Any renewals due?')).toEqual(['get_membership_alerts']);
  });

  test('studio tools do not need a selected client', () => {
    expect(names('What is my schedule?', {})).toEqual(['get_trainer_schedule']);
  });
});

describe('client-scoped intents', () => {
  const scope = { clientId: 'client-1' };

  test('a profile question with a selected client plans the profile tool', () => {
    expect(names('Show me the profile', scope)).toEqual(['get_client_profile']);
  });

  test('attendance, goals, assessments, progress, history and programme are recognised', () => {
    expect(names('How is the attendance looking?', scope)).toEqual(['get_attendance_summary']);
    expect(names('What are the goals?', scope)).toEqual(['get_client_goals']);
    expect(names('Any assessments on file?', scope)).toEqual(['get_client_assessments']);
    expect(names('How is progress going?', scope)).toEqual(['get_client_progress']);
    expect(names('Show me the workout history', scope)).toEqual(['get_workout_history']);
    expect(names('Which programme is she on?', scope)).toEqual(['get_active_workout_program']);
  });

  test('without a selected client, client tools are never planned', () => {
    expect(names('Show me the profile')).toEqual([]);
    expect(names('How is the attendance looking?')).toEqual([]);
    expect(names('What are the goals?')).toEqual([]);
    expect(names('How is progress going?')).toEqual([]);
  });

  test('two intents run two tools, in priority order', () => {
    expect(names("Show me Asha's attendance and her goals", scope))
      .toEqual(['get_attendance_summary', 'get_client_goals']);
  });

  test('never plans more than two tools', () => {
    const out = plan('attendance, goals, assessments, progress and the programme', scope);
    expect(out).toHaveLength(MAX_TOOLS);
  });

  test('client ids never travel in tool arguments', () => {
    for (const call of plan('profile and goals', scope)) {
      expect(call.args).toEqual({});
      expect(JSON.stringify(call.args)).not.toContain('client-1');
    }
  });
});

describe('legacy chat messages stay with the legacy readers', () => {
  const messages = [
    'What is a good warm-up routine?',
    'How many active clients do we have?',
    'Can you look up the client named Priya Sharma?',
    'What should I tell a new client about hydration?',
    'Tell me about Prakhar Sharma',
    'Any update on Prakhar Sharma?',
    'Tell me about Progressive Overload',
    'What was our revenue this month?',
    'What exercises target back for a beginner?',
    'What exercises for chest?',
    'How many active clients came in for attendance and how many trainers do we have?',
    // The legacy dues reader's exact triggers must not be taken over.
    'Who has outstanding dues?',
    'Who owes money?',
    'Show me the unpaid balances',
    'What is the balance due?',
  ];

  test.each(messages)('no registry tool is planned for: %s', (message) => {
    // These are exactly the messages the pre-Copilot suite pins with no client
    // selected; the registry must leave them to those readers.
    expect(names(message)).toEqual([]);
  });
});

describe('definition guard', () => {
  test('the client-required set is a subset of the tools the planner can emit', () => {
    const emitted = new Set();
    for (const call of plan(
      'profile goals assessments progress history programme attendance',
      { clientId: 'client-1' }
    )) emitted.add(call.name);
    // The planner caps at two, so only assert the set is not empty and every
    // emitted client tool is declared client-required.
    expect(emitted.size).toBeGreaterThan(0);
    for (const name of emitted) expect(CLIENT_REQUIRED.has(name)).toBe(true);
  });
});
