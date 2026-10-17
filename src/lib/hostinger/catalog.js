'use strict';
// The allow-list of Hostinger operations this platform may call.
//
// ── Why an allow-list and not a generic proxy ───────────────────────────────
//
// The credential behind this module can wipe the production VPS. A module that
// forwards "any path the operator typed" would make every Hostinger endpoint —
// including ones that do not exist yet, and the 264 this console does not
// cover — reachable from a browser tab. So the callable surface is exactly the
// table below: an operation that is not here cannot be reached, whatever the
// request says.
//
// Every entry is written against src/lib/hostinger/spec.json, which is
// generated from the official OpenAPI document (scripts/hostinger-extract-spec.js).
// __tests__/hostinger.catalog.test.js asserts that this table is a subset of
// that snapshot — path, method, parameter names, parameter locations and
// required flags all have to agree — so a typo here is a failing test rather
// than a 404 on a call that restarts a server.
//
// ── The three safety classes ────────────────────────────────────────────────
//
//   read         no confirmation. Nothing an operator can lose.
//   mutate       stored plan + explicit approve. Reversible-ish: a restart, a
//                cache clear, a start/stop. Losing a cache is not losing data.
//   destructive  stored plan + the operator types the operation id. Anything
//                that destroys data, deletes a restore point, or opens a
//                machine to the internet.
//
// The class is a property of the OPERATION, not of the request, and it is
// enforced server-side in operations.service.js. The UI repeats the wording;
// it does not decide it.
//
// Classifying is a judgement call, so the ones that could be argued either way
// carry the reason inline. Two rules kept it consistent:
//   * "reversible by pressing the opposite button" is not enough on its own —
//     disabling SSL on a live site is one click to undo and still destructive,
//     because the site is publicly served over HTTP until somebody notices.
//   * routine operations stay `mutate` even when they cause brief downtime.
//     Requiring a typed confirmation to restart a Node app trains operators to
//     type without reading.

const { z } = require('zod');

// ── Provenance ──────────────────────────────────────────────────────────────
//
// The API revision this table was written against, and where it came from.
// Shipped to the console so "the Hostinger API has no terminal endpoint" is a
// checkable statement about a named revision rather than an assertion about the
// present. Spec constants rather than a runtime read of spec.json: the snapshot
// is a build-time artifact, and hostinger.catalog.test.js asserts these match
// it, so they cannot drift from the source they name.
const SPEC_VERSION = '2.1.0';
const SPEC_SOURCE = 'https://developers.hostinger.com/openapi/openapi.json';

// ── Reusable primitives ─────────────────────────────────────────────────────

/** Upstream ids are integers; Hostinger examples are 7 digits. */
const intId = z.coerce.number().int().min(1).max(2147483647);

/**
 * A query boolean, coerced by hand.
 *
 * z.coerce.boolean() would be wrong here: it is Boolean(value), and
 * Boolean('false') is true. `?is_enabled=false` would silently mean "true" and
 * list the disabled websites. Only the documented spellings are accepted.
 */
const queryBool = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

/**
 * A repeated/csv query list: `?states=a&states=b` or `?states=a,b`.
 *
 * Both spellings hit the same wire format (Hostinger wants a repeated
 * parameter), and both are what a person types. Bounded at 50 because these
 * feed an upstream query and there is no reason for an operator to send more
 * filter values than the upstream can have distinct ones.
 */
const csvList = (inner) =>
  z
    .union([z.string(), z.array(z.string())])
    .transform((v) => (Array.isArray(v) ? v : String(v).split(',')).map((s) => s.trim()).filter(Boolean))
    .pipe(z.array(inner).min(1).max(50));

// A DNS label: no leading/trailing hyphen, 1-63 chars. Applied per label.
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';

/** A domain that has at least one dot. `localhost` is not a Hostinger domain. */
const domainName = z
  .string()
  .trim()
  .toLowerCase()
  .min(4)
  .max(253)
  .regex(new RegExp(`^${LABEL}(?:\\.${LABEL})+$`), 'not a domain name');

/** Hostinger account username, e.g. `u123456789`. No documented pattern. */
const accountUser = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/);

/** Docker Compose project name — documented as alphanumeric, dashes, underscores, 3-64. */
const projectName = z.string().trim().min(3).max(64).regex(/^[A-Za-z0-9_-]+$/);

/** Billing subscription id, e.g. `Cxy353Uhl1xC54pG6`. */
const subscriptionId = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);

const uuid = z.uuid();

