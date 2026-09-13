// What we proposed, what the trainer did with it, and what that teaches.
//
// ── Why this exists ───────────────────────────────────────────────────────
//
// Stages 1-4 built a programme from the client's own data and checked it
// against rules. Every generation still started from nothing: the engine could
// see what the CLIENT had done and never what the TRAINER had done about it.
// A studio could reject the same suggestion twenty times and get it again on
// the twenty-first.
//
// Measured before this was written — 95 workout generations in production, 9
// live plans. The other 86 are the most informative feedback this studio has
// produced and none of it was stored anywhere.
//
// ── The line these tests hold ─────────────────────────────────────────────
//
// Memory feeds SELECTION, never permission. A trainer who removes a safe
// exercise three times has stated a preference; a trainer who keeps a blocked
// one has not made it safe. `refuses to become a safety override` is the test
// that says so, and it is the one that must never be relaxed.
'use strict';

jest.mock('../db/pool', () => ({ query: jest.fn() }));

const pool = require('../db/pool');
const {
  recordGeneration, markAccepted, recentGenerations,
  diffPlans, buildMemory, describeMemory, MIN_REPEATS_FOR_PATTERN,
} = require('../modules/pt-os/programming-memory');

/** A proposal in the shape the generator actually returns. */
const proposal = (names) => ({
  name: 'Block', weeks: 8, days_per_week: names.length,
  weekly_schedule: Object.fromEntries(
    names.map((n, i) => [`Day${i + 1}`, { name: 'S', focus: 'f', exercises: [{ name: n }] }]),
  ),
});

/** One stored generation row, as recentGenerations returns it. */
const row = (proposed, accepted = null, o = {}) => ({
  id: `g-${Math.random()}`,
  created_at: '2026-09-01T00:00:00Z',
  quality_score: 100,
  revised: false,
  proposed_plan: proposal(proposed),
  accepted_plan_id: accepted ? 'plan-1' : null,
  accepted_at: accepted ? '2026-09-01T01:00:00Z' : null,
  accepted_exercises: accepted || [],
  ...o,
});

beforeEach(() => pool.query.mockReset());

describe('diffing a proposal against what was saved', () => {
  it('separates what survived from what the trainer swapped out', () => {
    const d = diffPlans(['Bench Press', 'Barbell Squat'], ['Barbell Squat', 'Leg Press']);
    expect(d).toEqual({
      kept: ['Barbell Squat'],
      dropped: ['Bench Press'],
      added: ['Leg Press'],
      comparable: true,
    });
  });

  it('compares on the same normalised names the audit uses', () => {
    // Nothing fuzzier is attempted here than in plan-critic.js, for the same
    // reason: a near-match is a different exercise.
    const d = diffPlans(['  BENCH-PRESS '], ['Bench Press']);
    expect(d.kept).toEqual(['  BENCH-PRESS ']);
    expect(d.dropped).toEqual([]);
  });

  it('reports nothing at all when the saved plan has no exercises yet', () => {
    // A plan saved and not yet populated is a trainer mid-edit. Reading it as
    // "they rejected everything" would invent the strongest possible signal
    // out of an empty row.
    const d = diffPlans(['Bench Press', 'Barbell Squat'], []);
    expect(d).toEqual({ kept: [], dropped: [], added: [], comparable: false });
  });
});

describe('building the memory', () => {
  it('says nothing about a client nobody has generated for', () => {
    const m = buildMemory([]);
    expect(m.proposals).toBe(0);
    // Not 0%. A client with no proposals has not had them rejected.
    expect(m.acceptance_pct).toBeNull();
    expect(m.has_memory).toBe(false);
    expect(describeMemory(m)).toBe('');
  });

  it('counts acceptance from what was actually saved', () => {
    const m = buildMemory([
      row(['Bench Press'], ['Bench Press']),
      row(['Bench Press']),
      row(['Bench Press']),
      row(['Bench Press']),
    ]);
    // The production shape in miniature: most proposals are never used.
    expect(m).toMatchObject({ proposals: 4, accepted: 1, acceptance_pct: 25 });
  });

  it('needs a repeat before calling something a preference', () => {
    const once = buildMemory([row(['Bench Press', 'Barbell Squat'], ['Barbell Squat'])]);
    // One removal is a rack that was busy, a variation they prefer to coach,
    // or a reorder. It is not a preference.
    expect(once.usually_removed).toEqual([]);
    expect(once.seen_once.removed).toEqual(['Bench Press']);

    const twice = buildMemory([
      row(['Bench Press', 'Barbell Squat'], ['Barbell Squat']),
      row(['Bench Press', 'Barbell Squat'], ['Barbell Squat']),
    ]);
    expect(twice.usually_removed).toEqual([{ exercise: 'Bench Press', count: MIN_REPEATS_FOR_PATTERN }]);
    expect(twice.seen_once.removed).toEqual([]);
  });

  it('learns what the trainer reaches for instead', () => {
    const m = buildMemory([
      row(['Bench Press'], ['Dumbbell Bench Press']),
      row(['Bench Press'], ['Dumbbell Bench Press']),
    ]);
    expect(m.usually_added).toEqual([{ exercise: 'Dumbbell Bench Press', count: 2 }]);
    expect(m.usually_removed).toEqual([{ exercise: 'Bench Press', count: 2 }]);
  });

  it('reports how many proposals could actually be compared', () => {
    const m = buildMemory([
      row(['Bench Press'], ['Bench Press']),
      // Accepted, but its exercises never joined the library, so it compares
      // against nothing. Counting it as a comparison would let an unreadable
      // plan dilute a real pattern.
      row(['Bench Press'], []),
      row(['Bench Press']),
    ]);
    // Two proposals were accepted; only one of them can be compared. Keeping
    // the two counts apart is the point — collapsing them would let an
    // unreadable plan either inflate the acceptance rate's evidence or
    // silently vanish from it.
    expect(m.accepted).toBe(2);
    expect(m.compared).toBe(1);
  });

  it('ignores proposals nobody saved when looking for preferences', () => {
    // A proposal the trainer never opened says nothing about the exercises in
    // it. Only the difference between a proposal and a saved plan is evidence.
    const m = buildMemory([row(['Bench Press']), row(['Bench Press']), row(['Bench Press'])]);
    expect(m.usually_removed).toEqual([]);
    expect(m.has_memory).toBe(false);
  });
});

