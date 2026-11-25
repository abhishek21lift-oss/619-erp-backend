'use strict';

// 291_ai_ops_queue.sql — the queue and its append-only audit.
//
// The static half pins the choices that are cheap to get wrong and expensive
// to discover in production: TEXT subject ids (pt_clients/pt_leads are TEXT),
// exactly one subject per item, and an audit that the tenant role cannot
// rewrite or erase.

const fs = require('fs');
const path = require('path');

const MIGRATION = path.join(__dirname, '..', 'db', 'migrations', '291_ai_ops_queue.sql');
const sql = fs.readFileSync(MIGRATION, 'utf8');
const body = sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ');

describe('291_ai_ops_queue.sql', () => {
  it('is read, so nothing below can pass vacuously', () => {
    expect(sql.length).toBeGreaterThan(2000);
  });

  it('creates the item and event tables', () => {
    expect(body).toMatch(/CREATE TABLE IF NOT EXISTS ai_ops_items/);
    expect(body).toMatch(/CREATE TABLE IF NOT EXISTS ai_ops_events/);
  });

  it('uses TEXT for the client and lead ids, never UUID', () => {
    expect(body).toMatch(/client_id TEXT REFERENCES pt_clients\(id\) ON DELETE CASCADE/);
    expect(body).toMatch(/lead_id TEXT REFERENCES pt_leads\(id\) ON DELETE CASCADE/);
    expect(body).not.toMatch(/client_id UUID/);
    expect(body).not.toMatch(/lead_id UUID/);
  });

  it('allows exactly one subject per row and one row per subject per org', () => {
    expect(body).toMatch(/CHECK \(num_nonnulls\(client_id, lead_id\) = 1\)/);
    expect(body).toMatch(/UNIQUE \(organization_id, dedupe_key\)/);
  });

  it('limits the item status to the five lifecycle states', () => {
    expect(body).toMatch(
      /status TEXT NOT NULL DEFAULT 'open' CHECK \(status IN \('open','snoozed','actioned','dismissed','resolved'\)\)/,
    );
  });

  it('limits event types to the audited transitions', () => {
    for (const type of [
      'created', 'reasons_updated', 'brief_generated', 'draft_generated',
      'approved', 'edited', 'sent', 'send_failed',
      'snoozed', 'dismissed', 'resolved', 'reopened',
    ]) {
      expect(body).toContain(`'${type}'`);
    }
  });

  it('makes the audit append-only for the tenant role', () => {
    const events = body.slice(body.indexOf('ALTER TABLE ai_ops_events'));
    expect(events).toMatch(/REVOKE ALL ON ai_ops_events FROM app_tenant/);
    expect(events).toMatch(/GRANT SELECT, INSERT ON ai_ops_events TO app_tenant/);
    expect(events).not.toMatch(/GRANT[^;]*UPDATE[^;]*ai_ops_events/i);
    expect(events).not.toMatch(/GRANT[^;]*DELETE[^;]*ai_ops_events/i);
    expect(events).toMatch(/CREATE POLICY ai_ops_events_tenant_select[\s\S]*?FOR SELECT TO app_tenant/);
    expect(events).toMatch(/CREATE POLICY ai_ops_events_tenant_insert[\s\S]*?FOR INSERT TO app_tenant/);
    expect(events).not.toMatch(/FOR ALL TO app_tenant/);
  });

  it('scopes the item table to the request organization', () => {
    expect(body).toMatch(/CREATE POLICY tenant_isolation ON ai_ops_items FOR ALL TO app_tenant/);
    expect(body).toMatch(/current_setting\('app\.org_id', true\)/);
    expect(body).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON ai_ops_items TO app_tenant/);
  });

  it('keeps deny-all policies for the direct-access roles', () => {
    expect(body.match(/CREATE POLICY deny_all_direct_access/g)).toHaveLength(2);
    expect(body).not.toMatch(/TO\s+(public|anon|authenticated)\b/);
  });

  it('has no transaction control — migrate.js owns the transaction', () => {
    expect(body).not.toMatch(/\bBEGIN\b/i);
    expect(body).not.toMatch(/\bCOMMIT\b/i);
    expect(body).not.toMatch(/\bROLLBACK\b/i);
  });

  it('does not seed a feature key — the queue reuses ai_suite', () => {
    expect(body).not.toMatch(/platform_features/i);
    expect(body).not.toMatch(/ai_ops_queue/);
  });
});
