# Staging — what it needs to be, and the cheapest thing that would work

A draft, not a decision. It exists because the RLS cutover in
`src/db/migrations/TENANT-RLS-PLAN.md` has a rollout order whose steps 2–4 all
say "on staging", and there is no staging.

## What was verified before proposing anything

Read out of the repository and its workflows, not assumed:

| Thing | State today |
|---|---|
| Deploy trigger | `deploy.yml` — `workflow_run` on CI success, `branches: [main]` only |
| Deploy target | One VPS, `secrets.HOST`, over SSH |
| Deploy method | `git pull --ff-only` → `docker compose build` → `run --rm migrate` → `up -d` |
| Rollback | `rollback.yml`, using `/opt/myptstudio/.backend-deployed-sha` written on the box |
| CI trigger | `ci.yml` — `branches: [main, staging]` |
| Database | One Supabase project, six live studios |
| Ingress | nginx: `myptstudio.com` → `:3000`, `api.myptstudio.com` → `:5000`, both loopback-bound |

Two of those deserve to be pulled out, because they shape everything below.

**`ci.yml` already builds a `staging` branch that has never existed.** The
trigger was written for an environment that was planned and not built. So the
CI half of this is already done; what is missing is a branch, a database and a
place to run.

**The compose file that actually runs is not in this repository.** The header of
`docker-compose.yml` says so plainly: the real one lives on the VPS at
`/opt/myptstudio/`, and the committed copy is a reference that has already
drifted — it declares a service named `api`, while `deploy.yml` builds and
starts one named `backend`. Any staging environment reproduced *from the repo*
would therefore not be a copy of production. That is worth fixing on its own
merits, and it is a prerequisite for a staging environment meaning anything.

## What staging is actually for here

Not "a place to click around" — that is a nice-to-have. The concrete job is:

> Find the code paths that break when the app connects as a role that cannot
> bypass RLS, **before** six live studios find them.

`TENANT-RLS-PLAN.md` step 4 calls this "the step that finds what the app quietly
relied on". Migration 159 already showed the shape of what is hiding there: the
eleven tables that would have returned zero rows, silently, were found by
running against a real database as `app_tenant` — not by reading code.

That framing matters because it rules an option in and an option out. Realistic
**request coverage** is what finds these; a database on its own does not. A
staging box nobody exercises would have found none of the eleven.

## Three options

### A. Ephemeral rehearsal — no new infrastructure

A Supabase branch (or any throwaway Postgres) stood up by
`scripts/rls-proof-setup.sh`, with the **existing E2E suite** pointed at an API
running as `app_tenant` with `TENANT_RLS_ENFORCE=on`.

The suite already exists — `scripts/e2e-setup.sh`, `scripts/seed-e2e.js`, and a
Playwright `api` project in the frontend repo — and it drives real HTTP requests
through real routes, which is exactly the coverage that surfaces permission and
scoping failures.

More than that: `e2e/tenant-isolation.api.spec.ts` is **already a cross-tenant
isolation suite**, over HTTP, against two seeded studios. It asserts that A's
client list never contains B's client, that A cannot fetch B's client by id,
that A cannot widen its own scope with an `x-org-id` header, that A cannot
record a payment or raise an invoice against B's client, and that B's data is
unchanged after every attempt.

Those are precisely the assertions the cutover needs re-run as `app_tenant`. The
work in option A is therefore not "write an isolation suite" — it is "point the
one that exists at a database where RLS is actually enforced". That is a
materially smaller job than it looked before reading the repository, and it is
the main reason this option is recommended over building an environment.

- **Cost:** none beyond Supabase branching, if that is on your plan.
- **Gets you:** the `tenant_scope_gap` list, the missing-grant list, and the
  super-admin zero-rows problem, all reproducibly, in CI.
- **Does not get you:** a URL to open, or a soak under real usage patterns.

### B. Staging on the same VPS

A second compose project on the existing box: `staging.myptstudio.com` →
`:3001`, `api-staging.myptstudio.com` → `:5001`, its own `.env.staging`, its own
Supabase branch, deployed from a `staging` branch by a copy of `deploy.yml`.

- **Cost:** no new hosting; roughly doubles memory and CPU demand on one box.
- **Gets you:** a persistent environment, and a rehearsal of the *deployment*
  step rather than only the database step.
- **Risk worth naming:** staging and production would share CPU, RAM and disk.
  A load test or a runaway migration on staging degrades six paying studios.
  Mitigable with compose resource limits; not eliminable.

### C. Separate VPS

Option B on its own box.

- **Cost:** another Hostinger instance, ongoing.
- **Gets you:** B, without the noisy-neighbour risk.
- **Honest assessment:** correct, and probably not yet justified for six
  studios and one engineer.

## Recommendation

**A now, B when a second engineer or a paying customer makes it necessary.**

A is not a lesser version of B for this purpose — it is a *better* one, because
the failures being hunted are found by request coverage, and the E2E suite has
more of that than a human clicking through staging would. It also lands in CI,
so the rehearsal repeats on every push instead of being a thing someone did once.

B remains the right answer for rehearsing *deployment* changes — nginx, compose,
env vars — which A cannot cover at all. That need is real but is not what is
blocking the cutover today.

## Option A, concretely

Roughly a day's work, in this order. Steps 1–3 are the cutover rehearsal; step 4
is what makes it repeatable.

1. **Stand up the database.** `scripts/rls-proof-setup.sh` already does this
   end-to-end — extensions, Supabase-compatible roles, `schema.sql`, all
   migrations, the `app_tenant` role. It has been run against a real PostgreSQL
   and is known to work. Give `app_tenant` a password out of band.

2. **Seed it with realistic multi-tenant data.** `scripts/seed-e2e.js` exists.
   It needs at least two organizations with overlapping-shaped data, or the
   isolation failures have nothing to show up against.

3. **Run the E2E suite against an API connected as `app_tenant`,** with
   `TENANT_RLS_ENFORCE=on`. Collect three lists:
   - every `tenant_scope_gap` warning `pool.js` logs (queries outside a
     transaction, which will not have `app.org_id` set),
   - every permission error,
   - every endpoint that returns empty where it should not — the silent class,
     which needs a comparison against the same run as `postgres` to detect at all.

4. **Add it to CI as a separate job.** Not inside the Jest job: it needs the
   API running, it is slower, and it should be allowed to fail independently
   while the list from step 3 is being worked through.

Then the production cutover is the same procedure with the flag flipped and
`DATABASE_URL` repointed — with the list from step 3 already empty.

## What must be decided by a human first

Two things block step 3 regardless of which option is chosen, and neither is a
patch:

**Platform-wide super-admin traffic reads zero rows.** A connection with no
`app.org_id` matches no strict policy, and `tenantScope`'s `applyFilter = false`
path resolves platform-wide operations to exactly that. Either the platform
console keeps its own `BYPASSRLS` connection, or `app.org_id` gains an explicit
platform-wide sentinel the policies honour. Recorded in migration 159.

**The authoritative compose file is not in version control.** Until
`/opt/myptstudio/docker-compose.yml` is reconciled with the repo, a staging
environment built from the repo is not a copy of production, and any deployment
rehearsal done on it proves less than it appears to.

## What this document is not

It is a proposal. Provisioning a Supabase branch, adding a DNS record, issuing a
certificate, or standing up a second VPS all require access to accounts and a
box that are outside this repository. Nothing here has been created.
