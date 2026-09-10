# Rollback reference — `191_drop_legacy_payments.sql`

Migration 191 drops the legacy `payments` ledger. This file preserves its
definition so the structure can be recreated if it is ever needed.

**There is no data to restore.** The table held 0 rows when it was dropped, and
migration 191 refuses to run at all if that is ever untrue — it counts the rows
first and raises rather than dropping a ledger with money in it.

Recreating the table does **not** restore any reader or writer. Every one was
removed as broken, unscopable, or both:

| Caller | What it did | Why it went |
|---|---|---|
| `routes/payments.js` | `UNION ALL` over both ledgers | legacy half selected `NULL::uuid AS organization_id`, so it sat behind a tenant filter it could never satisfy |
| `routes/payments.js` | DELETE/UPDATE fallback | no organization clause at all — a cross-tenant delete by id against a populated table |
| `routes/invoices.js` | INSERT on invoice settlement | wrote a payment row with no studio on it |
| `routes/trainers.js` | 6-month revenue trend | read the empty table, so the chart was a flat zero |
| `routes/razorpay-webhook.js` | three UPDATEs | named `gateway_payment_id` and `refund_id`, neither of which existed on the table |
| `workers/renewal.worker.js` | INSERT keyed on `member_id` | the gym-era membership model, whose tables hold 0 rows |

The canonical ledger is `pt_payments`, which carries `organization_id` on every
row.

## Structure as it stood

```sql
CREATE TABLE public.payments (
  id               text PRIMARY KEY,
  client_id        text,
  client_name      text,
  trainer_id       text,
  trainer_name     text,
  amount           numeric NOT NULL,
  method           text,
  date             date NOT NULL,
  receipt_no       text UNIQUE,
  package_type     text,
  incentive_amt    numeric,
  notes            text,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL,
  branch_id        text,
  member_id        text,
  membership_id    text,
  gateway          text,
  gateway_txn_id   text,
  gateway_status   text,
  invoice_no       text UNIQUE,
  refunded_amount  numeric,
  created_by       text,
  status           text NOT NULL,
  deleted_at       timestamptz,
  transaction_ref  text,
  collected_by     text
);

CREATE INDEX idx_payments_date          ON public.payments (date);
CREATE INDEX idx_payments_trainer       ON public.payments (trainer_id);
CREATE INDEX idx_payments_member_id     ON public.payments (member_id);
CREATE INDEX idx_payments_status        ON public.payments (status);
CREATE INDEX idx_payments_created_desc  ON public.payments (created_at DESC);
CREATE INDEX idx_payments_alive         ON public.payments (id) WHERE deleted_at IS NULL;
CREATE INDEX payments_date_idx          ON public.payments (date DESC);
CREATE INDEX payments_client_date_idx   ON public.payments (client_id, date DESC);
CREATE INDEX idx_payments_created_by    ON public.payments (created_by);
CREATE INDEX idx_payments_membership_id ON public.payments (membership_id);
CREATE INDEX idx_payments_client_id     ON public.payments (client_id);
CREATE INDEX idx_payments_deleted_at    ON public.payments (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX idx_payments_branch_id     ON public.payments (branch_id) WHERE branch_id IS NOT NULL;
```

Migration 191 also repoints `invoices.payment_id` from this table to
`pt_payments`, and adds that column where a fresh build lacked it (production
carried it; a database built from `schema.sql` + migrations did not). To
reverse that half:

```sql
ALTER TABLE public.invoices
  DROP CONSTRAINT IF EXISTS invoices_payment_id_fkey,
  ADD  CONSTRAINT invoices_payment_id_fkey
       FOREIGN KEY (payment_id) REFERENCES public.payments(id) ON DELETE SET NULL;
```
