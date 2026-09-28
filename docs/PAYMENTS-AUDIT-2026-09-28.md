# Payments & Invoices Audit — 2026-09-28

**Scope:**
- `POST/GET/DELETE /api/payments`
- `lib/ptPayments.js`
- `POST/GET /api/pt-os/payments`
- Enrolment through `PATCH /api/pt-os/clients/:id`
- `POST /api/pt-os/clients/:id/renew`
- `/api/invoices/*`
- Receipt numbering (`db/receipts.js`)
- The balance sheet and revenue report
- `GET /api/me/payments`
- The Finance pages in the frontend

UPI was audited and fixed earlier (#187/#272).

## Production snapshot (read-only)

| | |
|---|---|
| Live clients | 35 |
| Payments | 42, ₹6,75,750 total (32 cash, 10 UPI), none deleted |
| `pt_clients.paid_amount` vs ledger sum | **matches for every client** |
| Renewals | 6, across 4 clients |
| Clients with paid > current price | **1** (paid ₹20,000 vs ₹11,000 current term, after a renewal) |
| Payments without a receipt number | **28 of 42** |
| Duplicate receipt numbers | 0 |
| Invoices | 0 (feature unused) |
| Expenses | 0 |
| "Incentives" on the ledger | ₹36,125 |

The money on record is consistent today. The findings below are the ways it
stops being consistent.

Severity: **High**, **Medium**, **Low**.

## Status

Fixed on `claude/project-setup-understanding-9t82iv`:

| ID | Fix |
|---|---|
| PAY-1 | `PATCH /clients/:id` refuses money fields for a client with renewal history (`409 USE_RENEW`), and refuses lowering `paid_amount`. The Enroll page sends a renewed client to Renew instead. |
| PAY-2 | Renewal moved to `renewal.service.js`: one transaction, client `FOR UPDATE`, a repeat within 10 minutes refused (`409 DUPLICATE_RENEWAL`), overpayment refused, a zod schema, base/discount no longer zeroed. |
| PAY-3 | New `pt_payments.balance_applied` (migration 217), written by every path that moves the balance. `DELETE` restores exactly that. Rows from before 217 keep the old rule. |
| PAY-4 | `remind` returns 501 honestly. The Invoices page no longer offers Send Reminder. |
| PAY-5 | `PUT` can't set `paid`/`cancelled`. `mark-paid` books only the remainder and never writes a ₹0 payment. |
| PAY-6 | Enrolment and renewal payments get receipt numbers. Migration 217 numbers the existing unnumbered rows, oldest first. |
| PAY-12 | Renewal end dates are clamped to month end (31 Jan + 1 month = 28/29 Feb). |
| PAY-15 | The `mark-paid` client update is org-scoped. Its receipt reference no longer doubles the `INV-` prefix. |

Verified against a migrated Postgres:
- the migration backfill (ordering, dates, existing references kept);
- renewal balances, receipt and `balance_applied`;
- **two simultaneous renewals produce one term and one payment**;
- overpayment leaves nothing changed.

Still open: PAY-7 (GST invoice numbering and fields), PAY-8, PAY-9, PAY-10, PAY-11, PAY-13, PAY-14, PAY-16.

---

## High

### PAY-1: `paid_amount` means two different things, and the Enroll screen writes the wrong one
- **Renewal** treats `pt_clients.paid_amount` as a lifetime total (`paid_amount + paid now`).
- **Enrolment and the money path of `PATCH /clients/:id`** treat it as "paid for this term". They set it absolutely, then compute `balance = final − paid`.

"Enroll in PT" is shown on **every** client, including ones already enrolled and renewed. It pre-fills the stored values, so:

- **Renewed client** (the production case: paid ₹20,000, current price ₹11,000): the form shows paid > price and refuses to save. If the trainer "corrects" paid to ₹11,000, the server stores it, and ₹9,000 disappears from the client's paid total. The ledger still says ₹20,000.
- **Re-enrolling a client who paid before:** the server books only `new paid − old paid` as a payment. A client who paid ₹10,000 last term and pays ₹12,000 for the new one records **₹2,000** of revenue. The other ₹10,000 of real cash never reaches the ledger or any report.
- **Any `final_amount` edit after a renewal** recomputes the balance as `current price − lifetime paid`, which is usually 0. An outstanding amount is wiped.

**Fix:**
- Enrol only a client who has never been enrolled; anyone else goes to Renew.
- `PATCH` refuses money-field edits on a client with a renewal history.
- The Enroll page redirects to Renew for enrolled clients.

### PAY-2: Renewal is not a transaction and not idempotent
`POST /clients/:id/renew` makes four separate writes (client row, renewal log, subscription row, ledger row) with no transaction and no row lock.

- **Double submit** (a slow network, or a double tap) renews twice, adds the term price to the balance twice, and records the payment twice.
- **Partial failure** leaves the client extended with no ledger row, or the reverse.
- **No validation:**
  - `Number(x) || 0` everywhere;
  - a negative `paid_amount` lowers lifetime paid;
  - a negative discount or final amount is accepted;
  - paying more than the price silently discards the extra.

**Fix:** one transaction, `FOR UPDATE` on the client, a zod schema, and the ledger row through `recordPtPayment`.

### PAY-3: Deleting a payment can inflate the client's balance
- **Recording** a payment clamps the balance: `balance = GREATEST(0, balance − amount)`. Any overpayment is simply lost; there is no credit or advance.
- **Deleting** it adds the full amount back: `balance + amount`.

Example: ₹1,000 due, ₹1,500 paid → balance 0. Delete that payment → balance **₹1,500**, now more than was ever owed.

**Fix:** keep the balance consistent (store the applied amount, or recompute from price minus the ledger).

### PAY-4: "Send Reminder" on an invoice sends nothing
`POST /invoices/:id/remind` only writes a log line, then answers `"Reminder sent to <name>"`. The Invoices page shows that as success. The trainer believes the client was reminded.

**Fix:** send it through the studio's WhatsApp/email channel, or remove the button until that exists.

### PAY-5: An invoice can be marked paid with no money recorded
- `PUT /invoices/:id` takes any `status`, including `'paid'`, with no schema. That sets an invoice paid with no ledger row, no `paid_at` and no balance change.
- `mark-paid` on a `partial` invoice books the **full** total again, double-counting whatever was already paid.

**Fix:** a status enum on PUT that excludes `paid`/`cancelled`. Paying goes only through `mark-paid`, which records the remaining amount.

---

## Medium

| # | Finding |
|---|---|
| PAY-6 | **Most payments have no receipt number: 28 of 42.** Enrolment and renewal insert straight into `pt_payments`, bypassing `recordPtPayment`, which is where the receipt number and the activity-log entry come from. The receipt sequence is also one platform-wide counter: studio A's receipts jump by studio B's volume. |
| PAY-7 | **Invoice numbers:** `'INV-' + Date.now()` is 17 characters, not sequential, and two creates in the same millisecond hit the UNIQUE constraint (500). If a studio is GST-registered, Rule 46 needs a consecutive series of at most 16 characters per financial year, plus GSTIN, SAC and the CGST/SGST/IGST split, none of which the invoice has. Amounts are unrounded floats. Negative unit prices and any `tax_pct` are accepted, with no request schema. |
| PAY-8 | Deleting a payment that settled an invoice leaves the invoice "paid". There is no refund or credit-note flow; the only undo is deleting the payment. |
| PAY-9 | The invoice "Pending" stat includes **drafts**, which aren't receivables. "Overdue" only counts invoices someone manually set to overdue; nothing moves an invoice past its due date. The stats also ignore the list's date filter. |
| PAY-10 | The revenue report starts at 1 January. Indian studios work in financial years (April–March), so from January to March the report hides most of the current FY. |
| PAY-11 | `POST /api/payments` accepts any method string ("GPay" lands in no bucket of the method breakdown). Neither payment path has an amount ceiling (a ₹1,50,000 typo for ₹1,500 goes straight in). The date isn't validated: an invalid date is a 500, and future dates are accepted. A `limit` query parameter of `abc` is a 500. |
| PAY-12 | The renewal end date uses `setMonth`: a term starting 31 January for 1 month ends **3 March**. |

## Low

| # | Finding |
|---|---|
| PAY-13 | Every payment computes a 50% "trainer incentive" by default. In a one-trainer studio this is meaningless, but it shows ₹36,125 of "incentives" beside ₹6.76L of revenue on the reports. |
| PAY-14 | The member app's payment history has no receipt number, and no receipt for cash or card payments (only UPI orders have one). |
| PAY-15 | `mark-paid` updates the client without an organization predicate (the invoice was org-checked, so it isn't exploitable, but it's weaker than the rest). Its receipt reference reads `INV-INV-…`. |
| PAY-16 | The Invoices feature is unused in production (0 rows). Decide whether to finish it (PAY-4, 5, 7, 8, 9) or hide it. |

---

## Suggested fix order
1. **PAY-1, PAY-2, PAY-3.** The balance and ledger have one meaning, renewal is atomic, and deletion reverses exactly.
2. **PAY-6.** Every payment gets a receipt number, through `recordPtPayment`, with a backfill of the 28 existing rows.
3. **PAY-4, PAY-5.** Stop the invoice screens claiming things that didn't happen.
4. **PAY-11, PAY-12, PAY-10.** Input validation, the end-date overflow, and the financial-year revenue report.
5. **Decide on Invoices (PAY-16).** Either do GST-compliant numbering and fields (PAY-7, 8, 9), or hide the feature.
