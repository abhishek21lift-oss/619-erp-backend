// Migration 293 is the storage half of the WhatsApp inbox: one thread table
// serves both channels, provider ids are unique per studio so at-least-once
// delivery cannot duplicate a bubble, and a message from a number the studio
// cannot resolve is retained rather than dropped.
//
// These assertions read the SQL rather than a live database, so they run
// without DATABASE_URL. The RLS shape is checked here as text because the
// real privilege check (`verify:rls`) needs a database and skips in CI.
const fs = require('fs');
const path = require('path');
const sql = fs.readFileSync(
  path.join(__dirname, '..', 'db', 'migrations', '293_whatsapp_inbox.sql'), 'utf8');
const body = sql.replace(/--[^\n]*/g, ' ');

it('adds the channel columns with safe defaults for existing rows', () => {
  expect(body).toMatch(/channel\s+TEXT\s+NOT NULL\s+DEFAULT\s+'in_app'/i);
  expect(body).toMatch(/message_type\s+TEXT\s+NOT NULL\s+DEFAULT\s+'text'/i);
  expect(body).toMatch(/external_id\s+TEXT/i);
  expect(body).toMatch(/delivery_status\s+TEXT/i);
  expect(body).toMatch(/delivered_at\s+TIMESTAMPTZ/i);
  expect(body).toMatch(/provider_read_at\s+TIMESTAMPTZ/i);
  expect(body).toMatch(/failure_reason\s+TEXT/i);
});

it('pins the allowed channel, message type and delivery status', () => {
  expect(body).toMatch(/channel\s+IN\s*\('in_app','whatsapp'\)/i);
  expect(body).toMatch(/message_type\s+IN\s*\('text','image','video','audio','document','sticker','location','contact','other'\)/i);
  expect(body).toMatch(/delivery_status\s+IS\s+NULL\s+OR\s+delivery_status\s+IN\s*\('queued','sent','delivered','read','failed'\)/i);
});

it('makes a provider id unique per studio only when present', () => {
  expect(body).toMatch(
    /CREATE UNIQUE INDEX IF NOT EXISTS client_messages_external_idx[\s\S]*?\(organization_id, external_id\)[\s\S]*?WHERE external_id IS NOT NULL/i);
});

it('retains unmatched messages with a reason and no client guess', () => {
  expect(body).toMatch(/CREATE TABLE IF NOT EXISTS public\.whatsapp_unmatched_messages/i);
  expect(body).toMatch(/provider_message_id\s+TEXT\s+NOT NULL/i);
  expect(body).toMatch(/from_phone\s+TEXT\s+NOT NULL/i);
  expect(body).toMatch(/reason\s+TEXT\s+NOT NULL\s+CHECK\s*\(reason IN \('unknown_phone','ambiguous_phone'\)\)/i);
  expect(body).toMatch(/UNIQUE\s*\(organization_id, provider_message_id\)/i);
});

it('gives the unmatched table both RLS halves', () => {
  expect(body).toMatch(/ALTER TABLE public\.whatsapp_unmatched_messages ENABLE ROW LEVEL SECURITY/i);
  expect(body).toMatch(/CREATE POLICY deny_all_direct_access ON public\.whatsapp_unmatched_messages/i);
  expect(body).toMatch(/CREATE POLICY tenant_isolation ON public\.whatsapp_unmatched_messages FOR ALL TO app_tenant/i);
  expect(body).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON public\.whatsapp_unmatched_messages TO app_tenant/i);
});

it('raises if the unmatched table would be unwritable', () => {
  expect(body).toMatch(/RAISE EXCEPTION '293: tenant_isolation policy for app_tenant is missing/i);
  expect(body).toMatch(/RAISE EXCEPTION '293: app_tenant cannot INSERT/i);
});
