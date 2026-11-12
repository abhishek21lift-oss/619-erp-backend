'use strict';
// The member fitness service only shapes stored rows: no formula runs here,
// and the tier is the shared `tierForScore` output, not a second scoring
// framework.

jest.mock('../modules/progress/member-fitness.repo', () => ({
  client: jest.fn(),
  assessments: jest.fn(),
  latestMobility: jest.fn(),
}));
jest.mock('../modules/progress/fitness-scoring', () => ({
  tierForScore: jest.fn((score) => (score >= 85 ? 'Optimal' : score >= 70 ? 'Fit' : score >= 50 ? 'Moderate' : 'Needs Attention')),
}));

const repo = require('../modules/progress/member-fitness.repo');
const service = require('../modules/progress/member-fitness.service');

beforeEach(() => {
  jest.clearAllMocks();
  repo.client.mockResolvedValue({ name: 'Asha', gender: 'female' });
  repo.assessments.mockResolvedValue([]);
  repo.latestMobility.mockResolvedValue(null);
});

it('keeps the session scope and returns the client and mobility beside the rows', async () => {
  repo.latestMobility.mockResolvedValue({
    id: 'm1', assessment_date: '2026-03-02', mobility_score: 82, mobility_category: 'Good',
  });

  const out = await service.dashboard('org-1', 'client-1');

  expect(repo.client).toHaveBeenCalledWith('org-1', 'client-1');
  expect(repo.assessments).toHaveBeenCalledWith('org-1', 'client-1');
  expect(repo.latestMobility).toHaveBeenCalledWith('org-1', 'client-1');
  expect(out.client).toEqual({ name: 'Asha', gender: 'female' });
  expect(out.latest_mobility.mobility_score).toBe(82);
});

it('gives a tier only to a complete 100-point battery', async () => {
  repo.assessments.mockResolvedValue([
    { id: 'a1', assessment_date: '2026-03-01', overall_fitness_score: 78, overall_max: 100 },
    { id: 'a2', assessment_date: '2026-02-01', overall_fitness_score: 64, overall_max: '85.0' },
    { id: 'a3', assessment_date: '2026-01-01', overall_fitness_score: null, overall_max: 100 },
  ]);

  const { assessments } = await service.dashboard('org-1', 'client-1');

  expect(assessments[0].tier).toBe('Fit');
  expect(assessments[1].tier).toBeNull();
  expect(assessments[2].tier).toBeNull();
});

it('never recomputes a score from the step columns', async () => {
  repo.assessments.mockResolvedValue([{
    id: 'a1', assessment_date: '2026-03-01',
    overall_fitness_score: null, overall_max: 100,
    body_composition_score: 15, cardio_score_computed: 20, strength_score_computed: 15,
    endurance_score_computed: 15, mobility_score_computed: 15,
  }]);

  const { assessments } = await service.dashboard('org-1', 'client-1');

  expect(assessments[0].overall_fitness_score).toBeNull();
  expect(assessments[0].tier).toBeNull();
});
