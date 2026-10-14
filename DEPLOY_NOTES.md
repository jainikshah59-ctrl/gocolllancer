# gocolllancer — Deploy Notes

The redesign (`index.html` — liquid-glass creator + brand apps) is now fully wired to
the live Collancer backend (Firebase project **`collancer-8fd62`**, same as
collancerlatest). **Design was not touched** — only connectivity scripts were added.

## What's in this repo

| Path | Purpose |
|---|---|
| `index.html` | The redesign. Unchanged visually; only `<script>` tags appended (Firebase compat SDK, `connect/*`). |
| `connect/firebase-config.js` | Firebase init (auth + firestore), `window.FB` helpers, `/api` caller. |
| `connect/creator-connect.js` | Creator-side wiring: auth, profile, bookings, IG connect, earnings/payouts, market, AI. |
| `connect/brand-connect.js` | Brand-side wiring: auth, discovery, bookings, wallet/Cashfree, marketplace, AI. |
| `connect/shell-connect.js` | Parent page: handles `?ig=` Instagram OAuth return. |
| `connect/ai/` | The Collancer AI database + answer pipeline (276-entry brain, scope guard, keyless LLM pool). |
| `connect/lib/` | Shared `constants.js` / `format.js` (pricing math). |
| `api/` + `lib/` | 13 Vercel serverless functions. `instagram-callback.js` now reads `APP_URL` from env. |
| `firestore.rules`, `firestore.indexes.json` | Copied verbatim from collancerlatest. |
| `vercel.json` | SPA rewrite + daily `booking-deadlines` cron. |
| `package.json` | `firebase-admin`, `ws` for the API routes. |

## Connectivity parity with collancerlatest

- **Auth**: email/password + Google (creator & brand). Phone OTP helper is in the
  layer but not wired to UI (paused externally — needs Firebase India SMS region / Blaze).
- **Firestore**: creators, creatorHandles, bookings (rule-safe state machine),
  booking_messages, requirements/requirementOffers, reviews, walletDeposits,
  walletTransactions, payoutRequests, verificationRequests, bizNotifs/creatorNotifs,
  mediaKits, scamAlerts, promoDemos, adCampaigns — same collections, same rules.
- **Instagram**: `/api/instagram-start` → Meta OAuth → `/api/instagram-callback`
  (token exchange + full sync) → `?ig=` return. Set `INSTAGRAM_REDIRECT_URI` to the
  new deployment URL and register it in the Meta app dashboard.
- **Collancer AI**: creator side = local database only (askCreatorAI → 276-entry
  brain → fallback); brand side = scope guard → Collancer-name questions → deterministic
  engine → server-side 3-lane pool (`/api/llm`: Groq → Cloudflare → Gemini, free tier) →
  honest outage message.
- **Payments**: real Cashfree order + SDK v3 modal + server verify when
  `CASHFREE_APP_ID`/`CASHFREE_SECRET_KEY` are set; the existing TEST MODE demo sheet
  is kept as fallback and is honestly labeled. Manual UPI + UTR → `walletDeposits`
  (admin-credited) works as in collancerlatest.
- **Booking economics**: 12% brand fee, 95% creator share, Pro 5% discount,
  `collab_<sha256-32>` idempotency, 72h accept/review deadlines via cron.
- **Notifications**: Firestore `*Notifs` collections, realtime toast on new items.

## Deploy steps (Vercel)

1. Import this repo as a new Vercel project (do NOT attach to the collancer-app project).
2. Set env vars: `FIREBASE_SERVICE_ACCOUNT_JSON`, `INSTAGRAM_APP_ID`,
   `INSTAGRAM_APP_SECRET`, `INSTAGRAM_REDIRECT_URI=https://<new-url>/api/instagram-callback`,
   `APP_URL=https://<new-url>`, `CASHFREE_APP_ID`, `CASHFREE_SECRET_KEY`,
   `CASHFREE_ENV=test`, `CRON_SECRET` (REQUIRED — the money cron returns 401 without it).
3. Firebase console → Authentication → Settings → Authorized domains → add `<new-url>`.
4. Firebase console → Firestore → Rules → paste `firestore.rules` → Publish.
   Firestore → Indexes → add the 14 composite indexes from `firestore.indexes.json`.
5. Meta app dashboard → Instagram product → add the new redirect URI;
   keep `instagram_business_basic` + `instagram_business_manage_insights` scopes.

## Known limitations (same as collancerlatest right now)

- **`businesses` is admin-only in firestore.rules** (creator-first rollout): brand
  wallet balance and business profile reads fail client-side until the rules are
  unlocked. Discovery, requirements, bookings, deposits and notifications work.
- Phone OTP is paused externally (Firebase India SMS region / billing).
- Cashfree production needs the VCIP video-KYC step (separate thread).
- `collancer@upi` is still a placeholder for manual deposits.

## Deploy status

Site is LIVE (HTTP 200 on the production URL). Cycles 2 (17 fixes) and 3+4
(34 fixes) are committed and deployed. Deploy only on explicit approval.

## Standing manual steps (not done by deploys)

- **Firebase console → Firestore → Rules → paste `firestore.rules` → Publish.**
  Deploys never auto-publish rules. Same for the composite indexes in
  `firestore.indexes.json`.
- **Vercel env:** `CRON_SECRET` must be set (money cron is fail-closed).
- Instagram redirect-URI verification in the Meta dashboard + `APP_URL` env value.
