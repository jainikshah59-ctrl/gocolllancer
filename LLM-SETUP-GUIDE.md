# Collancer AI — 3-Lane Free LLM Setup Guide

**Cost: ₹0. No credit card on any provider.**

## Step 1: Get the 3 API keys (2 min each)

### Lane 1 — Groq (Primary)
1. Go to **console.groq.com** → Sign up (email)
2. Left sidebar → **API Keys** → **Create API Key**
3. Copy the key (starts with `gsk_`)

### Lane 2 — Cloudflare (Failover)
1. Go to **dash.cloudflare.com** → Sign up
2. Go to **Workers AI** → Get started (free tier auto-enabled)
3. **Account ID**: Right sidebar on any dashboard page, under "Account ID"
4. **API Key**: Top-right profile → **My Profile** → **API Tokens** → **Create Token** → use "Custom token" template with `Workers AI` → Read permission

### Lane 3 — Gemini (Backup)
1. Go to **aistudio.google.com** → Sign in with Google
2. Click **Get API Key** → **Create API Key**
3. Copy the key (starts with `AIza`)

## Step 2: Add keys to Vercel (1 min)

1. Go to **vercel.com** → open the **gocolllancer** project
2. **Settings** → **Environment Variables**
3. Add these 4 variables (apply to **Production**):

| Variable | Value from Step 1 |
|----------|-------------------|
| `GROQ_API_KEY` | Groq key (`gsk_...`) |
| `CLOUDFLARE_API_KEY` | Cloudflare API token |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID |
| `GEMINI_API_KEY` | Gemini key (`AIza...`) |

4. **Redeploy** (Deployments → ⋯ → Redeploy) so the new env vars take effect.

## Step 3: Verify

1. Open the app → Creator or Brand chat → ask any question
2. If a lane is working, you get an AI answer. If all lanes fail, it silently falls back to the local knowledge base (nothing breaks).

## How it works

- `connect/ai/llmPool.js` — 3-lane pool: Groq (3500ms) → Cloudflare → Gemini → local KB fallback
- `api/llm.js` — server-side proxy for all 3 lanes (keys from Vercel env vars, never exposed to client). Note: `api/llm-keys.js` (the old key-serving endpoint) was **deleted** on 2026-10-13 — the proxy replaced it.
- Priority: direct `/api/llm` call → local knowledge base fallback (all lanes fail)

## Live setup facts (2026-10-16)

- **Failover order:** Groq (primary) → Cloudflare Workers AI → Gemini (backup) → 276-entry local knowledge base.
- **Model on Groq:** `openai/gpt-oss-20b` — Groq **retired** `llama-3.1-8b-instant` (2026-10-13); using the retired model ID returns a model-not-found error, not an AI answer.
- **Auth + quota:** `POST /api/llm` requires Firebase ID-token auth (fail-closed) plus a **200/day/uid Firestore quota** — anonymous or over-quota calls are rejected server-side, so one client cannot burn another lane's key budget.
- **Keys live ONLY in Vercel env vars** (`GROQ_API_KEY`, `CLOUDFLARE_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `GEMINI_API_KEY`) — never committed to git; changing them needs a Vercel **Redeploy** to take effect.
- Verified live 2026-10-13 with `provider=groq` (after the model swap).
