// Progression: resolving what a programme prescribes in week N.
//
// This is the arithmetic behind "author one week, get twelve". It is worth
// testing properly because it is invisible when wrong: a trainer sees a number
// and has no way to tell it is the wrong week's.

const {
  weekOf, stepsFor, applyProgression, resolveWeek, anchorWeekFor, previewWeeks,
} = require('../modules/pt-os/progression');

const PLAN_WEIGHT = { progression_type: 'weight', progression_amount: 2.5, progression_every_weeks: 1 };
const PLAN_NONE = { progression_type: 'none', progression_amount: null, progression_every_weeks: 1 };

const SQUAT = { id: 'e1', name: 'Squat', week_number: 1, day_of_week: 1, sets: 4, reps: 8, target_weight: 60, rpe: 7 };

describe('weekOf', () => {
  it('counts the start date as week 1, not week 0', () => {
    expect(weekOf('2026-07-01', '2026-07-01')).toBe(1);
  });

  it('rolls to week 2 after seven days, not six', () => {
    expect(weekOf('2026-07-01', '2026-07-07')).toBe(1);
    expect(weekOf('2026-07-01', '2026-07-08')).toBe(2);
  });

  it('treats a session logged before the start as week 1', () => {
    // Not week 0 and not negative: a client who trained early did the first
    // week's workout early.
    expect(weekOf('2026-07-10', '2026-07-01')).toBe(1);
  });

  it('survives a malformed date instead of returning NaN', () => {
    // NaN would flow into stepsFor and produce a prescription of NaN kg.
    expect(weekOf('not-a-date', '2026-07-01')).toBe(1);
    expect(weekOf('2026-07-01', undefined)).toBe(1);
  });
});

describe('stepsFor', () => {
  it('is zero in week 1 — the baseline is what the trainer typed', () => {
    expect(stepsFor(1, 1)).toBe(0);
  });

  it('advances every week by default', () => {
    expect(stepsFor(4, 1)).toBe(3);
  });

  it('holds for two weeks at a time when asked to', () => {
    // every=2: weeks 1-2 baseline, weeks 3-4 one step, weeks 5-6 two.
    expect([1, 2, 3, 4, 5, 6].map((w) => stepsFor(w, 2))).toEqual([0, 0, 1, 1, 2, 2]);
  });
});

describe('applyProgression', () => {
  it('adds weight per step', () => {
    expect(applyProgression(SQUAT, PLAN_WEIGHT, 3).target_weight).toBe(65); // 60 + 2.5*2
  });

  it('leaves the caller row untouched', () => {
    // resolveWeek runs the same base row once per week when building a preview.
    applyProgression(SQUAT, PLAN_WEIGHT, 5);
    expect(SQUAT.target_weight).toBe(60);
  });

  it('does NOT invent a weight where the trainer set none', () => {
    // "Add 2.5kg" to an exercise with no prescribed load is meaningless, and
    // 2.5 would be a number the trainer never wrote.
    const bodyweight = { ...SQUAT, target_weight: null };
    expect(applyProgression(bodyweight, PLAN_WEIGHT, 6).target_weight).toBeNull();
  });

  it('rounds weight to 0.25kg rather than exposing float noise', () => {
    const plan = { ...PLAN_WEIGHT, progression_amount: 0.1 };
    const w = applyProgression({ ...SQUAT, target_weight: 60 }, plan, 4).target_weight;
    expect(Number.isInteger(w * 4)).toBe(true);
  });

  it('keeps reps whole', () => {
    const plan = { progression_type: 'reps', progression_amount: 0.5, progression_every_weeks: 1 };
    expect(applyProgression(SQUAT, plan, 3).reps).toBe(9); // 8 + 0.5*2
    expect(Number.isInteger(applyProgression(SQUAT, plan, 4).reps)).toBe(true);
  });

  it('caps RPE at 10 — there is nothing above it to prescribe', () => {
    const plan = { progression_type: 'rpe', progression_amount: 1, progression_every_weeks: 1 };
    expect(applyProgression(SQUAT, plan, 12).rpe).toBe(10);
  });

  it('changes nothing when the rule is none', () => {
    const out = applyProgression(SQUAT, PLAN_NONE, 9);
    expect(out.target_weight).toBe(60);
    expect(out.reps).toBe(8);
  });

  it('changes nothing in week 1, whatever the rule', () => {
    expect(applyProgression(SQUAT, PLAN_WEIGHT, 1).target_weight).toBe(60);
  });
});