describe('what the generator is told', () => {
  it('states the preference and its count, never as a rule', () => {
    const text = describeMemory(buildMemory([
      row(['Bench Press', 'Barbell Squat'], ['Barbell Squat']),
      row(['Bench Press', 'Barbell Squat'], ['Barbell Squat']),
    ]));
    expect(text).toContain('Repeatedly REMOVED from your proposals: Bench Press (2x)');
    expect(text).toContain('2 of 2 recent proposals were saved');
  });

  it('refuses to become a safety override', () => {
    // The line that matters most in this file. A model told "the trainer likes
    // X" next to "X is excluded" must not resolve that in X's favour, and the
    // prompt says so explicitly rather than relying on ordering.
    const text = describeMemory(buildMemory([
      row(['Bench Press'], ['Dumbbell Bench Press']),
      row(['Bench Press'], ['Dumbbell Bench Press']),
    ]));
    expect(text).toContain('preferences, not permissions');
    expect(text).toContain('stays excluded however often it has been added before');
  });

  it('tells the model not to infer a preference that is not there', () => {
    const text = describeMemory(buildMemory([row(['Bench Press']), row(['Bench Press'])]));
    expect(text).toContain('no preference to learn from yet');
    expect(text).toContain('Do not infer one');
  });

  it('says so when changes exist but none of them repeat', () => {
    const text = describeMemory(buildMemory([row(['Bench Press', 'Barbell Squat'], ['Barbell Squat'])]));
    expect(text).toContain('nothing here is a pattern yet');
  });
});

describe('storage', () => {
  it('records a proposal whether or not anyone ever accepts it', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 'g-1' }] });
    await recordGeneration({
      id: 'g-1', orgId: 'org-1', clientId: 'cl-1', createdBy: 'u1',
      requestId: 'r1', model: 'm', revised: true, qualityScore: 88,
      plan: proposal(['Bench Press']), screen: { gate: {} }, audit: { counts: {} },
    });
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO ai_workout_generations/);
    expect(params.slice(0, 8)).toEqual(['g-1', 'org-1', 'cl-1', 'u1', 'r1', 'm', true, 88]);
    // accepted_plan_id is not written here — that is the trainer's action.
    expect(sql).not.toMatch(/accepted_plan_id/);
  });

  it('scopes the accept stamp inside the UPDATE, not by trusting the caller', async () => {
    pool.query.mockResolvedValue({ rowCount: 1 });
    await markAccepted('g-1', 'plan-1', 'org-1');
    const [sql, params] = pool.query.mock.calls[0];
    // A write that trusts its caller to have checked is one bad caller away
    // from letting one studio stamp another studio's row.
    expect(sql).toMatch(/organization_id = \$3/);
    expect(params).toEqual(['g-1', 'plan-1', 'org-1']);
  });

  it('will not re-stamp a proposal that was already accepted', async () => {
    pool.query.mockResolvedValue({ rowCount: 0 });
    const [sql] = [null];
    expect(await markAccepted('g-1', 'plan-2', 'org-1')).toBe(0);
    expect(pool.query.mock.calls[0][0]).toMatch(/accepted_plan_id IS NULL/);
    expect(sql).toBeNull();
  });

  it('reads this client\'s history scoped to the studio', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await recentGenerations('cl-1', 'org-1');
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/g\.organization_id = \$2/);
    expect(params[0]).toBe('cl-1');
    expect(params[1]).toBe('org-1');
    // The accepted plan's exercises come back on the same row: a client with
    // ten proposals costs one round trip, not eleven.
    expect(sql).toMatch(/array_agg\(e\.name\)/);
  });

  it('caps how far back it reads', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await recentGenerations('cl-1', 'org-1', { limit: 5000 });
    expect(pool.query.mock.calls[0][1][2]).toBe(50);
  });
});
