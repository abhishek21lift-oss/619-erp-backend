# The release contract across the three repositories

`619-erp-backend`, `619-erp-frontend` and `619-erp-whatsapp` deploy from three
repositories on three independent workflows. This file is the one place that
says which builds are a set.

## The problem this exists to solve

Before it, none of the three reported a version, a commit or a contract. The
backend's `GET /` returned a hardcoded `3.0.0` that no deploy had ever changed
and none could, because nothing wrote it. The gateway returned `package.json`'s
version, which changes roughly never. The frontend reported nothing.

Two ordinary questions therefore had no answer on a live system:

- **"Is the fix deployed?"** — answerable only by triggering the bug again.
- **"Do these three agree?"** — nothing anywhere recorded which commits were
  live together, so a rollback could restore a guess per service rather than a
  known-compatible set.

## Two numbers, and the difference matters

| | What it is | When it changes |
|---|---|---|
| `version` | the human release number, from `package.json` | any release, for any reason |
| `contract` | the wire surface **between** services | only on a breaking change |

`contract` is a plain integer and the compatibility rule is a floor
comparison — deliberately, rather than semver ranges. The rule these
repositories actually follow is "bump on a breaking change", and a floor says
exactly that with nothing left to interpret.

**Bump `contract` when, and only when, a change would break a peer running the
previous release:** a removed or renamed field, a narrowed type, a newly
required request field, a changed error code.

A peer that reports **no** contract is treated as **incompatible**, never as
"probably current". Before this existed every service reported nothing, so
assuming absence meant fine would make the check pass on exactly the builds it
exists to catch.

## Current matrix

| Service | Declares | Requires of its peer | Source |
|---|---|---|---|
| backend | `contract: 1` | gateway `>= 1` | `src/lib/release.js` |
| whatsapp gateway | `contract: 1` | backend `>= 1` | `src/release.ts` |
| frontend | — | backend `>= 1` | `src/lib/release.ts` |

## Where each service reports itself

| Service | Endpoint | Also |
|---|---|---|
| backend | `GET /api/health` → `.release` | `x-app-version` and `x-api-contract` on every response; one `release` boot line; `sha` on every log line |
| whatsapp gateway | `GET /healthz` → `.release` | one `release` boot line |
| frontend | `GET /api/health` → `.release` | `x-app-version` on every response |

`sha` is baked at **build** time through a Docker `ARG`. A production image has
no `.git` directory, so anything shelling out to `git rev-parse` at runtime
answers "unknown" on precisely the machine where the question gets asked.

`sha: "unknown"` is a real, reportable value and never an error — a locally
built image genuinely has no commit. Inventing one would put a value that looks
authoritative next to ones that are.

## What is enforced, and where

- **Before deployment** — `scripts/assert-gateway-seam.js` runs in the backend's
  CI against a **real** gateway process (the null connector, so no WhatsApp
  account is needed). It asserts both directions: the gateway's contract is one
  this backend can talk to, and this backend's contract is one the gateway can
  serve. It fails the build, not the deploy.
- **During deployment** — both deploy workflows ask the container they just
  started which commit it is serving and fail if it is not the one they built.
  `docker compose up -d` returning 0 means a container *started*; it does not
  mean it is serving, and it certainly does not mean it is serving the new
  code.
- **In the repository** — `src/__tests__/release.contract.test.js` keeps this
  file honest: the numbers in the table above must match the source.

## Which order to merge in

The seam check builds the gateway from its **default branch**
(`feature/whatsapp-gateway-mvp`, pinned in `ci.yml`), not from whatever branch
a paired change happens to live on. CI therefore asks: does this backend agree
with the gateway as it is *today*?

That has one consequence worth knowing before it costs an afternoon:

> **A backend change that raises what it requires of the gateway cannot go
> green until the gateway side has merged.** Merge the gateway PR first, then
> re-run the backend's seam job.

This is the check working, not a CI problem. A backend that requires something
the deployed gateway does not serve is exactly what the seam exists to catch,
and the branch a fix is sitting on is not what production runs.

It cost an afternoon once already: the backend PR introducing contract
checking failed 8/11 against a gateway built from a commit predating
`619-erp-whatsapp/src/release.ts`, which was correct and read at first like a
bug in the new checks. Each contract check now names that situation
explicitly — "the gateway reports no release block at all… deploy the gateway
first" — rather than dereferencing a block that is not there.

In the other direction there is no ordering constraint: the gateway may merge
whenever it likes, because raising the gateway's own contract cannot break a
backend that is already above its floor.

## Rolling back to a known-compatible set

Each deploy writes the commit it verified to a marker file on the box
(`.backend-deployed-sha`), and that file is advanced **only after**
verification passes. A failed deploy therefore leaves it naming the last commit
that actually served traffic.

To roll back, check each service out at the commits recorded in its marker
file and redeploy. Where the contract numbers differ between the current and
target sets, roll back the **whole** set — a floor comparison tells you whether
a partial rollback is safe, and the seam check will refuse the build if it is
not.
