// src/lib/gemini.js
// 619 Fitness AI Coach — Google Gemini integration. Implements the same
// interface as openai.js so the ai-router can treat providers identically.
'use strict';

const pool   = require('../db/pool');
const logger = require('./logger');
// Reuse context-building logic from openai.js — no duplication
const { buildMemberContext, buildSystemPrompt } = require('./openai');

// Default model — can be overridden per-request via the gemini_model param
// passed by ai-router (which reads the value from ai_provider_settings).
const DEFAULT_MODEL = 'gemini-2.0-flash';

function getClient() {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set');
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  return new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
}

function isConfigured() {
  return !!process.env.GEMINI_API_KEY;
}

async function streamChat({ userId, userRole, conversationId, message, clientId, gemini_model }, res) {
  const modelId = gemini_model || DEFAULT_MODEL;
  const genAI   = getClient();

  // Build member context and system prompt (shared logic with OpenAI)
  const ctx          = await buildMemberContext(userId, userRole, clientId);
  const systemPrompt = buildSystemPrompt(ctx, userRole);

  // Load conversation history (last 20 messages) in Gemini's format
  let history = [];
  if (conversationId) {
    const { rows } = await pool.query(
      `SELECT role, content FROM ai_messages
       WHERE conversation_id = $1
       ORDER BY created_at ASC
       LIMIT 20`,
      [conversationId]
    );
    // Gemini uses 'model' instead of 'assistant', and 'parts' arrays
    history = rows.map(r => ({
      role:  r.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: r.content }],
    }));
  }

  // Set SSE headers before streaming begins
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  let fullContent = '';

  try {
    const model = genAI.getGenerativeModel({
      model: modelId,
      systemInstruction: systemPrompt,
    });

    const chat = model.startChat({
      history,
      generationConfig: {
        maxOutputTokens: 2000,
        temperature: 0.7,
      },
    });

    const result = await chat.sendMessageStream(message);

    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) {
        fullContent += text;
        res.write(`data: ${JSON.stringify({ content: text })}\n\n`);
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();

    // Persist both messages with provider tag
    await pool.query(
      `INSERT INTO ai_messages (conversation_id, role, content, provider)
       VALUES ($1, 'user', $2, 'gemini'), ($1, 'assistant', $3, 'gemini')`,
      [conversationId, message, fullContent]
    );

    await pool.query(
      'UPDATE ai_conversations SET updated_at = NOW() WHERE id = $1',
      [conversationId]
    );

    // Log token usage from Gemini's usageMetadata
    try {
      const finalResponse = await result.response;
      const usage         = finalResponse.usageMetadata;
      if (usage) {
        await pool.query(
          `INSERT INTO ai_usage_log
             (user_id, conversation_id, model, tokens_prompt, tokens_completion, tokens_total, provider)
           VALUES ($1, $2, $3, $4, $5, $6, 'gemini')`,
          [
            userId, conversationId, modelId,
            usage.promptTokenCount      || 0,
            usage.candidatesTokenCount  || 0,
            usage.totalTokenCount       || 0,
          ]
        );
      }
    } catch (_) { /* usage logging is non-critical */ }

  } catch (err) {
    logger.error({ err: err.message, userId, modelId }, 'Gemini streaming error');
    if (!res.headersSent) {
      res.status(500).json({ error: 'AI service error. Please try again.' });
    } else {
      res.write(`data: ${JSON.stringify({ error: 'AI response interrupted. Please try again.' })}\n\n`);
      res.end();
    }
  }
}

module.exports = { isConfigured, streamChat, DEFAULT_MODEL };
