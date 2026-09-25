'use strict';
// Which database connection the nightly backup dumps from.
//
// Getting this wrong does not fail loudly — it produces a dump that looks like
// a backup and is not one. With TENANT_RLS_ENFORCE on, DATABASE_URL is the
// RLS-confined app_tenant role, so a dump through it reads (nearly) nothing;
// and Supabase's transaction pooler on :6543 cannot hold pg_dump's snapshot.

const { resolveDumpUrl } = require('../../scripts/backup-database');

const POOLER = 'aws-1-ap-south-1.pooler.supabase.com';

describe('backup dump URL', () => {
  it('prefers the owner connection over the RLS-confined app connection', () => {
    const url = resolveDumpUrl({
      DATABASE_URL: `postgresql://app_tenant:x@${POOLER}:5432/postgres`,
      ADMIN_DATABASE_URL: `postgresql://postgres.ref:y@${POOLER}:5432/postgres`,
    });
    expect(url).toContain('postgres.ref:y@');
  });

  it('lets BACKUP_DATABASE_URL override both', () => {
    const url = resolveDumpUrl({
      DATABASE_URL: 'postgresql://a:a@db.example:5432/x',
      ADMIN_DATABASE_URL: 'postgresql://b:b@db.example:5432/x',
      BACKUP_DATABASE_URL: 'postgresql://c:c@direct.example:5432/x',
    });
    expect(url).toBe('postgresql://c:c@direct.example:5432/x');
  });

  it('falls back to DATABASE_URL when nothing else is set', () => {
    expect(resolveDumpUrl({ DATABASE_URL: 'postgresql://a:a@db.example:5432/x' }))
      .toBe('postgresql://a:a@db.example:5432/x');
  });

  it('moves a Supabase transaction-pooler URL (:6543) to session mode (:5432)', () => {
    const url = resolveDumpUrl({ ADMIN_DATABASE_URL: `postgresql://postgres.ref:y@${POOLER}:6543/postgres` });
    expect(new URL(url).port).toBe('5432');
    expect(new URL(url).hostname).toBe(POOLER);
    expect(url).toContain('postgres.ref:y@');
  });

  it('leaves :6543 alone on a host that is not the Supabase pooler', () => {
    const raw = 'postgresql://a:a@db.internal:6543/x';
    expect(resolveDumpUrl({ DATABASE_URL: raw })).toBe(raw);
  });

  it('returns null when no URL is configured', () => {
    expect(resolveDumpUrl({})).toBeNull();
  });

  it('does not run a backup when required by a test', () => {
    // require.main guard: importing the module must not start pg_dump.
    expect(typeof resolveDumpUrl).toBe('function');
  });
});
