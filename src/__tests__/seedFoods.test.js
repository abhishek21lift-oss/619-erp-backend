'use strict';
// The import writes the global catalog: a renamed column must fail loudly
// instead of importing a thousand zero-calorie foods, and a recipe served
// as two triangles must not be stored as one.

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../db/pool', () => ({ query: jest.fn() }));

const {
  parseCsv, records, householdServing, indbFoods,
} = require('../../scripts/seed-foods');

describe('parseCsv', () => {
  test('keeps commas and escaped quotes inside quoted fields', () => {
    expect(parseCsv('a,b\n"1, 2","say ""hi"""\n')).toEqual([
      ['a', 'b'],
      ['1, 2', 'say "hi"'],
    ]);
  });

  test('drops a UTF-8 BOM from the first header', () => {
    expect(parseCsv('\uFEFFcode,name\n1,Roti\n')[0]).toEqual(['code', 'name']);
  });
});

describe('records', () => {
  test('throws when a required column is renamed', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mps-foods-')), 'indb.csv');
    fs.writeFileSync(file, 'food_code,food_name\n1,Roti\n');
    expect(() => records(file, ['food_code', 'energy_kcal'])).toThrow(/energy_kcal/);
  });
});

describe('householdServing', () => {
  test('uses the real serving count, or the unit alone when it is unknown', () => {
    expect(householdServing('2', 'triangle')).toBe('2 triangle');
    expect(householdServing('2 to 3', 'pieces')).toBe('2 to 3 pieces');
    expect(householdServing('', 'katori')).toBe('katori');
    expect(householdServing(null, '')).toBeNull();
  });
});

describe('indbFoods', () => {
  test('joins the serving sizes and falls back to the unit alone', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mps-foods-'));
    fs.writeFileSync(path.join(dir, 'indb.csv'),
      'food_code,food_name,energy_kcal,protein_g,carb_g,fat_g,fibre_g,servings_unit\n'
      + 'ASC023,Cheese sandwich,300,10,30,12,2,triangle\n'
      + 'ASC999,Unknown recipe,100,1,1,1,1,katori\n');
    fs.writeFileSync(path.join(dir, 'indb_servings.csv'),
      'recipe_code,size_of_servings,servings_unit\nASC023,2,triangle\n');

    const foods = indbFoods(dir);
    expect(foods.map((f) => f.household_serving)).toEqual(['2 triangle', 'katori']);
  });
});
