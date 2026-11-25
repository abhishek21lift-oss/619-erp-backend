'use strict';
// The member's AI surface.
//
//   GET    /api/me/ai/history    recent turns + whether AI is configured
//   DELETE /api/me/ai/history    clear this member's turns
//   POST   /api/me/ai/chat       SSE answer, optional draft proposal
//
// Identity is the session's `pt_client_id` and `organization_id`. No route
// takes a client, organisation or conversation id — there is nothing in the
// request to tamper with.
//
// The mount in server.js carries auth, requireClient, requireFeature('ai_suite'),
// the per-user and AI burst limits, and requireAiQuota(). The guards inside
// this router are defence in depth for a future re-mount, not the entitlement
// decision.
//
// SSE contract:
//   event: start  data: {"type":"start","toolsUsed","toolsUnavailable","requestId"}
//   event: chunk  data: {"type":"chunk","content":"<delta>"}        (repeated)
//   event: done   data: {"type":"done","message","toolsUsed","toolsUnavailable",
//                        "proposedMessage","requiresConfirmation","meta","requestId"}
//   event: error  data: {"type":"error","code","message","partial","status"}
//   : ping                                                          (heartbeat)

const express = require('express');
const crypto = require('node:crypto');
const { z } = require('zod');
const { startSseHeartbeat } = require('../../lib/sse-heartbeat');
const { orgIdOf } = require('../../lib/tenant-db');
const { isConfigured, configurationProblem } = require('../../lib/ai/config');
const logger = require('../../lib/logger');
const { ask, historyFor, clearHistory } = require('./member-ai.service');

const Body = z.object({
  message: z.string().trim().min(1, 'message is required').max(2000),
});

const UNAVAILABLE = 'The assistant is temporarily unavailable. Please try again.';

function sseWrite(res, event, data) {
  // A caller that hung up leaves a destroyed socket behind; writing to it
  // raises asynchronously and would surface as an unhandled 'error'.
  if (res.writableEnded || res.destroyed) return;
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  } catch {
    // The socket went away between the guard and the write. The abort path
    // handles accounting; there is nobody left to send an error to.
  }
}

/** Refuse a session that is not a signed-in member. True when refused. */
function refuse(req, res) {
  if (!req.user || !req.user.organization_id) {
    res.status(401).json({ error: { code: 'UNAUTH', message: 'Authentication required.' } });
    return true;
  }
  if (!req.user.pt_client_id) {
    res.status(403).json({ error: { code: 'NO_CLIENT', message: 'This area is for client accounts.' } });
    return true;
  }
  return false;
}

const router = express.Router();

router.get('/history', async (req, res) => {
  if (refuse(req, res)) return;
  try {
    const messages = await historyFor(orgIdOf(req), req.user.id, 40);
    res.json({ data: { messages, configured: isConfigured() } });
  } catch (err) {
    logger.error({ code: err?.code }, 'member_ai_history_read_failed');
    res.status(503).json({ error: { code: 'UNAVAILABLE', message: UNAVAILABLE } });
  }
});

router.delete('/history', async (req, res) => {
  if (refuse(req, res)) return;
  try {
    const cleared = await clearHistory(orgIdOf(req), req.user.id);
    res.json({ data: { cleared: cleared > 0 } });
  } catch (err) {
    logger.error({ code: err?.code }, 'member_ai_history_clear_failed');
    res.status(503).json({ error: { code: 'UNAVAILABLE', message: UNAVAILABLE } });
  }
});

router.post('/chat', async (req, res) => {
  const requestId = req.id || crypto.randomUUID();

  if (refuse(req, res)) return;

  const parsed = Body.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({
      error: {
        code: 'BAD_REQUEST',
        message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      },
    });
  }

  // A missing provider key is a configuration problem, not an outage. Say so
  // before opening a stream the member would only see fail.
  if (!isConfigured()) {
    return res.status(501).json({
      error: { code: 'AI_NOT_CONFIGURED', message: configurationProblem() },
    });
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const stopHeartbeat = startSseHeartbeat(res);
  let sentStart = false;
  let sentChars = 0;
  let lastContent = '';

  // The member closed the tab: abort the model call and write no usage.
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });

  const finish = () => {
    stopHeartbeat();
    if (!res.writableEnded && !res.destroyed) res.end();
  };

  try {
    const result = await ask({
      req,
      message: parsed.data.message,
      requestId,
      signal: controller.signal,
      onDelta(cumulative, provenance) {
        lastContent = cumulative;
        if (!sentStart) {
          sentStart = true;
          sseWrite(res, 'start', {
            toolsUsed: provenance?.toolsUsed ?? [],
            toolsUnavailable: provenance?.toolsUnavailable ?? [],
            requestId,
          });
        }
        const delta = cumulative.slice(sentChars);
        if (delta) {
          sentChars = cumulative.length;
          sseWrite(res, 'chunk', { content: delta });
        }
      },
    });

    if (!result.ok) {
      // A disconnect has no reader left. Everything else is terminal so the
      // member sees a specific message rather than a cut-off answer.
      if (result.status !== 499) {
        sseWrite(res, 'error', {
          code: result.code,
          message: result.message,
          partial: sentChars > 0,
          status: result.status || 0,
        });
      }
      return finish();
    }

    if (!sentStart) {
      sseWrite(res, 'start', {
        toolsUsed: result.toolsUsed ?? [],
        toolsUnavailable: result.toolsUnavailable ?? [],
        requestId,
      });
    }
    if (!lastContent && result.message) {
      // Deltas never fired (defensive): deliver the answer as one chunk so
      // the member still sees it.
      sseWrite(res, 'chunk', { content: result.message });
    }
    sseWrite(res, 'done', {
      message: result.message,
      toolsUsed: result.toolsUsed ?? [],
      toolsUnavailable: result.toolsUnavailable ?? [],
      proposedMessage: result.proposedMessage ?? null,
      requiresConfirmation: Boolean(result.requiresConfirmation),
      meta: result.meta ?? null,
      requestId,
    });
    return finish();
  } catch (err) {
    // Unexpected only. Deliberately generic: err.message can carry a prompt
    // fragment or an upstream URL, and this text goes to a browser.
    logger.error({ requestId, code: err?.code }, 'member_ai_stream_unhandled');
    sseWrite(res, 'error', {
      code: 'INTERNAL',
      message: 'Something went wrong.',
      partial: sentChars > 0,
      status: err?.status || 0,
    });
    return finish();
  }
});

module.exports = router;
module.exports.Body = Body;