describe('resolveWeek', () => {
  const base = [SQUAT, { ...SQUAT, id: 'e2', name: 'Bench', target_weight: 40 }];

  it('derives a week from the week-1 rows', () => {
    const { exercises, source } = resolveWeek(base, PLAN_WEIGHT, 3);
    expect(source).toBe('derived');
    expect(exercises.map((e) => e.target_weight)).toEqual([65, 45]);
  });

  it('lets an explicit week override the derived numbers', () => {
    // A deload: week 4 written by hand must win over "+2.5kg x3".
    const deload = { ...SQUAT, id: 'e3', week_number: 4, target_weight: 45 };
    const { exercises, source } = resolveWeek([...base, deload], PLAN_WEIGHT, 4);
    expect(source).toBe('override');
    expect(exercises).toHaveLength(1);
    expect(exercises[0].target_weight).toBe(45);
  });

  it('never treats week 1 as an override of itself', () => {
    // Week 1 rows ARE the base. Matching them as overrides would skip
    // progression entirely and silently pin every week to week 1.
    const { source } = resolveWeek(base, PLAN_WEIGHT, 1);
    expect(source).toBe('derived');
  });
});

describe('previewWeeks', () => {
  it('shows where the rule lands, which is the reason to show it', () => {
    const rows = previewWeeks(SQUAT, PLAN_WEIGHT, 12);
    expect(rows).toHaveLength(12);
    expect(rows[0]).toMatchObject({ week: 1, target_weight: 60 });
    // 60 + 2.5*11 = 87.5 — a trainer may well decide that is too much, which
    // is cheaper to learn here than in week 9.
    expect(rows[11]).toMatchObject({ week: 12, target_weight: 87.5 });
  });

  it('clamps a nonsense duration instead of looping', () => {
    expect(previewWeeks(SQUAT, PLAN_WEIGHT, 0)).toHaveLength(1);
    expect(previewWeeks(SQUAT, PLAN_WEIGHT, 99999).length).toBeLessThanOrEqual(104);
  });
});

// ── Editing a later week ───────────────────────────────────────────────────
//
// Every week is editable, and an edit means "from here on". Week 4 edited to
// 45kg leaves weeks 1-3 alone and restarts the climb from 45 in week 5. The
// week the trainer edited becomes an ANCHOR; the weeks after it derive from
// that anchor instead of from week 1.
//
// This is the part that cannot be seen from the screen. Every number below
// looks perfectly plausible if the anchor logic is wrong — it is just the
// wrong week's prescription, handed to a client in the gym.

const PLAN_EVERY_2 = { progression_type: 'weight', progression_amount: 2.5, progression_every_weeks: 2 };

/** Week 1: squat 60, bench 40. */
const BASE = [
  { id: 'e1', exercise_id: 'x1', name: 'Squat', week_number: 1, sort_order: 0, target_weight: 60, reps: 8, rpe: 7 },
  { id: 'e2', exercise_id: 'x2', name: 'Bench', week_number: 1, sort_order: 1, target_weight: 40, reps: 8, rpe: 7 },
];
/** Week 4 rewritten by hand as a deload. */
const WEEK4 = [
  { id: 'w4a', exercise_id: 'x1', name: 'Squat', week_number: 4, sort_order: 0, target_weight: 45, reps: 8, rpe: 7 },
  { id: 'w4b', exercise_id: 'x2', name: 'Bench', week_number: 4, sort_order: 1, target_weight: 30, reps: 8, rpe: 7 },
];

describe('anchorWeekFor', () => {
  it('is week 1 when nothing has been edited', () => {
    expect(anchorWeekFor(BASE, 6)).toBe(1);
  });

  it('is the edited week itself, on that week', () => {
    expect(anchorWeekFor([...BASE, ...WEEK4], 4)).toBe(4);
  });

  it('is the nearest EARLIER edited week, after it', () => {
    expect(anchorWeekFor([...BASE, ...WEEK4], 7)).toBe(4);
  });

  it('does not reach forward — week 6 cannot be anchored on week 8', () => {
    // The whole point of "an edit moves the weeks after it". A deload written
    // for week 8 that quietly rewrote week 6 would be a different feature,
    // and a wrong one.
    const week8 = WEEK4.map((r) => ({ ...r, week_number: 8, target_weight: 20 }));
    expect(anchorWeekFor([...BASE, ...week8], 6)).toBe(1);
  });

  it('treats a missing week_number as week 1, as the column does', () => {
    expect(anchorWeekFor([{ id: 'x' }], 3)).toBe(1);
  });
});

