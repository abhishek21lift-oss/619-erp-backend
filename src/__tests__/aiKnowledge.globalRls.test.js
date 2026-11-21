'use strict';
// 286_ai_knowledge_global_rls.sql — the approved GLOBAL corpus must stay
// readable by a tenant connection after the app_tenant cutover, without
// becoming writable by it.
//
// 157 gave ai_documents and ai_document_chunks a column-only tenant policy.
// 173 then stored global documents as organization_id IS NULL, is_global TRUE,
// and dropped NOT NULL on both tables. The policy was never widened, so under
// app_tenant RLS hides the global rows before retrieval's own `is_global = TRUE
// OR ...` predicate can see them. The generators then answer 422
// INSUFFICIENT_EVIDENCE even though the corpus is approved and ready.
//
// This suite pins both halves:
//
//   * the SQL splits the old FOR ALL policy into SELECT (own org OR global)
//     and org-scoped writes, and authorizes chunks through their parent;
//   * a real PostgreSQL, connected as `app_tenant`, sees the global document
//     and its own studio's rows, cannot see another studio's, cannot adopt or
//     delete a global document, and cannot attach a chunk to one.
//
// The real-database half is skipped without RLS_TEST_DATABASE_URL, matching
// ai.retrievalLog.appendOnly.test.js. It creates its own organizations and
// removes only its own rows.

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { Pool } = require('pg');

const MIGRATION = path.join(
  __dirname, '..', 'db', 'migrations', '286_ai_knowledge_global_rls.sql',
);
const sql = fs.readFileSync(MIGRATION, 'utf8');
const body = sql.replace(/--[^\n]*/g, ' ');

