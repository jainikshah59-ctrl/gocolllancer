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
api/                    # Vercel serverless functions (12/12 — Hobby limit FULL;
                        # no new endpoint without merging/replacing one)
  booking-create.js     # Server-gated paid booking: auth → Cashfree PAID check
                        #   → server-recomputed total → order registry → atomic booking
  book-with-wallet.js   # Wallet-funded booking (Firebase auth, canonical math)
  booking-action.js     # Brand/creator state changes (approve/revise/dispute/cancel/notify)
  booking-deadlines.js  # Daily 02:00 UTC cron: auto-cancel, refunds (§1b), auto-approve,
                        #   paid-order reconcile, Pro expiry, DPDP deletions (§5)
  cashfree-order.js     # Cashfree order creation (Firebase auth, server rate-card)
  cashfree-verify.js    # Cashfree order verification (Firebase auth, amount match)
  cashfree-webhook.js   # Cashfree HMAC webhook (signature-verified; credits wallet top-ups)
  instagram-start.js    # OAuth start (public)
  instagram-callback.js # OAuth callback (HMAC-signed state; full IG sync)
  instagram-refresh.js  # IG token refresh (Firebase auth, 10/min/IP)
  llm.js               # LLM proxy: POST requires Firebase auth + 200/day/uid quota
                        #   (keys server-side only)
                        # (admin "mark paid" payouts: action 'payout-release'
                        #  inside booking-action.js — merged, admin doc + rate limit)
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
- **Business Pro:** ₹999/month, 5% discount on every paid booking (live; server-activated via Cashfree webhook, 30-day expiry)

## Auth on the API (exact)

- **Firebase ID-token auth (fail-closed):** `/api/booking-create`,
  `/api/book-with-wallet`, `/api/booking-action` (incl. admin-only action
  `'payout-release'`, admin doc required), `/api/cashfree-order`,
  `/api/cashfree-verify`, `/api/instagram-refresh`,
  and `POST /api/llm` (plus 200/day/uid Firestore quota).
- **Not Firebase-auth (by design):** `/api/instagram-start` and
  `/api/instagram-callback` (OAuth flow — HMAC-signed `state` instead),
  `/api/cashfree-webhook` (Cashfree HMAC signature on timestamp+rawBody),
  `/api/booking-deadlines` (Vercel `x-vercel-cron` header; `CRON_SECRET`
  Bearer only for manual invocations — currently ON HOLD, do not set).

## Environment Variables (Vercel)

See `BACKEND_SETUP.md` for the full list.

## Deployment

```bash
# Push to main → Vercel auto-deploys
git push origin main
```

**Important:** After changing env vars, **Redeploy** in Vercel dashboard. Firestore rules must be published manually in Firebase console, and composite indexes deployed via `firebase deploy --only firestore:indexes` — deploys never apply either file.

## Security Notes

- API keys live ONLY in Vercel env vars, never in git
- `/api/llm` POST requires Firebase auth + per-uid daily quota (keys stay server-side)
- Auth posture per endpoint is documented above; Firestore rules (765 lines)
  must be published manually in the Firebase console
- See `BACKEND_SETUP.md` for OAuth configuration
