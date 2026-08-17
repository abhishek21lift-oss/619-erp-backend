'use strict';
// RLS Policy Verification Test
// Verifies that migration 157 defines correct RLS policies for all tenant tables.
// This is a static analysis test - no database connection required.

const fs = require('fs');
const path = require('path');

const MIGRATION_157 = path.join(__dirname, '..', 'db', 'migrations', '157_app_tenant_role_and_rls.sql');
const SCHEMA_FILE = path.join(__dirname, '..', 'db', 'schema.sql');

describe('RLS Policy Verification - Migration 157', () => {
  let migration157;
  let schemaSql;

  beforeAll(() => {
    migration157 = fs.readFileSync(MIGRATION_157, 'utf8');
    schemaSql = fs.readFileSync(SCHEMA_FILE, 'utf8');
  });

  it('creates app_tenant role with NOBYPASSRLS', () => {
    expect(migration157).toMatch(/CREATE ROLE app_tenant WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS/);
  });

  it('grants privileges to app_tenant on schema public', () => {
    expect(migration157).toMatch(/GRANT USAGE ON SCHEMA public TO app_tenant/);
    expect(migration157).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_tenant/);
  });

  it('defines SHARED_TABLES array with correct tables', () => {
    const sharedTablesMatch = migration157.match(/shared_tables text\[\] := ARRAY\[([\s\S]*?)\];/);
    expect(sharedTablesMatch).toBeTruthy();
    
    const sharedTables = sharedTablesMatch[1];
    // Core shared tables
    expect(sharedTables).toContain('exercises');
    expect(sharedTables).toContain('diet_templates');
    expect(sharedTables).toContain('muscle_volume_landmarks');
    expect(sharedTables).toContain('login_events');
    expect(sharedTables).toContain('users');
    expect(sharedTables).toContain('workout_plans');
    expect(sharedTables).toContain('storage_objects');
    expect(sharedTables).toContain('user_webauthn_credentials');
  });

  it('creates strict RLS policies for tenant tables (no NULL org allowed)', () => {
    // The strict policy should NOT have "OR organization_id IS NULL"
    const strictPolicyMatch = migration157.match(
      /USING \(organization_id::text = current_setting\(''app\.org_id'', true\)\)/
    );
    expect(strictPolicyMatch).toBeTruthy();
  });

  it('creates shared RLS policies for shared tables (allows NULL org)', () => {
    // The shared policy should have "OR organization_id IS NULL"
    const sharedPolicyMatch = migration157.match(
      /USING \(organization_id::text = current_setting\(''app\.org_id'', true\) OR organization_id IS NULL\)/
    );
    expect(sharedPolicyMatch).toBeTruthy();
  });

  it('grants policies ONLY to app_tenant role (not public/anon/authenticated)', () => {
    expect(migration157).toMatch(/FOR ALL TO app_tenant/);
    // Should NOT grant to public
    expect(migration157).not.toMatch(/FOR ALL TO public/);
    expect(migration157).not.toMatch(/FOR ALL TO anon/);
    expect(migration157).not.toMatch(/FOR ALL TO authenticated/);
  });

  it('enables RLS on all tables with organization_id', () => {
    expect(migration157).toMatch(/ALTER TABLE public\.%I ENABLE ROW LEVEL SECURITY/);
  });

  it('drops existing tenant_isolation policies before creating new ones', () => {
    expect(migration157).toMatch(/DROP POLICY IF EXISTS tenant_isolation ON public\.%I/);
  });
});

