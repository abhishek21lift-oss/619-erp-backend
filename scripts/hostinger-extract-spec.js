#!/usr/bin/env node
'use strict';
// Regenerate src/lib/hostinger/spec.json from the official Hostinger OpenAPI
// specification.
//
// ── Why this exists ────────────────────────────────────────────────────────
//
// The Hostinger super-admin module must never call an endpoint that Hostinger
// does not have, and must never invent a parameter name. Hand-transcribing 60
// operations from a docs page guarantees a typo eventually, and the failure
// mode is a 404 or a silently ignored parameter on a call that can restart a
// production server.
//
// So the catalogue is written against THIS file, which is generated from the
// published spec, and a test asserts the catalogue is a subset of it. Refresh
// when Hostinger ships changes:
//
//     node scripts/hostinger-extract-spec.js
//
// The full spec is ~1.6 MB; only the operations this module exposes are kept,
// which is a fraction of it and makes the committed file reviewable.

const fs = require('fs');
const path = require('path');

const SOURCE = 'https://developers.hostinger.com/openapi/openapi.json';
const OUT = path.join(__dirname, '..', 'src', 'lib', 'hostinger', 'spec.json');

/**
 * The operations this module exposes, as `METHOD /path` exactly as the spec
 * writes them. Adding an endpoint here is the first step; the catalogue entry
 * in catalog.js must match it exactly or the parity test fails.
 */
const WANTED = [
  // Hosting: websites, orders, SSL, files
  'GET /api/hosting/v1/websites',
  'GET /api/hosting/v1/onboardings',
  'GET /api/hosting/v1/orders',
  'GET /api/hosting/v1/accounts/{username}/websites/{domain}/ssl/status',
  'POST /api/hosting/v1/accounts/{username}/websites/{domain}/ssl/setup',
  'PATCH /api/hosting/v1/accounts/{username}/websites/{domain}/ssl/https-redirect/toggle',
  'DELETE /api/hosting/v1/accounts/{username}/websites/{domain}/ssl',
  'DELETE /api/hosting/v1/websites/{domain}',
  'GET /api/hosting/v1/accounts/{username}/domains/{domain}/files',
  'GET /api/hosting/v1/accounts/{username}/domains/{domain}/files/content',
  'DELETE /api/hosting/v1/accounts/{username}/websites/{domain}/cache/clear',
  'PATCH /api/hosting/v1/accounts/{username}/websites/{domain}/cache/toggle',
  // Hosting: Node.js apps and Git deploys — the deployment surface
  'GET /api/hosting/v1/accounts/{username}/websites/{domain}/nodejs/builds',
  'GET /api/hosting/v1/accounts/{username}/websites/{domain}/nodejs/builds/settings',
  'GET /api/hosting/v1/accounts/{username}/websites/{domain}/nodejs/builds/{uuid}/logs',
  'GET /api/hosting/v1/accounts/{username}/websites/{domain}/nodejs/runtime-logs',
  'GET /api/hosting/v1/accounts/{username}/websites/{domain}/nodejs/vulnerabilities',
  'POST /api/hosting/v1/accounts/{username}/websites/{domain}/nodejs/builds',
  'POST /api/hosting/v1/accounts/{username}/websites/{domain}/nodejs/server/restart',
  'GET /api/hosting/v1/git/installations',
  'POST /api/hosting/v1/accounts/{username}/websites/{domain}/git/repositories/deploy',
  // Domains
  'GET /api/domains/v1/portfolio',
  'GET /api/domains/v1/portfolio/{domain}',
  'GET /api/domains/v1/portfolio/{domain}/renewal',
  // DNS
  'GET /api/dns/v1/zones/{domain}',
  'PUT /api/dns/v1/zones/{domain}',
  'DELETE /api/dns/v1/zones/{domain}',
  'POST /api/dns/v1/zones/{domain}/validate',
  'GET /api/dns/v1/snapshots/{domain}',
  'POST /api/dns/v1/snapshots/{domain}/{snapshotId}/restore',
  // VPS: machines, health, lifecycle
  'GET /api/vps/v1/virtual-machines',
  'GET /api/vps/v1/virtual-machines/{virtualMachineId}',
  'GET /api/vps/v1/virtual-machines/{virtualMachineId}/metrics',
  'GET /api/vps/v1/virtual-machines/{virtualMachineId}/actions',
  'POST /api/vps/v1/virtual-machines/{virtualMachineId}/start',
  'POST /api/vps/v1/virtual-machines/{virtualMachineId}/stop',
  'POST /api/vps/v1/virtual-machines/{virtualMachineId}/restart',
  'POST /api/vps/v1/virtual-machines/{virtualMachineId}/recreate',
  'POST /api/vps/v1/virtual-machines/{virtualMachineId}/recovery',
  // VPS: backups and snapshots
  'GET /api/vps/v1/virtual-machines/{virtualMachineId}/backups',
  'POST /api/vps/v1/virtual-machines/{virtualMachineId}/backups/{backupId}/restore',
  'GET /api/vps/v1/virtual-machines/{virtualMachineId}/snapshot',
  'POST /api/vps/v1/virtual-machines/{virtualMachineId}/snapshot',
  'POST /api/vps/v1/virtual-machines/{virtualMachineId}/snapshot/restore',
  'DELETE /api/vps/v1/virtual-machines/{virtualMachineId}/snapshot',
  // VPS: Docker Manager
  'GET /api/vps/v1/virtual-machines/{virtualMachineId}/docker',
  'GET /api/vps/v1/virtual-machines/{virtualMachineId}/docker/{projectName}',
  'GET /api/vps/v1/virtual-machines/{virtualMachineId}/docker/{projectName}/containers',
  'GET /api/vps/v1/virtual-machines/{virtualMachineId}/docker/{projectName}/logs',
  'POST /api/vps/v1/virtual-machines/{virtualMachineId}/docker/{projectName}/start',
  'POST /api/vps/v1/virtual-machines/{virtualMachineId}/docker/{projectName}/stop',
  'POST /api/vps/v1/virtual-machines/{virtualMachineId}/docker/{projectName}/restart',
  'POST /api/vps/v1/virtual-machines/{virtualMachineId}/docker/{projectName}/update',
  'DELETE /api/vps/v1/virtual-machines/{virtualMachineId}/docker/{projectName}/down',
  // VPS: firewall
  'GET /api/vps/v1/firewall',
  'GET /api/vps/v1/firewall/{firewallId}',
  'DELETE /api/vps/v1/firewall/{firewallId}/rules/{ruleId}',
  // Billing
  'GET /api/billing/v1/subscriptions',
  'GET /api/billing/v1/payment-methods',
  'PATCH /api/billing/v1/subscriptions/{subscriptionId}/auto-renewal/enable',
  'DELETE /api/billing/v1/subscriptions/{subscriptionId}/auto-renewal/disable',
];

