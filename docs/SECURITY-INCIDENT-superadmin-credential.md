# Security incident — platform super-admin credential published

**Status:** contained in the working tree; **rotation is outstanding and is the
operator's action.**
**Severity:** critical — platform-wide, cross-tenant.
**Found:** during the P0 remediation pass, by reading the migrations rather
than from a prior audit report.

---

## What happened

`src/db/migrations/131_rename_platform_super_admin.sql` committed a live
bcrypt hash for the platform super-admin account. `091_seed_platform_super_admin.sql`
did the same for the address it replaced.

Both files carried a header arguing this was safe:

> The password is stored only as a bcrypt hash (cost 12 …); the plaintext was
> delivered out-of-band and is not in git.

Both halves of that are true, and both miss the risk. A bcrypt hash is not a
public value. It is an offline-crackable copy of the credential: an attacker
with the hash can test candidate passwords locally, at their own pace, with no
rate limit, no lockout, no logging and nothing to alert on. Cost 12 makes that
slow per guess; it does not make it impossible, and it offers nothing at all if
the password is guessable.

## Why it is critical rather than untidy

Four facts verified against the live system, not assumed:

| Fact | How it was checked |
|---|---|
| The committed hash is **still the live one** | SHA-256 fingerprint of the hash in migration 131 compared to `digest(password,'sha256')` for the production row. Identical (`286f9ac1…`). Neither value was printed at any point. |
| The account is **active** | `users.is_active = true`, `role = 'super_admin'`, id `usr-superadmin-001`. |
| It has **cross-tenant authority** | `platform_owners` grant + `role='super_admin'`; the platform console reaches every one of the 6 organizations. |
| **MFA is off**, so the password is the only barrier | `user_profiles.mfa_enabled = false` for that account. The gate in `middleware/tenant.js` reads exactly that column. |

And the multiplier:

**The `619-erp-backend` repository is public.** Confirmed via the GitHub API
(`"private": false`, `"visibility": "public"`). The hash was not merely in
version control — it was published, world-readable, to anyone who cloned or
browsed the repository, for as long as it has been public.

Assume the hash is captured. There is no way to know whether it was, and
nothing in the design makes it detectable.

## What was done in this change

Working-tree containment only. No live credential was touched.

- **Both migrations redacted.** The hashes are replaced with a locked
  placeholder: `$2a$12$` followed by 53 `.` characters. It is a syntactically
  valid bcrypt string that **no input produces**, verified by test — so a
  freshly built database now seeds a super-admin row that exists and cannot
  be signed into, instead of one carrying a known-good platform credential.

  This edit is a no-op for production and every other existing database.
  Migration 091 is guarded by `WHERE NOT EXISTS`, migration 131 matches the
  *old* email address and stops matching after its first run, and the runner
  applies nothing already recorded in `_migrations`. It changes only databases
  built from scratch.

- **`scripts/rotate-super-admin-password.js`** added — the safe rotation path
  (see runbook below).

- **`src/__tests__/noCommittedSecrets.test.js`** added — fails the build if any
  bcrypt hash is committed under `src/`, `scripts/`, `infra/` or `db/`. Verified
  by planting a real hash and watching it fail, then removing it and watching
  it pass. It reports the *file*, never the hash: a CI log is often more public
  than the file it protects.

  A comment saying "don't do this" would not have prevented the second
  occurrence, because whoever wrote 131 was following 091 as precedent.

## What redaction does NOT do

**It does not un-publish anything.** The old hashes remain in the git history
of a repository that has been public. Any clone, fork, fetch, or cached view
still has them. Rewriting history (`git filter-repo`, force-push) would remove
them from this repository's future, not from copies already taken, and it
rewrites published commits — an operator decision, not one to take on someone's
behalf.

**Rotation is what removes the value of the leaked hash. Until the password is
rotated, the exposure is live.**

---

## Runbook — rotate the credential

Run from a machine that can reach the production database. Nothing here writes
a secret to the repository, the deploy log, the shell history or a process
list.

### 1. Rotate the password

