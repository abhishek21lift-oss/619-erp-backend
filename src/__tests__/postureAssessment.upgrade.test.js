// The postural assessment upgrade added structured observations, photographs,
// a corrective plan and a draft lifecycle to a table that already held real
// records. CI has no live database, so this guards the two things that would
// lose those records or leak another tenant's: the migration stays additive,
// and the new read/write paths stay tenant-scoped and photo-validated.

const fs = require('fs');
const path = require('path');

const MIGRATION = path.join(__dirname, '..', 'db', 'migrations', '268_posture_assessment_upgrade.sql');
const ROUTES = path.join(__dirname, '..', 'modules', 'progress', 'progress.routes.js');

describe('migration 268 — postural assessment upgrade', () => {
  const sql = fs.readFileSync(MIGRATION, 'utf8');

  it.each([
    ['assessment_type', 'TEXT'],
    ['status', "TEXT NOT NULL DEFAULT 'completed'"],
    ['completed_at', 'TIMESTAMPTZ'],
    ['view_notes', 'JSONB'],
    ['front_photo_url', 'TEXT'],
    ['side_photo_url', 'TEXT'],
    ['back_photo_url', 'TEXT'],
    ['muscle_imbalances', 'JSONB'],
    ['corrective_plan', 'JSONB'],
    ['assessment_summary', 'JSONB'],
    ['resolved_findings', 'TEXT[]'],
  ])('adds %s as %s', (column, type) => {
    expect(sql).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS ${column} ${type.replace(/[[\]]/g, '\\$&')}`));
  });

  it('is additive — nothing renamed, dropped or deleted', () => {
    expect(sql).not.toMatch(/\bDROP\s+(COLUMN|TABLE)\b/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(sql).not.toMatch(/\bRENAME\s+TO\b/i);
    expect(sql).not.toMatch(/SET NOT NULL/i);
  });

  it('constrains the new lifecycle values', () => {
    expect(sql).toContain("status IN ('draft', 'completed')");
    expect(sql).toContain("'initial', 'follow_up', 're_assessment', 'progress'");
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_pt_posture_assessments_client_status');
  });

  it('backfills completed_at from a timestamp the row actually has', () => {
    const backfill = sql.slice(sql.indexOf('UPDATE pt_posture_assessments'));
    expect(backfill).toMatch(/COALESCE\(updated_at, created_at\)/);
    expect(backfill).not.toMatch(/NOW\(\)/);
    expect(backfill).toMatch(/WHERE status = 'completed' AND completed_at IS NULL/);
  });
});

describe('posture assessment routes', () => {
  const src = fs.readFileSync(ROUTES, 'utf8');

  const handler = (method, route) => {
    const start = src.indexOf(`router.${method}('${route}'`);
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('}));', start);
    return src.slice(start, end);
  };

  it('lists history without photo payloads but reports which views have one', () => {
    const columns = src.match(/const POSTURE_LIST_COLUMNS = `([\s\S]*?)`;/)[1];
    expect(columns).not.toMatch(/SELECT \*/);
    for (const view of ['front', 'side', 'back']) {
      expect(columns).toContain(`(${view}_photo_url IS NOT NULL) AS has_${view}_photo`);
      expect(columns).not.toMatch(new RegExp(`^\\s*${view}_photo_url,`, 'm'));
    }
    const list = handler('get', '/posture-assessments');
    expect(list).toContain('POSTURE_LIST_COLUMNS');
    expect(list).toContain('tenantScope(req)');
    expect(list).toMatch(/organization_id = \$\$\{params\.length\}/);
  });

  it('reads one full record, photographs included, inside the caller\'s organization', () => {
    const body = handler('get', '/posture-assessments/:id');
    expect(body).toContain('SELECT *');
    expect(body).toContain('organization_id = $2');
    expect(body).toContain('tenantScope(req).orgId');
    expect(body).toContain('404');
  });

  it('validates each photo as a real image on save and edit', () => {
    expect(handler('post', '/posture-assessments')).toContain('posturePhoto(');
    expect(handler('patch', '/posture-assessments/:id')).toContain('posturePhoto(');
    expect(handler('post', '/posture-assessments')).toContain('INVALID_PHOTO');
    expect(handler('patch', '/posture-assessments/:id')).toContain('INVALID_PHOTO');
    // The helper rejects a fake data URL instead of storing whatever string
    // the client sent.
    const helper = src.slice(src.indexOf('function posturePhoto'), src.indexOf('function postureJson'));
    expect(helper).toContain('parseClientPhoto(value)');
  });

  it('writes the new structured fields and the draft/completed lifecycle', () => {
    const create = handler('post', '/posture-assessments');
    for (const column of [
      'view_notes', 'front_photo_url', 'side_photo_url', 'back_photo_url',
      'muscle_imbalances', 'corrective_plan', 'assessment_summary', 'resolved_findings',
    ]) {
      expect(create).toContain(column);
    }
    expect(create).toContain("status === 'completed' ? new Date() : null");
    expect(create).toContain("b.status || 'completed'");
  });

  it('completes a draft once and returns it to draft without losing the record', () => {
    const body = handler('patch', '/posture-assessments/:id');
    expect(body).toContain('completed_at = COALESCE(completed_at, NOW())');
    expect(body).toContain('completed_at = NULL');
    expect(body).toContain('if (!existing) return res.status(404)');
  });
});
