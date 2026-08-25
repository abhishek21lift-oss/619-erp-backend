# Command Center — Next-Level Reconstruction

This document is the implementation source-of-truth for the platform control plane.

## Protected architecture

- Tenant plane and platform plane remain separate.
- Platform access requires authentication, `super_admin`, MFA, platform-owner authorization, platform session boundary, and no active impersonation.
- Guardian diagnosis remains deterministic.
- AI may narrate verified findings but cannot create or alter diagnosis/severity/confidence.
- Operational commands remain allow-listed, confirmation-gated, cooldown-aware, and audited.
- Live logs and durable historical logs remain separate.
- Historical logs use bounded aggregates and keyset pagination.
- Tenant organization scoping remains mandatory.

## Implemented in this reconstruction pass

### Deterministic Platform Risk Engine

`src/modules/command-center/risk.service.js`

- 0–100 explainable risk score.
- Health, security, revenue, subscriptions, operations and support domains.
- Explicit unknown/unavailable domains.
- Guardian corroboration without allowing AI to determine the score.
- Deterministic severity bands: healthy, watch, elevated, high, critical.

### Risk API

`GET /api/super-admin/command-center/risk`

The route inherits the existing protected platform mount.

### Operator Action Center

`src/modules/command-center/action-center.service.js`

`GET /api/super-admin/command-center/action-center`

- Combines verified Guardian findings and live alerts.
- Produces an ordered operator queue.
- Never executes commands automatically.

### Testing

`src/__tests__/commandCenter.risk.test.js`

Covers healthy state, critical infrastructure, Guardian corroboration, and risk thresholds.

## Next implementation layers

1. Finish canonical `/api/platform/*` migration after consumer verification.
2. Add Overview 2.0 aggregation and lazy deep analytics.
3. Expand Guardian correlations and evidence-driven actions.
4. Enforce audit records for every privileged mutation.
5. Expand security/session center.
6. Add cross-domain incident drill-down.
7. Add realtime critical-alert/action updates.
8. Decompose remaining platform API domains without changing public contracts.
9. Add full Command Center integration/e2e coverage.

## Removal rule

No route, service, component, middleware, table, or compatibility layer may be removed until repository-wide consumers and security responsibilities have been verified.
