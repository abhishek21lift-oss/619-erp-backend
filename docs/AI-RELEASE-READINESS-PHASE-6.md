# AI RELEASE READINESS — PHASE 6 (read-only consolidation of Phases 1–5)

> **Superseded 2026-10-22. HISTORICAL RECORD — DO NOT EXECUTE COMMANDS FROM
> THIS DOCUMENT.** The standalone `mps-ai` service has been retired. The Client
> Assistant now runs in this backend at
> `POST /api/ai/client-agent/chat/stream`, behind `ai_suite`, trainer auth, the
> AI rate limiter and `requireAiQuota()`, and writes usage to `ai_usage_log`
> in-process. The `SERVICE_AUTH_SECRET` / `X-Service-Auth` bridge, the nginx
> `/ai/` block and the frontend `AI_SERVICE_URL` rewrite are gone.
>
> **The current production runbook is
> [`docs/AI-CLIENT-ASSISTANT-CUTOVER.md`](./AI-CLIENT-ASSISTANT-CUTOVER.md).**
> Sections 4, 5 and 6 below still contain the retired mps-ai checklist, SQL
> gate and deployment order; they are preserved as the Phase 6 record and must
> not be followed. Nginx now needs the `/api/ai/` SSE block on **both** vhosts,
> not a `/ai/` route.

Written 2026-10-21. **This phase changed nothing except this document.**
No new code, no migration change, no deploy, no SQL execution anywhere.

Confidence tags used throughout:
- **[proven]** verified in the repositories (code read; tests read/run on this machine);
- **[needs live]** requires production evidence — an operator command is supplied;
- **[assumption]** reasoned from code/behavior but not exercised;
- **[not run]** was not executed at all in this session.

---

## 1. Repository state at consolidation (preserved)

| Repo | Branch | Dirty files | Notes |
| --- | --- | --- | --- |
| `619-erp-backend` | `fix/client-current-term-balance` | 34 (23 M + 11 untracked) | Phases 1–5; migrations 218/234 in `src/db/migrations/` |
| `619-erp-frontend` | `refactor/client-profile-dedup` | 79 (27 ?? + 52 M; Phase-7 recount corrected an off-by-one tally) |AI-relevant surfaces only: env example + impersonation header wiring |
| `mps-ai` | `ai-remediation-phase-1` | 8 (5 M + 3 untracked) | client-agent, security/untrusted tests, CI workflow |
| `619-erp-whatsapp` | `feature/whatsapp-gateway-mvp` | **0 (clean)** | untouched by the AI remediation (verified in §2) |

Nothing was reset, stashed, cleaned, checked out over, committed or pushed.

---

## 2. Verified change inventory (Phases 1–5) — proven vs assumed