/**
 * A path inside a website's document root.
 *
 * Traversal is rejected here rather than trusted to the upstream: this string
 * lands in the Hostinger account's filesystem, and a client that can ask for
 * `../../..` is asking to read outside the website. Empty segments and NUL are
 * refused for the same reason. Absolute paths are allowed — Hostinger
 * documents paths relative to the document root and an operator pasting
 * `/public_html/index.php` means the obvious thing.
 */
const filePath = z
  .string()
  .min(1)
  .max(1024)
  .refine((p) => !p.includes('\0'), 'NUL byte in path')
  .refine((p) => !p.split('/').includes('..'), 'path may not traverse upwards');

/**
 * A git clone URL, or an scp-style SSH remote (`git@github.com:owner/repo.git`).
 *
 * Credentials in the URL are refused HERE, before the value can be logged or
 * sent: upstream documents that it rejects them, but role="error message" is a
 * worse place to learn that, and a token pasted into this field must never
 * reach an audit row.
 */
const gitRemote = z
  .string()
  .trim()
  .min(8)
  .max(255)
  .refine((raw) => {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
      let url;
      try {
        url = new URL(raw);
      } catch {
        return false;
      }
      if (!['http:', 'https:', 'ssh:', 'git:'].includes(url.protocol)) return false;
      if (url.username || url.password) return false;
      return !!url.hostname.includes('.');
    }
    // scp-style: user@host:path — the form Hostinger's own example uses.
    const m = raw.match(/^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,}):(.+)$/);
    return !!m;
  }, 'must be a clone URL without embedded credentials');

const gitBranch = z.string().trim().min(1).max(255).regex(/^[A-Za-z0-9._\-/]+$/);

// ── DNS record shapes, from the spec's nested item schemas ──────────────────

const DNS_TYPES = ['A', 'AAAA', 'CNAME', 'ALIAS', 'MX', 'TXT', 'NS', 'SOA', 'SRV', 'CAA'];

const dnsRecord = z
  .object({
    // Every record in the spec carries a name; `@` means the zone apex.
    name: z.string().trim().min(1).max(255),
    type: z.enum(DNS_TYPES),
    ttl: z.coerce.number().int().min(60).max(2147483647).optional(),
    records: z
      .array(
        z
          .object({
            content: z.string().max(4096),
          })
          .strict()
      )
      .min(1)
      .max(50),
  })
  .strict();

const dnsZone = z.array(dnsRecord).min(1).max(500);

// ── Node.js build body, from the spec's enums ──────────────────────────────

const nodejsVersion = z.coerce.number().int().refine((v) => [18, 20, 22, 24].includes(v), 'unsupported Node.js major');
const nodejsAppType = z.enum([
  'create-react-app', 'gatsby', 'vite', 'angular', 'react', 'vue', 'parcel', 'next',
  'nuxt', 'nest', 'express', 'fastify', 'astro', 'svelte', 'svelte-kit', 'hono',
  'react-router', 'nitro', 'other',
]);

/**
 * `source_options` is a union keyed by `source_type`: an archive path, or a
 * git owner/repo/branch/installation. Modelled as the union rather than one
 * permissive object so a build with `source_type: 'git'` and no repository is
 * refused here with a readable message instead of failing upstream mid-build.
 */
const nodejsSourceOptions = z
  .object({
    archive_path: filePath.optional(),
    owner: z.string().max(200).optional(),
    repository: z.string().max(100).optional(),
    branch: z.string().max(200).optional(),
    installation_uuid: uuid.optional(),
  })
  .strict();

// ── The table ───────────────────────────────────────────────────────────────

/**
 * @typedef {object} HostingerOperation
 * @property {string}  method      uppercase, as the spec writes it
 * @property {string}  path        literal template with {placeholders}
 * @property {string}  group       UI grouping
 * @property {string}  summary     shown on the approval screen
 * @property {'read'|'mutate'|'destructive'} safety
 * @property {object}  [pathParams] zod schemas, one per {placeholder}
 * @property {object}  [query]     zod object schema (whole query string)
 * @property {object}  [body]      zod object schema (whole body, strict)
 * @property {string[]} [secrets]  body fields that must never be logged,
 *                                 audited, echoed back, or shown to the AI
 */

