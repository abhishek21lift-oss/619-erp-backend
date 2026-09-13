// src/modules/command-center/container-recovery.js
//
// Rungs 4 and 5 of the recovery ladder: restart the worker, restart the API.
//
// ── The shape this deliberately is NOT ─────────────────────────────────────
//
// The obvious build is a handler that takes a container name and an action and
// asks Docker to do it. That is a remote shell with extra steps: the Docker
// API's own surface includes `POST /containers/create` (run any image, any
// command, any bind mount) and `POST /containers/{id}/exec` (run anything
// inside a running container). Anything holding /var/run/docker.sock is root on
// the host, so "super admin can restart a container" and "super admin can
// execute arbitrary code as root on the host" are the same sentence unless the
// mechanism makes them different.
//
// So three separate things constrain this module, and each is a property a test
// asserts rather than a convention to keep:
//
//   1. ONE VERB. The only request this file can construct is
//      `POST /containers/{id}/restart`. There is no code path to exec, create,
//      attach, or run. Not "we do not call it" — there is no call to remove.
//
//   2. TARGETS COME FROM THE ENVIRONMENT, NEVER FROM THE CALLER. `restart()`
//      takes a target KEY ('worker' | 'api'), which is looked up in a frozen
//      map populated at boot from CC_WORKER_CONTAINER / CC_API_CONTAINER. A
//      caller cannot name a container, and an unknown key is refused before any
//      request is built. Nothing from a request body is ever interpolated into
//      a URL or a path.
//
//   3. IT TALKS TO A PROXY, NOT THE SOCKET. DOCKER_PROXY_URL points at a
//      socket-proxy (tecnativa/docker-socket-proxy or equivalent) configured
//      with POST=1 and everything else off, so the blast radius is bounded by
//      the proxy's own allow-list as well as by this file. Two independent
//      constraints, because one of them is in a different repository and can
//      be misconfigured without this code changing.
//
// ── Off by default, and honest about it ────────────────────────────────────
//
// With no DOCKER_PROXY_URL this module reports a reason and runs nothing. That
// is the state of the current deployment: the API container has no socket and
// no proxy beside it. The console shows the rungs with the reason attached
// rather than hiding them, which is what it already did — the difference is
// that the mechanism now exists and is wired, so turning it on is a compose
// change rather than a code change.
'use strict';

const logger = require('../../lib/logger');

/** The only Docker verb this module can express. */
const RESTART_PATH = (id) => `/containers/${encodeURIComponent(id)}/restart`;

/**
 * How long to wait for the container's own graceful stop before Docker kills
 * it. Matches the worker's stop_grace_period: a membership-renewals job killed
 * mid-flight is a card charged with no membership row written.
 */
const STOP_TIMEOUT_S = Number(process.env.CC_RESTART_STOP_TIMEOUT_S) || 30;

/** How long to wait on the Docker API itself before giving up. */
const REQUEST_TIMEOUT_MS = Number(process.env.CC_RESTART_REQUEST_TIMEOUT_MS) || 20_000;

/**
 * target key -> container name, resolved from the environment.
 *
 * Read through a function rather than frozen at module load so a test can set
 * the variables without re-requiring, matching how the RLS and platform-session
 * flags are read elsewhere in this repo.
 */
function targets() {
  return {
    worker: process.env.CC_WORKER_CONTAINER || null,
    api: process.env.CC_API_CONTAINER || null,
  };
}

function proxyUrl() {
  return process.env.DOCKER_PROXY_URL || null;
}

/** True when this deployment has wired the proxy up. */
function isConfigured() {
  return Boolean(proxyUrl());
}

/**
 * Why this cannot run here, or null when it can.
 *
 * @param {'worker'|'api'} [target] when given, also checks that target exists.
 */
function unavailableReason(target) {
  if (!proxyUrl()) {
    return 'Container restart is not wired up on this deployment. It needs a Docker '
      + 'socket-proxy (POST only) beside the API and DOCKER_PROXY_URL pointing at it — '
      + 'the API container deliberately has no /var/run/docker.sock of its own.';
  }
  if (target !== undefined) {
    const name = targets()[target];
    if (!name) {
      return `No container is configured for "${target}". Set ${
        target === 'worker' ? 'CC_WORKER_CONTAINER' : 'CC_API_CONTAINER'
      }.`;
    }
  }
  return null;
}

/**
 * Restart one of the two known containers.
 *
 * @param {'worker'|'api'} target  a KEY, not a container name
 * @returns {Promise<{ ok: boolean, target: string, container: string,
 *                     status: number|null, reason: string|null }>}
 *
 * Never throws for an operational failure — the caller is a console that must
 * render a result during an incident. It DOES throw for a programming error
 * (an unknown target), because that is a bug, not a condition.
 */
async function restart(target) {
  const map = targets();
  // The allow-list check, before anything is built. `target` is compared
  // against fixed keys; it is never used to construct the path.
  if (!Object.prototype.hasOwnProperty.call(map, target)) {
    const err = new Error(`Unknown restart target: ${target}`);
    err.status = 400;
    throw err;
  }

  const reason = unavailableReason(target);
  if (reason) return { ok: false, target, container: map[target], status: null, reason };

  const container = map[target];
  const base = proxyUrl().replace(/\/+$/, '');
  const url = `${base}${RESTART_PATH(container)}?t=${STOP_TIMEOUT_S}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref?.();

  try {
    const res = await fetch(url, { method: 'POST', signal: controller.signal });
    // 204 restarted, 304 already restarting, 404 no such container.
    if (res.status === 204 || res.status === 304) {
      logger.warn({ target, container, status: res.status }, 'command-center restarted a container');
      return { ok: true, target, container, status: res.status, reason: null };
    }
    const body = await res.text().catch(() => '');
    return {
      ok: false, target, container, status: res.status,
      reason: `Docker refused the restart (${res.status})${body ? `: ${body.slice(0, 200)}` : ''}`,
    };
  } catch (err) {
    return {
      ok: false, target, container, status: null,
      reason: err.name === 'AbortError'
        ? `The Docker proxy did not answer within ${REQUEST_TIMEOUT_MS}ms`
        : `Could not reach the Docker proxy: ${err.message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  restart, isConfigured, unavailableReason, targets,
  RESTART_PATH, STOP_TIMEOUT_S, REQUEST_TIMEOUT_MS,
};
