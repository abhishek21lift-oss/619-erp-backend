'use strict';
// Hostinger integration — super-admin API.
//
// Mounted under the super-admin router, which already applies the full
// platform guard chain at the mount point (auth → requireSuperAdmin →
// requireSuperAdminMfa → requirePlatformOwner) and opens the platform DB
// context with runAsPlatform(). Nothing here re-implements any of that: this
// file is routes, validation of the SHAPE of a request, audit, and the wiring
// of the three services.
//
// ── Shape of the API ───────────────────────────────────────────────────────
//
//   GET    /hostinger/status                 the credential state machine
//   GET    /hostinger/catalogue              the 61 operations, described
//   POST   /hostinger/credential             connect (verifies before storing)
//   POST   /hostinger/credential/rotate      replace the stored credential
//   POST   /hostinger/credential/verify      re-run the live check
//   DELETE /hostinger/credential             revoke
//   GET    /hostinger/credential/history     every credential ever stored
//   GET    /hostinger/dashboard              the console's first screen
//   GET    /hostinger/vps/:id                one machine in full
//   GET    /hostinger/vps/:id/docker/:project
//   GET    /hostinger/websites/:username/:domain/files
//   POST   /hostinger/operations/read        call a read operation
//   POST   /hostinger/operations/plan        store an approval for a write
//   POST   /hostinger/operations/execute     run an approved write
//   GET    /hostinger/approvals              this operator's pending approvals
//   POST   /hostinger/approvals/:id/deny     refuse one
//   GET    /hostinger/history                what was done, from activity_log
//   POST   /hostinger/assistant              ask a question / get a proposal
//
// ── What is audited, and what deliberately is not ──────────────────────────
//
// This console can recreate a production VPS. Every credential change, every
// plan, every execute, every refusal, every deliberate read operation and every
// assistant question writes an `activity_log` row — `activity_log` is what the
// history screen reads back, and it is the only record that survives a session.
// The write routes audit the OUTCOME (ok or failed) rather than the attempt, so
// "who restarted the server" has an answer with a result attached.
//
// The high-frequency reads are NOT audited — status, catalogue, dashboard and
// the per-object tables. A dashboard is not an event; one row per dashboard
// load would drown the answer to "what did an operator DO" in the question
// "what did a screen MOVE". The read-operation route is the boundary: an
// operator asking for a specific object IS an event.
//
// Nothing audited here ever contains a token, a password or a response body —
// the params recorded are the ones that were validated, with secret fields
// already dropped by the plan step.

const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { makeStore } = require('../../../lib/rateLimitStore');
const { scrubBounded } = require('../../../lib/secretScrub');
const { validate } = require('../../../middleware/validate');
const { audit, logger } = require('./shared');
const credentials = require('../hostinger/credentials.service');
const operations = require('../hostinger/operations.service');
const assistant = require('../hostinger/assistant.service');
const {
  credentialSchemas,
  paramsSchemas,
  pathSchemas,
  listSchemas,
} = require('../hostinger/schemas');

/**
 * This module's own limiter, after `auth`.
 *
 * The general API limiter runs before authentication and therefore cannot
 * attribute a request to an operator; this one can. It is deliberately well
 * above human use — the Hostinger pacer is what protects the upstream budget —
 * and exists to stop a stuck client or a script from spending the minute's
 * quota before anybody notices.
 */
const hostingerLimiter = rateLimit({
  store: makeStore('hostinger'),
  passOnStoreError: true,
  windowMs: 60 * 1000,
  max: Number(process.env.HOSTINGER_RATE_LIMIT_PER_MINUTE) > 0
    ? Number(process.env.HOSTINGER_RATE_LIMIT_PER_MINUTE)
    : 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? ipKeyGenerator(req.ip),
  message: {
    error: {
      code: 'HOSTINGER_RATE_LIMITED',
      message: 'Too many Hostinger console requests in a minute — wait a moment and try again.',
    },
  },
});
router.use(hostingerLimiter);

/** The acting operator. The mount guarantees one; this names it once. */
function actorOf(req) {
  return { id: req.user?.id || null, name: req.user?.name || null };
}

/**
 * Send a failure in the shape the frontend already understands
 * (`{ error: { code, message } }`) and never include a stack or an upstream
 * body: those carry tokens in the worst case and noise in every other.
 */
