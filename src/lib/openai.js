// src/lib/openai.js
// 619 Fitness AI Coach — OpenAI integration, context building, streaming.
'use strict';

const OpenAI = require('openai');
const pool   = require('../db/pool');
const logger = require('./logger');

const MODEL = 'gpt-4o';
const HOURLY_LIMIT_MEMBER  = 30;
const HOURLY_LIMIT_TRAINER = 100;
const HOURLY_LIMIT_ADMIN   = 200;

function getClient() {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set');
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

function isConfigured() {
  return !!process.env.OPENAI_API_KEY;
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

async function checkRateLimit(userId, role) {
  const limit = role === 'admin' || role === 'manager' ? HOURLY_LIMIT_ADMIN
    : role === 'trainer' ? HOURLY_LIMIT_TRAINER
    : HOURLY_LIMIT_MEMBER;

  const { rows } = await pool.query(
    `SELECT COUNT(*) AS n FROM ai_messages
     WHERE conversation_id IN (SELECT id FROM ai_conversations WHERE user_id = $1)
       AND role = 'user'
       AND created_at > NOW() - INTERVAL '1 hour'`,
    [userId]
  );
  const used = parseInt(rows[0].n);
  if (used >= limit) {
    throw Object.assign(new Error(`Rate limit reached (${limit} messages/hour). Please wait before sending more.`), { status: 429 });
  }
}

// ── Member context builder ────────────────────────────────────────────────────
// Fetches all available member data to inject into the system prompt.

async function buildMemberContext(userId, userRole, clientId) {
  const ctx = {};

  try {
    // 1. User record
    const { rows: users } = await pool.query(
      'SELECT id, name, email, role, member_id, trainer_id FROM users WHERE id = $1',
      [userId]
    );
    if (!users[0]) return ctx;
    ctx.user = users[0];

    // 2. Client/member profile (gym client record linked to this user)
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

        // 3. Weight history (last 10)
        const { rows: wl } = await pool.query(
          'SELECT date, weight FROM weight_logs WHERE client_id = $1 ORDER BY date DESC LIMIT 10',
          [linkedClientId]
        );
        ctx.weightHistory = wl;

        // 4. Attendance last 30 days
        const { rows: att } = await pool.query(
          `SELECT COUNT(*) AS total,
                  SUM(CASE WHEN status = 'present' THEN 1 ELSE 0 END) AS present
           FROM attendance
           WHERE ref_id = $1 AND date >= CURRENT_DATE - INTERVAL '30 days'`,
          [linkedClientId]
        );
        ctx.attendance = att[0];

        // 5. Recent payments/renewals (last 3) for membership context
        const { rows: payments } = await pool.query(
          `SELECT amount, package_type, date FROM payments
           WHERE client_id = $1 ORDER BY date DESC LIMIT 3`,
          [linkedClientId]
        );
        ctx.recentPayments = payments;
      }
    }

    // 6. PT client profile (if in PT OS module)
    try {
      const ptQuery = userRole === 'trainer'
        ? 'SELECT * FROM pt_clients WHERE trainer_id = $1 LIMIT 1'
        : 'SELECT * FROM pt_clients WHERE client_id = $1 LIMIT 1';
      const ptParam = userRole === 'trainer' ? users[0].trainer_id : linkedClientId;
      if (ptParam) {
        const { rows: pt } = await pool.query(ptQuery, [ptParam]);
        if (pt[0]) ctx.ptClient = pt[0];
      }
    } catch (_) { /* table may not exist */ }

    // 7. Recent workout plans (last 3)
    try {
      const { rows: wPlans } = await pool.query(
        `SELECT name, goal, frequency, duration_weeks, created_at
         FROM workout_plans WHERE created_by = $1 ORDER BY created_at DESC LIMIT 3`,
        [userId]
      );
      ctx.workoutPlans = wPlans;
    } catch (_) { ctx.workoutPlans = []; }

    // 8. Recent diet plans (last 2)
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

  // Inject member context
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
    if (age)     lines.push(`Age: ${age} years`);
    if (c.gender) lines.push(`Gender: ${c.gender}`);
    if (c.weight) lines.push(`Current Weight: ${c.weight} kg`);
    if (c.email)  lines.push(`Email: ${c.email}`);
    if (c.trainer_name) lines.push(`Assigned Trainer: ${c.trainer_name}`);
    if (c.notes)  lines.push(`Trainer Notes: ${c.notes}`);
    if (c.status) lines.push(`Membership Status: ${c.status}`);
    if (c.package_type) lines.push(`Package: ${c.package_type}`);
    lines.push('');
  }

  if (ctx.weightHistory?.length) {
    lines.push(`## WEIGHT HISTORY (recent)`);
    ctx.weightHistory.slice(0, 6).forEach(w => {
      lines.push(`- ${w.date}: ${w.weight} kg`);
    });
    // Calculate trend
    if (ctx.weightHistory.length >= 2) {
      const latest = parseFloat(ctx.weightHistory[0].weight);
      const oldest = parseFloat(ctx.weightHistory[ctx.weightHistory.length - 1].weight);
      const diff = (latest - oldest).toFixed(1);
      const sign = diff > 0 ? '+' : '';
      lines.push(`Trend: ${sign}${diff} kg over this period`);
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
    ctx.workoutPlans.forEach(p => {
      lines.push(`- ${p.name} (Goal: ${p.goal || 'N/A'}, ${p.frequency || '?'} days/week, ${p.duration_weeks || '?'} weeks)`);
    });
    lines.push('');
  }

  if (ctx.dietPlans?.length) {
    lines.push(`## RECENT NUTRITION PLANS`);
    ctx.dietPlans.forEach(p => {
      lines.push(`- ${p.name} (Goal: ${p.goal || 'N/A'}, Calories: ${p.calories_target || '?'} kcal, Protein: ${p.protein_target || '?'}g)`);
    });
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

// ── Streaming chat ────────────────────────────────────────────────────────────

async function streamChat({ userId, userRole, conversationId, message, clientId }, res) {
  const ai = getClient();

  // Build context
  const ctx = await buildMemberContext(userId, userRole, clientId);
  const systemPrompt = buildSystemPrompt(ctx, userRole);

  // Load conversation history (last 20 messages for context window)
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
    { role: 'user', content: message },
  ];

  // Stream response
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

  let fullContent = '';
  let usage = null;

  try {
    const stream = await ai.chat.completions.create({
      model: MODEL,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 2000,
      temperature: 0.7,
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || '';
      if (content) {
        fullContent += content;
        res.write(`data: ${JSON.stringify({ content })}\n\n`);
      }
      if (chunk.usage) usage = chunk.usage;
    }

    res.write('data: [DONE]\n\n');
    res.end();

    // Persist the exchange
    await pool.query(
      `INSERT INTO ai_messages (conversation_id, role, content)
       VALUES ($1, 'user', $2), ($1, 'assistant', $3)`,
      [conversationId, message, fullContent]
    );

    // Update conversation timestamp
    await pool.query(
      'UPDATE ai_conversations SET updated_at = NOW() WHERE id = $1',
      [conversationId]
    );

    // Log usage
    if (usage) {
      await pool.query(
        `INSERT INTO ai_usage_log (user_id, conversation_id, model, tokens_prompt, tokens_completion, tokens_total)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [userId, conversationId, MODEL, usage.prompt_tokens || 0, usage.completion_tokens || 0, usage.total_tokens || 0]
      ).catch(() => {});
    }

  } catch (err) {
    logger.error({ err: err.message, userId }, 'OpenAI streaming error');
    if (!res.headersSent) {
      res.status(500).json({ error: 'AI service error. Please try again.' });
    } else {
      res.write(`data: ${JSON.stringify({ error: 'AI response interrupted. Please try again.' })}\n\n`);
      res.end();
    }
  }
}

module.exports = { isConfigured, checkRateLimit, streamChat };
