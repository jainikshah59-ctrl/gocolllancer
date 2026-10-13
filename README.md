# gocolllancer

**Where Influence Meets Industry** — India's creator-brand collaboration platform.

Live: https://gocolllancer.vercel.app

## What it is

A marketplace connecting content creators with brands for paid collaborations. Creators showcase their work, brands discover and book them, payments flow through the platform.

## Tech Stack

- **Frontend:** Vanilla JS SPA (single `index.html` + `connect/` modules)
- **Backend:** Vercel serverless functions (`api/`)
- **Database:** Firebase Firestore
- **Auth:** Firebase Auth (Email, Google)
- **AI:** 3-lane free LLM pool (Groq → Cloudflare → Gemini) via `/api/llm` proxy
- **Voice:** Web Speech API + Edge TTS

## Project Structure

```
index.html              # Main app shell (role selection + embedded apps)
connect/                # Client-side app modules
  creator-connect.js    # Creator app logic
  brand-connect.js      # Brand app logic
  ai/                   # Cleo AI (scopeGuard → llmPool → engine → KB)
  firebase-config.js    # Firebase client config
api/                    # Vercel serverless functions
  instagram-*.js        # Instagram OAuth flow
  llm.js               # LLM proxy (keys stay server-side)
  cashfree-*.js        # Payment gateway
  booking-deadlines.js # Cron: auto-cancel/approve bookings
lib/                    # Shared server utilities
  firebaseAdmin.js     # Firebase Admin SDK
  instagramSync.js     # Instagram data sync
firestore.rules        # Security rules (MANUAL PUBLISH REQUIRED)
```

## Key Features

- Creator/Brand onboarding with Instagram connect
- 6-step booking wizard with escrow
- AI assistant (Cleo) with voice
- Wallet system (manual UPI + admin credit)
- Marketplace for requirements/offers

## Pricing

- **Brand pays:** Creator price + 12% platform fee
- **Creator receives:** 95% of listed price
- **Business Pro:** 5% discount (planned)

## Environment Variables (Vercel)

See `BACKEND_SETUP.md` for the full list.

## Deployment

```bash
# Push to main → Vercel auto-deploys
git push origin main
```

**Important:** After changing env vars, **Redeploy** in Vercel dashboard. Firestore rules must be published manually in Firebase console.

## Security Notes

- API keys live ONLY in Vercel env vars, never in git
- `/api/llm` is the only LLM endpoint (keys stay server-side)
- All payment endpoints require Firebase auth
- See `BACKEND_SETUP.md` for OAuth configuration
