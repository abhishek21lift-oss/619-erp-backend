-- ============================================================================
-- one-trainer-dry-run.sql
--
-- The same report as scripts/one-trainer-dry-run.js, as one paste-able script
-- for the Supabase SQL editor — for when running node against production is
-- inconvenient or the connection string is not to hand.
--
-- READ-ONLY. Every statement is a SELECT. There is no INSERT, UPDATE, DELETE,
-- DDL or set_config anywhere in this file, and no migration behind it.
--
-- Output arrives as NOTICE messages (the "Messages"/"Notices" pane in the
-- Supabase editor, or plain stderr under psql). NOTICE rather than result sets
-- because production has drifted from this repository — it carries pt_os_*
-- and memberships tables the repo does not build — so every table has to be
-- probed with to_regclass and reached through dynamic SQL. A missing table is
-- reported as absent instead of raising.
--
-- Usage under psql:   psql "$ADMIN_DATABASE_URL" -f scripts/one-trainer-dry-run.sql
--
-- Use the OWNER connection. After the RLS cutover, DATABASE_URL authenticates
-- as app_tenant, and a cross-studio report on that connection comes back empty
-- — silently, because RLS filters rather than errors — which reads as "no
-- surplus trainers anywhere". The role is printed first for that reason.
-- ============================================================================

DO $$
DECLARE
  r           RECORD;
  n           BIGINT;
  n2          BIGINT;
  txt         TEXT;
  survivor_id TEXT;

  -- Which trainer survives in each studio. Prefer the row an owner's login
  -- points at — signup creates the org, a trainers row, and a role='admin'
  -- user linked to it, so that row IS the studio's original trainer. Fall back
  -- to the oldest active row; ties broken by id so two runs agree.
  CTE CONSTANT TEXT := $q$
    WITH active AS (
      SELECT t.id, t.organization_id, t.name, t.incentive_rate, t.created_at
        FROM trainers t WHERE t.deleted_at IS NULL AND t.status = 'active'
    ), owner_linked AS (
      SELECT DISTINCT u.organization_id, u.trainer_id FROM users u
       WHERE u.role = 'admin' AND u.deleted_at IS NULL AND u.trainer_id IS NOT NULL
    ), survivor AS (
      SELECT DISTINCT ON (a.organization_id)
             a.organization_id, a.id AS trainer_id, a.name AS trainer_name,
             (ol.trainer_id IS NOT NULL) AS chosen_by_owner_link
        FROM active a
        LEFT JOIN owner_linked ol
               ON ol.organization_id = a.organization_id AND ol.trainer_id = a.id
       ORDER BY a.organization_id, (ol.trainer_id IS NOT NULL) DESC,
                a.created_at ASC, a.id ASC
    )$q$;

  -- table, trainer column, predicate for "currently responsible"
  current_specs TEXT[][] := ARRAY[
    ['pt_clients',           'trainer_id', 'x.deleted_at IS NULL'],
    ['pt_leads',             'trainer_id', 'TRUE'],
    ['workout_assignments',  'trainer_id', 'x.status = ''active'''],
    ['diet_assignments',     'trainer_id', 'x.status = ''active'''],
    ['training_assignments', 'trainer_id', 'x.status = ''ASSIGNED''']
  ];

  -- table, trainer column, date column, predicate for "booked, not delivered".
  -- Written against each table's CHECK constraint, not guessed: a CANCELLED
  -- trial also has completed_at NULL, and training_sessions' statuses are
  -- uppercase, so `completed_at IS NULL` would sweep up cancelled and abandoned
  -- bookings. class_sessions' in_progress is excluded on purpose — a class
  -- being taught right now is mid-delivery, not a plan.
  future_specs TEXT[][] := ARRAY[
    ['pt_sessions',       'trainer_id',    'x.session_date', 'x.status = ''scheduled'' AND x.session_date >= CURRENT_DATE'],
    ['class_sessions',    'instructor_id', 'x.date',         'x.status = ''scheduled'' AND x.date >= CURRENT_DATE'],
    ['trial_sessions',    'trainer_id',    'x.scheduled_at', 'x.status = ''scheduled'' AND x.scheduled_at >= now()'],
    ['training_sessions', 'trainer_id',    'x.session_date', 'x.status IN (''NOT_STARTED'',''IN_PROGRESS'') AND x.session_date >= CURRENT_DATE']
  ];

  -- Tables whose rows must be identical before and after any conversion.
  protected TEXT[][] := ARRAY[
    ['pt_commissions',  'trainer_id'],
    ['pt_payouts',      'trainer_id'],
    ['leave_requests',  'trainer_id'],
    ['pt_sessions',     'trainer_id'],
    ['pt_payments',     'trainer_id']
  ];

  i INT;
  tbl TEXT; col TEXT; pred TEXT; datecol TEXT;

  -- Rows belonging to a trainer that would be archived.
  ARCHIVED_PRED CONSTANT TEXT :=
    ' t.deleted_at IS NULL AND t.status = ''active''
      AND (s.trainer_id IS NULL OR t.id <> s.trainer_id)';
