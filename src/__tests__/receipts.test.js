jest.mock('../db/pool', () => ({
  query: jest.fn(),
}));

const pool = require('../db/pool');
const { genReceiptNo } = require('../db/receipts');

describe('genReceiptNo', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns a RCP-prefixed string in the expected format', async () => {
    pool.query.mockImplementation(async function() {
      if (/CREATE SEQUENCE IF NOT EXISTS receipt_no_seq/i.test(arguments[0])) {
        return { rows: [] };
      }
      if (/SELECT nextval/i.test(arguments[0])) {
        return { rows: [{ n: 100001 }] };
      }
      return { rows: [] };
    });
    const r = await genReceiptNo();
    expect(r).toMatch(/^RCP-\d{8}-\d{6}$/);
  });

  it('produces unique values for sequential calls', async () => {
    let n = 100001;
    pool.query.mockImplementation(async function() {
      if (/CREATE SEQUENCE IF NOT EXISTS receipt_no_seq/i.test(arguments[0])) {
        return { rows: [] };
      }
      if (/SELECT nextval/i.test(arguments[0])) {
        n += 1;
        return { rows: [{ n: n - 1 }] };
      }
      return { rows: [] };
    });
    const a = await genReceiptNo();
    const b = await genReceiptNo();
    expect(a).not.toBe(b);
  });

  // Under app_tenant (RLS, migration 157) the API may not create objects, and
  // Postgres checks CREATE before it looks for the object — so even
  // `CREATE SEQUENCE IF NOT EXISTS` on an existing sequence is "permission
  // denied for schema public". That failed every payment recorded under RLS.
  describe('never asks for CREATE when the sequence exists', () => {
    /** A fresh module each time: the "already checked" flag is per process. */
    const fresh = () => {
      let mod;
      jest.isolateModules(() => { mod = require('../db/receipts'); });
      return mod;
    };

    it('issues no CREATE when the sequence is already there', async () => {
      const sql = [];
      pool.query.mockImplementation(async (q) => {
        sql.push(q);
        if (/CREATE SEQUENCE/i.test(q)) throw new Error('permission denied for schema public');
        if (/to_regclass/i.test(q)) return { rows: [{ present: true }] };
        if (/SELECT nextval/i.test(q)) return { rows: [{ n: 100007 }] };
        return { rows: [] };
      });
      await expect(fresh().genReceiptNo()).resolves.toMatch(/^RCP-\d{8}-100007$/);
      expect(sql.some((q) => /CREATE SEQUENCE/i.test(q))).toBe(false);
    });

    it('creates it when it is missing', async () => {
      const sql = [];
      pool.query.mockImplementation(async (q) => {
        sql.push(q);
        if (/to_regclass/i.test(q)) return { rows: [{ present: false }] };
        if (/SELECT nextval/i.test(q)) return { rows: [{ n: 100001 }] };
        return { rows: [] };
      });
      await fresh().genReceiptNo();
      expect(sql.filter((q) => /CREATE SEQUENCE IF NOT EXISTS receipt_no_seq/i.test(q))).toHaveLength(1);
    });

    it('checks once per process, not once per receipt', async () => {
      const sql = [];
      pool.query.mockImplementation(async (q) => {
        sql.push(q);
        if (/to_regclass/i.test(q)) return { rows: [{ present: true }] };
        if (/SELECT nextval/i.test(q)) return { rows: [{ n: 100001 }] };
        return { rows: [] };
      });
      const { genReceiptNo: gen } = fresh();
      await gen(); await gen(); await gen();
      expect(sql.filter((q) => /to_regclass/i.test(q))).toHaveLength(1);
    });
  });
});
