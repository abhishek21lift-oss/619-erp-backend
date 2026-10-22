# AI REMEDIATION — PR & CI READINESS PLAN (Phase 7)

> **Superseded 2026-10-22. HISTORICAL PLAN — DO NOT EXECUTE.** The standalone
> `mps-ai` service and its service-auth/ingest contract are retired; the Client
> Assistant runs in the ERP backend. The current production runbook is
> [`AI-CLIENT-ASSISTANT-CUTOVER.md`](./AI-CLIENT-ASSISTANT-CUTOVER.md).

Written 2026-10-21. **Read-only phase: audit + plan.** Nothing was committed, pushed,
stashed, cleaned, deployed or executed. The only file this phase adds is this document.
Evidence tags as in the Phase-6 doc: **[proven]** / **[assumption]** / **[not run]**.

Companion doc: `docs/AI-RELEASE-READINESS-PHASE-6.md` (historical Phase-6 record; the
current runbook above supersedes both for migration/config/deploy decisions).

---

## 1. Git inventory (verified this phase)

| Repo | Current branch | Upstream state | Dirty | Notes |
| --- | --- | --- | --- | --- |
| `619-erp-backend` | `fix/client-current-term-balance` | synced with `origin/…`; `origin/main..HEAD = 0` (merge-base = HEAD) | 23 M + 12 ?? | The user's balance fix (`9fa06ec`) is **already merged to origin/main**. ALL AI remediation here is uncommitted worktree diff. **Migration 218 is already tracked in HEAD/origin/main** (`git ls-files` verified). Only **234** is uncommitted. |
| `619-erp-frontend` | `refactor/client-profile-dedup` | **[behind 34]** | 52 M + 27 ?? | Remediation commits (`a374bad3` same-origin /ai routing, `406fc459` grounded-generation surfaces) are already pushed on this branch. Local worktree sits on an OLD base — do not push it as-is. |
| `mps-ai` | `ai-remediation-phase-1` | synced with `origin/…` | 5 M + 3 ?? (includes new `.github/workflows/ci.yml`) | CI triggers: push `main`/`staging` + `pull_request` (hermetic; no service containers). |
| `619-erp-whatsapp` | `feature/whatsapp-gateway-mvp` | synced | **0** | **Verification-only repo: nothing to PR.** ✓ clean. |

Stale machinery discovered: worktree-less branches `chore/post-audit-remediation`
(backend + frontend) point at deleted `/tmp/opencode/remediation/*` worktrees —
leftovers of a previous PR machine. Do not build on them blind; new branches in
fresh worktrees are cheaper than archaeology. Branches on other local worktrees
(`k11-worktrees`, `ptstaging`, `wt-be-cardio`…) are **user's parallel streams — untouchable**.

---

## 2. File-level ownership matrix

### 2.1 `619-erp-backend` — 23 M + 12 ??

**Remediation-owned (AI-coded, diff-verified):**

| File | Evidence |
| --- | --- |
| `infra/nginx/myptstudio.conf` (26 +) | diff = the `location /ai/` block → `127.0.0.1:4100`, one-route comment **[proven]** |
| `infra/nginx/README.md` (66 ±) | diff = same theme (mps-ai added to the loopback diagram + one-route rules) **[proven]** |
| `src/lib/ai/usage.js` (58 ±), `src/lib/ai/metering.js` (5 +), `src/lib/aiQuota.js` (15 ±) | attribution/metering/quota core |
| `src/routes/ai.js` (66 ±), `src/routes/aiServiceUsage.js` (22 ±) | `/test` endpoint + service-auth ingest |
| `src/modules/platform/super-admin/ai.js` (11 ±) | `COALESCE(l.organization_id, u.organization_id)` read paths **[proven in diff]** |
| `src/__tests__/superAdmin.aiControlCentre.test.js` (+12) | pinned-COALESCE test **[proven in diff]** |
| `src/__tests__/aiQuota.degraded.test.js`, `aiServiceUsage.test.js` | Phase-5 guarded suites (43/43 green) |
| `?? src/__tests__/ai.testEndpoint.guard.test.js`, `ai.usageAttribution.test.js` | new test files (464/464 AI lane) |
| `?? src/db/migrations/234_…sql` | org attribution + ingest idempotency (content verified this phase; 218 **already committed**) |
| `?? docs/AI-QUOTA-BEHAVIOR-MATRIX.md`, `docs/AI-USAGE-INGEST-RECOVERY-DESIGN.md`, `docs/MIGRATION-218-234-RUNBOOK.md`, `docs/MIGRATION-PREFLIGHT-218-234.sql`, `docs/AI-RELEASE-READINESS-PHASE-6.md` | Phase 5/6 documentation set |

