// Profile completion.
//
// The failure mode here is not a crash — it is a number that looks
// authoritative and is wrong. A percentage that rounds to 100 with a step
// outstanding, or a checklist that disagrees with the ring beside it, is worse
// than no score at all, because both get believed.
'use strict';

const { WEIGHTS, MIN, profileCompletion, credentialAttention } = require('../lib/profileCompletion');

/** A profile with every scored field satisfied. */
const complete = () => ({
  avatar_url: '/uploads/profile/a.png',
  phone: '9876543210',
  location: 'Kanpur',
  bio: 'x'.repeat(MIN.bio),
  philosophy: 'y'.repeat(MIN.philosophy),
  training_style: 'z'.repeat(30),
  languages: ['English'],
  job_title: 'Head Coach',
  designation: 'Founder',
  experience_since: '2010-06-01',
  coaching_modes: ['offline'],
  previous_gyms: [{ id: 'g1', name: 'Iron Temple' }],
  working_hours: { mon: [{ from: '06:00', to: '10:00' }] },
  specialisations: ['A', 'B', 'C'],
  certifications: [{ name: 'NASM-CPT' }],
  education: [{ institution: 'K11' }],
  achievements: [{ title: 'Gold' }],
});

describe('the weight table', () => {
  it('sums to exactly 100', () => {
    // A silent drift here makes every percentage on the platform subtly wrong
    // while still looking like a percentage.
    expect(WEIGHTS.reduce((n, w) => n + w.weight, 0)).toBe(100);
  });

  it('has no duplicate keys', () => {
    const keys = WEIGHTS.map((w) => w.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('states every threshold in its own label', () => {
    // Someone stuck below 100 with an unexplained gap types filler to clear it.
    const byKey = Object.fromEntries(WEIGHTS.map((w) => [w.key, w.label]));
    expect(byKey.bio).toContain(String(MIN.bio));
    expect(byKey.philosophy).toContain(String(MIN.philosophy));
    expect(byKey.specialisations).toContain(String(MIN.specialisations));
  });

  it('scores nothing the user cannot yet fill', () => {
    // Cover banner and portfolio have columns but no upload path. Scoring them
    // would park everyone below 100 with a step they cannot take, and a
    // checklist you cannot finish stops being read.
    const keys = WEIGHTS.map((w) => w.key);
    expect(keys).not.toContain('cover');
    expect(keys).not.toContain('portfolio');
  });
});

describe('profileCompletion', () => {
  it('is 0 for an empty profile, with everything listed as outstanding', () => {
    const r = profileCompletion({});
    expect(r.percent).toBe(0);
    expect(r.earned).toBe(0);
    expect(r.items.every((i) => !i.done)).toBe(true);
  });

  it('survives null and a malformed row without throwing', () => {
    for (const bad of [null, undefined, { languages: 'English', working_hours: [] }]) {
      expect(() => profileCompletion(bad)).not.toThrow();
      expect(profileCompletion(bad).percent).toBe(0);
    }
  });

  it('is exactly 100 when every item is done', () => {
    const r = profileCompletion(complete());
    expect(r.percent).toBe(100);
    expect(r.earned).toBe(r.total);
    expect(r.nextSteps).toEqual([]);
  });

  it('NEVER rounds up to 100 while a step is outstanding', () => {
    // Math.round on 99.6 gives 100: a full ring beside an unfinished list,
    // which is exactly when someone stops filling it in. Drop the lightest
    // item (3 points) and the score must read 97, not 100.
    const p = complete();
    p.languages = [];
    const r = profileCompletion(p);
    expect(r.earned).toBe(97);
    expect(r.percent).toBe(97);
    expect(r.percent).toBeLessThan(100);
  });

  it('reports earned points directly, because the weights total 100', () => {
    // Worth stating plainly: while the table sums to 100, earned/total*100 is
    // just `earned`, so no rounding happens and the Math.min(99, …) guard is
    // never reached. It stays as defence for a future table that does not sum
    // to 100 — and the "sums to exactly 100" test above is what keeps this
    // property true. Removing a 4-point item must read 96, not 95 or 97.
    const p = complete();
    p.location = '';
    const r = profileCompletion(p);
    expect([r.earned, r.percent]).toEqual([96, 96]);
  });

  it('each item independently accounts for exactly its weight', () => {
    // Catches a `done` predicate that reads the wrong column — the whole score
    // would still look plausible.
    const full = profileCompletion(complete());
    for (const w of WEIGHTS) {
      const p = complete();
      // Clear this one field in whichever shape it takes.
      const empty = { avatar_url: null, experience_since: null };
      p[w.key === 'avatar' ? 'avatar_url' : w.key] =
        empty[w.key === 'avatar' ? 'avatar_url' : w.key] !== undefined
          ? null
          : (Array.isArray(p[w.key]) ? [] : (typeof p[w.key] === 'object' && p[w.key] ? {} : ''));
      const r = profileCompletion(p);
      expect({ key: w.key, earned: r.earned }).toEqual({ key: w.key, earned: full.earned - w.weight });
    }
  });

  it('an EXPIRED certificate still counts as complete', () => {
    // Completeness is "have you told us about your qualifications"; currency is
    // a different question with its own strip. Folding them together would drop
    // the score on a day nobody edited anything.
    const p = complete();
    p.certifications = [{ name: 'Lapsed', expires_on: '2020-01-01' }];
    expect(profileCompletion(p).percent).toBe(100);
  });

  it('the checklist and the percentage cannot disagree', () => {
    const p = complete();
    p.bio = 'too short';
    p.education = [];
    const r = profileCompletion(p);
    const earnedFromItems = r.items.filter((i) => i.done).reduce((n, i) => n + i.weight, 0);
    expect(earnedFromItems).toBe(r.earned);
    expect(r.items.filter((i) => !i.done).map((i) => i.key).sort()).toEqual(['bio', 'education']);
  });

  it('a bio below the stated minimum does not count', () => {
    const p = complete();
    p.bio = 'x'.repeat(MIN.bio - 1);
    expect(profileCompletion(p).items.find((i) => i.key === 'bio').done).toBe(false);
    p.bio = 'x'.repeat(MIN.bio);
    expect(profileCompletion(p).items.find((i) => i.key === 'bio').done).toBe(true);
  });

  it('whitespace does not satisfy a text field', () => {
    const p = complete();
    p.location = '     ';
    expect(profileCompletion(p).items.find((i) => i.key === 'location').done).toBe(false);
  });

  it('working hours with only empty days do not count', () => {
    const p = complete();
    p.working_hours = { mon: [], tue: [] };
    expect(profileCompletion(p).items.find((i) => i.key === 'working_hours').done).toBe(false);
  });

  it('offers the heaviest outstanding items first, capped at three', () => {
    // The fastest route to a better profile, not a walk down the form.
    const r = profileCompletion({});
    expect(r.nextSteps).toHaveLength(3);
    expect(r.nextSteps.map((s) => s.weight)).toEqual([12, 10, 8]);
    const weights = r.nextSteps.map((s) => s.weight);
    expect([...weights].sort((a, b) => b - a)).toEqual(weights);
  });

  it('tells the UI which tab each step lives on', () => {
    for (const s of profileCompletion({}).nextSteps) {
      expect(['overview', 'credentials']).toContain(s.tab);
    }
  });
});

describe('credentialAttention', () => {
  const NOW = new Date('2026-07-29T10:00:00Z');

  it('counts expired and expiring separately from completeness', () => {
    expect(credentialAttention([
      { name: 'a', expires_on: '2020-01-01' },
      { name: 'b', expires_on: '2026-08-10' },
      { name: 'c', expires_on: '2030-01-01' },
      { name: 'd' },
    ], NOW)).toEqual({ expired: 1, expiring: 1 });
  });

  it('is empty for a malformed column rather than throwing', () => {
    expect(credentialAttention(null)).toEqual({ expired: 0, expiring: 0 });
  });
});