/** @type {Record<string, HostingerOperation>} */
const OPERATIONS = {
  // ── Hosting: websites ────────────────────────────────────────────────────
  'hosting.website.list': {
    method: 'GET',
    path: '/api/hosting/v1/websites',
    group: 'websites',
    summary: 'List websites',
    safety: 'read',
    query: z.object({
      page: z.coerce.number().int().min(1).optional(),
      per_page: z.coerce.number().int().min(1).max(100).optional(),
      username: z.string().max(64).optional(),
      order_id: intId.optional(),
      is_enabled: queryBool.optional(),
      domain: z.string().max(253).optional(),
      website_types: csvList(z.enum(['wordpress', 'builder', 'horizons', 'nodejs', 'other'])).optional(),
    }),
  },
  'hosting.website.delete': {
    method: 'DELETE',
    path: '/api/hosting/v1/websites/{domain}',
    group: 'websites',
    summary: 'Delete a website',
    // Removes the site and, per Hostinger's docs, its files. Restoring means a
    // plan restore; this is not an "undo press".
    safety: 'destructive',
    pathParams: { domain: domainName },
  },
  'hosting.onboarding.list': {
    method: 'GET',
    path: '/api/hosting/v1/onboardings',
    group: 'websites',
    summary: 'List website onboardings',
    safety: 'read',
    query: z.object({
      order_id: intId.optional(),
      subscription_id: subscriptionId.optional(),
      domain: z.string().max(253).optional(),
    }),
  },
  'hosting.order.list': {
    method: 'GET',
    path: '/api/hosting/v1/orders',
    group: 'websites',
    summary: 'List hosting orders',
    safety: 'read',
    query: z.object({
      page: z.coerce.number().int().min(1).optional(),
      per_page: z.coerce.number().int().min(1).max(100).optional(),
      statuses: csvList(z.enum(['active', 'deleting', 'deleted', 'suspended'])).optional(),
      order_ids: csvList(z.coerce.number().int().min(1)).optional(),
    }),
  },

  // ── Hosting: SSL ─────────────────────────────────────────────────────────
  'hosting.ssl.status': {
    method: 'GET',
    path: '/api/hosting/v1/accounts/{username}/websites/{domain}/ssl/status',
    group: 'ssl',
    summary: 'Get SSL status',
    safety: 'read',
    pathParams: { username: accountUser, domain: domainName },
  },
  'hosting.ssl.setup': {
    method: 'POST',
    path: '/api/hosting/v1/accounts/{username}/websites/{domain}/ssl/setup',
    group: 'ssl',
    summary: 'Issue an SSL certificate',
    // No body. Issuing a certificate is additive: the worst case is a
    // certificate that has to be reissued.
    safety: 'mutate',
    pathParams: { username: accountUser, domain: domainName },
  },
  'hosting.ssl.redirect.set': {
    method: 'PATCH',
    path: '/api/hosting/v1/accounts/{username}/websites/{domain}/ssl/https-redirect/toggle',
    group: 'ssl',
    summary: 'Toggle the HTTPS redirect',
    // Turning the redirect OFF downgrades a live site to HTTP. Within `mutate`
    // because it is the documented companion to `hosting.ssl.setup` and an
    // operator switching it off deliberately to debug is a normal workflow;
    // removing the certificate entirely is the destructive one below.
    safety: 'mutate',
    pathParams: { username: accountUser, domain: domainName },
    body: z.object({ is_enabled: queryBool }).strict(),
  },
  'hosting.ssl.delete': {
    method: 'DELETE',
    path: '/api/hosting/v1/accounts/{username}/websites/{domain}/ssl',
    group: 'ssl',
    summary: 'Delete the SSL certificate',
    // One click to undo, and still destructive: until somebody notices, the
    // site is served over HTTP and every browser shows it.
    safety: 'destructive',
    pathParams: { username: accountUser, domain: domainName },
  },

  // ── Hosting: files ───────────────────────────────────────────────────────
  'hosting.files.list': {
    method: 'GET',
    path: '/api/hosting/v1/accounts/{username}/domains/{domain}/files',
    group: 'files',
    summary: 'List website files',
    safety: 'read',
    pathParams: { username: accountUser, domain: domainName },
    query: z.object({
      directory: z.string().max(1024).optional(),
      max_depth: z.coerce.number().int().min(1).max(10).optional(),
      max_items: z.coerce.number().int().min(1).max(2000).optional(),
      offset: z.coerce.number().int().min(0).optional(),
      file_types: csvList(z.enum(['file', 'directory', 'symlink', 'other'])).optional(),
    }),
  },
  'hosting.files.content': {
    method: 'GET',
    path: '/api/hosting/v1/accounts/{username}/domains/{domain}/files/content',
    group: 'files',
    summary: 'Read a website file',
    // Read-only, and it is how a log or a wp-config is inspected without SSH.
    // The response may contain secrets, so it is capped and never cached
    // server-side (see operations.service.js).
    safety: 'read',
    pathParams: { username: accountUser, domain: domainName },
    query: z.object({
      path: filePath,
      from_line: z.coerce.number().int().min(0).optional(),
      max_lines: z.coerce.number().int().min(1).max(5000).optional(),
    }),
  },

  // ── Hosting: cache ───────────────────────────────────────────────────────
  'hosting.cache.clear': {
    method: 'DELETE',
    path: '/api/hosting/v1/accounts/{username}/websites/{domain}/cache/clear',
    group: 'websites',
    summary: 'Clear the website cache',
    // A DELETE that only costs a slower first page load.
    safety: 'mutate',
    pathParams: { username: accountUser, domain: domainName },
    query: z.object({ directory: z.string().max(1024).optional() }),
  },
  'hosting.cache.toggle': {
    method: 'PATCH',
    path: '/api/hosting/v1/accounts/{username}/websites/{domain}/cache/toggle',
    group: 'websites',
    summary: 'Enable or disable website caching',
    safety: 'mutate',
    pathParams: { username: accountUser, domain: domainName },
    body: z.object({ enabled: queryBool }).strict(),
  },

  // ── Hosting: Node.js ─────────────────────────────────────────────────────
  'hosting.nodejs.build.list': {
    method: 'GET',
    path: '/api/hosting/v1/accounts/{username}/websites/{domain}/nodejs/builds',
    group: 'nodejs',
    summary: 'List Node.js builds',
    safety: 'read',
    pathParams: { username: accountUser, domain: domainName },
    query: z.object({
      page: z.coerce.number().int().min(1).optional(),
      per_page: z.coerce.number().int().min(1).max(100).optional(),
      states: csvList(z.enum(['pending', 'running', 'completed', 'failed'])).optional(),
    }),
  },
  'hosting.nodejs.build.settings': {
    method: 'GET',
    path: '/api/hosting/v1/accounts/{username}/websites/{domain}/nodejs/builds/settings',
    group: 'nodejs',
    summary: 'Get Node.js build settings',
    safety: 'read',
    pathParams: { username: accountUser, domain: domainName },
  },
  'hosting.nodejs.build.logs': {
    method: 'GET',
    path: '/api/hosting/v1/accounts/{username}/websites/{domain}/nodejs/builds/{uuid}/logs',
    group: 'nodejs',
    summary: 'Get Node.js build logs',
    safety: 'read',
    pathParams: { username: accountUser, domain: domainName, uuid },
    query: z.object({ from_line: z.coerce.number().int().min(0).optional() }),
  },
  'hosting.nodejs.runtime.logs': {
    method: 'GET',
    path: '/api/hosting/v1/accounts/{username}/websites/{domain}/nodejs/runtime-logs',
    group: 'nodejs',
    summary: 'Get Node.js runtime logs',
    safety: 'read',
    pathParams: { username: accountUser, domain: domainName },
    query: z.object({
      period: z.enum(['1h', '1d', '1w', '1m']).optional(),
      from_line: z.coerce.number().int().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(5000).optional(),
      levels: csvList(z.enum(['LOG', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'])).optional(),
    }),
  },
  'hosting.nodejs.vulnerabilities': {
    method: 'GET',
    path: '/api/hosting/v1/accounts/{username}/websites/{domain}/nodejs/vulnerabilities',
    group: 'nodejs',
    summary: 'List Node.js dependency vulnerabilities',
    safety: 'read',
    pathParams: { username: accountUser, domain: domainName },
    query: z.object({
      severities: csvList(z.enum(['low', 'moderate', 'high', 'critical', 'unknown'])).optional(),
    }),
  },
  'hosting.nodejs.build.create': {
    method: 'POST',
    path: '/api/hosting/v1/accounts/{username}/websites/{domain}/nodejs/builds',
    group: 'nodejs',
    summary: 'Start a Node.js build',
    safety: 'mutate',
    pathParams: { username: accountUser, domain: domainName },
    body: z
      .object({
        node_version: nodejsVersion,
        app_type: nodejsAppType,
        root_directory: filePath,
        output_directory: z.string().max(255),
        build_script: z.string().max(500),
        entry_file: z.string().max(255).optional(),
        package_manager: z.enum(['npm', 'yarn', 'pnpm']).optional(),
        source_type: z.enum(['archive', 'git']),
        source_options: nodejsSourceOptions,
      })
      .strict()
      .superRefine((v, ctx) => {
        const need = v.source_type === 'archive'
          ? ['archive_path']
          : ['owner', 'repository', 'branch', 'installation_uuid'];
        for (const k of need) {
          if (!v.source_options[k]) {
            ctx.addIssue({ code: 'custom', path: ['source_options', k], message: `required when source_type is ${v.source_type}` });
          }
        }
      }),
  },
  'hosting.nodejs.server.restart': {
    method: 'POST',
    path: '/api/hosting/v1/accounts/{username}/websites/{domain}/nodejs/server/restart',
    group: 'nodejs',
    summary: 'Restart the Node.js application server',
    // Brief downtime, no data loss. Typed confirmation here would train people
    // to approve without reading, which is a worse trade than it looks.
    safety: 'mutate',
    pathParams: { username: accountUser, domain: domainName },
  },

  // ── Hosting: Git ─────────────────────────────────────────────────────────
  'hosting.git.installations': {
    method: 'GET',
    path: '/api/hosting/v1/git/installations',
    group: 'git',
    summary: 'List Git installations',
    safety: 'read',
    query: z.object({
      provider: z.enum(['github', 'gitlab', 'bitbucket']).optional(),
      status: z.enum(['pending', 'active', 'suspended']).optional(),
    }),
  },
  'hosting.git.deploy': {
    method: 'POST',
    path: '/api/hosting/v1/accounts/{username}/websites/{domain}/git/repositories/deploy',
    group: 'git',
    summary: 'Deploy a Git repository',
    // A deploy overwrites files in the target directory, but it is the routine
    // action the feature exists for; the operator reads the branch and target
    // on the approval screen.
    safety: 'mutate',
    pathParams: { username: accountUser, domain: domainName },
    body: z
      .object({
        repository_url: gitRemote,
        branch: gitBranch,
        directory: filePath.optional(),
      })
      .strict(),
  },

  // ── Domains ──────────────────────────────────────────────────────────────
  'domains.portfolio.list': {
    method: 'GET',
    path: '/api/domains/v1/portfolio',
    group: 'domains',
    summary: 'List domains in the portfolio',
    safety: 'read',
  },
  'domains.portfolio.get': {
    method: 'GET',
    path: '/api/domains/v1/portfolio/{domain}',
    group: 'domains',
    summary: 'Get a domain',
    safety: 'read',
    pathParams: { domain: domainName },
  },
  'domains.renewal.get': {
    method: 'GET',
    path: '/api/domains/v1/portfolio/{domain}/renewal',
    group: 'domains',
    summary: 'Get domain renewal terms',
    safety: 'read',
    pathParams: { domain: domainName },
  },

  // ── DNS ──────────────────────────────────────────────────────────────────
  'dns.zone.get': {
    method: 'GET',
    path: '/api/dns/v1/zones/{domain}',
    group: 'dns',
    summary: 'Get the DNS zone',
    safety: 'read',
    pathParams: { domain: domainName },
  },
  'dns.zone.validate': {
    method: 'POST',
    path: '/api/dns/v1/zones/{domain}/validate',
    group: 'dns',
    summary: 'Validate DNS records',
    // A POST that writes nothing: it answers "would this zone be accepted".
    // `read`, because the whole point is to check BEFORE the destructive PUT.
    safety: 'read',
    pathParams: { domain: domainName },
    body: z.object({ zone: dnsZone, overwrite: queryBool.optional() }).strict(),
  },
  'dns.zone.update': {
    method: 'PUT',
    path: '/api/dns/v1/zones/{domain}',
    group: 'dns',
    summary: 'Update DNS records',
    // `overwrite: true` replaces the zone. Publishing the wrong zone takes the
    // domain, its mail and its site off the internet.
    safety: 'destructive',
    pathParams: { domain: domainName },
    body: z.object({ zone: dnsZone, overwrite: queryBool.optional() }).strict(),
  },
  'dns.records.delete': {
    method: 'DELETE',
    path: '/api/dns/v1/zones/{domain}',
    group: 'dns',
    summary: 'Delete DNS records',
    // A DELETE whose body selects what dies. Same consequence as the overwrite.
    safety: 'destructive',
    pathParams: { domain: domainName },
    body: z
      .object({
        filters: z
          .array(z.object({ name: z.string().min(1).max(255), type: z.enum(DNS_TYPES) }).strict())
          .min(1)
          .max(100),
      })
      .strict(),
  },
  'dns.snapshot.list': {
    method: 'GET',
    path: '/api/dns/v1/snapshots/{domain}',
    group: 'dns',
    summary: 'List DNS snapshots',
    safety: 'read',
    pathParams: { domain: domainName },
  },
  'dns.snapshot.restore': {
    method: 'POST',
    path: '/api/dns/v1/snapshots/{domain}/{snapshotId}/restore',
    group: 'dns',
    summary: 'Restore a DNS snapshot',
    // Restoring REPLACES the live zone with an older one, discarding every
    // record added since. That is the destructive half of the pair.
    safety: 'destructive',
    pathParams: { domain: domainName, snapshotId: intId },
  },

  // ── VPS: machines ────────────────────────────────────────────────────────
  'vps.list': {
    method: 'GET',
    path: '/api/vps/v1/virtual-machines',
    group: 'vps',
    summary: 'List virtual machines',
    safety: 'read',
  },
  'vps.get': {
    method: 'GET',
    path: '/api/vps/v1/virtual-machines/{virtualMachineId}',
    group: 'vps',
    summary: 'Get a virtual machine',
    safety: 'read',
    pathParams: { virtualMachineId: intId },
  },
  'vps.metrics': {
    method: 'GET',
    path: '/api/vps/v1/virtual-machines/{virtualMachineId}/metrics',
    group: 'vps',
    summary: 'Get virtual machine metrics',
    // date_from/date_to are REQUIRED upstream — omitting them is a 422, not a
    // default range. The dashboard supplies them.
    safety: 'read',
    pathParams: { virtualMachineId: intId },
    query: z.object({
      date_from: z.string().min(1).max(64),
      date_to: z.string().min(1).max(64),
    }),
  },
  'vps.actions': {
    method: 'GET',
    path: '/api/vps/v1/virtual-machines/{virtualMachineId}/actions',
    group: 'vps',
    summary: 'List recent virtual machine actions',
    safety: 'read',
    pathParams: { virtualMachineId: intId },
    query: z.object({ page: z.coerce.number().int().min(1).optional() }),
  },
  'vps.start': {
    method: 'POST',
    path: '/api/vps/v1/virtual-machines/{virtualMachineId}/start',
    group: 'vps',
    summary: 'Start a virtual machine',
    safety: 'mutate',
    pathParams: { virtualMachineId: intId },
  },
  'vps.stop': {
    method: 'POST',
    path: '/api/vps/v1/virtual-machines/{virtualMachineId}/stop',
    group: 'vps',
    summary: 'Stop a virtual machine',
    // Takes every service on the machine down. Recoverable by the button
    // beside it, which is the test for `mutate` rather than `destructive`.
    safety: 'mutate',
    pathParams: { virtualMachineId: intId },
  },
  'vps.restart': {
    method: 'POST',
    path: '/api/vps/v1/virtual-machines/{virtualMachineId}/restart',
    group: 'vps',
    summary: 'Restart a virtual machine',
    safety: 'mutate',
    pathParams: { virtualMachineId: intId },
  },
  'vps.recreate': {
    method: 'POST',
    path: '/api/vps/v1/virtual-machines/{virtualMachineId}/recreate',
    group: 'vps',
    summary: 'Recreate a virtual machine from a template',
    // Wipes the machine back to a fresh OS install. Everything on it is gone.
    safety: 'destructive',
    pathParams: { virtualMachineId: intId },
    body: z
      .object({
        template_id: intId,
        password: z.string().min(8).max(128).optional(),
        panel_password: z.string().min(8).max(128).optional(),
        post_install_script_id: intId.optional(),
      })
      .strict(),
    // Write-only credentials. Redacted from the audit row, the stored approval
    // and every log line; they are forwarded to Hostinger and dropped.
    secrets: ['password', 'panel_password'],
  },
  'vps.recovery': {
    method: 'POST',
    path: '/api/vps/v1/virtual-machines/{virtualMachineId}/recovery',
    group: 'vps',
    summary: 'Enter recovery mode',
    // Reboots the machine into a rescue image with the given root password.
    // The machine is offline for as long as it stays there.
    safety: 'destructive',
    pathParams: { virtualMachineId: intId },
    body: z.object({ root_password: z.string().min(8).max(128) }).strict(),
    secrets: ['root_password'],
  },

  // ── VPS: backups and snapshots ───────────────────────────────────────────
  'vps.backup.list': {
    method: 'GET',
    path: '/api/vps/v1/virtual-machines/{virtualMachineId}/backups',
    group: 'backups',
    summary: 'List virtual machine backups',
    safety: 'read',
    pathParams: { virtualMachineId: intId },
    query: z.object({ page: z.coerce.number().int().min(1).optional() }),
  },
  'vps.backup.restore': {
    method: 'POST',
    path: '/api/vps/v1/virtual-machines/{virtualMachineId}/backups/{backupId}/restore',
    group: 'backups',
    summary: 'Restore a virtual machine backup',
    // Replaces the disk contents with the backup's. Everything written since
    // that backup is discarded.
    safety: 'destructive',
    pathParams: { virtualMachineId: intId, backupId: intId },
  },
  'vps.snapshot.get': {
    method: 'GET',
    path: '/api/vps/v1/virtual-machines/{virtualMachineId}/snapshot',
    group: 'backups',
    summary: 'Get the virtual machine snapshot',
    safety: 'read',
    pathParams: { virtualMachineId: intId },
  },
  'vps.snapshot.create': {
    method: 'POST',
    path: '/api/vps/v1/virtual-machines/{virtualMachineId}/snapshot',
    group: 'backups',
    summary: 'Create a virtual machine snapshot',
    // Additive. It is also the thing an operator should do BEFORE the
    // destructive operations above, so it stays cheap to run.
    safety: 'mutate',
    pathParams: { virtualMachineId: intId },
  },
  'vps.snapshot.restore': {
    method: 'POST',
    path: '/api/vps/v1/virtual-machines/{virtualMachineId}/snapshot/restore',
    group: 'backups',
    summary: 'Restore the virtual machine snapshot',
    safety: 'destructive',
    pathParams: { virtualMachineId: intId },
  },
  'vps.snapshot.delete': {
    method: 'DELETE',
    path: '/api/vps/v1/virtual-machines/{virtualMachineId}/snapshot',
    group: 'backups',
    summary: 'Delete the virtual machine snapshot',
    // Deleting the restore point is unrecoverable on its own terms: the whole
    // value of the snapshot is that it exists.
    safety: 'destructive',
    pathParams: { virtualMachineId: intId },
  },

  // ── VPS: Docker ──────────────────────────────────────────────────────────
  'vps.docker.list': {
    method: 'GET',
    path: '/api/vps/v1/virtual-machines/{virtualMachineId}/docker',
    group: 'docker',
    summary: 'List Docker Compose projects',
    safety: 'read',
    pathParams: { virtualMachineId: intId },
  },
  'vps.docker.get': {
    method: 'GET',
    path: '/api/vps/v1/virtual-machines/{virtualMachineId}/docker/{projectName}',
    group: 'docker',
    summary: 'Get a Docker project',
    safety: 'read',
    pathParams: { virtualMachineId: intId, projectName },
  },
  'vps.docker.containers': {
    method: 'GET',
    path: '/api/vps/v1/virtual-machines/{virtualMachineId}/docker/{projectName}/containers',
    group: 'docker',
    summary: 'List a project\u2019s containers',
    safety: 'read',
    pathParams: { virtualMachineId: intId, projectName },
  },
  'vps.docker.logs': {
    method: 'GET',
    path: '/api/vps/v1/virtual-machines/{virtualMachineId}/docker/{projectName}/logs',
    group: 'docker',
    summary: 'Get container logs',
    safety: 'read',
    pathParams: { virtualMachineId: intId, projectName },
  },
  'vps.docker.start': {
    method: 'POST',
    path: '/api/vps/v1/virtual-machines/{virtualMachineId}/docker/{projectName}/start',
    group: 'docker',
    summary: 'Start a Docker project',
    safety: 'mutate',
    pathParams: { virtualMachineId: intId, projectName },
  },
  'vps.docker.stop': {
    method: 'POST',
    path: '/api/vps/v1/virtual-machines/{virtualMachineId}/docker/{projectName}/stop',
    group: 'docker',
    summary: 'Stop a Docker project',
    safety: 'mutate',
    pathParams: { virtualMachineId: intId, projectName },
  },
  'vps.docker.restart': {
    method: 'POST',
    path: '/api/vps/v1/virtual-machines/{virtualMachineId}/docker/{projectName}/restart',
    group: 'docker',
    summary: 'Restart a Docker project',
    safety: 'mutate',
    pathParams: { virtualMachineId: intId, projectName },
  },
  'vps.docker.update': {
    method: 'POST',
    path: '/api/vps/v1/virtual-machines/{virtualMachineId}/docker/{projectName}/update',
    group: 'docker',
    summary: 'Pull and recreate a Docker project',
    safety: 'mutate',
    pathParams: { virtualMachineId: intId, projectName },
  },
  'vps.docker.down': {
    method: 'DELETE',
    path: '/api/vps/v1/virtual-machines/{virtualMachineId}/docker/{projectName}/down',
    group: 'docker',
    summary: 'Stop and remove a Docker project',
    // Removes the containers and the project. Any volume the compose file
    // declares unnamed or that is pruned alongside goes with it — data loss
    // that a restart does not undo.
    safety: 'destructive',
    pathParams: { virtualMachineId: intId, projectName },
  },

  // ── VPS: firewall ────────────────────────────────────────────────────────
  'firewall.list': {
    method: 'GET',
    path: '/api/vps/v1/firewall',
    group: 'firewall',
    summary: 'List firewalls',
    safety: 'read',
    query: z.object({ page: z.coerce.number().int().min(1).optional() }),
  },
  'firewall.get': {
    method: 'GET',
    path: '/api/vps/v1/firewall/{firewallId}',
    group: 'firewall',
    summary: 'Get a firewall and its rules',
    safety: 'read',
    pathParams: { firewallId: intId },
  },
  'firewall.rule.delete': {
    method: 'DELETE',
    path: '/api/vps/v1/firewall/{firewallId}/rules/{ruleId}',
    group: 'firewall',
    summary: 'Delete a firewall rule',
    // Removing a DENY rule exposes the port it was blocking. A rule deletion
    // is a security change, and it is the one deletion here with no snapshot
    // to fall back to.
    safety: 'destructive',
    pathParams: { firewallId: intId, ruleId: intId },
  },

  // ── Billing ──────────────────────────────────────────────────────────────
  'billing.subscription.list': {
    method: 'GET',
    path: '/api/billing/v1/subscriptions',
    group: 'billing',
    summary: 'List subscriptions',
    safety: 'read',
  },
  'billing.payment_methods.list': {
    method: 'GET',
    path: '/api/billing/v1/payment-methods',
    group: 'billing',
    summary: 'List payment methods',
    // The upstream response carries card metadata, never the PAN; the console
    // renders the same fields and nothing else.
    safety: 'read',
  },
  'billing.autorenewal.enable': {
    method: 'PATCH',
    path: '/api/billing/v1/subscriptions/{subscriptionId}/auto-renewal/enable',
    group: 'billing',
    summary: 'Enable auto-renewal',
    safety: 'mutate',
    pathParams: { subscriptionId },
  },
  'billing.autorenewal.disable': {
    method: 'DELETE',
    path: '/api/billing/v1/subscriptions/{subscriptionId}/auto-renewal/disable',
    group: 'billing',
    summary: 'Disable auto-renewal',
    // Nothing breaks today; it is destructive because the failure mode is a
    // lapsed domain or server months later, and nobody connects the two.
    safety: 'destructive',
    pathParams: { subscriptionId },
  },
};

/** Groups, in the order the console renders them. */
const GROUPS = ['websites', 'domains', 'dns', 'ssl', 'files', 'nodejs', 'git', 'vps', 'docker', 'backups', 'firewall', 'billing'];

/** Look up one operation, or undefined. The only reader of the table. */
function get(id) {
  return Object.prototype.hasOwnProperty.call(OPERATIONS, id) ? OPERATIONS[id] : undefined;
}

/** True when this id is callable at all. */
function has(id) {
  return !!get(id);
}

/** Operations of one group, as [id, operation] pairs. */
function byGroup(group) {
  return Object.entries(OPERATIONS).filter(([, op]) => op.group === group);
}

/**
 * The catalogue as the browser and the AI may see it.
 *
 * Parameter NAMES and required flags, never the zod schemas (not
 * serialisable), and never a default value that could be a secret. This is
 * what the operations panel lists and what the assistant is given to reason
 * over, so it is the one description of the surface that has to be safe to
 * publish.
 */
function describe() {
  return Object.entries(OPERATIONS).map(([id, op]) => ({
    id,
    method: op.method,
    path: op.path,
    group: op.group,
    summary: op.summary,
    safety: op.safety,
    params: [
      ...Object.keys(op.pathParams || {}).map((name) => ({ in: 'path', name, required: true })),
      ...Object.entries(op.query?.shape || {}).map(([name, schema]) => ({
        in: 'query',
        name,
        required: !schema.isOptional?.(),
        secret: false,
      })),
      ...Object.entries(op.body?.shape || {}).map(([name, schema]) => ({
        in: 'body',
        name,
        required: !schema.isOptional?.(),
        // Flagged so the console renders a write-only field and the assistant
        // refuses to take a credential as an argument — it has no business
        // handling one, and a model would happily repeat it into a reply.
        secret: (op.secrets || []).includes(name),
      })),
    ],
  }));
}

/** How the approval gate is worded, one string per class. */
const SAFETY_LABELS = {
  read: 'Runs immediately',
  mutate: 'Requires approval',
  destructive: 'Requires approval and a typed confirmation',
};

module.exports = {
  OPERATIONS,
  GROUPS,
  SAFETY_LABELS,
  DNS_TYPES,
  SPEC_VERSION,
  SPEC_SOURCE,
  // exported for reuse by the client and the services
  s: { intId, queryBool, csvList, domainName, accountUser, projectName, subscriptionId, uuid, filePath },
  get,
  has,
  byGroup,
  describe,
};
