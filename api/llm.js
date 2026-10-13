/* POST /api/llm — 100% free 3-lane serverless LLM proxy for Collancer Ai.
 * GET  /api/llm — returns key status (for debugging, no raw keys).
 *
 * ZERO COST (₹0): Only free-tier, cardless providers.
 * Lanes (sequential failover):
 *   1. Groq (llama-3.1-8b-instant) — 3500ms timeout
 *   2. Cloudflare Workers AI (@cf/meta/llama-3.1-8b-instruct)
 *   3. Gemini 1.5 Flash (gemini-1.5-flash)
 *
 * Keys from Vercel env vars: GROQ_API_KEY, CLOUDFLARE_API_KEY,
 * CLOUDFLARE_ACCOUNT_ID, GEMINI_API_KEY. Never exposed to client.
 *
 * POST input:  { system, user }
 * POST output: { provider: 'groq'|'cloudflare'|'gemini'|'none', text }
 * Always HTTP 200, never throws.
 */

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'openai/gpt-oss-20b'; // free, no card (llama-3.1-8b-instant was retired by Groq)
const CF_MODEL = '@cf/meta/llama-3.1-8b-instruct';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const GEMINI_MODEL = 'gemini-1.5-flash';
const TIMEOUT_MS = 8000;

function clean(s) {
  let t = String(s || '');
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, ' ');
  t = t.replace(/```[\s\S]*?```/g, ' ');
  t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  t = t.replace(/[*_~`#>|]/g, '');
  t = t.replace(/^\s*[-•·]\s+/gm, '');
  t = t.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu, '');
  t = t.replace(/\s+/g, ' ').trim();
  if (t.length > 1200) t = t.slice(0, 1200).replace(/\s\S*$/, '').trim() + '…';
  return t;
}

function extractContent(json) {
  const m = json && json.choices && json.choices[0] && json.choices[0].message;
  if (!m) return '';
  let t = typeof m.content === 'string' ? m.content : '';
  if (!t && typeof m.reasoning === 'string') t = m.reasoning;
  if (!t && Array.isArray(m.reasoning_details)) {
    t = m.reasoning_details.map((d) => (d && d.text) || '').join(' ');
  }
  return clean(t);
}

async function callLane(url, apiKey, body, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (r.status === 429) return { error: 'rate_limited' };
    if (!r.ok) return { error: 'failed' };
    const j = await r.json().catch(() => null);
    const text = extractContent(j);
    if (!text) return { error: 'failed' };
    return { text };
  } catch {
    return { error: 'failed' };
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  const done = (provider, text) => res.status(200).json({ provider, text: String(text || '') });

  // GET: key status (no raw values exposed)
  if (req.method === 'GET') {
    return res.status(200).json({
      groq: !!process.env.GROQ_API_KEY,
      cloudflare: !!process.env.CLOUDFLARE_API_KEY,
      cloudflareAccountId: !!process.env.CLOUDFLARE_ACCOUNT_ID,
      gemini: !!process.env.GEMINI_API_KEY,
    });
  }

  // Rate limiting: 30 requests per minute per IP (prevent quota theft)
  const { rateLimit } = await import('../lib/rateLimit.js');
  if (!rateLimit(req, res, { max: 30, windowMs: 60000 })) return;

  try {
    if (req.method !== 'POST') return done('none', '');
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    body = body && typeof body === 'object' ? body : {};
    const system = String(body.system || '').slice(0, 4000);
    const user = String(body.user || '').slice(0, 2000);
    if (!user) return done('none', '');

    const messages = [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: user },
    ];
    const base = { messages, max_tokens: 600, temperature: 0.6 };

    // Lane 1: Groq
    if (process.env.GROQ_API_KEY) {
      const r = await callLane(GROQ_URL, process.env.GROQ_API_KEY,
        { ...base, model: GROQ_MODEL }, 3500);
      if (r.text) return done('groq', r.text);
    }
    // Lane 2: Cloudflare
    if (process.env.CLOUDFLARE_API_KEY && process.env.CLOUDFLARE_ACCOUNT_ID) {
      const url = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/v1/chat/completions`;
      const r = await callLane(url, process.env.CLOUDFLARE_API_KEY,
        { ...base, model: CF_MODEL }, TIMEOUT_MS);
      if (r.text) return done('cloudflare', r.text);
    }
    // Lane 3: Gemini
    if (process.env.GEMINI_API_KEY) {
      const r = await callLane(GEMINI_URL, process.env.GEMINI_API_KEY,
        { ...base, model: GEMINI_MODEL }, TIMEOUT_MS);
      if (r.text) return done('gemini', r.text);
    }
    return done('none', '');
  } catch {
    return done('none', '');
  }
}
