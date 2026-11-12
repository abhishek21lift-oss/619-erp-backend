'use strict';
// POST /api/diet/plans/from-ai with a generation_id.
//
// A generation is what the engine proposed; the ledger froze the numbers it
// was judged against. Saving by id must therefore:
//   · read the proposal inside the caller's studio, and only for this client
//   · re-check it against the client's LIVE allergies and dietary pattern,
//     because the record may have changed since generation
//   · report target drift as a warning, never as a blocker — the plan is a
//     snapshot, and re-weighing the client does not invalidate the food
//   · link the accepted end of the ledger in the same request
// A body `plan` still saves exactly as it did before.

process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long!!';

const ORG_A = '11111111-1111-4111-8111-111111111111';

const mockQueries = [];
let mockGeneration = null;

const mockClient = {
  query: jest.fn(async (sql, params) => {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    mockQueries.push({ via: 'tx', sql: flat, params: params || [] });
    if (/RETURNING \*/i.test(flat)) return { rows: [{ id: 'as-1', status: 'active' }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  }),
  release: jest.fn(),
};

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    mockQueries.push({ via: 'pool', sql: flat, params: params || [] });
    if (/FROM pt_clients/i.test(flat)) return { rows: [], rowCount: 1 };
    if (/FROM ai_diet_generations/i.test(flat)) {
      return { rows: mockGeneration ? [mockGeneration] : [], rowCount: mockGeneration ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  }),
  connect: jest.fn(async () => mockClient),
}));

jest.mock('../modules/pt-os/authoritative-client', () => ({ loadClientSources: jest.fn() }));
const { loadClientSources } = require('../modules/pt-os/authoritative-client');

let mockCurrentUser = { id: 'usr-1', role: 'trainer', organization_id: ORG_A, trainer_id: null };
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requireTrainer: (...a) => jest.requireActual('../middleware/rbac').requireTrainer(...a),
}));

const express = require('express');
const request = require('supertest');

const app = express();
app.use(express.json());
app.use('/api/diet', require('../routes/diet'));

const PLAN = {
  name: 'Ledger plan',
  goal: 'fat_loss',
  total_calories: 2000,
  macros: { protein_g: 150, carbs_g: 200, fat_g: 60 },
  meals: [
    {
      name: 'Breakfast', slot: 'breakfast', time: '08:00',
      calories: 475, protein_g: 17.5, carbs_g: 15, fat_g: 40,
      foods: [{
        name: 'Peanut butter', quantity: 5, unit: 'tbsp',
        calories: 475, protein_g: 17.5, carbs_g: 15, fat_g: 40,
      }],
    },
    {
      name: 'Dinner', slot: 'dinner', time: '20:00',
      calories: 1525, protein_g: 132.5, carbs_g: 185, fat_g: 20, foods: [],
    },
  ],
};

const CALCULATION = {
  version: '1.0.0',
  calorie_target: 2000,
  macros: { protein_g: 150, carbs_g: 200, fat_g: 60 },
  inputs: { weight_kg: 80, height_cm: 180, goal: 'fat_loss' },
};

const SCHEDULE = [
  { slot: 'breakfast', time: '08:00' },
  { slot: 'dinner', time: '20:00' },
];

const SOURCES = {
  client: { id: 'cl-1', height: 180 },
  profile: null,
  goals: [{ goal_type: 'fat_loss' }],
  nutrition: { food_allergies: [], foods_to_avoid: [], dietary_pattern: 'vegetarian' },
  latestAssessment: { weight: 80, height_cm: 180 },
};

const generation = (over = {}) => ({
  id: 'gen-1',
  client_id: 'cl-1',
  proposed_plan: PLAN,
  calculation: CALCULATION,
  schedule: SCHEDULE,
  ...over,
});

const txInserts = (table) => mockQueries.filter(
  (q) => q.via === 'tx' && new RegExp(`^INSERT INTO ${table}\\b`, 'i').test(q.sql),
);

beforeEach(() => {
  mockQueries.length = 0;
  mockGeneration = generation();
  mockClient.release.mockClear();
  mockCurrentUser = { id: 'usr-1', role: 'trainer', organization_id: ORG_A, trainer_id: null };
  loadClientSources.mockReset();
  loadClientSources.mockResolvedValue(SOURCES);
});

