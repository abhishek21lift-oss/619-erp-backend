// src/lib/ai.service.js
// 619 Fitness AI Coach — Token Router → MiniMax-M3
// Single centralized AI service. All modules call generateAIResponse() from here.
'use strict';

const pool   = require('../db/pool');
const logger = require('./logger');

const MODEL       = () => process.env.TOKEN_ROUTER_MODEL || 'MiniMax-M3';
const BASE_URL    = () => (process.env.TOKEN_ROUTER_BASE_URL || 'https://api.tokenrouter.com/v1').replace(/\/+$/, '');
const MAX_TOKENS  = 2000;
const TEMPERATURE = 0.7;
const TIMEOUT_MS  = 60_000;    // 60 s per request
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1_000;   // 1 s, 2 s, 3 s back-off

const HOURLY_LIMIT_MEMBER  = 30;
const HOURLY_LIMIT_TRAINER = 100;
const HOURLY_LIMIT_ADMIN   = 200;

// ── Configuration check ───────────────────────────────────────────────────────

function isConfigured() {
  return !!process.env.TOKEN_ROUTER_API_KEY;
}

// ── Rate limiting (DB-backed, role-aware) ─────────────────────────────────────

async function checkRateLimit(userId, role) {
  const limit =
    role === 'admin' || role === 'manager' ? HOURLY_LIMIT_ADMIN :
    role === 'trainer'                     ? HOURLY_LIMIT_TRAINER :
                                             HOURLY_LIMIT_MEMBER;

  const { rows } = await pool.query(
    `SELECT COUNT(*) AS n FROM ai_messages
     WHERE conversation_id IN (SELECT id FROM ai_conversations WHERE user_id = $1)
       AND role = 'user'
       AND created_at > NOW() - INTERVAL '1 hour'`,
    [userId]
  );
  const used = parseInt(rows[0].n);
  if (used >= limit) {
    throw Object.assign(
      new Error(`Rate limit reached (${limit} messages/hour). Please wait before sending more.`),
      { status: 429 }
    );
  }
}

// ── Member context builder ────────────────────────────────────────────────────

async function buildMemberContext(userId, userRole, clientId) {
  const ctx = {};

  try {
    const { rows: users } = await pool.query(
      'SELECT id, name, email, role, member_id, trainer_id FROM users WHERE id = $1',
      [userId]
    );
    if (!users[0]) return ctx;
    ctx.user = users[0];

    const linkedClientId = clientId || users[0].member_id;
    if (linkedClientId) {
      const { rows: clients } = await pool.query(
        `SELECT c.*, t.name AS trainer_name
         FROM clients c
         LEFT JOIN trainers t ON t.id = c.trainer_id
         WHERE c.id = $1`,
        [linkedClientId]
      );
      if (clients[0]) {
        ctx.client = clients[0];

        const { rows: wl } = await pool.query(
          'SELECT date, weight FROM weight_logs WHERE client_id = $1 ORDER BY date DESC LIMIT 10',
          [linkedClientId]
        );
        ctx.weightHistory = wl;

        const { rows: att } = await pool.query(
          `SELECT COUNT(*) AS total,
                  SUM(CASE WHEN status = 'present' THEN 1 ELSE 0 END) AS present
           FROM attendance_logs
           WHERE ref_id = $1 AND ref_type = 'client' AND date >= CURRENT_DATE - INTERVAL '30 days'`,
          [linkedClientId]
        );
        ctx.attendance = att[0];

        const { rows: payments } = await pool.query(
          `SELECT amount, package_type, date FROM payments
           WHERE client_id = $1 ORDER BY date DESC LIMIT 3`,
          [linkedClientId]
        );
        ctx.recentPayments = payments;
      }
    }

    // PT OS profile
    try {
      const ptQuery = userRole === 'trainer'
        ? 'SELECT * FROM pt_clients WHERE trainer_id = $1 LIMIT 1'
        : 'SELECT * FROM pt_clients WHERE client_id = $1 LIMIT 1';
      const ptParam = userRole === 'trainer' ? users[0].trainer_id : linkedClientId;
      if (ptParam) {
        const { rows: pt } = await pool.query(ptQuery, [ptParam]);
        if (pt[0]) ctx.ptClient = pt[0];
      }
    } catch (_) {}

    // Recent workout plans
    try {
      const { rows: wPlans } = await pool.query(
        `SELECT name, goal, frequency, duration_weeks, created_at
         FROM workout_plans WHERE created_by = $1 ORDER BY created_at DESC LIMIT 3`,
        [userId]
      );
      ctx.workoutPlans = wPlans;
    } catch (_) { ctx.workoutPlans = []; }

    // Recent diet plans
    try {
      const { rows: dPlans } = await pool.query(
        `SELECT name, goal, calories_target, protein_target, carbs_target, fat_target, created_at
         FROM diet_plans WHERE created_by = $1 ORDER BY created_at DESC LIMIT 2`,
        [userId]
      );
      ctx.dietPlans = dPlans;
    } catch (_) { ctx.dietPlans = []; }

  } catch (err) {
    logger.warn({ err: err.message }, 'AI context build partial failure — proceeding with available data');
  }

  return ctx;
}

