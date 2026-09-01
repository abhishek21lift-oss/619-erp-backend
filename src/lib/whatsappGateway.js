'use strict';
// src/lib/whatsappGateway.js
//
// The HTTP client for the self-hosted WhatsApp gateway (repo: 619-erp-whatsapp).
//
// ── What this is and is not ─────────────────────────────────────────────────
//
// It is a transport. It authenticates this backend to the gateway with a shared
// key and forwards an organization id the CALLER has already resolved from the
// authenticated session. It makes no authorisation decision of its own, and it
// must never be handed an organization id that came from a request body, query
// string or client header — see lib/tenant-db.js for why that rule exists.
//
// The gateway publishes no host port and has no nginx vhost: it is reachable
// only from this container, over the Docker network. That is the primary
// control. The shared key is the second, and it is the whole credential on this
// hop — which is acceptable only because of the first.
//
// ── Why every call degrades rather than throws ──────────────────────────────
//
// The gateway is an optional component. If it is down, mis-deployed, or simply
// not part of this deployment, the ERP must keep working: the WhatsApp card
// shows a stale state, and everything else — including the existing Twilio
// delivery path — is untouched. So the functions below return a result object
// in the style of services/whatsappDelivery.js rather than throwing, and the
// route layer decides what the studio sees.

const logger = require('./logger');

const DEFAULT_TIMEOUT_MS = 10000;

function gatewayUrl() {
  return (process.env.WA_GATEWAY_URL || '').trim().replace(/\/+$/, '');
}

/**
 * Is the self-hosted gateway wired up in this deployment?
 *
 * Both values are required. A URL with no key would produce 401s on every call;
 * a key with no URL has nothing to authenticate to. Reporting "not configured"
 * for either is the honest answer and lets the UI say so plainly instead of
 * showing an error the studio cannot act on.
 */
function isConfigured(env = process.env) {
  return Boolean((env.WA_GATEWAY_URL || '').trim() && (env.WA_GATEWAY_KEY || '').trim());
}

/**
 * One request to the gateway.
 *
 * @param {string} method
 * @param {string} path       Must start with '/'. Never caller-supplied.
 * @param {object} opts       { orgId, body, requestId }
 * @returns {Promise<{ok: boolean, status: number, data: object|null, code: string|null}>}
 *
 * `code` carries the gateway's stable error code (INSTANCE_NOT_FOUND,
 * QR_EXPIRED, …) so callers branch on that rather than on message text.
 */
async function call(method, path, opts = {}) {
  const base = gatewayUrl();
  if (!isConfigured()) {
    return { ok: false, status: 0, data: null, code: 'GATEWAY_NOT_CONFIGURED' };
  }

  const timeoutMs = parseInt(process.env.WA_GATEWAY_TIMEOUT_MS, 10) || DEFAULT_TIMEOUT_MS;
  const headers = {
    'X-Gateway-Key': process.env.WA_GATEWAY_KEY,
    // The organization the caller resolved from req.user. The gateway treats
    // this as a CROSS-CHECK against the owner stored on the instance, never as
    // a lookup key — so a wrong value cannot select a different studio's
    // instance, only fail.
    'X-Org-Id': opts.orgId,
  };
  // Propagated so one operation can be followed across both services' logs.
  if (opts.requestId) headers['X-Request-Id'] = opts.requestId;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      // Bounded, always. An unresponsive gateway must not hold an ERP request
      // open — the studio would see a spinner on a page that has nothing to do
      // with WhatsApp.
      signal: AbortSignal.timeout(timeoutMs),
    });

    // 204 has no body; parsing it would throw and turn a success into a failure.
    let data = null;
    if (res.status !== 204) {
      data = await res.json().catch(() => null);
    }

    return {
      ok: res.ok,
      status: res.status,
      data,
      code: data && data.error ? data.error.code : null,
    };
  } catch (err) {
    // Never logs the key: `headers` is not included in this line.
    logger.warn(
      { err: err.message, method, path, timeout_ms: timeoutMs },
      'whatsapp_gateway_unreachable'
    );
    return { ok: false, status: 0, data: null, code: 'GATEWAY_UNREACHABLE' };
  }
}

const gateway = {
  isConfigured,
  gatewayUrl,

  /** Create an instance and begin pairing. Idempotent at the gateway. */
  createInstance: (orgId, instanceId, requestId) =>
    call('POST', '/v1/instances', {
      orgId,
      requestId,
      body: { instance_id: instanceId, organization_id: orgId },
    }),

  status: (orgId, instanceId, requestId) =>
    call('GET', `/v1/instances/${instanceId}/status`, { orgId, requestId }),

  qr: (orgId, instanceId, requestId) =>
    call('GET', `/v1/instances/${instanceId}/qr`, { orgId, requestId }),

  reconnect: (orgId, instanceId, requestId) =>
    call('POST', `/v1/instances/${instanceId}/reconnect`, { orgId, requestId }),

  /** Close the socket, KEEP credentials. Reconnecting needs no new QR. */
  disconnect: (orgId, instanceId, requestId) =>
    call('POST', `/v1/instances/${instanceId}/disconnect`, { orgId, requestId }),

  /** Log out of WhatsApp and DESTROY credentials. A new QR will be required. */
  deleteInstance: (orgId, instanceId, requestId) =>
    call('DELETE', `/v1/instances/${instanceId}`, { orgId, requestId }),
};

module.exports = gateway;
