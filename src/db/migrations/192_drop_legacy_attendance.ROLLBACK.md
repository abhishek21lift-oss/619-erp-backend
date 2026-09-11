# Rollback for `192_drop_legacy_attendance.sql`

Migration 192 drops `public.attendance`, which held **0 rows** in production.
There is no data to restore — this restores the structure only.

This lives in a `.md` file rather than as a commented block inside the `.sql`
for a mechanical reason: `architecture.domains.convention.test.js` builds the
schema's table list by scanning `schema.sql` and every migration for
`CREATE`/`DROP` **in filename order, without stripping SQL comments**. A
commented-out `CREATE TABLE public.attendance` below a `DROP TABLE` would be
read as a live create and the table would be reported as unowned by any domain.

## Restoring the table

Reproduces the production shape as it stood immediately before 192, including
the drift from `schema.sql` (production's `type` CHECK allowed only
`client`/`trainer`, and its `status` CHECK additionally allowed `leave`).

```sql
CREATE TABLE public.attendance (
  id               TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  type             TEXT        NOT NULL DEFAULT 'client',
  ref_id           TEXT        NOT NULL,
  ref_name         TEXT,
  trainer_id       TEXT,
  trainer_name     TEXT,
  date             DATE        NOT NULL,
  check_in         TIME,
  check_out        TIME,
  status           TEXT        NOT NULL DEFAULT 'present',
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  branch_id        TEXT        REFERENCES branches(id),
  member_id        TEXT        REFERENCES members(id),
  booking_id       TEXT        REFERENCES bookings(id),
  pt_session_id    TEXT        REFERENCES pt_sessions(id),
  check_in_method  TEXT,
  device_id        TEXT,
  organization_id  UUID        NOT NULL
                   REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT attendance_type_check
    CHECK (type = ANY (ARRAY['client'::text, 'trainer'::text])),
  CONSTRAINT attendance_status_check
    CHECK (status = ANY (ARRAY['present'::text, 'absent'::text, 'late'::text,
                               'half_day'::text, 'leave'::text])),
  CONSTRAINT attendance_type_ref_id_date_key UNIQUE (type, ref_id, date)
);

CREATE INDEX idx_attendance_ref_id        ON public.attendance (ref_id);
CREATE INDEX idx_attendance_date          ON public.attendance (date);
CREATE INDEX idx_attendance_ref           ON public.attendance (ref_id, date);
CREATE INDEX idx_attendance_member_id     ON public.attendance (member_id);
CREATE INDEX idx_attendance_booking_id    ON public.attendance (booking_id);
CREATE INDEX idx_attendance_branch_id     ON public.attendance (branch_id);
CREATE INDEX idx_attendance_pt_session_id ON public.attendance (pt_session_id);
CREATE INDEX attendance_org_idx           ON public.attendance (organization_id);
```

## Restoring row-level security

`attendance` was one of the few tables in this schema with **FORCE** row level
security, so the owner was subject to the policy too. Restore both flags:

```sql
ALTER TABLE public.attendance ENABLE  ROW LEVEL SECURITY;
ALTER TABLE public.attendance FORCE   ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.attendance
  USING (organization_id::text = current_setting('app.org_id', true));
CREATE POLICY deny_all_anon ON public.attendance
  TO anon USING (false);
CREATE POLICY deny_all_authenticated ON public.attendance
  TO authenticated USING (false);
```

## Restoring the writer

The only runtime code that used this table was the class check-in mirror in
`src/modules/bookings/bookings.service.js`. Its previous form:

```js
await pool.query(
  `INSERT INTO attendance (type, ref_id, member_id, booking_id, branch_id, date, check_in, status, check_in_method, organization_id)
   VALUES ('client', $1, $1, $2, COALESCE($4, 'br-main'), CURRENT_DATE, NOW()::time, 'present', $3, $5)
   ON CONFLICT (type, ref_id, date) DO UPDATE SET check_in = EXCLUDED.check_in, status = 'present'`,
  [b.member_id, b.id, method, process.env.BRANCH_ID || null, b.organization_id]
);
```

Restoring it would reinstate the original defect: nothing reads this table, so
a class check-in recorded here appears on no screen, in no report and in no
automation. Repoint it at `attendance_logs` instead.