describe('286_ai_knowledge_global_rls.sql', () => {
  it('is read, so nothing below can pass vacuously', () => {
    expect(sql.length).toBeGreaterThan(1000);
  });

  it('drops the old tenant_isolation policy on both tables', () => {
    expect(body).toMatch(/DROP POLICY IF EXISTS tenant_isolation ON public\.ai_documents/i);
    expect(body).toMatch(/DROP POLICY IF EXISTS tenant_isolation ON public\.ai_document_chunks/i);
  });

  it('gives SELECT a global branch and keeps it fail-closed without app.org_id', () => {
    const select = body.match(
      /CREATE POLICY ai_documents_tenant_select[\s\S]*?;/i,
    )?.[0] || '';
    expect(select).toMatch(/FOR SELECT TO app_tenant/i);
    expect(select).toMatch(/is_global = TRUE/i);
    expect(select).toMatch(/NULLIF\(current_setting\('app\.org_id', true\), ''\) IS NOT NULL/i);
  });

  it('never lets a tenant write a global or another studio\'s document', () => {
    for (const cmd of ['insert', 'update', 'delete']) {
      const policy = body.match(
        new RegExp(`CREATE POLICY ai_documents_tenant_${cmd}[\\s\\S]*?;`, 'i'),
      )?.[0] || '';
      expect(policy).toMatch(new RegExp(`FOR ${cmd.toUpperCase()} TO app_tenant`, 'i'));
      expect(policy).toMatch(/is_global = FALSE/i);
      expect(policy).toMatch(/organization_id::text = current_setting\('app\.org_id', true\)/i);
    }

    const update = body.match(/CREATE POLICY ai_documents_tenant_update[\s\S]*?;/i)?.[0] || '';
    expect(update).toMatch(/WITH CHECK/i);
  });

  it('authorizes chunks through their parent document', () => {
    for (const cmd of ['select', 'insert', 'update', 'delete']) {
      const policy = body.match(
        new RegExp(`CREATE POLICY ai_document_chunks_tenant_${cmd}[\\s\\S]*?;`, 'i'),
      )?.[0] || '';
      expect(policy).toMatch(/EXISTS\s*\(\s*SELECT 1/i);
      expect(policy).toMatch(/FROM public\.ai_documents d/i);
      expect(policy).toMatch(/d\.id = ai_document_chunks\.document_id/i);
    }

    const insert = body.match(/CREATE POLICY ai_document_chunks_tenant_insert[\s\S]*?;/i)?.[0] || '';
    expect(insert).toMatch(/d\.organization_id::text = current_setting\('app\.org_id', true\)/i);
    expect(insert).toMatch(/d\.is_global = FALSE/i);
  });

  it('does not keep a FOR ALL tenant policy on either table', () => {
    expect(body).not.toMatch(/FOR ALL TO app_tenant/i);
  });

  it('is idempotent — every policy it creates is dropped first', () => {
    const created = [...body.matchAll(/CREATE POLICY ([a-z0-9_]+)/gi)].map((m) => m[1]);
    expect(created.length).toBe(8);
    for (const name of created) {
      expect(body).toMatch(new RegExp(`DROP POLICY IF EXISTS ${name}`, 'i'));
    }
    expect(new Set(created).size).toBe(created.length);
  });

  it('grants the four DML privileges explicitly and widens nothing else', () => {
    expect(body).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON public\.ai_documents TO app_tenant/i);
    expect(body).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON public\.ai_document_chunks TO app_tenant/i);
    expect(body).not.toMatch(/GRANT ALL/i);
    expect(body).not.toMatch(/GRANT[^;]*\bTO\s+(?:anon|authenticated|PUBLIC)\b/i);
  });

  it('changes policies only — no data, schema or transaction control', () => {
    expect(body).not.toMatch(/DELETE\s+FROM/i);
    expect(body).not.toMatch(/UPDATE\s+public\.ai_documents/i);
    expect(body).not.toMatch(/TRUNCATE/i);
    expect(body).not.toMatch(/DROP\s+TABLE/i);
    expect(body).not.toMatch(/\bBEGIN\b/i);
    expect(body).not.toMatch(/\bCOMMIT\b/i);
    expect(body).not.toMatch(/\bROLLBACK\b/i);
  });
});

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('286 global-corpus proof', () => {
    it('has a database to run against', () => {
      throw new Error(
        'RLS_TEST_DATABASE_URL is not set in CI, so the 286 global-corpus proof '
        + 'would silently skip. Restore the "Stand up the RLS isolation database" '
        + 'step and the env var in .github/workflows/ci.yml.',
      );
    });
  });
}

// Distinct from the fixtures owned by the other RLS suites.
const ORG_A = 'a7a7a7a7-a7a7-4a7a-8a7a-a7a7a7a7a7a7';
const ORG_B = 'b8b8b8b8-b8b8-4b8b-8b8b-b8b8b8b8b8b8';
const DOC_GLOBAL = 'c9c9c9c9-c9c9-4c9c-9c9c-c9c9c9c9c9c9';
const DOC_A = 'd1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1';
const DOC_B = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2';
const CHUNK_GLOBAL = 'f3f3f3f3-f3f3-4f3f-8f3f-f3f3f3f3f3f3';
const CHUNK_A = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a4a4';
const CHUNK_B = 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b5b5';

const TENANT_URL = DB_URL
  ? (() => {
      const url = new URL(DB_URL);
      url.username = 'app_tenant';
      url.password = process.env.RLS_TEST_TENANT_PASSWORD || 'localproof';
      return url.toString();
    })()
  : null;

const EMBEDDING = `[${new Array(384).fill('0.1').join(',')}]`;
const MODEL = 'Xenova/all-MiniLM-L6-v2';

jest.setTimeout(30000);

