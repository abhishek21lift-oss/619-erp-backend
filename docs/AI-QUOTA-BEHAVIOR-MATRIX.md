# AI Quota Behavior Matrix (Phase 5C)

Source of truth: `src/lib/aiQuota.js` (ERP) and
`mps-ai/src/agents/client/agent.js:93-128` (service `checkQuota`). Tests
pinning every row: `src/__tests__/aiQuota.test.js`, `aiQuota.degraded.test.js`,
`ai.privacyAndMetering.test.js`; and `mps-ai/__tests__/contract-frontend.test.js`
(MPS-01). **This document describes behavior; Phase 5 changed no defaults,
policy, caps or billing.**

## Facts the matrix rests on

- One settings row (`ai_platform_settings`) carries
  `default_monthly_tokens`, `enforcement_enabled`, `warn_at_pct`.
  `loadSettings` fails open with `{ enforcement_enabled: false,
  default_monthly_tokens: null, warn_at_pct: 80 }` when the row is missing.
- `organization_ai_limits` rows: a row **with a value** caps just that studio
  (source `studio`); a row **with NULL** marks the studio EXEMPT
  (a deliberate operator decision, never collapsed into "no row"); absent row
  → platform default; neither → unlimited (source `none`).
- Usage measured per calendar month via `date_trunc('month', now())`,
  joined through `COALESCE(l.organization_id, u.organization_id)`.
- Failure bias: default **fail-open**; `AI_QUOTA_FAILURE_MODE=fail-closed`
  flips it to 503. Degraded execution is not silent: fail-open logs a warn per
  failure and escalates to error after 3 consecutive
  (`ai_quota_enforcement_degraded`), exposes `quotaEnforcementHealth()` state
  and logs `ai_quota_check_recovered` on recovery.

## ERP — `requireAiQuota()` / probe

| Situation / settings | Result | Code |
| --- | --- | --- |
| Request has no `organization_id` (e.g. platform operator) | **Pass** — there is no studio quota to spend | — |
| Enforcement off (default row or explicit) | Pass (over-limit allowed) | — |
| Enforcement on, under cap | Pass | — |
| Enforcement on, ≥ limit | **429** (numbers echoed on the error) | `AI_QUOTA_EXCEEDED` |
| Studio exempt (`organization_ai_limits` row with NULL) | Pass at any usage — `over`/`warn` never fire | — |
| No settings row (pre-migration database) | Pass — fail-open defaults | — |
| Any check error, `AI_QUOTA_FAILURE_MODE` unset (default) | **Pass** + warn → error after 3-streak | — |
| Any check error, `AI_QUOTA_FAILURE_MODE=fail-closed` | **503** | `AI_QUOTA_UNVERIFIABLE` |

## mps-ai — `AI_QUOTA_MODE` × ERP probe answer

The service never self-decides: the ERP's `enforcement_enabled` (from the same
settings) is what it obeys; `AI_QUOTA_MODE` is only the service's local posture.

| ERP probe answer | `off` | `monitor` (default) | `enforce` |
| --- | --- | --- | --- |
| No probe performed | ✔ skip | | |
| Under limit | | pass | pass |
| Over + ERP `enforcement_enabled: true` | | pass + warn `client_agent_quota_spent` | **429** refuse, `QUOTA_EXCEEDED`, no provider call |
| Over + ERP `enforcement_enabled: false` | | pass + warn | **pass + warn** — mode defers to the ERP switch |
| Probe errors / ERP unreachable | | pass + warn `client_agent_quota_check_unavailable` | **503 fail-closed** `QUOTA_UNVERIFIED`, no provider call |

## Dangerous-mismatch notes (review before altering either side alone)

1. `AI_QUOTA_MODE=enforce` while ERP `enforcement_enabled: false` must stay
   pass-through (new 5C test pins it). Flipping the service to self-enforce
   would double-gate studios the operator explicitly released.
2. `AI_QUOTA_MODE=off` on the service does not disable the ERP's own AI-suite
   guard — quota off means "this service doesn't gate", not "quota is gone".
3. `monitor` with a broken ERP probe = blind `monitor`: warn per turn (counted
   in logs, no alert rule yet). Enforce mode's blindness is loud by design
   (503 or, on the ERP, streak-error + `quotaEnforcementHealth`).

## Error-code cross-reference

| Where | 429 | 503 | Origin semantics |
| --- | --- | --- | --- |
| ERP suite | `AI_QUOTA_EXCEEDED` | `AI_QUOTA_UNVERIFIABLE` (fail-closed only) | Failure bias per env; never fails open ON 429 paths |
| mps-ai | `QUOTA_EXCEEDED` | `QUOTA_UNVERIFIED` | Enforce = fail-closed on unverifiable; monitor = fail-open |
