# AI Quota Behavior Matrix

Source of truth: `src/lib/aiQuota.js`. Tests pinning every row:
`src/__tests__/aiQuota.test.js`, `aiQuota.degraded.test.js`,
`aiQuota.failureMode.test.js`, and `ai.privacyAndMetering.test.js`.

The standalone assistant (`mps-ai`) is retired. The Client Assistant runs at
`POST /api/ai/client-agent/chat/stream`, mounted behind the same
`requireAiQuota()` as every other `/api/ai` route, and does not keep a second
quota opinion.

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
- Failure bias: **bounded fail-open**. The first `AI_QUOTA_FAILURE_ALERT_AFTER
  - 1` consecutive check failures pass (default threshold 3, so the first two
  errors), so a transient database blip does not take the AI suite down. At
  the threshold the check fails closed (503) — a sustained outage must not
  leave spend uncapped. Explicit `AI_QUOTA_FAILURE_MODE=fail-open` always
  passes; `fail-closed` refuses from the first failure.
- Degraded execution is not silent: every failure logs a warn, the streak
  escalates to error (`ai_quota_enforcement_degraded`), and
  `quotaEnforcementHealth()` exposes the state. Recovery logs
  `ai_quota_check_recovered` and resets the streak.

## ERP — `requireAiQuota()` / probe

| Situation / settings | Result | Code |
| --- | --- | --- |
| Request has no `organization_id` (e.g. platform operator) | **Pass** — there is no studio quota to spend | — |
| Enforcement off (default row or explicit) | Pass (over-limit allowed) | — |
| Enforcement on, under cap | Pass | — |
| Enforcement on, ≥ limit | **429** (numbers echoed on the error) | `AI_QUOTA_EXCEEDED` |
| Studio exempt (`organization_ai_limits` row with NULL) | Pass at any usage — `over`/`warn` never fire | — |
| No settings row (pre-migration database) | Pass — fail-open defaults | — |
| Check error, unset mode, streak **below** threshold | Pass + warn | — |
| Check error, unset mode, streak **at/above** threshold | **503** | `AI_QUOTA_UNVERIFIABLE` |
| Check error, `AI_QUOTA_FAILURE_MODE=fail-open` | Pass + warn (always) | — |
| Check error, `AI_QUOTA_FAILURE_MODE=fail-closed` | **503** from the first failure | `AI_QUOTA_UNVERIFIABLE` |

## Client Assistant

The mount in `src/server.js` is:

```js
app.use('/api/ai/client-agent',
  ...studioGate('ai_suite'), aiLimiter, requireAiQuota(),
  require('./routes/aiClientAgent'));
```

So entitlement, trainer role, rate limiting and the monthly allowance are all
decided before the handler can authorise a client or spend a token. A quota
refusal is an ordinary JSON 429 (`AI_QUOTA_EXCEEDED`) or 503
(`AI_QUOTA_UNVERIFIABLE`) — not an SSE event, because the stream has not opened.
Usage is written exactly once per answered turn to `ai_usage_log` with
`intent_type = 'client_agent'`; a caller who disconnects mid-answer is not
billed.

## Dangerous-mismatch notes

1. The agent must not add its own quota check. Two gates drift; one gate is the
   allowance.
2. A 503 here is deliberate: it means the allowance cannot be verified after a
   sustained failure, not that the model is down. The panel maps both the 429
   and 503 codes to distinct messages.
3. `fail-open` is an operator override for a known-good database path, not the
   default. Sustained failure must fail closed.

## Error-code cross-reference

| Where | 429 | 503 | Origin semantics |
| --- | --- | --- | --- |
| ERP suite + Client Assistant | `AI_QUOTA_EXCEEDED` | `AI_QUOTA_UNVERIFIABLE` (after streak, or explicit fail-closed) | Bounded fail-open; never fails open ON 429 paths |