describe('POST /api/diet/plans/from-ai with generation_id', () => {
  it('saves the generation plan, not a body plan sent alongside it', async () => {
    const res = await request(app).post('/api/diet/plans/from-ai').send({
      client_id: 'cl-1',
      generation_id: 'gen-1',
      plan: { ...PLAN, name: 'Typed plan' },
    });

    expect(res.status).toBe(201);
    expect(txInserts('diet_templates')[0].params).toContain('Ledger plan');
    expect(txInserts('diet_templates')[0].params).not.toContain('Typed plan');
    expect(res.body.generation_id).toBe('gen-1');
  });

  it('reads the generation inside the studio and refuses another client\'s', async () => {
    mockGeneration = generation({ client_id: 'cl-other' });
    const res = await request(app).post('/api/diet/plans/from-ai').send({
      client_id: 'cl-1', generation_id: 'gen-1',
    });

    expect(res.status).toBe(404);
    const read = mockQueries.find((q) => /FROM ai_diet_generations/i.test(q.sql));
    expect(read.params).toEqual(['gen-1', ORG_A]);
    expect(txInserts('diet_templates')).toHaveLength(0);
  });

  it('refuses a plan whose food the client is now allergic to', async () => {
    loadClientSources.mockResolvedValue({
      ...SOURCES,
      nutrition: { ...SOURCES.nutrition, food_allergies: ['peanuts'] },
    });
    const res = await request(app).post('/api/diet/plans/from-ai').send({
      client_id: 'cl-1', generation_id: 'gen-1',
    });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(res.body.blockers.join(' ')).toMatch(/Peanut butter/);
    expect(txInserts('diet_templates')).toHaveLength(0);
    expect(mockQueries.some((q) => /^UPDATE ai_diet_generations/i.test(q.sql))).toBe(false);
  });

  it('refuses a plan that breaks the live dietary pattern', async () => {
    loadClientSources.mockResolvedValue({
      ...SOURCES,
      nutrition: { ...SOURCES.nutrition, dietary_pattern: 'vegan' },
    });
    const paneer = {
      ...PLAN,
      meals: [
        {
          ...PLAN.meals[0],
          foods: [{ ...PLAN.meals[0].foods[0], name: 'Paneer (raw)' }],
        },
        PLAN.meals[1],
      ],
    };
    mockGeneration = generation({ proposed_plan: paneer });

    const res = await request(app).post('/api/diet/plans/from-ai').send({
      client_id: 'cl-1', generation_id: 'gen-1',
    });

    expect(res.status).toBe(422);
    expect(res.body.blockers.join(' ')).toMatch(/Paneer/);
    expect(txInserts('diet_templates')).toHaveLength(0);
  });

  it('reports target drift as a warning and still saves', async () => {
    loadClientSources.mockResolvedValue({
      ...SOURCES,
      latestAssessment: { weight: 82, height_cm: 180 },
    });
    const res = await request(app).post('/api/diet/plans/from-ai').send({
      client_id: 'cl-1', generation_id: 'gen-1',
    });

    expect(res.status).toBe(201);
    expect(res.body.targets_stale).toBe(true);
    expect(txInserts('diet_templates')).toHaveLength(1);
  });

  it('links the accepted template and assignment on the ledger', async () => {
    const res = await request(app).post('/api/diet/plans/from-ai').send({
      client_id: 'cl-1', generation_id: 'gen-1',
    });

    expect(res.status).toBe(201);
    const templateId = txInserts('diet_templates')[0].params[0];
    const link = mockQueries.find(
      (q) => /^UPDATE ai_diet_generations/i.test(q.sql) && /accepted_template_id/i.test(q.sql),
    );
    expect(link.params).toEqual(['gen-1', templateId, 'as-1', ORG_A]);
  });

  it('leaves the body-plan path exactly as it was', async () => {
    const res = await request(app).post('/api/diet/plans/from-ai').send({
      client_id: 'cl-1', plan: PLAN,
    });

    expect(res.status).toBe(201);
    expect(mockQueries.some((q) => /FROM ai_diet_generations/i.test(q.sql))).toBe(false);
    expect(res.body.targets_stale).toBeUndefined();
    expect(txInserts('diet_templates')).toHaveLength(1);
  });
});
