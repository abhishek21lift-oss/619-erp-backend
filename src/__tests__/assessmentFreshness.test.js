'use strict';
// A stored score is only as fresh as the other module's last answer. Water and
// meals are asked in Nutrition but scored in Lifestyle; alcohol is asked in
// Lifestyle but scored in Nutrition. Editing one assessment used to leave the
// other module's stored score stale until that row was edited too, so the
// dashboard showed yesterday's answer. The list read refreshes the latest row.

const express = require('express');
const request = require('supertest');

const ORG = '11111111-1111-4111-8111-111111111111';
const CLIENT = '44444444-4444-4444-8444-444444444444';

let mockQueries = [];
let mockNutritionRows = [];
let mockLifestyleRows = [];
let mockNutritionHabits = {};
let mockLifestyleHabits = {};

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    mockQueries.push({ text, params });
    if (/^SELECT 1 FROM pt_clients/i.test(text)) return { rows: [{ ok: 1 }], rowCount: 1 };
    if (/^SELECT \* FROM pt_nutrition_assessments/i.test(text)) return { rows: mockNutritionRows, rowCount: mockNutritionRows.length };
    if (/^SELECT \* FROM pt_lifestyle_assessments/i.test(text)) return { rows: mockLifestyleRows, rowCount: mockLifestyleRows.length };
    if (/SELECT water_intake_liters, meals_per_day, breakfast_regularity, late_night_eating/i.test(text)) {
      return { rows: [mockNutritionHabits], rowCount: 1 };
    }
    if (/SELECT smoking_status, alcohol_status, drinks_per_week/i.test(text)) {
      return { rows: [mockLifestyleHabits], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  }),
}));
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = { id: 'u1', role: 'trainer', organization_id: ORG }; next(); },
  requireTrainer: (_req, _res, next) => next(),
}));
jest.mock('../middleware/validate', () => ({ validate: () => (_req, _res, next) => next() }));
jest.mock('../lib/activityLog', () => ({ logActivity: jest.fn(async () => {}) }));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn() }));

const app = express();
app.use(express.json());
app.use('/api/progress', require('../modules/progress/progress.routes'));
app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));

const updates = (table) => mockQueries.filter((q) => new RegExp(`^UPDATE ${table} SET`, 'i').test(q.text));

beforeEach(() => {
  mockQueries = [];
  mockNutritionRows = [];
  mockLifestyleRows = [];
  mockNutritionHabits = {};
  mockLifestyleHabits = {};
});

describe('the nutrition list refreshes scores that read Lifestyle', () => {
  it('applies a newer alcohol answer and stores it on the latest row', async () => {
    mockLifestyleHabits = { smoking_status: null, alcohol_status: 'weekly', drinks_per_week: 6 };
    mockNutritionRows = [{
      id: 'n1', client_id: CLIENT, assessment_date: '2026-10-01',
      water_intake_liters: '2.0', soft_drinks_per_day: 0,
      nutrition_risk_score: 0, risk_factors: null, nutrition_score: 55, nutrition_readiness: 'Average',
    }];

    const res = await request(app).get(`/api/progress/nutrition-assessments?client_id=${CLIENT}`);

    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({
      nutrition_risk_score: 15, risk_factors: ['Alcohol Risk'], nutrition_readiness: 'Insufficient data',
    });
    const [update] = updates('pt_nutrition_assessments');
    expect(update).toBeDefined();
    expect(update.params).toContain(ORG);
    expect(update.params).toContain(15);
  });

  it('leaves a row alone when nothing moved', async () => {
    mockNutritionRows = [{
      id: 'n1', client_id: CLIENT, assessment_date: '2026-10-01',
      water_intake_liters: '2.0', soft_drinks_per_day: 0,
      nutrition_risk_score: 0, risk_factors: null, nutrition_score: null, nutrition_readiness: 'Insufficient data',
      diet_quality_score: null, protein_score: null, protein_assessment: null, daily_fluid_intake_liters: 2,
      hydration_score: 55, digestive_health_score: null, supplement_score: null,
    }];

    const res = await request(app).get(`/api/progress/nutrition-assessments?client_id=${CLIENT}`);

    expect(res.status).toBe(200);
    expect(updates('pt_nutrition_assessments')).toHaveLength(0);
  });
});

describe('the lifestyle list refreshes scores that read Nutrition', () => {
  it('scores the latest water and meals answer, not the copy on its own row', async () => {
    mockNutritionHabits = {
      water_intake_liters: '3.0', meals_per_day: 3, breakfast_regularity: 'daily', late_night_eating: false,
    };
    mockLifestyleRows = [{
      id: 'l1', client_id: CLIENT, assessment_date: '2026-10-01',
      sleep_duration_hours: '8.0', sleep_quality: 8,
      stress_level: 1,
      water_intake_liters: '1.0', hydration_score: 25,
      daily_steps_bracket: '8000_10000', activity_level: 'Active', activity_score: 80,
      meal_frequency: 2, breakfast_habit: null, late_night_eating: null, nutrition_score: 90,
      smoking_status: null, alcohol_status: null,
      energy_level: 8, recovery_quality: 'good',
      lifestyle_score: 0, lifestyle_readiness: 'High Risk',
    }];

    const res = await request(app).get(`/api/progress/lifestyle-assessments?client_id=${CLIENT}`);

    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({
      hydration_score: 85, nutrition_score: 100, lifestyle_score: 90, lifestyle_readiness: 'Excellent',
    });
    const [update] = updates('pt_lifestyle_assessments');
    expect(update).toBeDefined();
    expect(update.params).toContain(ORG);
    expect(update.params).toContain(85);
    expect(update.params).toContain(100);
  });
});
