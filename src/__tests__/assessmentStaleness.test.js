'use strict';
// An assessment's age is itself a fact about the evidence.
//
// Every section of the training brief already carried an `as_of`, and nothing
// read it. So a mobility screen taken two years ago reached the programme with
// exactly the authority of one taken last Tuesday.
//
// The dangerous half is the silence. An ABSENT finding in a stale screen reads
// as "nothing wrong there" — when what it actually means is "nothing was wrong
// there, two years ago, before whatever they have not mentioned since". That is
// the same class of mistake as the defaults this engine exists to remove: an
// unknown being quietly rendered as a reassuring answer.
//
// Stale is a THIRD state, not a synonym for missing and not a synonym for
// fresh: real data whose age the trainer should weigh. So it is reported rather
// than discarded — discarding it would throw away the only screen the studio
// has — and reported rather than silently trusted, which is what it replaces.

const {
  staleness, ageInDays, sectionDate, STALE_AFTER_DAYS, SECTIONS, buildBrief,
} = require('../modules/pt-os/training-brief');

const TODAY = new Date('2026-09-14T00:00:00Z');
const daysAgo = (n) => new Date(TODAY.getTime() - n * 86400000).toISOString().slice(0, 10);

describe('ageInDays', () => {
  test('counts whole days back from today', () => {
    expect(ageInDays(daysAgo(10), TODAY)).toBe(10);
    expect(ageInDays(daysAgo(0), TODAY)).toBe(0);
  });

  test('answers null for anything it cannot date rather than guessing zero', () => {
    expect(ageInDays(null, TODAY)).toBeNull();
    expect(ageInDays('', TODAY)).toBeNull();
    expect(ageInDays('not a date', TODAY)).toBeNull();
  });

  test('a future date is not negative age, it is no answer', () => {
    expect(ageInDays(new Date(TODAY.getTime() + 86400000).toISOString().slice(0, 10), TODAY)).toBeNull();
  });
});

describe('staleness', () => {
  test('reports a section past its threshold, with the evidence for saying so', () => {
    const out = staleness({ readiness: { present: true, as_of: daysAgo(400) } }, TODAY);
    expect(out).toEqual([{
      section: 'readiness', as_of: daysAgo(400), age_days: 400, stale_after_days: 365,
    }]);
  });

  test('a section inside its threshold is not reported', () => {
    expect(staleness({ readiness: { present: true, as_of: daysAgo(364) } }, TODAY)).toEqual([]);
  });

  // The boundary is "older than", not "at least". A screen taken exactly a
  // year ago today is due, not overdue, and a trainer reading STALE on it
  // learns to discount the word.
  test('the threshold day itself is still current', () => {
    expect(staleness({ readiness: { present: true, as_of: daysAgo(365) } }, TODAY)).toEqual([]);
    expect(staleness({ readiness: { present: true, as_of: daysAgo(366) } }, TODAY)).toHaveLength(1);
  });

  // The fixture carries a date deliberately. Written as `{ present: false }`
  // alone, this test passed for the wrong reason — the undated guard excluded
  // it and the `present` check was never exercised, which a mutation removing
  // that check survived. A dated-but-absent section is the only shape that
  // actually pins it.
  test('an absent section is missing, which is a different complaint', () => {
    expect(staleness({ readiness: { present: false, as_of: daysAgo(400) } }, TODAY)).toEqual([]);
  });

  // Saying "stale" about something whose age is unknown would be the same
  // mistake, pointing the other way: a confident claim with no evidence.
  test('a present but UNDATED section is not reported stale', () => {
    expect(staleness({ readiness: { present: true, as_of: null } }, TODAY)).toEqual([]);
  });

  test('each section is judged against its own threshold, not a shared one', () => {
    const at = (days) => ({ present: true, as_of: daysAgo(days) });
    // 100 days: past body (90), inside limitations/capacity/lifestyle/goal
    // (180) and readiness (365).
    const out = staleness({
      body: at(100), limitations: at(100), capacity: at(100),
      lifestyle: at(100), goal: at(100), readiness: at(100),
    }, TODAY);
    expect(out.map((s) => s.section)).toEqual(['body']);
  });

  test('history carries no threshold — its currency is its status, not its age', () => {
    expect(STALE_AFTER_DAYS.history).toBeUndefined();
    expect(staleness({ history: { present: true, as_of: daysAgo(9999) } }, TODAY)).toEqual([]);
  });

  test('every threshold names a real brief section', () => {
    for (const section of Object.keys(STALE_AFTER_DAYS)) {
      expect(SECTIONS).toContain(section);
    }
  });
});

// ── The shape the real brief actually builds ───────────────────────────────
//
// These fixtures are the reason the first version of staleness() shipped
// broken. They were synthetic sections with a flat `as_of`, and `limitations`
// — the one section that changes exercise SELECTION rather than volume — does
// not have one: it composes posture and mobility and nests a date under each.
// staleness() read `s.as_of`, found undefined, and skipped it silently.
//
// A live client with a 2023 mobility screen is what found that. So these run
// against buildBrief's own output rather than against a hand-written object.
describe('against the brief this actually receives', () => {
  // TODAY is passed in, not left to the wall clock. Every fixture below dates
  // itself relative to TODAY, so grading the result against the real current
  // date made the whole block true only on the day it was written.
  const brief = (over = {}) => buildBrief({
    client: { id: 'c1', name: 'A' },
    parq: null, assessment: null, posture: null, mobility: null,
    lifestyle: null, goal: null, assignment: null, recentSessions: [],
    today: TODAY,
    ...over,
  });

  test('limitations is dated from its nested assessments, not a flat field', () => {
    const b = brief({ mobility: { assessment_date: daysAgo(600) } });
    expect(b.sections.limitations.present).toBe(true);
    expect(b.sections.limitations.as_of).toBeUndefined();
    expect(sectionDate('limitations', b.sections.limitations)).toBe(daysAgo(600));
    expect(staleness(b.sections, TODAY).map((x) => x.section)).toContain('limitations');
  });

  // A studio assessing properly must not be told its screen is stale because
  // one of the two halves is older. The section is as current as its freshest
  // evidence.
  test('a recent posture screen keeps limitations current despite an old mobility one', () => {
    const b = brief({
      mobility: { assessment_date: daysAgo(600) },
      posture: { assessment_date: daysAgo(10) },
    });
    expect(sectionDate('limitations', b.sections.limitations)).toBe(daysAgo(10));
    expect(staleness(b.sections, TODAY).map((x) => x.section)).not.toContain('limitations');
  });

  test('limitations present only through a typed injury stays undated, not stale', () => {
    const b = brief({ client: { id: 'c1', name: 'A', injuries: 'left knee' } });
    expect(b.sections.limitations.present).toBe(true);
    expect(sectionDate('limitations', b.sections.limitations)).toBeNull();
    expect(staleness(b.sections, TODAY)).toEqual([]);
  });

  test('a flat-dated section still reads its own as_of', () => {
    const b = brief({ parq: { assessment_date: daysAgo(400) } });
    expect(sectionDate('readiness', b.sections.readiness)).toBe(daysAgo(400));
    expect(staleness(b.sections, TODAY).map((x) => x.section)).toContain('readiness');
  });

  test('buildBrief reports staleness on the brief itself', () => {
    const b = brief({ mobility: { assessment_date: daysAgo(600) } });
    expect(b.stale.map((x) => x.section)).toEqual(['limitations']);
    expect(b.stale[0].age_days).toBe(600);
  });
});
