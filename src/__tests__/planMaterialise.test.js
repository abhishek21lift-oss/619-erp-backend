// Turning a generated programme into rows a trainer can open in the builder.
//
// ── Why this mapping is the whole feature ─────────────────────────────────
//
// The AI workout generator has never been able to save a plan. Every consumer
// of a generated programme renders it — the client card's preview says
// "nothing has been saved" in so many words — and the one dialog that creates a
// plan creates an EMPTY one for the builder to fill by hand. Production shows
// 95 generations and 9 live plans; the nine were typed.
//
// So stages 4 and 5 had nothing to attach to: the audit judged plans nobody
// could keep, and the memory could never see a trainer's edits because no
// proposal was ever accepted.
//
// ── The constraint everything bends around ────────────────────────────────
//
// workout_exercises.exercise_id is NOT NULL with a foreign key. An exercise
// whose name does not resolve to a library row cannot be stored at all — the
// schema decides that, not this file. And resolution is exact-normalised only,
// for the reason plan-critic.js measured: trigram similarity files "Overhead
// Press" under "Overhead Lat".
//
// Of the 94 distinct exercise names trainers have logged here, 82 match the
// library. One name in eight failing is the EXPECTED rate, from humans using a
// picker — so `reports what it could not save, rather than dropping it` is the
// test that matters most.
'use strict';

const {
  materialise, dayNumber, parseReps, parseRpe, notesFor, configFor,
  WEEK_ONE, SINGLE_BOUT,
} = require('../modules/pt-os/plan-materialise');
const { normaliseName } = require('../modules/pt-os/plan-critic');

/** A library resolver, as client-context builds it. */
const resolver = (names) => new Map(
  names.map((n) => [normaliseName(n), { id: `ex-${normaliseName(n).replace(/ /g, '-')}`, name: n }]),
);

const ex = (o = {}) => ({
  name: 'Barbell Squat', prescription_type: 'SETS_REPS', sets: 4, reps: '8-10',
  rir_or_rpe: 'RIR 2', tempo: '3-1-1-0', rest_seconds: 120, notes: '', ...o,
});

const plan = (days, o = {}) => ({
  name: 'Hypertrophy Block', description: 'x', goal: 'muscle_gain', level: 'intermediate',
  weeks: 8, days_per_week: Object.keys(days).length,
  weekly_schedule: Object.fromEntries(
    Object.entries(days).map(([d, list]) => [d, { name: d, focus: 'f', exercises: list }]),
  ),
  ...o,
});

describe('days', () => {
  it('maps names onto the builder\'s own numbering', () => {
    // 1 = Monday, matching workout_exercises.day_of_week and the builder tabs.
    expect(['Monday', 'Wednesday', 'Sunday'].map(dayNumber)).toEqual([1, 3, 7]);
    expect(dayNumber('monday')).toBe(1);
  });

  it('accepts the other two shapes a generator actually emits', () => {
    expect(dayNumber('Day 3')).toBe(3);
    expect(dayNumber('4')).toBe(4);
  });

  it('refuses to guess at one it cannot read', () => {
    // Filing an unreadable day under Monday would put a leg session in the
    // wrong place, silently, and nobody would ever find out.
    for (const bad of ['Someday', '', null, 'Day 9', '0']) expect(dayNumber(bad)).toBeNull();

    const out = materialise(plan({ Someday: [ex()] }), resolver(['Barbell Squat']));
    expect(out.exercises).toEqual([]);
    expect(out.unknown_days).toEqual(['Someday']);
    expect(out.unresolved[0].reason).toBe('unrecognised day');
  });
});

