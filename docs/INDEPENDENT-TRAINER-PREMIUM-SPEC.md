# Spec: Independent Trainer Premium Track

**Customer:** solo personal trainer, ~10–40 active clients, no staff, works from phone + laptop.
**Problem:** they pay for software only while it saves them time or protects their income.
**Bet:** the three jobs they do every day — review form videos, answer WhatsApp, stop clients leaving — are also the three jobs this app does half-way today.

---

## In scope (v1)

1. AI Form Check 2.0
2. WhatsApp two-way inbox
3. Retention Autopilot
4. Real plan gating for the three above (otherwise there is nothing to upgrade to)

## Out of scope (explicitly)

White-label, custom domain, readiness/adaptive programming, community, wearables, native apps, expenses UI, calendar sync, multi-location. Each is a separate bet; none of them is why a solo trainer pays.

---

## Already built — do not rebuild

Checked against the code on 2026-11-01. Both of these look missing from the outside and are not:

- **Churn scoring and follow-ups.** `pt-os/churn-risk.js` scores deterministically, `churn.service.js` assembles the list, `pt_client_followups` (migration 246) is the trainer's action log with snooze semantics, and the screen is live at `/pt-os/clients/at-risk`. Has its own tests (`churnRisk`, `churn.service`, `churn.routes`, `churn.migration`).
- **Plan → feature matrix.** `plan_features` is fully seeded with every plan × every feature = TRUE (migration 123). `is_plan_gated` is FALSE everywhere. Enforcement via `requireFeature()` exists and is already wired on a few mounts. Arming it is an operator action in the super-admin feature manager, deliberately not a code change — see the note in `super-admin/billing.js`.

`churn_risk_log` (migration 006) is real but unused, and its `client_id` points at the legacy `clients` table, not `pt_clients`. Nothing reads or writes it. Ignore it; do not extend it.

---

## 1. AI Form Check 2.0

**Today:** member uploads video to `pt_form_checks`, trainer writes timed comments in `pt_form_check_comments`. No analysis.

**Change:** on upload, a worker job extracts pose landmarks and writes a structured analysis. Trainer sees a pre-filled review: rep count, faults with timestamps, one corrective drill per fault, and a suggested program adjustment. Trainer approves or edits. Nothing reaches the member without that approval.

**Data touchpoints**
- Read `pt_form_checks` (`video_url`, `exercise`, `client_id`).
- New `pt_form_check_analysis`: `form_check_id`, `status` (`queued|done|failed`), `rep_count`, `faults` JSONB (`[{code, label, at_seconds, severity}]`), `model`, `confidence`, `raw`, timestamps.
- Add `source TEXT NOT NULL DEFAULT 'trainer'` (`trainer|ai`) to `pt_form_check_comments` — approved AI notes land here, so the member-facing read path does not change.
- Cost rows go to the existing `ai_usage_log`, keyed to the trainer's organization.

**Acceptance**
- 30s clip produces an analysis row within 60s; UI shows progress, not a blank screen.
- Rep count within ±1 of a manual count on the 20-clip reference set.
- Every fault timestamp within ±1.5s of true.
- AI never writes `pt_form_checks.status`, never writes programs, never messages the member directly.
- Analysis failure leaves the check `pending` and the current manual flow fully usable.

**Guardrail:** if confidence is low, surface "manual review only" instead of guessed faults. A wrong rep count costs more trust than no rep count.

---

## 2. WhatsApp Two-Way Inbox

**Today:** `whatsapp-webhook.js` handles connection events and delivery receipts, filters `fromMe`, ingests no inbound messages. Campaigns are CRUD-only with no send path.

**Change:** persist inbound messages, thread them by client, let the trainer reply from the app through the same instance.

**Data touchpoints**
- Read `whatsapp_instances`, `whatsapp_webhook_events`, `whatsapp_automation_settings`, `whatsapp_automation_trainer_grants` (permissions already modelled — do not invent a second permission system).
- New `whatsapp_messages`: `organization_id`, `instance_id`, `wa_message_id` (unique), `direction`, `from_e164`, `to_e164`, `client_id` (nullable), `body`, `media_url`, `status`, `occurred_at`.
- Phone → `pt_clients` match to fill `client_id`. No match = "unknown" queue, never an auto-created client.
- Replies reuse the existing sender; campaign send path builds on the same function.