/** Query and path parameters are kept; header parameters are not (we set our own auth). */
function slimParameters(op, spec) {
  return (op.parameters || [])
    // Parameters are `$ref`s into components.parameters, so they must be
    // resolved before their `in`/`name` can be read at all. Reading the raw ref
    // silently dropped EVERY path parameter — including the machine id — which
    // is exactly the class of miss this file exists to prevent.
    .map((p) => resolveRef(p, spec) || {})
    .filter((p) => p.in === 'path' || p.in === 'query')
    .map((p) => ({
      name: p.name,
      in: p.in,
      required: !!p.required,
      type: (p.schema && p.schema.type) || 'unknown',
    }));
}

/**
 * Request bodies are `$ref` into components.schemas, and the referenced shapes
 * are sometimes wrapped in `allOf`. Resolving here rather than in the test
 * means spec.json is the truth for body property names too — which is what
 * makes the parity test able to catch an invented field like `password` vs
 * `root_password`.
 */
function resolveRef(node, spec, depth = 0) {
  if (!node || depth > 6) return null;
  if (node.$ref) {
    const trail = node.$ref.replace('#/', '').split('/');
    let cur = spec;
    for (const seg of trail) cur = cur && cur[seg];
    return resolveRef(cur, spec, depth + 1);
  }
  return node;
}

/** Property names of a JSON request body. Types only — the catalogue declares its own zod schema. */
function slimBody(op, spec) {
  const content = op.requestBody && op.requestBody.content && op.requestBody.content['application/json'];
  if (!content || !content.schema) return null;
  const resolved = resolveRef(content.schema, spec);
  if (!resolved) return { required: !!op.requestBody.required, properties: [] };

  // allOf: merge the members' property lists.
  const flat = resolved.allOf ? resolved.allOf.map((n) => resolveRef(n, spec)).filter(Boolean) : [resolved];
  const properties = [];
  for (const node of flat) {
    for (const [name, schema] of Object.entries(node.properties || {})) {
      properties.push({ name, type: (schema && schema.type) || 'object' });
    }
  }
  return {
    required: !!op.requestBody.required,
    properties,
    required_properties: flat.flatMap((n) => n.required || []),
  };
}

async function main() {
  const local = process.argv[2];
  let spec;
  if (local) {
    spec = JSON.parse(fs.readFileSync(local, 'utf8'));
  } else {
    const res = await fetch(SOURCE);
    if (!res.ok) throw new Error(`could not fetch the specification: HTTP ${res.status}`);
    spec = await res.json();
  }

  const out = {};
  const missing = [];
  for (const key of WANTED) {
    const [method, route] = key.split(' ');
    const op = spec.paths[route] && spec.paths[route][method.toLowerCase()];
    if (!op) { missing.push(key); continue; }
    out[key] = {
      summary: op.summary || '',
      parameters: slimParameters(op, spec),
      body: slimBody(op, spec),
    };
  }

  if (missing.length) {
    // Loud, not silent: a missing operation means either Hostinger renamed it or
    // this list is stale, and both need a human before the catalogue drifts.
    console.error('MISSING from the specification (fix WANTED or the catalogue):');
    for (const m of missing) console.error(`  ${m}`);
    process.exitCode = 1;
    if (missing.length === WANTED.length) return;
  }

  const payload = {
    $comment:
      'Generated by scripts/hostinger-extract-spec.js from the official Hostinger OpenAPI '
      + 'specification. Only the operations the super-admin module exposes. Do not edit by hand: '
      + 're-run the script. hostinger.catalog.spec.test.js asserts catalog.js matches this file.',
    source: SOURCE,
    spec_version: (spec.info && spec.info.version) || null,
    fetched_at: new Date().toISOString(),
    operations: out,
  };
  fs.writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`wrote ${Object.keys(out).length} operations to ${path.relative(process.cwd(), OUT)}`);
  for (const [key, v] of Object.entries(out)) {
    const params = v.parameters
      .map((p) => `${p.in[0]}:${p.name}${p.required ? '!' : ''}${p.in === 'query' ? `(${p.type})` : ''}`)
      .join(' ');
    const body = v.body ? ` body[${v.body.properties.map((p) => p.name).join(',')}]${v.body.required ? '!' : ''}` : '';
    console.log(`${key.padEnd(96)}${params}${body}`);
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