// ── System prompt builder ─────────────────────────────────────────────────────

function buildSystemPrompt(ctx, userRole) {
  const lines = [
    `You are **619 Fitness AI Coach**, the official AI assistant of 619 FITNESS STUDIO.`,
    `You are a professional fitness coach, certified nutritionist, and sports scientist.`,
    `Your personality: motivating, knowledgeable, precise, and warm. You address members by first name.`,
    ``,
    `## YOUR CAPABILITIES`,
    `- Generate personalized workout programs with sets, reps, rest, progressive overload`,
    `- Create complete nutrition plans with calories, macros, meal timing, and food alternatives`,
    `- Analyze progress data and predict goal timelines`,
    `- Explain exercise techniques in detail`,
    `- Detect plateaus and suggest adjustments`,
    `- Generate trainer client reports and check-in messages`,
    ``,
    `## FORMATTING RULES`,
    `- Use markdown formatting (bold, lists, tables where appropriate)`,
    `- For workout plans: use a clear Day-by-Day structure with sets × reps format`,
    `- For nutrition plans: include a meal-by-meal schedule with portion sizes`,
    `- Always include safety notes for exercises involving injury risk`,
    `- Use metric units (kg, cm) unless member profile indicates otherwise`,
    ``,
    `## IMPORTANT`,
    `- Base ALL recommendations on the member data provided below`,
    `- Never make up data that isn't in the member profile`,
    `- If data is missing, ask the user for it before generating a plan`,
    `- Never recommend medications or diagnose medical conditions`,
    ``,
  ];

  const c = ctx.client;
  const u = ctx.user;

  if (u) {
    lines.push(`## CURRENT USER`);
    lines.push(`Name: ${u.name || 'Unknown'}`);
    lines.push(`Role: ${userRole}`);
    lines.push('');
  }

  if (c) {
    const dob = c.dob ? new Date(c.dob) : null;
    const age = dob ? Math.floor((Date.now() - dob.getTime()) / (365.25 * 24 * 3600 * 1000)) : null;

    lines.push(`## MEMBER PROFILE`);
    lines.push(`Name: ${c.name}`);
    if (age)            lines.push(`Age: ${age} years`);
    if (c.gender)       lines.push(`Gender: ${c.gender}`);
    if (c.weight)       lines.push(`Current Weight: ${c.weight} kg`);
    if (c.email)        lines.push(`Email: ${c.email}`);
    if (c.trainer_name) lines.push(`Assigned Trainer: ${c.trainer_name}`);
    if (c.notes)        lines.push(`Trainer Notes: ${c.notes}`);
    if (c.status)       lines.push(`Membership Status: ${c.status}`);
    if (c.package_type) lines.push(`Package: ${c.package_type}`);
    lines.push('');
  }

  if (ctx.weightHistory?.length) {
    lines.push(`## WEIGHT HISTORY (recent)`);
    ctx.weightHistory.slice(0, 6).forEach(w => lines.push(`- ${w.date}: ${w.weight} kg`));
    if (ctx.weightHistory.length >= 2) {
      const latest = parseFloat(ctx.weightHistory[0].weight);
      const oldest = parseFloat(ctx.weightHistory[ctx.weightHistory.length - 1].weight);
      const diff   = (latest - oldest).toFixed(1);
      lines.push(`Trend: ${diff > 0 ? '+' : ''}${diff} kg over this period`);
    }
    lines.push('');
  }

  if (ctx.attendance) {
    lines.push(`## ATTENDANCE (last 30 days)`);
    lines.push(`Sessions attended: ${ctx.attendance.present || 0} out of ${ctx.attendance.total || 0} scheduled`);
    lines.push('');
  }

  if (ctx.workoutPlans?.length) {
    lines.push(`## RECENT WORKOUT PLANS`);
    ctx.workoutPlans.forEach(p =>
      lines.push(`- ${p.name} (Goal: ${p.goal || 'N/A'}, ${p.frequency || '?'} days/week, ${p.duration_weeks || '?'} weeks)`)
    );
    lines.push('');
  }

  if (ctx.dietPlans?.length) {
    lines.push(`## RECENT NUTRITION PLANS`);
    ctx.dietPlans.forEach(p =>
      lines.push(`- ${p.name} (Goal: ${p.goal || 'N/A'}, Calories: ${p.calories_target || '?'} kcal, Protein: ${p.protein_target || '?'}g)`)
    );
    lines.push('');
  }

  if (userRole === 'trainer' || userRole === 'admin' || userRole === 'manager') {
    lines.push(`## TRAINER MODE`);
    lines.push(`You are assisting a ${userRole}. You can:`);
    lines.push(`- Generate programs for their clients`);
    lines.push(`- Create professional assessment reports`);
    lines.push(`- Draft client check-in and follow-up messages`);
    lines.push(`- Provide evidence-based coaching strategies`);
    lines.push('');
  }

  lines.push(`Today's date: ${new Date().toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`);

  return lines.join('\n');
}