function sendError(res, err) {
  const status = err instanceof credentials.HostingerError ? err.status
    : err?.status && Number.isInteger(err.status) ? err.status
      : 500;
  const code = err?.code && typeof err.code === 'string' && /^[A-Z_]+$/.test(err.code)
    ? err.code
    : 'HOSTINGER_ERROR';
  const message = status === 500 ? 'The hosting console hit an internal error.' : err.message;
  if (status === 500) logger.error({ err: err.message, stack: err.stack }, 'hostinger route failed');
  return res.status(status).json({
    error: {
      code,
      message,
      ...(err.details ? { fields: err.details } : {}),
    },
  });
}

/** Every handler is this: run, then map a failure to a response. */
const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    sendError(res, err);
  }
};

// ── Status and catalogue ───────────────────────────────────────────────────

router.get('/hostinger/status', handle(async (req, res) => {
  const state = await credentials.status();
  res.json({ ...state, history: await credentials.history({ limit: 10 }) });
}));

router.get('/hostinger/catalogue', handle(async (_req, res) => {
  res.json(operations.listCatalogue());
}));

// ── The credential ─────────────────────────────────────────────────────────

router.post('/hostinger/credential', validate(credentialSchemas.connect), handle(async (req, res) => {
  const actor = actorOf(req);
  const result = await credentials.connect({
    token: req.body.token,
    label: req.body.label,
    actorId: actor.id,
  });
  // The label and the last four characters only. There is no path by which the
  // token reaches this call, and a test asserts the audit row has no token.
  await audit(req, 'hostinger.credential.connect', 'hostinger_credential', result.credential?.id, {
    label: req.body.label || null,
    hint: result.credential?.hint || null,
    unchanged: !!result.unchanged,
  });
  res.status(result.unchanged ? 200 : 201).json({
    state: result.state,
    unchanged: !!result.unchanged,
    credential: result.credential,
  });
}));

router.post('/hostinger/credential/rotate', validate(credentialSchemas.connect), handle(async (req, res) => {
  const actor = actorOf(req);
  const result = await credentials.rotate({
    token: req.body.token,
    label: req.body.label,
    actorId: actor.id,
  });
  await audit(req, 'hostinger.credential.rotate', 'hostinger_credential', result.credential?.id, {
    label: req.body.label || null,
    hint: result.credential?.hint || null,
    unchanged: !!result.unchanged,
  });
  res.json({ state: result.state, unchanged: !!result.unchanged, credential: result.credential });
}));

router.post('/hostinger/credential/verify', handle(async (req, res) => {
  const outcome = await credentials.reverify();
  await audit(req, 'hostinger.credential.verify', 'hostinger_credential', null, {
    ok: outcome.ok,
    status: outcome.status ?? null,
  });
  res.status(outcome.ok ? 200 : 502).json(outcome);
}));

router.delete('/hostinger/credential', handle(async (req, res) => {
  const actor = actorOf(req);
  const revoked = await credentials.revoke({ actorId: actor.id });
  await audit(req, 'hostinger.credential.revoke', 'hostinger_credential', revoked.id, {
    label: revoked.label,
    hint: revoked.token_hint,
  });
  res.json({ revoked: true, credential: { id: revoked.id, label: revoked.label, hint: revoked.token_hint } });
}));

router.get('/hostinger/credential/history', validate(listSchemas.history), handle(async (req, res) => {
  res.json({ credentials: await credentials.history({ limit: req.query.limit }) });
}));

// ── Dashboard and object detail ────────────────────────────────────────────

router.get('/hostinger/dashboard', handle(async (req, res) => {
  const force = req.query.force === 'true' || req.query.force === '1';
  res.json(await operations.dashboard({ force }));
}));

router.get('/hostinger/vps/:virtualMachineId', validate(pathSchemas.vps), handle(async (req, res) => {
  res.json(await operations.vpsDetail({ virtualMachineId: req.params.virtualMachineId }));
}));

router.get(
  '/hostinger/vps/:virtualMachineId/docker/:projectName',
  validate(pathSchemas.dockerProject),
  handle(async (req, res) => {
    res.json(await operations.dockerProject({
      virtualMachineId: req.params.virtualMachineId,
      projectName: req.params.projectName,
    }));
  })
);

router.get(
  '/hostinger/websites/:username/:domain/files',
  validate(pathSchemas.websiteFiles),
  handle(async (req, res) => {
    res.json(await operations.websiteFiles({
      username: req.params.username,
      domain: req.params.domain,
      directory: req.query.directory,
      filePath: req.query.path,
      fromLine: req.query.from_line,
      maxLines: req.query.max_lines,
    }));
  })
);