| Remediation item | Where | Evidence status |
| --- | --- | --- |
| **History sanitization** (untrusted context class) | mps-ai `src/platform/context/untrusted.js`; `__tests__/untrusted.test.js` | **[proven]** suite green on this machine: mps-ai `npm test` 56/56 (run in Phase 5) |
| **Frontend `/ai` routing + impersonation headers** | nginx owns `/ai/` → `127.0.0.1:4100` (`infra/nginx/myptstudio.conf` — `proxy_buffering off`, 300 s read timeout, `proxy_pass` **without a URI part**); `AI_SERVICE_URL` deliberately unset in the frontend `.env.example` (single-route rule: the Next.js rewrite activates **only** when it is set); `http.ts` `IMPERSONATION_KEY = '619_impersonation'` — identity is carried by the **Bearer token** (while impersonating, that token IS the impersonated studio's), no separate tenant header; `ai-stream.ts` and `client-ai.ts` attach `tenantAuthHeaders()` to their `/ai` calls | **[proven]** in repo code / **[needs live]** for rendering + reachability (§4) |
| **Service authentication + tenant authorization** | backend `src/routes/aiServiceUsage.js`: `X-Service-Auth` = shared secret; identity resolved server-side from the forwarded user token; forged identity from the body refused; 401 / 403 / 503 fail-closed paths tested (`aiServiceUsage.test.js`) | **[proven]** |
| **`/api/ai/test` validation + metering** | `src/routes/ai.js` (endpoint `/test`): `auth, requireTrainer, requireConfigured`; 32 KiB body cap (413 `PAYLOAD_TOO_LARGE`); 400 `BAD_INTENT` / `BAD_PROMPT`; 413 `PROMPT_TOO_LONG`; bare body → boot-check prompt (`Say "MY PT STUDIO AI is ready" …`); execution through `meteredChat(req, intent, routedChat)` — spend metered (≤ 50 max_tokens), usage logged, fallback attribution honest | **[proven]** (`ai.testEndpoint.guard.test.js`). ⚠ Not `requireAiQuota`-gated — see Risks #1 |
| **Provider/routing attribution + idempotency** | `src/lib/ai/usage.js`: `provider` labeled from the configured base (`openrouter` vs `openai_compatible`), `routed_via` from the route file, `INSERT … ON CONFLICT (request_id, user_id) … DO NOTHING RETURNING id`; mps-ai `requestId` = UUID per turn; ledger rows retained locally as audit evidence | **[proven]** `ai.usageAttribution.test.js` (43/43 in Phase 5) and full backend AI lane `src/__tests__/ai` 464/464 (35 suites) |
| **Organization-aware usage reporting** | migration 234 columns; reads via `COALESCE(l.organization_id, u.organization_id)`; organization from the authenticated context only; **no backfill** | **[proven]** tests + SQL-text assertions; **[needs live]** the first attributed row after deploy (§6 step 6) |
| **Quota failure behavior** | ERP `src/lib/aiQuota.js` + mps-ai `checkQuota` — full matrix in `docs/AI-QUOTA-BEHAVIOR-MATRIX.md`: ERP fail-open default with `ai_quota_check_failed` → streak error `ai_quota_enforcement_degraded` → `ai_quota_check_recovered`, `quotaEnforcementHealth()`, fail-closed 503 `AI_QUOTA_UNVERIFIABLE` behind `AI_QUOTA_FAILURE_MODE=fail-closed`; mps-ai modes `off/monitor/enforce` with deference to the ERP's `enforcement_enabled` switch (fail-closed 503 `QUOTA_UNVERIFIED` when `enforce` and the probe errors) | **[proven]** `aiQuota.test.js`, `aiQuota.degraded.test.js`, mps-ai `contract-frontend.test.js` (29/29 incl. new 5C cells) |
| **Migrations 218 & 234** | `src/db/migrations/218_ai_usage_accounting_and_quota.sql` (3 columns + `ai_usage_source_check` + **enforcement flip**) and `234_ai_usage_organization_and_upstream.sql` (`organization_id`, `routed_via`, org index, partial unique `(request_id, user_id)`); both idempotent (`IF NOT EXISTS` throughout) | **[proven]** SQL text reviewed line-by-line in Phases 4–5; **[not run]** against any database — release gate in §5 |
| **Failed-ingestion observability + recovery limits** | mps-ai: exactly one `usage_ingest_failed` warn per turn, no retry loop; ERP typed 503 `USAGE_LOG_UNAVAILABLE`; same-request re-delivery is idempotent; design doc `docs/AI-USAGE-INGEST-RECOVERY-DESIGN.md` states the durable-recovery boundary honestly (expired JWTs, identity resolution contract, in-process-only 'ai' queue) | **[proven]** tests; durable automation **[assumption]** = not implemented by design |
| **Integration boundaries** | browser → nginx `/ai/` → mps-ai directly (same-origin, cookie intact; the ingest endpoint keeps the service-auth pair on `/api/ai/usage/service/*`); **WhatsApp has no AI boundary** — no matches for `ai/client-agent`, `/ai/`, `AI_API`, `openrouter` anywhere under `619-erp-whatsapp/src`; backend ↔ whatsapp is joined only by the gateway HTTP-contract test job in backend `ci.yml` | **[proven]** in repo; live reachability **[needs live]** (§4) |

---

## 3. CI and test readiness

**Tests executed during the remediation (artifacts from this machine; NOT rerun in this phase; no CI claim):**

| Suite | Command used | Result |
| --- | --- | --- |
| backend touched suites (`aiQuota.degraded`, `ai.usageAttribution`, `aiServiceUsage`) | `npx jest <files>` | **43/43 passed** |
| backend full AI lane (`src/__tests__/ai`) | `npx jest` (all but the PDF suite) / `npm test` for the PDF suite | **464/464 passed** (35 suites) |
| backend PDF-extraction suite (`ai.textExtract.test.js`) | `npm test` (the canonical script) | **5/5 passed** |
| mps-ai full suite | `npm test` | **56/56 passed** |
| lint over all changed files | `npx eslint --max-warnings=0` | **clean** (backend + mps-ai) |

**`@napi-rs/canvas` investigation — resolved, nothing changed [proven]:** the one failure seen earlier was an **invocation artifact of running `npx jest` directly, not a repository defect**. Chain verified: `src/lib/ai/textExtract.js` → `pdf-parse@2.4.5` → `pdfjs-dist@5.4.296` → `@napi-rs/canvas@0.1.80`. The real error text is from pdf.js's fake-worker setup: **"A dynamic import callback was invoked without --experimental-vm-modules"** — jest's CommonJS sandbox reaches an `import()` inside `pdfjs-dist/legacy/build/pdf.mjs`, and the native-canvas frame (`requireNative` in `@napi-rs/canvas/js-binding.js`) is merely the fallback probe inside that path. Evidence that nothing is broken locally: both prebuilt binaries exist (`node_modules/@napi-rs/canvas-linux-x64-gnu/skia.linux-x64-gnu.node`, `…-musl/skia.linux-x64-musl.node`), and plain Node loads the chain fine (`node -e "require('pdf-parse')"` succeeds; host x86_64, Node v24.21.0 ABI 137). The repo's canonical script — `package.json` `"test": "NODE_OPTIONS=--experimental-vm-modules jest --forceExit --detectOpenHandles"` — sets the flag, and **under `npm test` the suite passes 5/5**. Jest also surfaced a benign `CustomGC` open handle, which `--forceExit` covers. **No dependency change, no native rebuild, no test skipped.**

**What CI covers and what it does not:**

- `619-erp-backend/.github/workflows/ci.yml` **[proven from the workflow text]** — lint job (`npm run lint -- --max-warnings=0`) + jest job on a `pgvector/pgvector:pg15` service (`DATABASE_URL=…/test_619`, `npm test -- --passWithNoTests`), with the RLS isolation database stood up (`RLS_TEST_DATABASE_URL=…/rls_proof?sslmode=disable` via `./scripts/rls-proof-setup.sh`) so tenant-isolation suites prove isolation against a **real** database; jest testMatch picks up everything under `src/__tests__/**`, hence all AI remediation suites and the 218/234 SQL-text assertions.
- **CI triggers key on `main`/`staging` (and PRs → `main`); the remediation branches are unpushed and uncovered — CI has NOT run against this diff. [needs live]** §6 step 1 (open PRs / `workflow_dispatch`) is the moment the workflows actually see the code. mps-ai's CI is fully hermetic (no service containers; fake ERP adapter and fake provider against the real `buildApp`).
- `619-erp-frontend/.github/workflows/ci.yml` — `npm run lint -- --max-warnings=269` (an intentionally absorbed backlog, not zero), `npm run typecheck`, `npm test`, scoring parity, and `npx playwright test --project=api`. **[not run]** — the frontend changes are uncommitted and have never met CI this session.
- `619-erp-whatsapp/.github/workflows/ci.yml` — per its own header, PR-time typecheck/tests/build; branch clean; not part of this remediation. **[not run]**
- `backup.yml` (off-site pg_dump), `cc-recovery.yml` (manual-only recovery helper: inspect/apply/verify from the main checkout on the VPS), `rollback.yml` (redeploy; expects the additive-migrations pattern).
- `deploy.yml` runs `<compose svc> npm run migrate` inside its pipeline. **The migrate runner reads ONLY `src/db/migrations/*.sql`** (verified: `src/db/migrate.js` lists `path.join(__dirname, 'migrations')` and filters `.sql`). The `docs/` directory is not scanned; the only `docs/` references in any workflow are prose mentions (DISASTER-RECOVERY / CC-recovery). **The runbook and the preflight SQL cannot be auto-executed by any pipeline or by each other.**

---

## 4. Production configuration checklist (HISTORICAL — DO NOT RUN)

All items **[needs live]**. Run on the VPS via SSH where marked; every probe below tests **presence or wiring**, not content.

```bash
# 1. Single-route contract: AI_SERVICE_URL must be UNSET while nginx owns /ai/
grep -c '^AI_SERVICE_URL=.' <frontend-env-file>          # expect 0
# (If it ever becomes non-zero, remove the nginx /ai/ block in the same change — never both routes active.)

# 2. nginx /ai/ route + streaming posture
sed -n '/^# Client-agent AI/,/^}/p' /etc/nginx/sites-available/myptstudio.conf \
  | grep -E 'location /ai/|proxy_pass|proxy_buffering|proxy_read_timeout'
nginx -t 2>&1        # expect "syntax is ok / test is successful"

# 3. mps-ai required env present (zod boots hard when any is missing)
docker compose … exec -T mps-ai env \
  | grep -oE '^(ERP_BACKEND_URL|SERVICE_AUTH_SECRET|ALLOWED_ORIGINS|AI_QUOTA_MODE)' | sort
# ALLOWED_ORIGINS must list the exact HTTPS origin the browser uses; "*" is boot-refused by config.

# 4. Service-auth pairing: compare HASHES, not values
a=$(docker compose … exec -T mps-ai        printenv SERVICE_AUTH_SECRET | sha256sum | cut -c1-12)
b=$(docker compose … exec -T <backend svc> printenv SERVICE_AUTH_SECRET | sha256sum | cut -c1-12)
test "$a" = "$b" && echo PAIRED || echo NOT-PAIRED

# 5. Quota failure mode (presence-only; expect UNSET = the tested default fail-open)
docker compose … exec -T <backend svc> printenv AI_QUOTA_FAILURE_MODE || echo UNSET(fail-open)

# 6. Ingest endpoint lives — probe WITHOUT any secret: bare POST must answer 401 (route + auth enforced), never a connection error
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$ERP_URL/api/ai/usage/service/ingest" \
  -H 'Content-Type: application/json' --data '{}'      # expect 401

# 7. AI-suite health through the gateway without any secret in the shell:
#    open the studio app, then in the logged-in browser console:
fetch('/api/ai/test',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(r=>r.json())
#    expect {success:true, model:"…", latency_ms:…} (≤ ~50 tokens of spend)
#    And the Ask AI panel: one streamed turn over /ai/ — deltas arrive incrementally.

# 8. mps-ai reachability on the box
docker compose … ps mps-ai        # Up + published 127.0.0.1:4100
```

- **pgvector prerequisite [needs live]:** the migrations (046/116) require the vector extension. Verify in the operator SQL session: `SELECT extname FROM pg_extension WHERE extname='vector';` — expect one row. CI uses image `pgvector/pgvector:pg15`; production must be the same family.
- `/api/ai/test` over `/ai/`: metered spend is ≤ ~50 tokens per call; it asserts provider routing + honest fallback attribution, NOT quota posture.

---

## 5. Migration 218/234 release gate (HISTORICAL — see current runbook)

**Blocker #0 — backup/restore verified.** `backup.yml` pg_dumps off-site; the operator shows a dump produced within 24 h AND a restore exercised per `docs/DISASTER-RECOVERY.md`. **NO-GO without both.**

### A. Ordered read-only preflight — run BEFORE any deploy that would migrate
One command, all SELECTs:
```
psql "$DATABASE_URL" -f docs/MIGRATION-PREFLIGHT-218-234.sql > preflight-$(date +%F).txt
```

| § | Go/No-Go observation |
| --- | --- |
| 0 | table size workable for an in-transaction index build — seconds-scale expected; minutes+ → choose the CONCURRENTLY path below |
| 1 | which of 218's columns already exist (re-runs stay safe: `IF NOT EXISTS`) |
| 2 / 2b | exactly the settings row(s) the 218 flip will touch — expected 0–1; informational, decides whether the flip changes anything at deploy |
| 3 / 3b | **duplicate `(request_id, user_id)` groups: 0 required. Any ≥1 = NO-GO** (the unique build aborts; duplicates must be resolved manually first — not covered by any phase, deliberately) |
| 4 / 5 | historical NULL-org rows (any count — they stay unknown by design); orphan user rows expected 0 |
| 6 | whether `ai_usage_request_key` already exists (yes → the 234 index portions no-op) |
| 7 | no long-running non-idle transactions holding locks (they queue the builds) |

### B. The exact 218 flip [SQL semantics proven; execution [not run]]
```sql
UPDATE ai_platform_settings
   SET enforcement_enabled    = TRUE,
       default_monthly_tokens = 3000000,
       updated_at             = NOW()
 WHERE default_monthly_tokens IS NULL
   AND enforcement_enabled     = FALSE;
```
- Affected: precisely the rows listed by preflight §2 (expected: the single settings row on a legacy install where nobody chose anything).
- **At deploy time every studio without an explicit decision becomes capped at 3,000,000 tokens/calendar month with enforcement ON**; `requireAiQuota()` goes from always-pass to possibly-429 (`AI_QUOTA_EXCEEDED`).
- Unaffected: rows with any explicit `default_monthly_tokens`, rows already enforced, and per-studio `organization_ai_limits` rows — including legacy-exempt (NULL) rows, which stay over-limit-pass.
- The flip is DATA, not schema: reversing it later = `enforcement_enabled = FALSE` on the row (Command Center or SQL). Re-running 218 cannot undo it (the WHERE clause is exhausted).

### C. Lock risk and scheduling for 234 [semantics proven; sizing [needs live]]
- `ALTER TABLE ADD COLUMN IF NOT EXISTS` on `ai_usage_log`: brief ACCESS EXCLUSIVE catalog operations — practically seconds.
- Both `CREATE INDEX` statements are **plain builds that hold ACCESS EXCLUSIVE for the duration**, blocking concurrent INSERTs (and reads) on `ai_usage_log`.
- If preflight §0 shows minutes-scale size: run the two `CREATE INDEX CONCURRENTLY …` statements manually OUTSIDE the migration transaction during the deploy window, then `npm run migrate` re-runs and no-ops (the runner's transactions cannot host CONCURRENTLY).
- The unique build aborts on any duplicate key — a second reason preflight §3/3b must be zero first.
- Postflight: `SELECT indexdef FROM pg_indexes WHERE indexname LIKE 'ai_usage%';` shows both indexes; the first real turn lands with `request_id` set and `organization_id` populated; repeat preflight §3b → still zero.

### D. GO / NO-GO
**GO:** verified restore point; preflight §3b = 0; §7 lock window clean; release manager named; §6 rollback triggers acknowledged.
**NO-GO:** any duplicate group ≥ 1; index build un-sizable under plain CREATE INDEX without the CONCURRENTLY alternative agreed; restore-point gap; missing `vector` extension; unmatched `SERVICE_AUTH_SECRET` pairing; §4 checks in fail.

---

## 6. Deployment & smoke-test plan (HISTORICAL — DO NOT RUN)

1. **Pre-deployment:** backup verified (Blocker #0) → §4 checklist (presence + pairing) → §5 preflight captured with GO observations → open PRs / merge branches and **read the actual CI runs** for backend, mps-ai, frontend, whatsapp (today **[not run]**).
2. **Order & version compatibility:** recommended **backend first, mps-ai second, frontend last.** Rationale: `deploy.yml` runs migrations in the backend pipeline BEFORE replacing the container, so the schema (218/234) is in place when any new code runs; both sides of the service-auth/ingest contract are forward-compatible in either order (proven contract tests), so the pairing check in §4 is the real gate. `AI_SERVICE_URL` stays unset while nginx keeps `/ai/`. WhatsApp: unrelated to this release, deploys independently (`deploy-vps.yml`).
3. **Migration execution:** let `deploy.yml` run `npm run migrate` under advisory lock 619619619. Compare "applied: N" in the deploy log against the preflight prediction (expected: 218 and/or 234 — 0 if already applied).
4. **Health & streaming smoke tests:** `/api/ai/test` boot-check speaks (success + model + latency); Ask AI panel streams deltas over `/ai/` (watch `docker compose logs -f --since=5m mps-ai` for `client_agent_answered`, `client_agent_quota_blocked` when applicable).
5. **Tenant isolation & impersonation regression [needs live]:** as the platform admin, enter the studio (impersonation cookie `619_impersonation`), open Ask AI, and confirm the turn runs AS the studio (ledger row + organization derive from the impersonated studio's token, not the admin's); verify no separate tenant header is involved and the same origin/cookie path works; scrub the audit trail for the impersonation pair.
6. **Usage ledger & organization attribution [needs live]:** one turn → exactly one row carrying `request_id` and `organization_id`; re-deliver the same turn (same requestId) → `202 {ok:true, duplicate:true}` and still one row; turn from a second studio → second row with its own org; spot-check with
   `SELECT organization_id, count(*) FROM ai_usage_log GROUP BY 1 ORDER BY 2 DESC LIMIT 5;`
7. **Quota verification without touching customer settings [needs live]:** read-only `GET /api/ai/usage/service/quota` (numbers only) and the Command Center AI page readouts; record tokens_used / limit / enforcement flags per studio. DO NOT change enforcement or limits on live data without a separate approved change (except the post-218 flip row itself, if an operator decides to disable enforcement).
8. **Rollback triggers, owners, and recovery limitations:** owner = release manager + platform operator. Triggers: any smoke failure (§6 steps 4–7), unexplained error-rate drift, usage/revenue attribution anomalies, or a failed postflight re-check. Rollback path **[proven semantics]**:
   - **Redeploy the previous backend image via `rollback.yml`; the migrations STAY deployed.** No down-migration exists, and dropping the new columns while remediated code runs is NOT safe (the COALESCE read paths reference them). A pre-remediation image functions against the deployed columns — they are additive and nullable, and the legacy writer never references them — so image-only rollback is safe, data-level rollback is a full psql restore from the verified backup (last resort).
   - mps-ai rolls back independently (its own image); note its `enforce` mode is deliberately fail-closed when quota is unverifiable (ERP down ⇒ AI answers refused) — that is by design, not a bug to roll back.
   - Decisions and re-verification after any rollback land back in this document's §5 postflight checks.

---

## 7. Unresolved risks & explicit assumptions

1. **`/api/ai/test` is not quota-gated [verified in code, unchanged by design this session.]** Authenticated trainers hit it with ≤ ~50 tokens of metered spend per call and a 32 KiB body cap, but volume is unbounded — a determined user could still accumulate usage that bypasses the 429 (while being fully accounted). Decision needed post-approval: add `requireAiQuota` or a rate limit. Everything else the endpoint validates (payload caps, intent/prompt typing, provider routing, metering honesty) is proven by tests.
2. **The 218 flip is a real, deliberate behavior change at deploy time** (documented §5B; reversible at the data level, not by re-running the migration).
3. **`enforcement_enabled=false` semantics** mean the cap is not the enforcement: meters move but 429s do not fire until the switch is on (or the 218 flip turns it on for rows that never chose).
4. **mps-ai durable ingestion recovery is intentionally absent** — the design doc explains the identity resolution boundary and proposes the `userRef` option behind an approved contract change and a new secret. Until then, replay failures count lost rows via ledger request-ids only (no attribution), and the loss window remains explicitly an operator/monitoring concern, not an automatic recovery.
5. **CI on `main`/`staging`/PRs→`main` only: none of the remediation branches have entered CI.** The "everything green" claim in §3 is from local runs on this machine, exact commands and counts shown — treat it as a strong pre-merge signal, not a CI proof.
6. **Assumption:** production stays on the tested defaults post-release — `AI_QUOTA_MODE` unset or `monitor`, `AI_QUOTA_FAILURE_MODE` unset (fail-open), `AI_SERVICE_URL` unset, single `/ai/` route. Any deviation requires re-reading `AI-QUOTA-BEHAVIOR-MATRIX.md` before deploy.
7. **[not run]** pricing / `cost_inr` accuracy: cost columns land with 218, but pricing verification is a separate workstream; nothing in this remediation altered rates or billing.

---

**Stop-after-Phase-6:** awaiting explicit approval before any merge, deploy, migration execution, configuration change, or follow-on implementation work.
