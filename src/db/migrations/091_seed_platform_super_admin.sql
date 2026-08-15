-- 091_seed_platform_super_admin.sql
-- Seeds the platform Super Admin — the org-less account (organization_id NULL,
-- role 'super_admin') that manages all tenants via the hidden /platform portal.
-- Idempotent: does nothing if a super_admin (or this email) already exists.
--
-- ── The password below is a LOCKED PLACEHOLDER, not a credential ────────
--
-- This file used to carry a real bcrypt hash for a live account. Its header
-- reasoned that "the plaintext was delivered out-of-band and is not in git",
-- which is true and is not the point: a bcrypt hash is not a public value.
-- It is an offline-crackable copy of the credential, and this repository has
-- been public, so publishing it here published the account. Migration 131
-- then repeated the pattern with the hash that was still live in production.
--
-- The hash is replaced with a syntactically valid bcrypt string whose salt
-- and digest are '.' padding. No input produces it, so bcrypt.compare()
-- returns false for every password: the row exists and cannot be signed into
-- until an operator sets one out of band with
--
--   node scripts/rotate-super-admin-password.js
--
-- That is the better posture regardless — a fresh database no longer comes
-- up carrying a known-good platform credential — and
-- src/__tests__/noCommittedSecrets.test.js fails the build if a real hash is
-- committed here again.
--
-- Redacting this file does NOT un-publish the old hashes: they remain in the
-- history of a repository that was public, so they must be assumed captured.
-- Rotation is what removes their value. See
-- docs/SECURITY-INCIDENT-superadmin-credential.md.

INSERT INTO public.users (id, name, email, password, role, is_active, token_version, organization_id)
SELECT
  'usr-superadmin-001',
  'Platform Super Admin',
  'superadmin@619studio.com',
  '$2a$12$.....................................................',
  'super_admin',
  true,
  0,
  NULL
WHERE NOT EXISTS (
  SELECT 1 FROM public.users
   WHERE email = 'superadmin@619studio.com' OR role = 'super_admin'
);