```bash
# Interactive: the password is prompted for and not echoed, so it does not
# land in shell history or a scrollback.
DATABASE_URL='<production connection string>' \
  node scripts/rotate-super-admin-password.js
```

or, from a password manager, without a prompt:

```bash
DATABASE_URL='<production connection string>' \
SUPER_ADMIN_NEW_PASSWORD="$(op read 'op://vault/619-superadmin/password')" \
  node scripts/rotate-super-admin-password.js
```

Add `DRY_RUN=1` first if you want to see the target account and confirm the
match before anything is written.

The script refuses a weak password, verifies the new hash validates *before*
writing it (so a broken rotation cannot lock the account), writes it, and
**bumps `token_version`** — which is what actually signs out anyone already
holding a session. `middleware/auth.js` compares the JWT's `token_version`
against the row and rejects a mismatch, so every token minted under the old
password stops working the moment this runs.

Generate the password with a manager, not by hand. It is the platform
administrator credential for six businesses' data.

### 2. Enable MFA on the account

The password is one factor and it has been published once. Enrol an
authenticator through the profile MFA routes under `/api/profile/mfa` — never
gated, so there is no bootstrap deadlock — and confirm:

```sql
SELECT mfa_enabled FROM user_profiles WHERE user_id = 'usr-superadmin-001';
```

It must be `true` **before** step 3.

### 3. Turn the security flags on

`src/server.js` now refuses to start in production unless all three are exactly
`on`. Set them in the deployment environment:

```
TENANT_RLS_ENFORCE=on
PLATFORM_SESSION_ENFORCE=on
SUPER_ADMIN_REQUIRE_MFA=on
```

Read the header of `src/server.js` first — each has a prerequisite, and
`SUPER_ADMIN_REQUIRE_MFA=on` without step 2 locks out the only account that can
reach the console. (Recoverable, since enrolment is never gated. Still a
lockout.)

### 4. Make the repositories private

Both `619-erp-backend` and `619-erp-frontend`. This needs a repository admin;
it cannot be done from this session's tooling.

Public exposure is what turned a bad practice into an active compromise, and it
is not only about this hash — the public history also carries the full schema,
every migration, the tenant-isolation design, and the exact shape of each
security control and its env flag.

### 5. Decide on history

Options, in increasing order of effort and disruption:

1. **Leave history as-is.** Defensible *only* once rotation (1) and MFA (2) are
   done and the repository is private (4): the leaked hash then protects an
   account whose password it no longer matches.
2. **Rewrite history** with `git filter-repo` and force-push. Removes the
   hashes from this repository going forward. Does not reach existing clones or
   forks, breaks every outstanding branch and PR, and needs coordination with
   anyone holding a checkout.

Rotation makes (1) survivable, which is why it comes first.

### 6. Check for use of the exposed account

Worth doing regardless of whether the hash was ever cracked:

```sql
-- Sign-ins for the platform account.
SELECT created_at, ip_address, user_agent, success
  FROM login_events
 WHERE user_id = 'usr-superadmin-001'
 ORDER BY created_at DESC
 LIMIT 200;

-- Anything the platform account did, cross-tenant.
SELECT created_at, action, entity_type, entity_id, organization_id
  FROM activity_log
 WHERE user_id = 'usr-superadmin-001'
 ORDER BY created_at DESC
 LIMIT 200;
```

Look for sign-ins from addresses or user-agents you do not recognise, and for
activity at times nobody was working. `login_events` holds 536 rows and
`activity_log` 440, so this is a short read, not a forensics project.

---

## Related, checked in the same pass

`src/__tests__/auth.login.test.js` contains a bcrypt-*shaped* literal. It was
checked and is **not** a credential: it is 29 characters against a real hash's
60, annotated in place as `// not a real hash; bcrypt.compare mocked below`,
and the suite mocks `bcrypt.compare` so nothing ever verifies against it.

`noCommittedSecrets.test.js` scans `src/` — that file included — and does not
flag it, because the pattern requires the full 53-character salt-and-digest
tail that a real hash has. That is the intended behaviour rather than a gap:
matching on the `$2a$10$` prefix alone would fire on every truncated stand-in
in the test suite, and a guard that cries wolf is a guard somebody deletes.
