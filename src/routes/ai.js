// src/routes/ai.js
// 619 Fitness AI Coach — chat, conversations, usage, and provider status.
// All AI calls route through Token Router → MiniMax-M3 (ai.service.js).
'use strict';

const router    = require('express').Router();
const pool      = require('../db/pool');
const logger    = require('../lib/logger');
const ai        = require('../lib/ai.service');
const { auth, adminOnly } = require('../middleware/auth');

// ── POST /api/ai/chat ─────────────────────────────────────────────────────────
router.post('/chat', auth, async (req, res) => {
  if (!ai.isConfigured()) {
    return res.status(501).json({ error: 'AI Coach is not configured. Set TOKEN_ROUTER_API_KEY.' });
  }

  try {
    const { message, conversation_id, client_id } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });
    if (message.length > 4000) return res.status(400).json({ error: 'Message too long (max 4000 chars)' });

    await ai.checkRateLimit(req.user.id, req.user.role);

    // Resolve or create conversation
    let convId = conversation_id;
    if (!convId) {
      const title = message.slice(0, 80).trim();
      const { rows } = await pool.query(
        `INSERT INTO ai_conversations (user_id, title, client_id)
         VALUES ($1, $2, $3) RETURNING id`,
        [req.user.id, title, client_id || null]
      );
      convId = rows[0].id;
      res.setHeader('X-Conversation-Id', convId);
    } else {
      const { rows } = await pool.query(
        'SELECT id FROM ai_conversations WHERE id = $1 AND user_id = $2',
        [convId, req.user.id]
      );
      if (!rows[0]) return res.status(403).json({ error: 'Conversation not found' });
    }

    await ai.streamChat({
      userId:         req.user.id,
      userRole:       req.user.role,
      conversationId: convId,
      message:        message.trim(),
      clientId:       client_id || req.user.member_id || null,
    }, res);

  } catch (err) {
    if (err.status === 429) return res.status(429).json({ error: err.message });
    logger.error({ err: err.message }, 'AI chat error');
    if (!res.headersSent) res.status(500).json({ error: 'AI service error. Please try again.' });
  }
});

// ── GET /api/ai/conversations ─────────────────────────────────────────────────
router.get('/conversations', auth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 30, 100);
    const { rows } = await pool.query(
      `SELECT id, title, client_id, created_at, updated_at,
              (SELECT content FROM ai_messages WHERE conversation_id = ai_conversations.id
               ORDER BY created_at DESC LIMIT 1) AS last_message
       FROM ai_conversations
       WHERE user_id = $1
       ORDER BY updated_at DESC
       LIMIT $2`,
      [req.user.id, limit]
    );
    res.json({ data: rows });
  } catch (err) {
    logger.error({ err: err.message }, 'List conversations error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/ai/conversations/:id ─────────────────────────────────────────────
router.get('/conversations/:id', auth, async (req, res) => {
  try {
    const { rows: conv } = await pool.query(
      'SELECT * FROM ai_conversations WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (!conv[0]) return res.status(404).json({ error: 'Conversation not found' });

    const { rows: messages } = await pool.query(
      'SELECT id, role, content, provider, created_at FROM ai_messages WHERE conversation_id = $1 ORDER BY created_at ASC',
      [req.params.id]
    );
    res.json({ data: { ...conv[0], messages } });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── DELETE /api/ai/conversations/:id ─────────────────────────────────────────
router.delete('/conversations/:id', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM ai_conversations WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Conversation not found' });
    res.json({ message: 'Conversation deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/ai/usage ─────────────────────────────────────────────────────────
router.get('/usage', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour')  AS messages_this_hour,
         COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') AS messages_today,
         COALESCE(SUM(tokens_total) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours'), 0) AS tokens_today
       FROM ai_usage_log WHERE user_id = $1`,
      [req.user.id]
    );
    res.json({ data: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/ai/provider-settings  (admin only) ───────────────────────────────
router.get('/provider-settings', auth, adminOnly, async (req, res) => {
  res.json({
    data: {
      provider:   'Token Router',
      model:      ai.MODEL,
      configured: ai.isConfigured(),
      base_url:   (process.env.TOKEN_ROUTER_BASE_URL || 'https://api.token-router.ai/v1').replace(/\/+$/, ''),
    },
  });
});

// ── GET /api/ai/provider-stats  (admin only) ──────────────────────────────────
router.get('/provider-stats', auth, adminOnly, async (req, res) => {
  try {
    const stats = await ai.getStats();
    res.json({ data: stats });
  } catch (err) {
    logger.error({ err: err.message }, 'Get provider stats error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/ai/test-provider  (admin only) ──────────────────────────────────
router.post('/test-provider', auth, adminOnly, async (req, res) => {
  try {
    const result = await ai.testConnection();
    res.json(result);
  } catch (err) {
    logger.error({ err: err.message }, 'Test provider error');
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
