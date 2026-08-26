-- ============================================================================
-- one-trainer-checks.sql
--
-- The one-trainer invariant, as queries that RETURN ROWS.
--
-- Companion to one-trainer-dry-run.sql, which reports through RAISE NOTICE.
-- That is the right shape under psql and the wrong one in the Supabase SQL
-- editor, which returns result sets as JSON and drops notices — so pasting the
-- other file in there runs it and shows you nothing. This file is what to use
-- in the dashboard.
--
-- READ-ONLY. Every statement is a SELECT.
--
-- Use the OWNER connection. After the RLS cutover DATABASE_URL authenticates as
-- app_tenant, and a cross-studio query on that connection returns nothing —
-- silently, because RLS filters rather than errors — which reads as "every
-- studio is fine".
--
-- Run the sections one at a time; the editor shows one result set per query.
-- Section C is the gate on migration 184's index: every studio must read OK, or
-- 184 warns and skips the index rather than building it.
-- ============================================================================


-- ── A. Owner <-> trainer link, every studio ─────────────────────────────────
-- One row per (admin, active trainer) pair. `linked` NULL rather than false
-- means the admin has no trainer_id at all: NULL = anything is NULL.
SELECT o.name AS studio, u.id AS admin_id, u.email AS admin_email,
       u.trainer_id AS admin_trainer_id, t.id AS active_trainer_id,
       t.name AS active_trainer, (u.trainer_id = t.id) AS linked
  FROM organizations o
  LEFT JOIN users u ON u.organization_id=o.id AND u.role='admin' AND u.deleted_at IS NULL
  LEFT JOIN trainers t ON t.organization_id=o.id AND t.deleted_at IS NULL AND t.status='active'
 ORDER BY o.name, u.email, t.name;


-- ── B. WHY the owner link did or did not resolve ────────────────────────────
-- A reports whether; this reports why. The distinction matters: "no admin at
-- all" and "admin linked to a soft-deleted trainer" both show up as an empty
-- link in A and need completely different fixes.
SELECT o.name AS studio, u.email, u.trainer_id,
  CASE WHEN u.id IS NULL               THEN 'NO ACTIVE ADMIN USER'
       WHEN u.trainer_id IS NULL       THEN 'admin.trainer_id IS NULL'
       WHEN tt.id IS NULL              THEN 'admin.trainer_id points at a MISSING trainers row'
       WHEN tt.deleted_at IS NOT NULL  THEN 'linked trainer is SOFT-DELETED'
       WHEN tt.status <> 'active'      THEN 'linked trainer status=' || tt.status
       WHEN tt.organization_id <> o.id THEN 'linked trainer belongs to ANOTHER org'
       ELSE 'link is valid' END AS why
  FROM organizations o
  LEFT JOIN users u ON u.organization_id=o.id AND u.role='admin' AND u.deleted_at IS NULL
  LEFT JOIN trainers tt ON tt.id = u.trainer_id
 ORDER BY o.name, u.email;


-- ── C. Exactly one active trainer and one active admin? ─────────────────────
-- The gate on 184's index. Anything but OK and the index is skipped.
SELECT o.name AS studio,
  (SELECT count(*) FROM trainers t WHERE t.organization_id=o.id AND t.deleted_at IS NULL AND t.status='active') AS active_trainers,
  (SELECT count(*) FROM users u WHERE u.organization_id=o.id AND u.role='admin' AND u.deleted_at IS NULL) AS active_admins,
  CASE WHEN (SELECT count(*) FROM trainers t WHERE t.organization_id=o.id AND t.deleted_at IS NULL AND t.status='active')=1
        AND (SELECT count(*) FROM users u WHERE u.organization_id=o.id AND u.role='admin' AND u.deleted_at IS NULL)=1
       THEN 'OK' ELSE '** NEEDS A HUMAN **' END AS verdict
  FROM organizations o ORDER BY 4 DESC, 1;


