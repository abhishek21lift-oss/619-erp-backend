'use strict';
// POST /api/ai/copilot/context — resolve the trainer context, no model call.
// GET  /api/ai/copilot/conversations/:conversationId/tool-runs — ledger list.
// GET  /api/ai/copilot/tool-runs/:runId — one ledger entry.
//
// Mounted in server.js behind studioGate('ai_suite') + userApiLimiter.
// Deliberately NOT behind requireAiQuota(): these endpoints spend no tokens,
// and a context or history read must not fail because the studio's monthly
// allowance is exhausted — that state belongs to the chat surface, which
// reports it.
//
// A client id that is missing, deleted, in another studio or not assigned to
// the caller all produce the same 404. Otherwise the response itself would say
// whether an id exists elsewhere. The ledger APIs use the same rule: a foreign
// conversation or run is indistinguishable from an unknown one, and neither
// response confirms that the id exists.

const express = require('express');
const logger = require('../../lib/logger');
const { ContextError, resolveTrainerContext } = require('./context/trainer-context');
const { assembleContext } = require('./context/assemble');
const { conversationForUser, getToolRun, listToolRuns } = require('./tools/ledger');

const router = express.Router();
const MAX_CLIENT_ID_LENGTH = 100;
const MAX_ID_LENGTH = 100;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function validId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function contextError(res, err) {
  return res.status(err.status).json({ error: { code: err.code, message: err.message } });
}

router.post('/context', async (req, res, next) => {
  try {
    const raw = req.body?.client_id;
    if (raw !== undefined && raw !== null
      && (typeof raw !== 'string' || raw.length > MAX_CLIENT_ID_LENGTH)) {
      return res.status(400).json({
        error: {
          code: 'INVALID_CLIENT_ID',
          message: `client_id must be a string of at most ${MAX_CLIENT_ID_LENGTH} characters`,
        },
      });
    }

    const ctx = resolveTrainerContext(req);
    const clientId = raw || null;
    const context = await assembleContext(ctx, clientId);

    if (clientId && !context) {
      return res.status(404).json({
        error: { code: 'CLIENT_NOT_FOUND', message: 'Client not found' },
      });
    }

    if (clientId) {
      // Ids only. The client's name, contact details and any clinical text stay
      // out of the application log.
      logger.info({
        event: 'copilot.context.client_access',
        user_id: ctx.identity.userId,
        organization_id: ctx.tenant.organizationId,
        client_id: clientId,
        policy: ctx.clientAccess.policy,
      }, 'copilot client context read');
    }

    res.json({ context });
  } catch (err) {
    if (err instanceof ContextError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    }
    next(err);
  }
});

/* ── Ledger reads ──────────────────────────────────────────────────────────
   Tenant and user are taken from the authenticated request only. The
   conversation ownership check is repeated here rather than trusted from the
   path: a conversation id in a URL is caller input like any other. */

router.get('/conversations/:conversationId/tool-runs', async (req, res, next) => {
  try {
    const ctx = resolveTrainerContext(req);
    const { conversationId } = req.params;
    if (!validId(conversationId)) {
      return res.status(400).json({
        error: { code: 'INVALID_CONVERSATION_ID', message: 'conversationId is invalid' },
      });
    }

    let limit = DEFAULT_LIMIT;
    if (req.query.limit !== undefined) {
      const parsed = Number(req.query.limit);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
        return res.status(400).json({
          error: { code: 'INVALID_LIMIT', message: `limit must be an integer from 1 to ${MAX_LIMIT}` },
        });
      }
      limit = parsed;
    }

    const before = req.query.before;
    if (before !== undefined && (typeof before !== 'string' || Number.isNaN(Date.parse(before)))) {
      return res.status(400).json({
        error: { code: 'INVALID_CURSOR', message: 'before must be an ISO timestamp' },
      });
    }
    const beforeId = req.query.before_id;
    if (beforeId !== undefined && !validId(beforeId)) {
      return res.status(400).json({
        error: { code: 'INVALID_CURSOR', message: 'before_id is invalid' },
      });
    }

    const owned = await conversationForUser(
      ctx.tenant.organizationId, ctx.identity.userId, conversationId
    );
    if (!owned) {
      return res.status(404).json({
        error: { code: 'CONVERSATION_NOT_FOUND', message: 'Conversation not found' },
      });
    }

    const runs = await listToolRuns({
      organizationId: ctx.tenant.organizationId,
      userId: ctx.identity.userId,
      conversationId,
      limit,
      before: before || null,
      beforeId: beforeId || null,
    });

    const last = runs[runs.length - 1];
    res.json({
      runs,
      next: runs.length === limit && last
        ? { before: last.created_at, before_id: last.id }
        : null,
    });
  } catch (err) {
    if (err instanceof ContextError) return contextError(res, err);
    next(err);
  }
});

router.get('/tool-runs/:runId', async (req, res, next) => {
  try {
    const ctx = resolveTrainerContext(req);
    const { runId } = req.params;
    if (!validId(runId)) {
      return res.status(400).json({
        error: { code: 'INVALID_RUN_ID', message: 'runId is invalid' },
      });
    }

    const run = await getToolRun({
      organizationId: ctx.tenant.organizationId,
      userId: ctx.identity.userId,
      id: runId,
    });
    if (!run) {
      return res.status(404).json({
        error: { code: 'TOOL_RUN_NOT_FOUND', message: 'Tool run not found' },
      });
    }
    res.json({ run });
  } catch (err) {
    if (err instanceof ContextError) return contextError(res, err);
    next(err);
  }
});

module.exports = router;
