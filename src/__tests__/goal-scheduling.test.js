'use strict';
const s = require('../modules/progress/goal-scheduling');

describe('goal scheduling backend', () => {
  it('3 days full body', () => {
    const r = s.recommendTrainingSplit(3, { goal: 'fat_loss', experience: 'beginner' });
    expect(r.split).toBe('full_body');
    expect(r.calendar.filter(d => d.type === 'training')).toHaveLength(3);
  });
  it('all frequencies', () => {
    for (const d of [1,2,3,4,5,6,7]) {
      const r = s.recommendTrainingSplit(d, {});
      expect(r.calendar.filter(x => x.type === 'training')).toHaveLength(d);
    }
  });
  it('milestones + blueprint', () => {
    const ms = s.generateMilestones('2026-01-01', '2026-04-01', 8, 12);
    expect(ms.length).toBeGreaterThan(1);
    const b = s.buildRoutineBlueprint({ goal: 'strength_gain', experience: 'intermediate', equipment: 'full_gym', trainingDays: 4, split: 'upper_lower' });
    expect(b.sessionTemplate.mainLifts.sets).toBeGreaterThan(0);
  });
});