describe('the prescription', () => {
  const one = (o) => materialise(plan({ Monday: [ex(o)] }), resolver(['Barbell Squat'])).exercises[0];

  it('keeps the lower bound of a rep range, and the range itself in the notes', () => {
    // The column holds one number; "8-10" is two. The lower bound is what the
    // client must reach for the set to count, and the range as written is not
    // thrown away.
    const row = one({ reps: '8-10' });
    expect(row.reps).toBe(8);
    expect(row.notes).toContain('Reps: 8-10');
  });

  it('does not clutter the notes when the range is just a number', () => {
    expect(one({ reps: '12' }).notes).toBeNull();
  });

  it('reads the rep shapes a coach actually writes', () => {
    expect(parseReps('8-10')).toBe(8);
    expect(parseReps('12')).toBe(12);
    expect(parseReps(10)).toBe(10);
    expect(parseReps('AMRAP')).toBeNull();
    expect(parseReps('')).toBeNull();
    // Never zero or negative: the column is a prescription a client performs.
    expect(parseReps('0')).toBe(1);
    expect(parseReps(-5)).toBe(1);
  });

  it('converts RIR onto the RPE scale the column is named for', () => {
    // 2 reps in reserve is RPE 8. Storing the 2 would read as a trivially
    // easy set rather than a hard one.
    expect(parseRpe('RIR 2')).toBe(8);
    expect(parseRpe('RPE 8')).toBe(8);
    expect(parseRpe('8')).toBe(8);
    expect(parseRpe('')).toBeNull();
    expect(parseRpe('as hard as possible')).toBeNull();
  });

  it('carries a cardio prescription into config rather than faking reps', () => {
    const row = one({
      prescription_type: 'TIME_DISTANCE', sets: null, reps: null,
      duration_seconds: 1200, distance: 5, distance_unit: 'km',
    });
    // `config` is the loose JSON column added for exactly this. Reps is one
    // bout, not the 12 the hand-written plan route defaults to — 12 is a
    // number a trainer would read as a prescription and nobody wrote it.
    expect(row.config).toEqual({ duration_seconds: 1200, distance: 5, distance_unit: 'km' });
    expect(row.reps).toBe(SINGLE_BOUT);
    expect(row.notes).toContain('Prescription: TIME_DISTANCE');
  });

  it('leaves config null for ordinary strength work', () => {
    expect(one({}).config).toBeNull();
    expect(configFor(ex())).toBeNull();
  });

  it('numbers slots per day, not across the week', () => {
    const out = materialise(
      plan({ Monday: [ex(), ex({ name: 'Bench Press' })], Thursday: [ex({ name: 'Deadlift' })] }),
      resolver(['Barbell Squat', 'Bench Press', 'Deadlift']),
    );
    // Slot 0 on Thursday is Thursday's first exercise — the meaning the
    // builder and progression.js already give sort_order.
    expect(out.exercises.map((r) => [r.day_of_week, r.sort_order]))
      .toEqual([[1, 0], [1, 1], [4, 0]]);
    expect(out.exercises.every((r) => r.week_number === WEEK_ONE)).toBe(true);
  });
});

describe('what cannot be saved', () => {
  it('reports it by name and day, rather than dropping it', () => {
    const out = materialise(
      plan({ Monday: [ex(), ex({ name: 'Overhead Press' })] }),
      resolver(['Barbell Squat']),
    );
    // One name in eight is the measured rate for humans using a picker. A
    // save that quietly shortened the session would be worse than one that
    // refused, so the trainer is told what to add in the builder.
    expect(out.counts).toEqual({ saved: 1, unresolved: 1 });
    expect(out.unresolved).toEqual([
      { day: 'Monday', position: 2, name: 'Overhead Press', reason: 'not in the exercise library' },
    ]);
  });

  it('never resolves a name by anything but an exact normalised match', () => {
    // The library holds "Overhead Lat". Trigram similarity scores it 0.474
    // against "Overhead Press" and would file a shoulder-loading press under
    // a lat exercise — in a plan whose whole point is that the shoulder was
    // screened.
    const out = materialise(plan({ Monday: [ex({ name: 'Overhead Press' })] }), resolver(['Overhead Lat']));
    expect(out.exercises).toEqual([]);
    expect(out.unresolved[0].name).toBe('Overhead Press');
  });

  it('matches through case, spacing and punctuation', () => {
    const out = materialise(plan({ Monday: [ex({ name: '  BENCH-PRESS ' })] }), resolver(['Bench Press']));
    expect(out.counts.saved).toBe(1);
    // Filed under the library's spelling, not the generator's.
    expect(out.exercises[0].exercise_name).toBe('Bench Press');
  });

  it('reports an unnamed exercise instead of resolving the empty string', () => {
    const out = materialise(plan({ Monday: [ex({ name: '' })] }), resolver(['Barbell Squat']));
    expect(out.unresolved[0].reason).toBe('no name');
  });
});

describe('the plan itself', () => {
  it('takes its shape from the generated plan', () => {
    const out = materialise(plan({ Monday: [ex()], Thursday: [ex()] }), resolver(['Barbell Squat']));
    expect(out.plan).toEqual({
      name: 'Hypertrophy Block', goal: 'muscle_gain', difficulty: 'intermediate',
      duration_weeks: 8, sessions_per_week: 2,
    });
  });

  it('counts the days itself when the plan does not say', () => {
    const p = plan({ Monday: [ex()], Thursday: [ex()] });
    delete p.days_per_week;
    expect(materialise(p, resolver(['Barbell Squat'])).plan.sessions_per_week).toBe(2);
  });

  it('names an unnamed plan rather than saving a blank', () => {
    const p = plan({ Monday: [ex()] }, { name: '   ' });
    expect(materialise(p, resolver(['Barbell Squat'])).plan.name).toBe('AI programme');
  });

  it('survives a malformed plan instead of throwing mid-save', () => {
    for (const bad of [null, undefined, {}, { weekly_schedule: 'x' }]) {
      const out = materialise(bad, new Map());
      expect(out.exercises).toEqual([]);
      expect(out.counts).toEqual({ saved: 0, unresolved: 0 });
    }
  });
});

describe('notes', () => {
  it('keeps what the trainer typed alongside what the mapping lost', () => {
    expect(notesFor(ex({ reps: '8-10', prescription_type: 'TIME', notes: 'slow eccentric' })))
      .toBe('Reps: 8-10 · Prescription: TIME · slow eccentric');
  });
});
