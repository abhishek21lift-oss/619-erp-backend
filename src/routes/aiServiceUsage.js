'use strict';
// /api/ai/usage/service — internal AI-service endpoints (round-2 remediation).
//
// The mps-ai assistant spends the SAME OpenRouter account as this backend but
// had no metering of its own (round-2 MPS-01). Rather than a second accounting
// system, it reports into the ledger this backend already owns:
//
//   POST /ingest   one row per successful assistant turn, into ai_usage_log,
//                  with intent_type 'client_agent'. Identity is never claimed
//                  by the caller: user and studio are resolved server-side
//                  from the FORWARDED user token, exactly like every tool read.
//
//   GET  /quota    the caller's studio allowance (lib/aiQuota.statusFor), so
//                  the assistant can enforce the shared budget before it sends
//                  tokens to the provider.
//
// Both are FIRST-PARTY-ONLY: requireServiceAuth() rejects the open internet,
// `auth()` resolves the acting user, `requireTrainer` keeps member tokens out.
// Feature gates are deliberately absent — a bookkeeping endpoint must not 403
// on an AI feature flag, or the quota enforcement would blind itself.

const express = require('express');
const router = express.Router();
const { auth, requireTrainer } = require('../middleware/auth');
const { requireServiceAuth } = require('../middleware/serviceAuth');
const { statusFor } = require('../lib/aiQuota');
const usage = require('../lib/ai/usage');
const { usageFields } = require('../lib/ai/metering');

// Field-by-field whitelist, because the caller is a service we own but the
// body is still untrusted input: never log client names, prompts, notes or
// tokens here, and never accept a user/org id from the body.
const MAX_LATENCY_MS = 5 * 60 * 1000;
const MAX_TOKENS = 2_000_000;
const MAX_REPLY_CHARS = 1_000_000;
const OUTCOMES = new Set(['ok']);
const MODELS_RE = /^[A-Za-z0-9._:/@-]{1,120}$/;

function intWithin(v, max) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > max) return null;
  return n;
}

router.get('/quota', requireServiceAuth(), auth, requireTrainer, async (req, res) => {
  // Shared with every AI route: a studio without an organization id has no
  // quota to check, and reaching that conclusion costs the caller nothing.
  const orgId = req.user?.organization_id;
  if (!orgId) {
    return res.status(403).json({
      error: { code: 'NO_STUDIO', message: 'This account has no studio to bill AI usage against.' },
    });
  }
  try {
    const s = await statusFor(orgId);
    // Plain object JSON; the mps-ai side tolerates {data:...} wrappers too.
    return res.json(s);
  } catch (err) {
    // The quota probe exists BECAUSE a check may fail; the assistant's
    // enforce-mode treats this as fail-closed. Report as an upstream state,
    // not a stack trace.
    return res.status(503).json({
      error: { code: 'QUOTA_UNAVAILABLE', message: 'Quota cannot be evaluated right now.' },
    });
  }
});

router.post('/ingest', requireServiceAuth(), auth, requireTrainer, async (req, res) => {
  const body = req.body || {};

  const requestId = typeof body.requestId === 'string' && body.requestId.length <= 80
    ? body.requestId
    : null;
  const model = typeof body.model === 'string' && MODELS_RE.test(body.model)
    ? body.model
    : null;
  const outcome = OUTCOMES.has(body.outcome) ? body.outcome : null;

  if (!requestId || !model || !outcome) {
    return res.status(400).json({
      error: { code: 'BAD_BODY', message: 'requestId, model and outcome=ok are required.' },
    });
  }

  const latencyMs = intWithin(body.latencyMs, MAX_LATENCY_MS) ?? 0;
  const usedFallback = body.usedFallback === true;

  // Only a well-formed pair counts as exact ("provider") usage; anything
  // partial or absent flows into usageFields() and is labelled 'estimated'
  // (completion ≈ replyChars/4) — the ERP's own convention. A silent 0 never
  // happens here, and nothing the body claims about the user is trusted:
  // identity comes from auth() alone (round-2 MPS-01 requirements 2-4).
  const promptKnown = intWithin(body.promptTokens, MAX_TOKENS);
  const completionKnown = intWithin(body.completionTokens, MAX_TOKENS);
  const usageIn = {
    prompt_tokens: promptKnown,
    completion_tokens: completionKnown,
  };
  const replyChars = intWithin(body.replyChars, MAX_REPLY_CHARS) ?? 0;
  const fields = usageFieldsFor(usageIn, promptKnown !== null && completionKnown !== null, replyChars);

  await usage.logUsage({
    user_id: req.user.id,
    conversation_id: null,
    model,
    provider: 'openrouter',
    intent_type: 'client_agent',
    tokens_prompt: fields.tokens_prompt,
    tokens_completion: fields.tokens_completion,
    latency_ms: latencyMs,
    used_fallback: usedFallback,
    cost_inr: fields.cost_inr,
    usage_source: fields.usage_source,
    request_id: requestId,
  });

  return res.status(202).json({ ok: true, usage_source: fields.usage_source });
});

/**
 * Thin wrapper over the shared metering convention (lib/ai/metering.js): one
 * estimate rule for ERP calls and service-reported turns alike. Exact usage
 * is only believed when BOTH halves are well-formed positive integers.
 */
function usageFieldsFor(usageIn, bothKnown, replyChars) {
  const known = bothKnown && usageIn.prompt_tokens > 0
    ? usageIn
    : null; // anything else is deliberately fed to the estimate path
  return usageFields(known, replyChars);
}

module.exports = router;
