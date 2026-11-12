'use strict';
// Migration 280 is read, not run: the food tables and their policies have to
// be right before any database sees them, and a real-DB test would be skipped
// without RLS_TEST_DATABASE_URL.

const fs = require('fs');
const path = require('path');

const SQL = fs.readFileSync(
  path.join(__dirname, '..', 'db', 'migrations', '280_food_level_nutrition.sql'),
  'utf8',
);

const statement = (re) => (SQL.match(re) || [''])[0];

describe('280 food-level nutrition', () => {
  test('creates both tables with the food-level keys', () => {
    expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS foods/);
    expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS diet_meal_foods/);
    const child = statement(/CREATE TABLE IF NOT EXISTS diet_meal_foods[\s\S]*?\);/);
    expect(child).toMatch(/meal_id\s+TEXT\s+NOT NULL\s+REFERENCES meals\(id\)/);
    expect(child).toMatch(/nutrition_source[\s\S]*CHECK \(nutrition_source IN \('reference','model'\)\)/);
  });

  test('adds the schedule and calculation columns', () => {
    const planMeals = statement(/ALTER TABLE diet_plan_meals[\s\S]*?;/);
    expect(planMeals).toContain('slot');
    expect(planMeals).toContain('serve_time');
    expect(planMeals).toContain('day_offset');

    const templates = statement(/ALTER TABLE diet_templates[\s\S]*?;/);
    for (const column of ['calculation_version', 'calculation', 'food_culture', 'dietary_pattern']) {
      expect(templates).toContain(column);
    }
  });

  test('foods reads global plus own, writes own only', () => {
    const read = statement(/CREATE POLICY foods_read[\s\S]*?;/);
    expect(read).toMatch(/organization_id IS NULL\s+OR organization_id::text = current_setting\('app\.org_id', true\)/);

    const write = statement(/CREATE POLICY foods_write[\s\S]*?;/);
    expect(write).toContain("current_setting('app.org_id', true)");
    expect(write).not.toMatch(/IS NULL/);
  });

  test('diet_meal_foods walks to meals for its tenant boundary', () => {
    const policy = statement(/CREATE POLICY tenant_isolation ON diet_meal_foods[\s\S]*?;/);
    expect(policy).toMatch(/EXISTS \(SELECT 1 FROM meals m/);
    expect(policy).toMatch(/m\.organization_id::text = current_setting\('app\.org_id', true\)/);
  });

  test('app_tenant may insert into both tables', () => {
    expect(SQL).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON foods TO app_tenant/);
    expect(SQL).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON diet_meal_foods TO app_tenant/);
  });

  test('leaves transaction control to the runner', () => {
    expect(SQL).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
  });

  test('seeds the curated foods and is re-runnable', () => {
    const values = statement(/FROM \(VALUES[\s\S]*?\) AS v\(/);
    const rows = (values.match(/^\s*\('/gm) || []).length;
    expect(rows).toBeGreaterThanOrEqual(60);
    expect(rows).toBeLessThanOrEqual(80);
    // Both cultures must survive any future edit of the seed.
    expect(values).toContain("'indian'");
    expect(values).toContain("'western'");
    expect(SQL.trimEnd()).toMatch(/ON CONFLICT DO NOTHING;$/);
  });
});