describeIf('286 global-corpus proof, against a real database', () => {
  let owner;
  let tenant;

  const asOrg = async (orgId, fn) => {
    const client = await tenant.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1,$2,true)', ['app.org_id', orgId]);
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  };

  const insertDocument = (client, { id, orgId, isGlobal, title, key }) => client.query(
    `INSERT INTO ai_documents
       (id, organization_id, is_global, title, category, filename, file_key,
        mime_type, file_size_bytes, status, chunk_count, approval_status,
        source_version, content_hash, approved_at)
     VALUES ($1,$2,$3,$4,'sop',$5,$6,'text/plain',10,'ready',1,'approved','v1',$7,now())`,
    [id, orgId, isGlobal, title, `${key}.txt`, `knowledge/${key}.txt`, `hash-${key}`],
  );

  const insertChunk = (client, { id, documentId, orgId, content }) => client.query(
    `INSERT INTO ai_document_chunks
       (id, document_id, organization_id, chunk_index, content, embedding, token_count, embedding_model)
     VALUES ($1,$2,$3,0,$4,$5::vector,3,$6)`,
    [id, documentId, orgId, content, EMBEDDING, MODEL],
  );

  beforeAll(async () => {
    owner = new Pool({ connectionString: DB_URL, max: 2 });
    tenant = new Pool({ connectionString: TENANT_URL, max: 2 });

    // Start from a clean slate for this suite's own rows only.
    await owner.query('DELETE FROM ai_documents WHERE id = ANY($1::uuid[])',
      [[DOC_GLOBAL, DOC_A, DOC_B]]);
    await owner.query('DELETE FROM organizations WHERE id IN ($1,$2)', [ORG_A, ORG_B]);

    await owner.query(
      `INSERT INTO organizations (id, name, slug)
       VALUES ($1,'286 Global RLS A','286-global-rls-a'),
              ($2,'286 Global RLS B','286-global-rls-b')`,
      [ORG_A, ORG_B],
    );

    await insertDocument(owner, {
      id: DOC_GLOBAL, orgId: null, isGlobal: true, title: 'Global SOP', key: '286-global',
    });
    await insertDocument(owner, {
      id: DOC_A, orgId: ORG_A, isGlobal: false, title: 'Studio A SOP', key: '286-a',
    });
    await insertDocument(owner, {
      id: DOC_B, orgId: ORG_B, isGlobal: false, title: 'Studio B SOP', key: '286-b',
    });

    await insertChunk(owner, {
      id: CHUNK_GLOBAL, documentId: DOC_GLOBAL, orgId: null, content: 'Global content',
    });
    await insertChunk(owner, {
      id: CHUNK_A, documentId: DOC_A, orgId: ORG_A, content: 'Studio A content',
    });
    await insertChunk(owner, {
      id: CHUNK_B, documentId: DOC_B, orgId: ORG_B, content: 'Studio B content',
    });
  });

  afterAll(async () => {
    await owner.query('DELETE FROM ai_documents WHERE id = ANY($1::uuid[])',
      [[DOC_GLOBAL, DOC_A, DOC_B]]);
    await owner.query('DELETE FROM organizations WHERE id IN ($1,$2)', [ORG_A, ORG_B]);
    await owner?.end();
    await tenant?.end();
  });

  it('a tenant reads its own documents and the approved global document', async () => {
    const { rows } = await asOrg(ORG_A, (c) =>
      c.query('SELECT id FROM ai_documents ORDER BY id'));
    const ids = rows.map((r) => r.id);

    expect(ids).toContain(DOC_A);
    expect(ids).toContain(DOC_GLOBAL);
    expect(ids).not.toContain(DOC_B);
  });

  it('a tenant reads its own chunks and the global document\'s chunks', async () => {
    const { rows } = await asOrg(ORG_A, (c) =>
      c.query('SELECT id FROM ai_document_chunks ORDER BY id'));
    const ids = rows.map((r) => r.id);

    expect(ids).toContain(CHUNK_A);
    expect(ids).toContain(CHUNK_GLOBAL);
    expect(ids).not.toContain(CHUNK_B);
  });

  it('refuses a document insert for another studio', async () => {
    await expect(asOrg(ORG_A, (c) => insertDocument(c, {
      id: randomUUID(), orgId: ORG_B, isGlobal: false, title: 'Smuggled', key: '286-smuggled',
    }))).rejects.toThrow(/row-level security/i);
  });

  it('refuses a global document insert from a tenant connection', async () => {
    await expect(asOrg(ORG_A, (c) => insertDocument(c, {
      id: randomUUID(), orgId: null, isGlobal: true, title: 'Fake global', key: '286-fake-global',
    }))).rejects.toThrow(/row-level security/i);
  });

  it('cannot adopt a global document by rewriting its organization', async () => {
    const updated = await asOrg(ORG_A, (c) => c.query(
      'UPDATE ai_documents SET organization_id = $1, is_global = FALSE WHERE id = $2',
      [ORG_A, DOC_GLOBAL],
    ));
    expect(updated.rowCount).toBe(0);

    const { rows } = await owner.query(
      'SELECT organization_id, is_global FROM ai_documents WHERE id = $1', [DOC_GLOBAL],
    );
    expect(rows[0]).toEqual({ organization_id: null, is_global: true });
  });

  it('cannot delete a global document', async () => {
    const deleted = await asOrg(ORG_A, (c) => c.query(
      'DELETE FROM ai_documents WHERE id = $1', [DOC_GLOBAL],
    ));
    expect(deleted.rowCount).toBe(0);

    const { rows } = await owner.query(
      'SELECT count(*)::int AS n FROM ai_documents WHERE id = $1', [DOC_GLOBAL],
    );
    expect(rows[0].n).toBe(1);
  });

  it('cannot attach a chunk to a global document', async () => {
    await expect(asOrg(ORG_A, (c) => insertChunk(c, {
      id: randomUUID(), documentId: DOC_GLOBAL, orgId: ORG_A, content: 'Poisoned global content',
    }))).rejects.toThrow(/row-level security/i);
  });

  it('cannot attach a chunk to another studio\'s document', async () => {
    await expect(asOrg(ORG_A, (c) => insertChunk(c, {
      id: randomUUID(), documentId: DOC_B, orgId: ORG_A, content: 'Poisoned studio B content',
    }))).rejects.toThrow(/row-level security/i);
  });

  it('can create, update and delete its own document and chunk', async () => {
    const docId = randomUUID();
    const chunkId = randomUUID();

    await asOrg(ORG_A, (c) => insertDocument(c, {
      id: docId, orgId: ORG_A, isGlobal: false, title: 'Studio A draft', key: '286-a-draft',
    }));
    await asOrg(ORG_A, (c) => insertChunk(c, {
      id: chunkId, documentId: docId, orgId: ORG_A, content: 'Studio A draft content',
    }));

    const updated = await asOrg(ORG_A, (c) => c.query(
      'UPDATE ai_documents SET title = $2 WHERE id = $1', [docId, 'Studio A updated'],
    ));
    expect(updated.rowCount).toBe(1);

    const chunkDeleted = await asOrg(ORG_A, (c) => c.query(
      'DELETE FROM ai_document_chunks WHERE id = $1', [chunkId],
    ));
    expect(chunkDeleted.rowCount).toBe(1);

    const docDeleted = await asOrg(ORG_A, (c) => c.query(
      'DELETE FROM ai_documents WHERE id = $1', [docId],
    ));
    expect(docDeleted.rowCount).toBe(1);
  });

  it('sees nothing, including the global corpus, when no organization is set', async () => {
    const client = await tenant.connect();
    try {
      const docs = await client.query('SELECT count(*)::int AS n FROM ai_documents');
      expect(docs.rows[0].n).toBe(0);

      const chunks = await client.query('SELECT count(*)::int AS n FROM ai_document_chunks');
      expect(chunks.rows[0].n).toBe(0);

      await expect(insertDocument(client, {
        id: randomUUID(), orgId: ORG_A, isGlobal: false, title: 'No org', key: '286-no-org',
      })).rejects.toThrow(/row-level security/i);
    } finally {
      client.release();
    }
  });
});