**Acceptance**
- Inbound message visible in the trainer thread within 5s of the gateway event.
- Replayed webhook does not create a duplicate row (idempotent on `wa_message_id`).
- Trainer reply arrives on the member's WhatsApp and its delivery receipt updates the thread row.
- Unmatched numbers stay in the unknown queue and are not attached to anyone.

---

## 3. Retention Autopilot — **shipped 2026-11-01**

**Was:** the scoring, the list and the trainer action log all existed (see *Already built*), but nothing reached the trainer — retention was pull-only. A solo trainer had to remember to open `/pt-os/clients/at-risk`.

**Built:** a daily sweep that tells the trainer who crossed into high or critical, on all three channels — in-app, email and WhatsApp — with one tap to the existing screen. Trainer only, never the member.

Files: `modules/pt-os/churn.sweep.js`, `workers/churn.worker.js`, `db/migrations/252_churn_digest_deliveries.sql`, plus the `churn_digest` template and `recipientFromStudioTrainer()` in `notifications.service.js`.


**Data touchpoints**
- Reuse `buildChurnList(orgId)` unchanged — it already excludes snoozed and recently contacted clients via `pt_client_followups`, which is exactly the suppression a digest needs.
- Follow `progress.worker.js` exactly: same BullMQ shape, `upsertJobScheduler`, standalone-run block, registration in `workers/index.js` and `jobs/queue.js`.
- Exactly-once via a delivery ledger, as `progress_reminder_deliveries` does. Do not rely on the loop.
- No new scoring table. The list is cheap to recompute per org.

**Acceptance**
- One digest per trainer per day, containing only clients whose band is `high` or `critical`.
- A client the trainer snoozed today does not appear tomorrow.
- Zero digests when the list is empty — no "you have 0 at-risk clients" email.
- A failed send does not block the next day.
- No member-facing message of any kind.

---

## 4. Plan Gating

**Today:** the matrix exists and grants every feature to every plan. That is deliberate — migration 123 says so, and `super-admin/billing.js` documents enforcement as an operator decision, not a code change.

**Change:** none in code. Arming is a business decision and needs the customer count per plan before anyone flips a switch.

**What to actually do**
1. Decide which of the 17 feature keys belong to which tier. The pricing page already promises a mapping in `PLAN_FEATURES` (`PricingSection.tsx`); reconcile it with the real keys.
2. Check how many live studios sit on `starter` while using a feature you are about to gate. An org override is the escape hatch, and it is already modelled.
3. Flip `is_plan_gated` per feature in the super-admin feature manager, one feature at a time.
4. Add the in-product upgrade prompt at the point of need.

**Acceptance**
- No studio loses a feature it was actively using without an explicit, logged override.
- The pricing page and the enforced gates describe the same product.

---

## Success metrics

| Metric | Baseline | Target |
|---|---|---|
| Form checks reviewed within 24h | unmeasured | 90% |
| Trainer minutes per form check | ~8 (manual) | <3 |
| WhatsApp first response | unmeasured | <2h |
| Monthly active-client churn | unmeasured | −30% relative |

Instrument all four in the first release. Without the baseline, none of this is provable.

---

## Open decisions

1. **Pose extraction:** local worker (privacy, no per-minute cost) vs hosted vision API (faster to ship, ongoing cost). Decide before task 1 — it changes the worker footprint.
2. **AI cost ceiling:** cap per trainer per month? Free plan gets how many analysed clips?
3. ~~**Digest channel:**~~ **Decided 2026-11-01 — all three.** In-app, email and WhatsApp. `channelsFor()` sends each only when the trainer can actually receive on it, so a studio with no mobile on the `trainers` row silently gets two channels instead of three.
4. **Digest frequency:** daily is the shipped default. Revisit only if trainers report it as noise.

---

## Sequencing

Remaining, each shippable alone: WhatsApp inbox → AI form check (largest, needs the worker you already have).

Retention digest is shipped. Plan gating is not on this list because it is not a build — it is a business decision with an operator procedure.

