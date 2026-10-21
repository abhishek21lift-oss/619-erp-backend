# AI remediation — Phase 11 corrections and the tenant-scope ratchet finding

This is an addendum. The Phase 6 and Phase 7 documents are point-in-time
records and are left exactly as written; nothing below rewrites them.

## 1. Corrections to the Phase-7 PR/CI plan

| Phase-7 said | What is actually true |
|---|---|
| PR-M1 branches "off `origin/main`" in mps-ai | mps-ai has no `main`. Its default branch is `claude/session-01dcjf1c88rf5nfdukc-o1vv0m-5l89cs`, which already consumed `ai-remediation-phase-1` via PR #2 (`eb12dd7`). That default branch is the repo's integration branch. |
| — (not anticipated) | mps-ai PR #3 was retargeted to that default branch (REST `PATCH /pulls/3`), and its `ci.yml` triggers (`push`/`pull_request`) were pointed at the real integration branch in commit `ad9ed95` after Phase 10 found the workflow filtered on nonexistent `main`/`staging`. CI verified running green on the PR. |
| Merge order M1 → B1 → F1 → D1, with PR-F1 | PR-F1 is obsolete: the frontend fix was merged upstream directly before publication, and no frontend PR exists. The order reads M1 → B1 → D1. |
| Phase-6 dirty counts (backend "34 dirty") | Point-in-time snapshot values; at publication the backend tree counted 36 dirty entries. The numbers were correct for the day they were recorded. |

## 2. The tenant-scope convention-ratchet finding (Phase 10/11)

### What CI showed

Backend PR #252's Jest failed one test: `tenantScope.convention.test.js ›
every file querying a tenant table references the tenant boundary`, naming

- `modules/command-center/ai-inventory.service.js` → `ai_usage_log`
- `modules/command-center/collectors/ai.collector.js` → `ai_usage_log`

Neither file is part of #252's diff, and a clean `main` checkout passes the
suite — the failure is deterministic and possessed of one cause:

### The mechanism

`tenantTables()` in the convention test derives the tenant-table set from the
migrations, using the retrofit form `ALTER TABLE x ADD COLUMN …
organization_id`. Migration **218** created `ai_usage_log` **without** an
organization column, so on `main` the table is not a tenant table and the two
readers above are invisible to the ratchet. Migration **234** (PR #252) adds
the column using exactly that retrofit form — making `ai_usage_log` a tenant
table and, correctly, surfacing the two pre-existing readers that aggregate it
without a recognized tenant-boundary reference. The ratchet was doing its job:
the migration that makes the ledger tenant-honest exposes the readers it
orphaned.

### The security decision (Phase 11)

Both readers are legitimately platform-global, not gaps:

- `ai-inventory.service.js` `usageByModel()` — a platform-wide, model-grouped
  30-day aggregate for the operator's AI Operations view. Its single caller is
  `GET /api/super-admin/command-center/ai/models`.
- `collectors/ai.collector.js` `collect()` — a background job with no request
  context at all (tenant-context state 1), reading today / last-hour /
  last-request / served-24h aggregates plus the `platform_ai_settings`
  singleton, deliberately sharing `COST_SQL` with `super-admin/ai.js`.

Both are consumed only through the `/api/super-admin` mount
(`auth → requireSuperAdmin → requireSuperAdminMfa → requirePlatformOwner`,
router opens `runAsPlatform`). Space-scoping either query would be the bug —
the operator card describes the platform, and tenant-context.js documents
platform-wide reads as an intended state.

Per the ratchet's own exception contract ("If the file is a genuine exception
… add it to REVIEWED_EXCEPTIONS with the reason it cannot leak" — and four
sibling command-center entries already exist on exactly this reasoning), the
fix adds both files to `REVIEWED_EXCEPTIONS` with their reasons, and the
collector now states its cross-tenant intent explicitly with `runAsPlatform`
(the documented purpose of that helper) instead of depending on the absence
of a context. No ratchet logic was weakened and no migration was changed.

Regression coverage: `commandCenter.aiOps.test.js` already pins the mount
matrix (a studio trainer is refused with 403; a super admin without MFA is
refused with 403; a super admin with MFA gets 200). `commandCenter.
tenantIsolation.test.js` gained the AI model inventory in its platform-wide
endpoint loop, and a new case proves the collector re-opens the platform
context even when invoked from inside a tenant context.

### Why the fix rides on the #252 branch

The violation exists only on trees that contain migration 234: on a clean
`main` branch, `ai_usage_log` is not a derived tenant table, so the two
`REVIEWED_EXCEPTIONS` entries would fail the ratchet's honesty test ("no
longer touches a tenant table — drop the exception") and there would be
nothing to fix. The orphaned-reader resolution therefore lands as a dedicated
commit on PR #252's branch, where its CI can actually prove the whole tree
green.

## 3. Migration status (unchanged)

Migration 218 is present in the base; migration 234 remains unexecuted
anywhere and requires the Phase-6 release gates (preflight + runbook) at
deploy time. Neither migration file was modified by any Phase 11 work.
