'use strict';
// POST /api/ai/client-agent/chat/stream — the consolidated Client Assistant.
//
// Replaces mps-ai's /ai/client-agent/chat/stream. The wire contract is the one
// ClientAiPanel already consumes (src/lib/client-ai.ts):
//
//   data: {"type":"start","clientId","clientName","toolsUsed","toolsUnavailable","requestId"}
//   data: {"type":"chunk","content":"<delta>"}      (repeated)
//   data: {"type":"done","message","clientId","clientName","toolsUsed",
//          "toolsUnavailable","proposedAction","requiresConfirmation","meta","requestId"}
//   data: {"type":"error","code","message","partial","status"}   (terminal)
//   : ping                                            (heartbeat comment)
//
// Authorisation happens BEFORE the 200 status line. That gives a foreign client
// a real 404 (not an SSE error), and proves no tool ran for it. The mount in
// server.js carries studioGate('ai_suite') + aiLimiter + requireAiQuota(), so
// entitlement, trainer role and the monthly allowance are decided before this
// handler is entered — the same gates every other /api/ai route has.

const express = require('express');
const crypto = require('node:crypto');
const { z } = require('zod');
const { startSseHeartbeat } = require('../lib/sse-heartbeat');
const { orgIdOf } = require('../lib/tenant-db');
const read = require('../modules/pt-os/client-read.service');
const { ask } = require('../modules/client-agent/agent');
const logger = require('../lib/logger');

const Body = z.object({
  clientId: z.string().trim().min(1).max(64),
  message: z.string().trim().min(1, 'message is required').max(2000),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().max(4000),
  })).max(40).optional(),
});

function sseWrite(res, event, data) {
  // A caller that hung up leaves a destroyed socket behind; writing to it
  // raises asynchronously and would surface as an unhandled 'error'.
  if (res.writableEnded || res.destroyed) return;
  // Named event plus the typed JSON body, matching the retired service. The
  // browser parser keys on the body's `type`, so both readers agree.
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  } catch {
    // The socket went away between the guard and the write. The agent's abort
    // path handles the accounting; there is nobody left to send an error to.
  }
}

const router = express.Router();

router.post('/chat/stream', async (req, res) => {
  const requestId = req.id || crypto.randomUUID();

  // The mount already guarantees this; the explicit refusal keeps a future
  // re-mount from silently opening an unauthenticated path.
  if (!req.user?.organization_id) {
    return res.status(401).json({ error: { code: 'NO_TOKEN', message: 'Authentication required.' } });
  }

  const parsed = Body.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({
      error: {
        code: 'BAD_REQUEST',
        message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      },
    });
  }

  const { clientId, message, history } = parsed.data;
  const orgId = orgIdOf(req);

  // 1. Authorise before opening the stream. A client outside the caller's
  //    studio is indistinguishable from one that never existed, and no tool,
  //    prompt or token exists yet.
  let authorised;
  try {
    authorised = await read.findVisibleClient(orgId, clientId);
  } catch (err) {
    logger.error({ requestId, err: err.message }, 'client_agent_authorise_failed');
    return res.status(503).json({
      error: { code: 'UNAVAILABLE', message: 'The assistant is temporarily unavailable. Please try again.' },
    });
  }
  if (!authorised) {
    return res.status(404).json({
      error: { code: 'CLIENT_NOT_FOUND', message: 'Not found, or not visible to you.' },
    });
  }

  // 2. SSE headers only after authorisation.
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const stopHeartbeat = startSseHeartbeat(res);
  let sentStart = false;
  let sentChars = 0;
  let lastContent = '';

  // The trainer closed the panel: abort the model call and record no usage.
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });

  const finish = () => {
    stopHeartbeat();
    if (!res.writableEnded && !res.destroyed) res.end();
  };

  try {
    const result = await ask({
      req,
      clientId,
      message,
      history,
      authorised,
      requestId,
      signal: controller.signal,
      onDelta(cumulative, provenance) {
        lastContent = cumulative;
        if (!sentStart) {
          sentStart = true;
          sseWrite(res, 'start', {
            clientId,
            clientName: provenance?.clientName,
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
      // A disconnect has no reader left. Everything else is a terminal error
      // event so the panel can show a specific message instead of a cut-off.
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
        clientId,
        clientName: result.clientName,
        toolsUsed: result.toolsUsed,
        toolsUnavailable: result.toolsUnavailable,
        requestId,
      });
    }
    if (!lastContent) {
      // Deltas never fired (defensive; ask() returns the full content on ok):
      // deliver the whole answer as one delta so the panel still paints.
      sseWrite(res, 'chunk', { content: result.message });
    }
    sseWrite(res, 'done', {
      message: result.message,
      clientId: result.clientId,
      clientName: result.clientName,
      toolsUsed: result.toolsUsed,
      toolsUnavailable: result.toolsUnavailable,
      proposedAction: result.proposedAction,
      requiresConfirmation: result.requiresConfirmation,
      meta: result.meta,
      requestId,
    });
    return finish();
  } catch (err) {
    // Unexpected only. Deliberately generic: err.message can carry a prompt
    // fragment or an upstream URL, and this text goes to a browser.
    logger.error({ requestId, code: err?.code }, 'client_agent_stream_unhandled');
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