BEGIN
  RAISE NOTICE '=========================================================';
  RAISE NOTICE 'ONE TRAINER PER STUDIO - DRY RUN. Nothing is changed.';
  RAISE NOTICE '=========================================================';

  SELECT current_user || '  bypassrls=' ||
         COALESCE((SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user), false)::text
    INTO txt;
  RAISE NOTICE 'Connected as: %', txt;
  IF NOT COALESCE((SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user), false) THEN
    RAISE NOTICE '  WARNING: this role does not bypass RLS. A cross-studio report on the';
    RAISE NOTICE '  tenant connection returns nothing and looks like "no surplus trainers".';
  END IF;
  RAISE NOTICE ' ';

  -- ── 1. Studios ────────────────────────────────────────────────────────────
  RAISE NOTICE '1. STUDIOS';
  FOR r IN EXECUTE CTE || $q$
    SELECT o.name AS studio,
      (SELECT count(*) FROM users u WHERE u.organization_id=o.id AND u.role='admin' AND u.deleted_at IS NULL) AS owners,
      (SELECT count(*) FROM users u WHERE u.organization_id=o.id AND u.role='trainer' AND u.deleted_at IS NULL) AS trainer_logins,
      (SELECT count(*) FROM users u WHERE u.organization_id=o.id AND u.role IN ('manager','reception') AND u.deleted_at IS NULL) AS mgr_recep,
      (SELECT count(*) FROM trainers t WHERE t.organization_id=o.id AND t.deleted_at IS NULL AND t.status='active') AS active_trainers,
      (SELECT count(*) FROM trainers t WHERE t.organization_id=o.id AND t.deleted_at IS NULL AND t.status<>'active') AS already_inactive,
      (SELECT count(*) FROM pt_clients c WHERE c.organization_id=o.id AND c.deleted_at IS NULL) AS clients,
      s.trainer_name, s.chosen_by_owner_link
    FROM organizations o LEFT JOIN survivor s ON s.organization_id=o.id
   ORDER BY active_trainers DESC, o.name$q$
  LOOP
    RAISE NOTICE '  % | owners % | trainer logins % | mgr/recep % | active trainers % (inactive %) | clients %',
      r.studio, r.owners, r.trainer_logins, r.mgr_recep, r.active_trainers, r.already_inactive, r.clients;
    IF r.trainer_name IS NULL THEN
      RAISE NOTICE '      NO active trainer - nothing can survive. Look at this studio first.';
    ELSE
      RAISE NOTICE '      would survive: %  (%)', r.trainer_name,
        CASE WHEN r.chosen_by_owner_link THEN 'owner login points at it' ELSE 'oldest active row' END;
    END IF;
    IF r.owners > 1 THEN
      RAISE NOTICE '      WARNING: % owners. No account is demoted by any migration; the operator decides.', r.owners;
    END IF;
  END LOOP;
  RAISE NOTICE ' ';

  -- ── 2. Would be archived ──────────────────────────────────────────────────
  RAISE NOTICE '2. WOULD BE ARCHIVED (status -> inactive; row kept, never deleted)';
  FOR r IN EXECUTE CTE || $q$
    SELECT o.name AS studio, t.id, t.name, t.incentive_rate,
      (SELECT count(*) FROM pt_clients c WHERE c.trainer_id=t.id AND c.deleted_at IS NULL) AS assigned_clients,
      (SELECT count(*) FROM users u WHERE u.trainer_id=t.id AND u.role<>'member' AND u.deleted_at IS NULL) AS staff_logins
    FROM trainers t
    JOIN organizations o ON o.id=t.organization_id
    LEFT JOIN survivor s ON s.organization_id=t.organization_id
   WHERE $q$ || ARCHIVED_PRED || $q$ ORDER BY o.name, t.name$q$
  LOOP
    RAISE NOTICE '  % | % | rate % | % assigned client(s) | % staff login(s)',
      r.studio, r.name, r.incentive_rate, r.assigned_clients, r.staff_logins;
  END LOOP;
  RAISE NOTICE ' ';

  -- ── 3. Current responsibility that would move ─────────────────────────────
  RAISE NOTICE '3. WOULD BE REPOINTED - current responsibility';
  FOR i IN 1 .. array_length(current_specs, 1) LOOP
    tbl := current_specs[i][1]; col := current_specs[i][2]; pred := current_specs[i][3];
    IF to_regclass('public.' || tbl) IS NULL THEN
      RAISE NOTICE '     -    %  (table absent in this database)', tbl; CONTINUE;
    END IF;
    EXECUTE CTE || format($q$ SELECT count(*) FROM %I x
        JOIN trainers t ON t.id = x.%I
        LEFT JOIN survivor s ON s.organization_id = t.organization_id
       WHERE %s AND $q$, tbl, col, pred) || ARCHIVED_PRED INTO n;
    RAISE NOTICE '  %  %.%', lpad(n::text, 5), tbl, col;
  END LOOP;
  -- users.trainer_id on role='member' means "MY trainer", not "I am this
  -- trainer" (client-login.js:168-184). Same column, two meanings.
  EXECUTE CTE || $q$ SELECT count(*) FROM users u
      JOIN trainers t ON t.id = u.trainer_id
      LEFT JOIN survivor s ON s.organization_id = t.organization_id
     WHERE u.role='member' AND u.deleted_at IS NULL AND $q$ || ARCHIVED_PRED INTO n;
  RAISE NOTICE '  %  users.trainer_id (role=member) - the client''s assigned trainer', lpad(n::text, 5);
  RAISE NOTICE ' ';

  -- ── 4. Future bookings that would move ────────────────────────────────────
  RAISE NOTICE '4. WOULD BE REPOINTED - future bookings';
  FOR i IN 1 .. array_length(future_specs, 1) LOOP
    tbl := future_specs[i][1]; col := future_specs[i][2]; pred := future_specs[i][4];
    IF to_regclass('public.' || tbl) IS NULL THEN
      RAISE NOTICE '     -    %  (table absent in this database)', tbl; CONTINUE;
    END IF;
    EXECUTE CTE || format($q$ SELECT count(*) FROM %I x
        JOIN trainers t ON t.id = x.%I
        LEFT JOIN survivor s ON s.organization_id = t.organization_id
       WHERE %s AND $q$, tbl, col, pred) || ARCHIVED_PRED INTO n;
    RAISE NOTICE '  %  %.%   WHERE %', lpad(n::text, 5), tbl, col, pred;
  END LOOP;
  RAISE NOTICE ' ';

  -- ── 5. Protected history: counts and checksums ────────────────────────────
  -- The count alone can be fooled by a same-count substitution, so a checksum
  -- over (trainer_id, count) groupings goes with it. Capture these before any
  -- migration and compare after; they must be identical.
  RAISE NOTICE '5. MUST NOT CHANGE - counts and per-trainer checksums';
  FOR i IN 1 .. array_length(protected, 1) LOOP
    tbl := protected[i][1]; col := protected[i][2];
    IF to_regclass('public.' || tbl) IS NULL THEN
      RAISE NOTICE '     -    %  (table absent in this database)', tbl; CONTINUE;
    END IF;
    EXECUTE format('SELECT count(*) FROM %I WHERE %I IS NOT NULL', tbl, col) INTO n;
    EXECUTE CTE || format($q$ SELECT count(*) FROM %I x
        JOIN trainers t ON t.id = x.%I
        LEFT JOIN survivor s ON s.organization_id = t.organization_id
       WHERE $q$, tbl, col) || ARCHIVED_PRED INTO n2;
    EXECUTE format($q$
      SELECT md5(string_agg(k || ':' || c, '|' ORDER BY k))
        FROM (SELECT %I AS k, count(*)::text AS c FROM %I
               WHERE %I IS NOT NULL GROUP BY 1) g$q$, col, tbl, col) INTO txt;
    RAISE NOTICE '  %  %  | % belong to a would-be-archived trainer and stay there | checksum %',
      lpad(n::text, 6), rpad(tbl, 16), n2, COALESCE(txt, '(empty)');
  END LOOP;
  RAISE NOTICE ' ';

  -- ── 6. Status vocabulary ──────────────────────────────────────────────────
  -- Two questions. The CHECK constraint says what is POSSIBLE and is what a
  -- predicate should be written against; the row counts say what is PRESENT,
  -- which is what reveals a legal-but-unexpected status actually out there.
  RAISE NOTICE '6. STATUS VOCABULARY - verify the predicates above against this';
  FOR r IN
    SELECT c.conrelid::regclass::text AS tbl, pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c
     WHERE c.contype='c'
       AND c.conrelid::regclass::text IN ('pt_sessions','class_sessions','trial_sessions','training_sessions')
       AND pg_get_constraintdef(c.oid) ILIKE '%status%' ORDER BY 1
  LOOP
    RAISE NOTICE '  CHECK  % allows %', rpad(r.tbl, 18),
      replace(replace(COALESCE(substring(r.def from 'ARRAY\[(.*?)\]'), r.def), '::text', ''), '''', '');
  END LOOP;
  FOR i IN 1 .. array_length(future_specs, 1) LOOP
    tbl := future_specs[i][1]; datecol := replace(future_specs[i][3], 'x.', '');
    CONTINUE WHEN to_regclass('public.' || tbl) IS NULL;
    FOR r IN EXECUTE format($q$
      SELECT status, count(*) AS rows,
             count(*) FILTER (WHERE %I >= %s) AS future_dated,
             count(*) FILTER (WHERE %I IS NULL) AS null_date
        FROM %I GROUP BY status ORDER BY 2 DESC$q$,
      datecol, CASE WHEN datecol='scheduled_at' THEN 'now()' ELSE 'CURRENT_DATE' END, datecol, tbl)
    LOOP
      RAISE NOTICE '  DATA   % % | % rows | % future-dated | % null date',
        rpad(tbl, 18), rpad(COALESCE(r.status, '(null)'), 14), r.rows, r.future_dated, r.null_date;
    END LOOP;
  END LOOP;
  RAISE NOTICE ' ';

  -- ── 7. Future rows deliberately left alone ────────────────────────────────
  -- "Untouched" should be a decision on the page, not an omission.
  RAISE NOTICE '7. FUTURE RECORDS DELIBERATELY LEFT UNTOUCHED';
  IF to_regclass('public.leave_requests') IS NOT NULL THEN
    EXECUTE CTE || $q$ SELECT count(*) FROM leave_requests x
        JOIN trainers t ON t.id = x.trainer_id
        LEFT JOIN survivor s ON s.organization_id = t.organization_id
       WHERE x.to_date >= CURRENT_DATE AND $q$ || ARCHIVED_PRED INTO n;
    RAISE NOTICE '  %  leave_requests - future leave belongs to the person who requested it,', lpad(n::text, 5);
    RAISE NOTICE '         not to the studio''s trainer role';
  END IF;
  FOR i IN 1 .. array_length(future_specs, 1) LOOP
    tbl := future_specs[i][1]; col := future_specs[i][2];
    datecol := future_specs[i][3]; pred := future_specs[i][4];
    CONTINUE WHEN to_regclass('public.' || tbl) IS NULL;
    EXECUTE CTE || format($q$ SELECT count(*) FROM %I x
        JOIN trainers t ON t.id = x.%I
        LEFT JOIN survivor s ON s.organization_id = t.organization_id
       WHERE (%s >= %s) AND NOT (%s) AND $q$,
      tbl, col, datecol,
      CASE WHEN datecol LIKE '%%scheduled_at' THEN 'now()' ELSE 'CURRENT_DATE' END,
      pred) || ARCHIVED_PRED INTO n;
    IF n > 0 THEN
      RAISE NOTICE '  %  % - future-dated but outside the repoint predicate (cancelled, etc)',
        lpad(n::text, 5), tbl;
    END IF;
  END LOOP;

  RAISE NOTICE ' ';
  RAISE NOTICE '=========================================================';
  RAISE NOTICE 'Read-only. No migration exists. Nothing was changed.';
  RAISE NOTICE '=========================================================';
END $$;
