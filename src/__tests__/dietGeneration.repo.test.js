'use strict';
// The ledger row is best-effort bookkeeping: it records the proposal, never
// changes it. These tests pin the SQL contract — tenant scoping and JSON
// columns — without a database.

jest.mock('../db/pool', () => ({ query: jest.fn() }));

const pool = require('../db/pool');
const {
  recordDietGeneration, readDietGeneration, markDietGenerationAccepted,
} = require('../modules/nutrition/diet-generation.repo');

const ORG = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  pool.query.mockReset();
  pool.query.mockResolvedValue({ rows: [], rowCount: 1 });
});

test('records one generation, scoped to the studio, and returns its id', async () => {
  const id = await recordDietGeneration({
    orgId: ORG,
    clientId: 'client-1',
    createdBy: 'u1',
    plan: { name: 'Lean Fuel' },
    calculation: { calorie_target: 1700 },
    schedule: [{ slot: 'breakfast' }],
    validation: { ok: true },
    grounding: { status: 'ok' },
  });

  expect(typeof id).toBe('string');
  const [sql, params] = pool.query.mock.calls[0];
  expect(sql).toContain('INSERT INTO ai_diet_generations');
  expect(params[1]).toBe(ORG);
  expect(params[2]).toBe('client-1');
  expect(params).toContain(id);
});

test('reads a generation only inside the caller\'s studio', async () => {
  await readDietGeneration('g-1', ORG);

  const [sql, params] = pool.query.mock.calls[0];
  expect(sql).toContain('WHERE id = $1 AND organization_id = $2');
  expect(params).toEqual(['g-1', ORG]);
});

test('a foreign generation reads as null, never as someone else\'s row', async () => {
  pool.query.mockResolvedValue({ rows: [] });
  const row = await readDietGeneration('g-1', '22222222-2222-2222-2222-222222222222');
  expect(row).toBeNull();
  expect(pool.query.mock.calls[0][1]).toEqual(['g-1', '22222222-2222-2222-2222-222222222222']);
});

test('accepting is first-write-wins and tenant-scoped', async () => {
  const rowCount = await markDietGenerationAccepted('g-1', 't-1', 'a-1', ORG);

  const [sql, params] = pool.query.mock.calls[0];
  expect(sql).toContain('accepted_template_id IS NULL');
  expect(sql).toContain('organization_id = $4');
  expect(params).toEqual(['g-1', 't-1', 'a-1', ORG]);
  expect(rowCount).toBe(1);
});

test('the JSON columns are parameters, not concatenated text', async () => {
  await recordDietGeneration({
    orgId: ORG,
    clientId: 'client-1',
    plan: { name: 'P' },
    inputs: { age: 30 },
    calculation: { calorie_target: 1700 },
    schedule: [{ slot: 'breakfast' }],
    validation: { ok: true, blockers: [] },
    grounding: { status: 'ok' },
  });

  const [sql, params] = pool.query.mock.calls[0];
  expect(sql).toMatch(/proposed_plan, inputs, data_quality, calculation, schedule, validation,\s+grounding/);
  expect(sql.match(/::jsonb/g)).toHaveLength(7);
  // No raw model text is stored; prompt_version is a label, not content.
  expect(sql).not.toMatch(/raw|prompt_text/i);
  expect(params[7]).toBe(JSON.stringify({ name: 'P' }));
  expect(params[8]).toBe(JSON.stringify({ age: 30 }));
});