// ── Operations ─────────────────────────────────────────────────────────────

router.post('/hostinger/operations/read', validate(paramsSchemas.read), handle(async (req, res) => {
  const { token } = await credentials.activeToken();
  const result = await operations.read({
    operationId: req.body.operation,
    params: req.body.params,
    token,
  });
  // Reads are audited too — not every read (a dashboard is not an event), but
  // the ones an operator deliberately asked for, because "who read the
  // wp-config" is a question worth being able to answer.
  await audit(req, 'hostinger.read', 'hostinger_operation', req.body.operation, {
    ok: result.ok,
    status: result.status,
    params: operations.publicParams(req.body.operation, req.body.params),
  });
  if (!result.ok) {
    return res.status(result.status && result.status >= 400 ? result.status : 502).json({
      error: { code: result.error.code, message: result.error.message, fields: result.error.fields, correlation_id: result.error.correlationId },
    });
  }
  res.json({ operation: req.body.operation, data: result.data });
}));

router.post('/hostinger/operations/plan', validate(paramsSchemas.plan), handle(async (req, res) => {
  const actor = actorOf(req);
  const plan = await operations.plan({
    operationId: req.body.operation,
    params: req.body.params,
    actorId: actor.id,
    actorName: actor.name,
  });
  await audit(req, 'hostinger.plan', 'hostinger_approval', plan.approval_id, {
    operation: plan.operation,
    safety: plan.safety,
  });
  res.status(201).json(plan);
}));

router.post('/hostinger/operations/execute', validate(paramsSchemas.execute), handle(async (req, res) => {
  const actor = actorOf(req);
  const result = await operations.execute({
    operationId: req.body.operation,
    approvalId: req.body.approval_id,
    confirmation: req.body.confirmation,
    secrets: req.body.secrets,
    actorId: actor.id,
  });
  await audit(req, 'hostinger.execute', 'hostinger_approval', result.approval_id, {
    operation: result.operation,
    safety: result.safety,
    ok: result.ok,
    status: result.status,
    // Never the request body: this is the row that survives, and a recreate
    // carries a root password in the request that produced it.
    ...(result.ok ? {} : { error: { code: result.error.code, message: result.error.message } }),
  });
  if (!result.ok) {
    return res.status(result.status && result.status >= 400 ? result.status : 502).json({
      error: { code: result.error.code, message: result.error.message, fields: result.error.fields, correlation_id: result.error.correlationId },
      approval_id: result.approval_id,
    });
  }
  res.json({ operation: result.operation, safety: result.safety, approval_id: result.approval_id, data: result.data });
}));

router.get('/hostinger/approvals', validate(listSchemas.approvals), handle(async (req, res) => {
  res.json({ approvals: await operations.pendingApprovals({ actorId: req.user?.id, limit: req.query.limit }) });
}));

router.post('/hostinger/approvals/:id/deny', validate(pathSchemas.approvalId), handle(async (req, res) => {
  const denied = await operations.deny({ approvalId: req.params.id, actorId: req.user?.id });
  await audit(req, 'hostinger.deny', 'hostinger_approval', denied.id, { operation: denied.operation });
  res.json({ denied: true, approval_id: denied.id });
}));

router.get('/hostinger/history', validate(listSchemas.history), handle(async (req, res) => {
  res.json(await operations.history({ limit: req.query.limit, offset: req.query.offset, action: req.query.action }));
}));

// ── The assistant ──────────────────────────────────────────────────────────

router.post('/hostinger/assistant', validate(credentialSchemas.ask), handle(async (req, res) => {
  const actor = actorOf(req);
  const answer = await assistant.ask({ question: req.body.question, actorId: actor.id });
  // The question is recorded, scrubbed; the answer and proposal are not — the
  // proposal is in the approval row if it is acted on, and the answer is model
  // prose, not a decision.
  await audit(req, 'hostinger.assistant.ask', 'hostinger_assistant', null, {
    // The question as it may be stored: bounded, and scrubbed of anything that
    // looks like a credential. Somebody pastes a token into a chat box more
    // often than anyone expects, and this column outlives the session.
    question: scrubBounded(assistant.maskShapedCredentials(req.body.question), { max: 400 }),
    proposed: answer.proposal?.operation || null,
    rejected: !!answer.proposal?.rejected,
  });
  res.json({ ...answer, rate: assistant.rateStatus(actor.id) });
}));

module.exports = router;
