'use strict';
// Does the AI health endpoint ask the same question the AI code answers?
//
// ── The disagreement this pins ─────────────────────────────────────────────
//
// The code that CALLS the provider read `AI_API_KEY || OPENROUTER_API_KEY`.
// The code that REPORTED whether it was configured read OPENROUTER_API_KEY
// alone — in two places, GET /api/ai/health and GET /api/ai/provider-settings.
//
// So a box configured with AI_API_KEY, the first name the working code looks
// for, had fully functional AI while its own health endpoint said
// `configured: false` and the operator's integrations page said the provider
// was not set up. The console lied about the one thing it exists to report,
// in the direction that sends somebody hunting for a key that is present.
//
// Mid-rotation the reverse is worse: OPENROUTER_API_KEY left behind and
// AI_API_KEY removed reported `configured: true` while every generation failed.

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';

const {
  apiKey, baseUrl, isConfigured, configurationProblem, keySource,
} = require('../lib/ai/config');

describe('one answer to "is the provider configured"', () => {
  it('accepts AI_API_KEY', () => {
    const env = { AI_API_KEY: 'sk-one' };
    expect(isConfigured(env)).toBe(true);
    expect(apiKey(env)).toBe('sk-one');
    expect(keySource(env)).toBe('AI_API_KEY');
  });

  it('accepts OPENROUTER_API_KEY, which is what .env.example documents', () => {
    const env = { OPENROUTER_API_KEY: 'sk-two' };
    expect(isConfigured(env)).toBe(true);
    expect(keySource(env)).toBe('OPENROUTER_API_KEY');
  });

  it('prefers AI_API_KEY, matching the order the calling code always used', () => {
    const env = { AI_API_KEY: 'sk-one', OPENROUTER_API_KEY: 'sk-two' };
    expect(apiKey(env)).toBe('sk-one');
    expect(keySource(env)).toBe('AI_API_KEY');
  });

  it('is not configured when neither is set', () => {
    expect(isConfigured({})).toBe(false);
    expect(apiKey({})).toBeNull();
    expect(keySource({})).toBeNull();
  });

  it('names BOTH variables when it refuses', () => {
    // "The key is missing" is useless when the reason is that the key is
    // present under the other name.
    const problem = configurationProblem({});
    expect(problem).toMatch(/AI_API_KEY/);
    expect(problem).toMatch(/OPENROUTER_API_KEY/);
  });

  it('defaults the base URL, so its absence is never the failure', () => {
    expect(baseUrl({})).toBe('https://openrouter.ai/api/v1');
    expect(baseUrl({ AI_BASE_URL: 'https://example.test/v1' })).toBe('https://example.test/v1');
  });

  it('never returns the key from anything an operator reads', () => {
    const env = { AI_API_KEY: 'sk-super-secret-value' };
    expect(keySource(env)).not.toContain('secret');
    expect(String(configurationProblem(env) ?? '')).not.toContain('secret');
  });
});

describe('no file reads the provider key directly any more', () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');

  it('every consumer goes through lib/ai/config.js', () => {
    // The original defect was two copies of a predicate that drifted. A third
    // copy added later would drift the same way, and only a scan can see it.
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '__tests__') continue;
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.js')) continue;
        if (full.endsWith(path.join('lib', 'ai', 'config.js'))) continue;

        // Comments explain the history at length; only code counts.
        const code = fs.readFileSync(full, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        if (/process\.env\.(AI_API_KEY|OPENROUTER_API_KEY)/.test(code)) {
          offenders.push(path.relative(root, full));
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});

describe('the streaming path records which model actually answered', () => {
  // ── The production evidence ──────────────────────────────────────────────
  //
  // ai_usage_log: 137 calls in 45 days recorded as model "auto", most recent
  // an hour before this was written. ai_workout_generations: every row's
  // `model` column reads "auto".
  //
  // "auto" is an auto-router — it picks a different underlying model per
  // request by design — so the requested name can never answer "what wrote
  // this plan", which is the only question that column exists for. A plan
  // scoring 88 and one scoring 82 could have come from different models and
  // nothing recorded which.
  //
  // The non-streaming path had always captured it (`data.model || model`).
  // The streaming path parsed the same chunks for `usage` and threw `model`
  // away — and the workout and diet generators use streaming.
  const { streamCompletion } = require('../lib/ai/openrouter');

  /** An SSE body in the shape OpenRouter really sends. */
  function sseResponse(chunks) {
    const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
    const encoder = new TextEncoder();
    let sent = false;
    return {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: encoder.encode(body) };
          },
          releaseLock: () => {},
        }),
      },
    };
  }

  const origFetch = global.fetch;
  afterEach(() => { global.fetch = origFetch; });

  it('returns the model the provider says served the request', async () => {
    process.env.AI_API_KEY = 'sk-test';
    global.fetch = async () => sseResponse([
      // OpenRouter stamps `model` on every chunk; it is the resolved model,
      // not the "auto" that was asked for.
      { model: 'nvidia/nemotron-3-super-120b-a12b:free', choices: [{ delta: { content: 'Hello' } }] },
      { model: 'nvidia/nemotron-3-super-120b-a12b:free', choices: [{ delta: { content: ' world' } }],
        usage: { total_tokens: 12 } },
    ]);

    const gen = streamCompletion({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] });
    const out = [];
    let step = await gen.next();
    while (!step.done) { out.push(step.value); step = await gen.next(); }

    expect(out.join('')).toBe('Hello world');
    expect(step.value.model).toBe('nvidia/nemotron-3-super-120b-a12b:free');
    // Both facts, so a caller can report "asked for auto, got X".
    expect(step.value.requested_model).toBe('auto');
    expect(step.value.usage).toEqual({ total_tokens: 12 });
  });

  it('falls back to the requested model when the provider does not say', async () => {
    process.env.AI_API_KEY = 'sk-test';
    global.fetch = async () => sseResponse([{ choices: [{ delta: { content: 'x' } }] }]);

    const gen = streamCompletion({ model: 'openai/gpt-oss-120b:free', messages: [] });
    let step = await gen.next();
    while (!step.done) step = await gen.next();

    expect(step.value.model).toBe('openai/gpt-oss-120b:free');
  });
});

describe('the router forwards the served model rather than discarding it', () => {
  // `for await (const chunk of gen) yield chunk` looks equivalent to `yield*`
  // and is not: it throws the generator's return value away. That is exactly
  // how the served model was lost.
  const fs = require('fs');
  const path = require('path');
  const routerSrc = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'ai', 'router.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('no longer drains a stream with for-await, which discards the return', () => {
    expect(routerSrc).not.toMatch(/for await \(const chunk of gen\)/);
  });

  it('delegates with yield*, which forwards chunks AND the return value', () => {
    expect(routerSrc).toMatch(/yield\* gen/);
  });

  it('reports both the served and the requested model', () => {
    expect(routerSrc).toMatch(/requested_model/);
  });
});
