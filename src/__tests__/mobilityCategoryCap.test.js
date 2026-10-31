'use strict';
// A movement screen with pain must not read "Excellent" while the same row
// tells the trainer to refer the client. These pin the cap, not the formula.

const { calcMobilityScore, classifyMobility } = require('../modules/progress/mobility-scoring');

const item = (over = {}) => ({ score: 5, pain: false, restriction: false, ...over });

describe('mobility category cap', () => {
  test('a perfect screen with no pain or restriction stays Excellent', () => {
    const body = [item({ region: 'Neck' }), item({ region: 'Shoulder' })];
    const score = calcMobilityScore(body, []);
    expect(score).toBe(100);
    expect(classifyMobility(score, body, [])).toBe('Excellent');
  });

  test('pain caps the category at Average even when the mean is perfect', () => {
    const body = [item({ region: 'Neck' }), item({ region: 'Shoulder', pain: true }), item({ region: 'Hip', pain: true })];
    const score = calcMobilityScore(body, []);
    expect(score).toBe(90);
    expect(classifyMobility(score, body, [])).toBe('Average');
  });

  test('restriction caps the category at Good', () => {
    const body = [item({ region: 'Neck' }), item({ region: 'Hip', restriction: true })];
    const score = calcMobilityScore(body, []);
    expect(score).toBe(97);
    expect(classifyMobility(score, body, [])).toBe('Good');
  });

  test('pain and restriction together take the stricter cap', () => {
    const body = [item({ region: 'Neck', pain: true, restriction: true }), item({ region: 'Hip' })];
    expect(classifyMobility(calcMobilityScore(body, []), body, [])).toBe('Average');
  });

  test('the cap never raises a lower score', () => {
    const body = [item({ region: 'Neck', score: 1, pain: true }), item({ region: 'Hip', score: 1 })];
    const score = calcMobilityScore(body, []);
    expect(score).toBe(15);
    expect(classifyMobility(score, body, [])).toBe('Poor');
  });

  test('without scores there is no category', () => {
    expect(classifyMobility(null, [], [])).toBeNull();
  });
});