-- ── D. Every trainers row, not just the active ones ─────────────────────────
-- C counts only active trainers, so archived and soft-deleted rows are
-- invisible to it. They still hold commission and payout history.
SELECT o.name AS studio, t.status, (t.deleted_at IS NOT NULL) AS soft_deleted, count(*) AS rows
  FROM trainers t JOIN organizations o ON o.id=t.organization_id
 GROUP BY 1,2,3 ORDER BY 1,2,3;


-- ── E. FK-less pointers that do not resolve to their own studio trainer ─────
-- pt_clients.trainer_id, pt_leads.trainer_id and users.trainer_id are TEXT with
-- no foreign key (072:5), so nothing prevents a stale, cross-org or dangling
-- id. Empty is the healthy answer.
SELECT src, studio, bad_trainer_id, diagnosis, count(*) AS rows FROM (
  SELECT 'pt_clients' src, o.name studio, c.trainer_id bad_trainer_id,
    CASE WHEN c.trainer_id IS NULL THEN 'unassigned (NULL)'
         WHEN tt.id IS NULL THEN 'points at a MISSING trainers row'
         WHEN tt.organization_id <> c.organization_id THEN 'points at ANOTHER studio trainer'
         WHEN tt.deleted_at IS NOT NULL THEN 'points at a SOFT-DELETED trainer'
         WHEN tt.status <> 'active' THEN 'points at an INACTIVE trainer'
         ELSE 'ok' END diagnosis
    FROM pt_clients c JOIN organizations o ON o.id=c.organization_id
    LEFT JOIN trainers tt ON tt.id=c.trainer_id
   WHERE c.deleted_at IS NULL
  UNION ALL
  SELECT 'pt_leads', o.name, l.trainer_id,
    CASE WHEN l.trainer_id IS NULL THEN 'unassigned (NULL)'
         WHEN tt.id IS NULL THEN 'points at a MISSING trainers row'
         WHEN tt.organization_id <> l.organization_id THEN 'points at ANOTHER studio trainer'
         WHEN tt.deleted_at IS NOT NULL THEN 'points at a SOFT-DELETED trainer'
         WHEN tt.status <> 'active' THEN 'points at an INACTIVE trainer'
         ELSE 'ok' END
    FROM pt_leads l JOIN organizations o ON o.id=l.organization_id
    LEFT JOIN trainers tt ON tt.id=l.trainer_id
  UNION ALL
  -- role='member' only: on a staff row this column means "I am this trainer",
  -- which is a different question and belongs in A/B.
  SELECT 'users(member)', o.name, u.trainer_id,
    CASE WHEN u.trainer_id IS NULL THEN 'unassigned (NULL)'
         WHEN tt.id IS NULL THEN 'points at a MISSING trainers row'
         WHEN tt.organization_id <> u.organization_id THEN 'points at ANOTHER studio trainer'
         WHEN tt.deleted_at IS NOT NULL THEN 'points at a SOFT-DELETED trainer'
         WHEN tt.status <> 'active' THEN 'points at an INACTIVE trainer'
         ELSE 'ok' END
    FROM users u JOIN organizations o ON o.id=u.organization_id
    LEFT JOIN trainers tt ON tt.id=u.trainer_id
   WHERE u.role='member' AND u.deleted_at IS NULL
) q WHERE diagnosis <> 'ok'
GROUP BY 1,2,3,4 ORDER BY 1,2,4;


-- ── F. Denormalised trainer_name drifted from trainers.name ─────────────────
-- pt_clients carries a copy of the trainer's name alongside the id. Nothing
-- keeps the two in step, so a rename leaves the copy stale.
SELECT o.name AS studio, c.trainer_id, c.trainer_name AS stored_name,
       t.name AS actual_name, count(*) AS rows
  FROM pt_clients c JOIN organizations o ON o.id=c.organization_id
  JOIN trainers t ON t.id=c.trainer_id
 WHERE c.deleted_at IS NULL AND c.trainer_name IS DISTINCT FROM t.name
 GROUP BY 1,2,3,4 ORDER BY 1;
