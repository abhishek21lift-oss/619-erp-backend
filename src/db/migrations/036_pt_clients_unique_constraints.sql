-- Migration 036: add UNIQUE constraints on pt_clients mobile and email
-- The pt_clients table was missing these constraints (present on clients table).
-- Use partial index for email to allow NULL.

ALTER TABLE pt_clients
  ADD CONSTRAINT pt_clients_mobile_unique UNIQUE (mobile);

CREATE UNIQUE INDEX pt_clients_email_unique
  ON pt_clients (email)
  WHERE email IS NOT NULL;