describe('Schema Verification - Tenant Tables Have organization_id', () => {
  // Migration files that ADD organization_id column with FK to tenant tables
  const migrationFilesWithFk = [
    '079_pt_clients_organization_id.sql',
    '143_pt_trainers_organization_id.sql',
    '156_mobility_posture_organization_id.sql',
  ];

  it('migration files exist that add organization_id to tenant tables', () => {
    const migrationFiles = [
      '079_pt_clients_organization_id.sql',
      '143_pt_trainers_organization_id.sql',
      '156_mobility_posture_organization_id.sql',
      '155_organization_id_not_null.sql',
      '160_organization_id_not_null_round_two.sql',
      '171_backfill_pt_trainers_assessments_org.sql',
    ];
    for (const file of migrationFiles) {
      const filePath = path.join(__dirname, '..', 'db', 'migrations', file);
      expect(fs.existsSync(filePath)).toBe(true);
    }
  });

  it('migrations that ADD organization_id column include FK to organizations', () => {
    const migrationFilesWithFk = [
      '079_pt_clients_organization_id.sql',
      '143_pt_trainers_organization_id.sql',
      '156_mobility_posture_organization_id.sql',
    ];
    for (const file of migrationFilesWithFk) {
      const filePath = path.join(__dirname, '..', 'db', 'migrations', file);
      const content = fs.readFileSync(filePath, 'utf8');
      // Check for ADD COLUMN organization_id or ALTER COLUMN organization_id
      expect(content).toMatch(/organization_id/);
      // Check for FK reference to organizations
      expect(content).toMatch(/REFERENCES organizations\(id\)/);
    }
  });

  it('migration 155 tightens organization_id to NOT NULL where safe', () => {
    const content = fs.readFileSync(
      path.join(__dirname, '..', 'db', 'migrations', '155_organization_id_not_null.sql'),
      'utf8'
    );
    expect(content).toMatch(/ALTER TABLE.*ALTER COLUMN organization_id SET NOT NULL/);
  });

  it('migration 160 handles remaining tables with organization_id', () => {
    const content = fs.readFileSync(
      path.join(__dirname, '..', 'db', 'migrations', '160_organization_id_not_null_round_two.sql'),
      'utf8'
    );
    expect(content).toMatch(/pt_trainers/);
    expect(content).toMatch(/pt_posture_assessments/);
    expect(content).toMatch(/pt_mobility_performance_assessments/);
    expect(content).toMatch(/ALTER TABLE.*ALTER COLUMN organization_id SET NOT NULL/);
  });

  it('migration 171 backfills remaining NULL organization_id for assessments', () => {
    const content = fs.readFileSync(
      path.join(__dirname, '..', 'db', 'migrations', '171_backfill_pt_trainers_assessments_org.sql'),
      'utf8'
    );
    expect(content).toMatch(/pt_trainers/);
    expect(content).toMatch(/pt_posture_assessments/);
    expect(content).toMatch(/pt_mobility_performance_assessments/);
  });
});

describe('Shared Tables Have Correct RLS Policy Shape', () => {
  let migration157;

  beforeAll(() => {
    migration157 = fs.readFileSync(MIGRATION_157, 'utf8');
  });

  const sharedTables = [
    'exercises',
    'diet_templates',
    'muscle_volume_landmarks',
    'login_events',
    'users',
    'workout_plans',
    'storage_objects',
    'user_webauthn_credentials',
  ];

  it('shared tables are listed in SHARED_TABLES array', () => {
    for (const table of sharedTables) {
      expect(migration157).toContain(table);
    }
  });

  it('shared tables get permissive policy (OR organization_id IS NULL)', () => {
    const sharedPolicyBlock = migration157.slice(
      migration157.indexOf('IF tbl = ANY(shared_tables) THEN'),
      migration157.indexOf('ELSE')
    );
    expect(sharedPolicyBlock).toMatch(/OR organization_id IS NULL/);
  });
});

describe('Application Tenant Role Uses app_tenant Connection', () => {
  let poolJs;

  beforeAll(() => {
    poolJs = fs.readFileSync(path.join(__dirname, '..', 'db', 'pool.js'), 'utf8');
  });

  it('TENANT_RLS_ENFORCE defaults to ON', () => {
    expect(poolJs).toMatch(/TENANT_RLS_ENFORCE !== 'off'/);
  });

  it('pool.js routes platform-wide work to owner connection', () => {
    expect(poolJs).toContain('useOwnerConnection()');
  });

  it('pool.js uses app_tenant connection for tenant requests', () => {
    expect(poolJs).toContain('withOrgScope');
  });

  it('pool.js does NOT set app.org_id for platform-wide work', () => {
    // Platform-wide work uses ownerPool connection, not scoped connection
    expect(poolJs).toContain('useOwnerConnection()');
    expect(poolJs).toContain('ownerPool');
    expect(poolJs).toContain('isPlatformWide()');
  });
});

describe('RLS Cutover Validation', () => {
  let serverJs;

  beforeAll(() => {
    serverJs = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  });

  it('server.js validates ADMIN_DATABASE_URL differs from DATABASE_URL when RLS enforced', () => {
    expect(serverJs).toMatch(/const adminUrl = process\.env\.ADMIN_DATABASE_URL \|\| process\.env\.DATABASE_URL;/);
    expect(serverJs).toMatch(/adminUrl === process\.env\.DATABASE_URL/);
    expect(serverJs).toMatch(/TENANT_RLS_ENFORCE/);
  });
});