/* GET /api/llm-keys — returns free-tier LLM API keys from Vercel env vars.
 *
 * The client-side 3-lane pool (connect/ai/llmPool.js) fetches this on first
 * use. Keys live ONLY in the Vercel dashboard (never in git, never hardcoded).
 *
 * Required Vercel env vars (all 100% free, no credit card):
 *   GROQ_API_KEY              — console.groq.com → API Keys
 *   CLOUDFLARE_API_KEY        — dash.cloudflare.com → API token
 *   CLOUDFLARE_ACCOUNT_ID     — dash.cloudflare.com → Account ID
 *   GEMINI_API_KEY            — aistudio.google.com → Get API Key
 *
 * Output: { groq, cloudflare, cloudflareAccountId, gemini }
 * Missing keys are returned as empty strings; the pool skips unconfigured lanes.
 * Always HTTP 200, never throws.
 */

export default async function handler(req, res) {
  try {
    res.status(200).json({
      groq: process.env.GROQ_API_KEY || '',
      cloudflare: process.env.CLOUDFLARE_API_KEY || '',
      cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID || '',
      gemini: process.env.GEMINI_API_KEY || '',
    });
  } catch {
    res.status(200).json({ groq: '', cloudflare: '', cloudflareAccountId: '', gemini: '' });
  }
}