// ── HTTP with retry + timeout ─────────────────────────────────────────────────

async function fetchWithRetry(url, options, attemptsLeft = MAX_RETRIES) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw Object.assign(new Error('AI service timed out. Please try again.'), { status: 504 });
    }
    if (attemptsLeft > 0) {
      const delay = (MAX_RETRIES - attemptsLeft + 1) * RETRY_BASE_MS;
      const cause = err.cause?.message ?? err.cause?.code ?? err.message;
      logger.warn({ attempt: MAX_RETRIES - attemptsLeft + 1, delay, cause }, 'AI request failed — retrying');
      await new Promise(r => setTimeout(r, delay));
      return fetchWithRetry(url, options, attemptsLeft - 1);
    }
    throw err;
  }
}

// ── Core: generateAIResponse (non-streaming) ──────────────────────────────────
// All modules that need a one-shot AI response use this function.

async function generateAIResponse({ systemPrompt, userMessage, history = [], maxTokens = MAX_TOKENS }) {
  if (!isConfigured()) {
    throw Object.assign(new Error('AI Coach is not configured. Set TOKEN_ROUTER_API_KEY.'), { status: 501 });
  }

  const messages = [
    { role: 'system',    content: systemPrompt },
    ...history,
    { role: 'user',      content: userMessage },
  ];

  const res = await fetchWithRetry(
    `${BASE_URL()}/chat/completions`,
    {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${process.env.TOKEN_ROUTER_API_KEY}`,
      },
      body: JSON.stringify({
        model:       MODEL(),
        messages,
        stream:      false,
        max_tokens:  maxTokens,
        temperature: TEMPERATURE,
      }),
    }
  );

  if (!res.ok) {
    const body   = await res.text().catch(() => '');
    const status = res.status;
    if (status === 429) throw Object.assign(new Error('AI rate limit reached. Please wait before retrying.'),   { status: 429 });
    if (status === 401 || status === 403) throw Object.assign(new Error('AI auth failed. Check TOKEN_ROUTER_API_KEY.'), { status: 500 });
    throw new Error(`AI service error (${status}): ${body.slice(0, 200)}`);
  }

  const data   = await res.json();
  const content = data.choices?.[0]?.message?.content || '';
  const usage   = data.usage || null;

  return { content, usage, model: MODEL(), provider: 'minimax' };
}

// ── Core: streamChat (SSE streaming) ─────────────────────────────────────────
// Used by the AI Coach chat endpoint. Writes SSE directly to the Express res.

async function streamChat({ userId, userRole, conversationId, message, clientId }, res) {
  if (!isConfigured()) {
    return res.status(501).json({ error: 'AI Coach is not configured. Set TOKEN_ROUTER_API_KEY.' });
  }

  const ctx          = await buildMemberContext(userId, userRole, clientId);
  const systemPrompt = buildSystemPrompt(ctx, userRole);

  let history = [];
  if (conversationId) {
    const { rows } = await pool.query(
      `SELECT role, content FROM ai_messages
       WHERE conversation_id = $1
       ORDER BY created_at ASC
       LIMIT 20`,
      [conversationId]
    );
    history = rows;
  }

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user',   content: message },
  ];

  res.setHeader('Content-Type',    'text/event-stream');
  res.setHeader('Cache-Control',   'no-cache');
  res.setHeader('Connection',      'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('X-Provider-Used', 'minimax-m3');

  let fullContent = '';
  let usage       = null;

  try {
    const httpRes = await fetchWithRetry(
      `${BASE_URL()}/chat/completions`,
      {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${process.env.TOKEN_ROUTER_API_KEY}`,
        },
        body: JSON.stringify({
          model:       MODEL(),
          messages,
          stream:      true,
          max_tokens:  MAX_TOKENS,
          temperature: TEMPERATURE,
        }),
      }
    );

    if (!httpRes.ok) {
      const body   = await httpRes.text().catch(() => '');
      const status = httpRes.status;
      if (status === 429) throw Object.assign(new Error('AI rate limit reached. Please wait before retrying.'),   { status: 429 });
      if (status === 401 || status === 403) throw Object.assign(new Error('AI auth failed. Check TOKEN_ROUTER_API_KEY.'), { status: 500 });
      throw new Error(`AI service error (${status}): ${body.slice(0, 200)}`);
    }

    const reader  = httpRes.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') {
          res.write('data: [DONE]\n\n');
          res.end();
          break outer;
        }
        try {
          const parsed  = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content || '';
          if (content) {
            fullContent += content;
            res.write(`data: ${JSON.stringify({ content })}\n\n`);
          }
          if (parsed.usage) usage = parsed.usage;
        } catch { /* non-JSON SSE lines */ }
      }
    }

    if (!res.writableEnded) {
      res.write('data: [DONE]\n\n');
      res.end();
    }

    // Persist the exchange
    await pool.query(
      `INSERT INTO ai_messages (conversation_id, role, content, provider)
       VALUES ($1, 'user', $2, 'minimax'), ($1, 'assistant', $3, 'minimax')`,
      [conversationId, message, fullContent]
    );

    await pool.query(
      'UPDATE ai_conversations SET updated_at = NOW() WHERE id = $1',
      [conversationId]
    );

    if (usage) {
      await pool.query(
        `INSERT INTO ai_usage_log
           (user_id, conversation_id, model, tokens_prompt, tokens_completion, tokens_total, provider)
         VALUES ($1, $2, $3, $4, $5, $6, 'minimax')`,
        [
          userId, conversationId, MODEL(),
          usage.prompt_tokens     || 0,
          usage.completion_tokens || 0,
          usage.total_tokens      || 0,
        ]
      ).catch(() => {});
    }

  } catch (err) {
    logger.error({ err: err.message, userId }, 'MiniMax-M3 streaming error');
    if (!res.headersSent) {
      res.status(err.status || 500).json({ error: err.message || 'AI service error. Please try again.' });
    } else if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: 'AI response interrupted. Please try again.' })}\n\n`);
      res.end();
    }
  }
}

// ── Health check ──────────────────────────────────────────────────────────────

async function testConnection() {
  if (!isConfigured()) {
    return { success: false, message: 'TOKEN_ROUTER_API_KEY is not set' };
  }

  // Use a direct fetch (no retries) with a tight 15 s timeout — this is a
  // health check, not a production call. Node.js native fetch wraps the real
  // network error inside err.cause, so we surface that instead of the generic
  // "fetch failed" TypeError message.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  try {
    const res = await fetch(
      `${BASE_URL()}/chat/completions`,
      {
        method:  'POST',
        signal:  controller.signal,
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${process.env.TOKEN_ROUTER_API_KEY}`,
        },
        body: JSON.stringify({
          model:      MODEL(),
          messages:   [{ role: 'user', content: 'Reply with exactly one word: ok' }],
          max_tokens: 5,
          stream:     false,
        }),
      }
    );
    clearTimeout(timer);

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const base = `HTTP ${res.status}: ${body.slice(0, 200)}`;

      // On 403 / 404 model-not-found errors, also fetch /v1/models so the
      // admin can see which models this API key actually has access to.
      if (res.status === 403 || res.status === 404) {
        try {
          const modelsRes = await fetch(`${BASE_URL()}/models`, {
            headers: { 'Authorization': `Bearer ${process.env.TOKEN_ROUTER_API_KEY}` },
          });
          if (modelsRes.ok) {
            const modelsData = await modelsRes.json();
            const names = (modelsData.data ?? modelsData.models ?? modelsData ?? [])
              .slice(0, 20)
              .map(m => m.id ?? m.name ?? m)
              .filter(Boolean)
              .join(', ');
            if (names) {
              return { success: false, message: `${base} — Set TOKEN_ROUTER_MODEL to one of: ${names}` };
            }
          }
        } catch (_) { /* ignore secondary fetch errors */ }
      }

      return { success: false, message: base };
    }
    const data  = await res.json();
    const reply = data.choices?.[0]?.message?.content?.trim() || '(no response)';
    return { success: true, message: `Connected via Token Router (${MODEL()}) — responded: "${reply}"` };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      return { success: false, message: `Connection timed out (15 s). Verify TOKEN_ROUTER_BASE_URL is set correctly (currently: ${BASE_URL()})` };
    }
    // err.cause holds the underlying OS/TLS/DNS error on Node.js native fetch
    const cause  = err.cause?.message ?? err.cause?.code ?? '';
    const detail = cause ? `${err.message}: ${cause}` : (err.message || 'Connection test failed');
    return { success: false, message: detail };
  }
}

// ── Usage stats ───────────────────────────────────────────────────────────────

async function getStats() {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*)                                                           AS requests,
       COALESCE(SUM(tokens_total), 0)                                    AS tokens_total,
       COALESCE(SUM(tokens_prompt), 0)                                   AS tokens_prompt,
       COALESCE(SUM(tokens_completion), 0)                               AS tokens_completion,
       COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') AS requests_today,
       COALESCE(SUM(tokens_total) FILTER
         (WHERE created_at > NOW() - INTERVAL '24 hours'), 0)            AS tokens_today
     FROM ai_usage_log
     WHERE provider = 'minimax' AND created_at > NOW() - INTERVAL '30 days'`
  ).catch(() => ({
    rows: [{ requests: 0, tokens_total: 0, tokens_prompt: 0, tokens_completion: 0, requests_today: 0, tokens_today: 0 }],
  }));

  return {
    minimax: {
      configured: isConfigured(),
      model:      MODEL(),
      provider:   'Token Router',
      ...rows[0],
    },
  };
}

module.exports = {
  get MODEL() { return MODEL(); },
  isConfigured,
  checkRateLimit,
  buildMemberContext,
  buildSystemPrompt,
  generateAIResponse,
  streamChat,
  testConnection,
  getStats,
};