**Inherited / user-owned (OUT of the AI PRs — branch's own workstreams):**

| File | Classification |
| --- | --- |
| `src/modules/pt-os/cardio.js` (775 +), `cardio.engine.test.js` (399 +) | user's cardio FITT work |
| `src/modules/pt-os/{pt-os.routes.js, pt-os.service.js, workout-generator.js, workout-generator.routes.js}`, `src/routes/{attendance.js, workouts.js}`, worksout tests + `?? attendance.bulk.test.js`, `?? ptOs.clientPage.test.js` | user's pt-os/balance/attendance stream |
| `src/db/pool.js` (59 ±) | **verified not-AI**: diff adds `withTenantSession()` pinned-connection perf path (AsyncLocalStorage) — tenant-read performance, not AI accounting |
| `?? src/__tests__/tenantReadSession.{test,integration}.test.js` | pair with `pool.js`'s withTenantSession; grep for AI terms: **none** → same user stream |

**Ambiguous: none** in backend (disjoint path sets, verified by content probes).

### 2.2 `619-erp-frontend` — 52 M + 26 ??

**Remediation-owned (diff-verified this phase):**

| File | Evidence |
| --- | --- |
| `src/lib/client-ai.ts` (8 ±) | `tenantAuthHeaders()` on the direct `/ai` fetch — the impersonation fix **[proven in diff]** |
| `.env.example` (15 +) | `AI_SERVICE_URL` unset-on-purpose doc **[proven in diff]** |
| `DEPLOYMENT.md` (45 ±) | "The AI service (mps-ai)" + single-route rule **[proven in diff]** |
| `src/__tests__/api-transport.test.ts` | scan widened to `/ai/` fetches; pins `client-ai.ts` header **[proven in diff]** |
| `src/__tests__/client-ai-stream.test.ts` (+65) | the impersonation regression test |

**Inherited / user-owned: everything else** — clusters: navbar/nav-IA + AppShell /
forms system (schemas + guardrails) / payments+balance+UPI / cardio calculator /
programme builder / attendance & weekly check-in / enrol+profile pages / portfolio —
plus `??` tests + specs matching those clusters, `scripts/form-audit/justifications.mjs`,
`FORM_SYSTEM_AUDIT.md`. Ambiguous junk: `?? .git-artifacts/` — leave alone (do not commit).

**Same-file collisions between remediation and user work: none in any repo**
(verified by inspection) → file-level application onto a clean branch suffices;
no hunk surgery required.

### 2.3 `mps-ai` — 8 dirty, all remediation-owned

`src/agents/client/agent.js`, `src/platform/context/untrusted.js`,
`__tests__/{contract-frontend,security}.test.js` (M) +
`?? .github/workflows/ci.yml`, `?? __tests__/{untrusted,usage-ingest-observability}.test.js`,
`?? docker-compose.snippet.yml` (loopback-only deploy config).

### 2.4 `619-erp-whatsapp` — nothing to classify (clean).

---

## 3. PR grouping (proposed; NOTHING opened this phase)

Branch recipe (applies to each PR unless noted): fresh `worktree` under
`/tmp/opencode/<prefix>-<scope>`, branch `chore/ai-remediation-<scope>` cut from
`origin/main` (backend proven 0 ahead; frontend must **ignore** its stale behind-34
local branch), apply ONLY the owned paths (`git diff -- <paths> > patch; git apply`
for modified; copy for untracked), run that PR's gates locally (§4), then — **only
with explicit approval** — push branch + open PR (this also unblocks CI, which keys
on `main`/`staging`/PRs).

| # | Repo / branch | Contents | Review focus | Coupling & risk |
| --- | --- | --- | --- | --- |
| **PR-M1** (first) | mps-ai, off origin/main | the 8 files (untrusted-context sanitization, agent hardening, security+observability tests, CI workflow, compose snippet) | security/reliability; the service-auth + `X-Service-Auth` contract it publishes | Independent; hermetic CI. Its ingest/quota contract is consumed by PR-B1. |
| **PR-B1** | backend, off origin/main | AI code (usage/metering/aiQuota/ai.js routes/super-admin org read) + 4 test files + **migration 234** + `infra/nginx/*` | validation/metering/attribution; 234 lock story per Phase-6 §5; nginx `/ai/` one-route contract | 218 is already on origin/main (schema columns exist after deploy; flip semantics documented there). PR-M1 should merge first (or same release train). |
| **PR-F1** | frontend, off origin/main | 5 files (client-ai.ts headers, env.example, DEPLOYMENT.md, 2 test files) | impersonation Bearer-identity path; single-route doc contract | Needs PR-M1/B1 merged to be fully exercisable, but test-safe standalone. Frontend CI lint ceiling 269. |
| **PR-D1** | backend docs, off origin/main | 5 remediation docs incl. preflight SQL + runbook + Phase-6/7 plans | docs + release procedures only — zero runtime impact | Can merge anytime; referenced by the release gate in PR-B1's review order. |

Order: **M1 → B1 → F1 → D1** (contract-first). WhatsApp: no PR — verification-only ✓.

Risk notes [proven]:
- Frontend stale-branch trap: `refactor/client-profile-dedup` is **34 behind** its
  upstream and holds the user's mid-flight refactor. Never push that branch for the
  AI PR; the fresh-branch recipe sidesteps it.
- Backend dirty diffs were audited against a branch whose tip IS the origin/main
  merge-base → applying the file-subset onto `origin/main` is equivalent-base; still
  re-run §4 gates on the new branch before opening.
- **Resolved while closing Phase 7:** `a374bad3` and `406fc459` (frontend remediation
  commits) are **both already ancestors of `origin/main`** (`git merge-base --is-ancestor`
  verified) — no cherry-pick needed for PR-F1.

---

## 4. CI & verification readiness (per PR gate)

| PR | CI that runs (proven workflow text, Phase 6) | Local pre-PR gate to run on the new branch |
| --- | --- | --- |
| PR-M1 | mps-ai `CI — Lint · Test` (hermetic, PR trigger) | `npm run lint && npm test` (56/56 baseline) |
| PR-B1 | backend `ci.yml` — lint `--max-warnings=0`, jest on `pgvector/pgvector:pg15`, RLS-proof DB | `npx eslint --max-warnings=0` over owned files; `npm test -- src/__tests__/ai*` (note: PDF suite needs the script's `--experimental-vm-modules` — use `npm test`, never bare `npx jest`) |
| PR-F1 | frontend `ci.yml` — lint(269), typecheck, `npm test`, scoring parity, playwright `--project=api` | same commands over the 5-file set; `npx playwright test --project=api` optional |
| PR-D1 | backend ci (lint may re-run on docs? jest skips; txt-only) | none required |
| whatsapp | — | none (repo untouched, clean, in-sync) |

Test evidence carried (Phase 5/6, exact counts in the Phase-6 doc): backend AI lane
464/464, touched suites 43/43, PDF 5/5 under `npm test`; mps-ai 56/56; lint clean.
**[not rerun this phase]** — re-run on fresh PR branches before opening (§3 recipe).

---

## 5. Execution gate

**This phase executed: audit commands + this document. Nothing else.**
Actions that require explicit approval before any actor performs them:
create worktrees/branches; apply the file-subset patches; run §4 suites on the new
branches; `git push` (also enables CI); open a PR; anything in the Phase-6 release
gate (migration/deploy/config).

Write-set of Phase 7: backend untracked count grew by exactly **one** file — this
document (`?? docs/AI-REMEDIATION-PR-CI-PLAN-PHASE-7.md`), re-verified below.