describe('editing week 4', () => {
  const rows = [...BASE, ...WEEK4];

  it('leaves the weeks before it untouched', () => {
    // 60 + 2.5×2 = 65. Week 3 still derives from week 1, as if week 4 had
    // never been edited.
    const { exercises, source, anchor_week: anchor } = resolveWeek(rows, PLAN_WEIGHT, 3);
    expect(source).toBe('derived');
    expect(anchor).toBe(1);
    expect(exercises.map((e) => e.target_weight)).toEqual([65, 45]);
  });

  it('says exactly what the trainer wrote, on week 4', () => {
    const { exercises, source } = resolveWeek(rows, PLAN_WEIGHT, 4);
    expect(source).toBe('override');
    expect(exercises.map((e) => e.target_weight)).toEqual([45, 30]);
  });

  it('climbs again from the edit, not from week 1', () => {
    // 45 + 2.5 = 47.5 in week 5, NOT 60 + 2.5×4 = 70. Deriving from week 1
    // here would throw away the deload the week after it was written.
    const { exercises, anchor_week: anchor } = resolveWeek(rows, PLAN_WEIGHT, 5);
    expect(anchor).toBe(4);
    expect(exercises.map((e) => e.target_weight)).toEqual([47.5, 32.5]);
  });

  it('keeps climbing week after week', () => {
    expect(resolveWeek(rows, PLAN_WEIGHT, 7).exercises[0].target_weight).toBe(52.5);
  });

  it('keeps the rule on week 1\'s clock when it fires every 2 weeks', () => {
    // The schedule is baseline, baseline, +1, +1, +2, +2 … Week 4 is one step
    // in; week 5 is two. So an anchor at week 4 is worth exactly one more step
    // by week 5 — 45 + 2.5. Counting from the anchor as a fresh week 1 would
    // give 45 and shift every later week by one.
    expect(resolveWeek(rows, PLAN_EVERY_2, 5).exercises[0].target_weight).toBe(47.5);
    expect(resolveWeek(rows, PLAN_EVERY_2, 6).exercises[0].target_weight).toBe(47.5);
    expect(resolveWeek(rows, PLAN_EVERY_2, 7).exercises[0].target_weight).toBe(50);
  });

  it('chains: an edit in week 8 builds on the one in week 4', () => {
    const week8 = [{ ...WEEK4[0], id: 'w8a', week_number: 8, target_weight: 80 }];
    const { exercises, anchor_week: anchor } = resolveWeek([...rows, ...week8], PLAN_WEIGHT, 9);
    expect(anchor).toBe(8);
    expect(exercises[0].target_weight).toBe(82.5);
  });

  it('is inert when the plan has no rule', () => {
    // Weeks after an edit repeat it exactly; there is nothing to add.
    expect(resolveWeek(rows, PLAN_NONE, 6).exercises.map((e) => e.target_weight)).toEqual([45, 30]);
  });
});

describe('previewWeeks with the real week rows', () => {
  const rows = [...BASE, ...WEEK4];

  it('shows the edited week, not where the rule would have gone', () => {
    const weeks = previewWeeks(BASE[0], PLAN_WEIGHT, 6, rows);
    expect(weeks[3]).toMatchObject({ week: 4, target_weight: 45 });
    expect(weeks[4]).toMatchObject({ week: 5, target_weight: 47.5 });
  });

  it('is the rule\'s own trajectory when no rows are supplied', () => {
    // The old two-argument behaviour, which every caller without the day's
    // rows still depends on.
    const weeks = previewWeeks(BASE[0], PLAN_WEIGHT, 6);
    expect(weeks[3]).toMatchObject({ week: 4, target_weight: 67.5 });
  });

  it('reports a blank for a week the exercise was removed from', () => {
    // Lying here would put another movement's load under this one's name.
    const soloWeek4 = [{ ...WEEK4[1], sort_order: 0 }];
    const weeks = previewWeeks(BASE[0], PLAN_WEIGHT, 5, [...BASE, ...soloWeek4]);
    expect(weeks[3].target_weight).toBe(30);          // slot 0 is bench now
    const removed = previewWeeks(BASE[1], PLAN_WEIGHT, 5, [...BASE, ...soloWeek4]);
    expect(removed[3].target_weight).toBe(30);        // matched by exercise_id
  });
});
