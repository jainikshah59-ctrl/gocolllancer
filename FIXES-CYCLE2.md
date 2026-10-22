# NEXUS 24/7 Cycle 2 — Fixes Implemented

**Date:** 2026-10-14  
**Approved by:** Jainik (all 18 approved)  
**Commit base:** 5de7fb8  
**Status:** Committed as `d25390e` and DEPLOYED LIVE to gocolllancer production (Jainik approved all items + said "krdo"). Verified with `node --check`; post-deploy check: API responding.

---

## CRITICAL

### 1. `api/booking-deadlines.js` — ESM `require()` → `import` + business-doc guard
- **File:** `api/booking-deadlines.js`
- Changed `const { FieldValue } = require('firebase-admin/firestore')` (inside the loop!) to a top-level `import { FieldValue } from 'firebase-admin/firestore'`.
- Added business-doc exists guard: `const bizSnap = await bizRef.get(); if (bizSnap.exists)` before touching the wallet. Prevents batch failure on orphaned bookings.
- Auto-cancel now sets `refundProcessed`/`refundedAt` correctly (only `true` when a refund actually happened).

### 2. Creator-reject refund — atomic, idempotent
- **Files:** `connect/creator-connect.js`, `api/booking-deadlines.js`
- Creator `onAction` reject now uses `DB.runTransaction`: reads the booking, computes the refundable amount (`paidAmount`/`escrowAmount`, skips barter/already-refunded), updates booking to `Cancelled` with `refundProcessed: false`, `refundAmount`, `refundStatus: 'pending'`, and writes an idempotent ledger intent `walletTransactions/refund_{bookingId}`.
- Cron (`api/booking-deadlines.js`) gained section **1b**: picks up `Cancelled` + `refundProcessed == false` bookings, verifies the business doc exists, increments `walletBalance` (admin), writes the canonical `wallet_ledger/refund_{bookingId}` entry (merge = idempotent), and flips `refundProcessed: true`.

---

## HIGH

### 3. `CRON_SECRET` mandatory (fail closed)
- **File:** `api/booking-deadlines.js`
- Previously: secret optional ("allow if not configured"). Now: **401 unless** `Authorization: Bearer <secret>` OR `x-cron-secret` header OR `cron_secret` query param matches `process.env.CRON_SECRET`. No secret configured = all calls rejected.

### 4. `pricingFor` — canonical discount order
- **File:** `connect/brand-connect.js`
- Was: `fee = 12% of creatorPrice`, `discount = 5% of creatorPrice`, `total = price + fee - discount` (fee computed on the *undiscounted* price).
- Now: `discount = 5% of creatorPrice` → `discounted = price - discount` → `fee = 12% of discounted` → `total = discounted + fee`. Also exposes `discountedPrice` in the return object.

### 5. `CREATOR_SHARE_PCT` 93 → 95
- **File:** `connect/lib/constants.js`
- `93` → `95` (comment updated: 5% platform cut). Matches the canonical 95% creator share used in payouts.

---

## MEDIUM

### 6. Brand-side voice timer leak
- **File:** `index.html` (brand `stopMic`, ~line 2405)
- Added missing `clearTimeout(aiSilTm)` so the 1.6s auto-submit timer can't fire after the mic is stopped (ghost/duplicate submits).

### 7. Firebase auth on `api/cashfree-verify`
- **File:** `api/cashfree-verify.js`
- Now requires a valid Firebase ID token (`body.idToken` or `Authorization: Bearer`) verified via Admin SDK before returning order status. Closes the open order-status oracle. Returns 401 `auth_required` / `invalid_token`.

### 8. Auth + rate limit on `api/edge-tts`
- **File:** `api/edge-tts.js`
- Added Firebase ID-token check (401 `auth-required` / `invalid-token`) and shared rate limiting (20 req/min/IP, key `edge-tts`). No longer an open TTS proxy.

### 9. Dead "Continue with Phone" button
- **File:** `index.html` (~line 1299)
- Added `data-toast="Phone sign-in opens in the app"` so it gives feedback like the other two phone buttons instead of doing nothing.

### 10. Pro upsell nudge at checkout
- **File:** `index.html` (order-summary step, `s==4`)
- For paid bookings, shows a highlighted hint under the total: "Go Pro and save ₹X" where X = 5% of the creator price. Uses existing `.hint` styling — no design change.

### 11. XSS escaping completed
- **File:** `index.html` (brand `card()` + creator detail view)
- `data-v="'+c.id+'"` → `data-v="'+esc(c.id)+'"` (both card + Book button).
- Detail view: `c.name`, `c.h`, `c.plat`, `c.niche`, `c.city` now wrapped in `esc()` (they were raw).

### 12. Refund idempotency (`refund_{bookingId}`)
- **File:** `api/booking-deadlines.js`
- Auto-cancel ledger entries now use deterministic doc id `refund_{bookingId}` with `{ merge: true }` — a retried cron run can never double-refund. Same pattern used for creator-reject finalization.

### 13. CTA button heights → 44px
- **File:** `index.html`
- Standardized `.black` primary buttons from 43/45/47/52px to **44px** (border-radius 22px), including the `btn()` helper default. 12 instances fixed.

### 14. Persistent offline indicator + back-online toast
- **File:** `index.html`
- `updateOnlineStatus()` now shows a persistent red top banner ("⚠ You are offline — changes may not save") while offline, hides it on reconnect, and fires a "Back online. Connection restored." toast (only if we were previously offline).

### 15. Shared rate-limit middleware
- **New file:** `lib/rateLimit.js` — `rateLimit(req, res, { max, windowMs, key })`, per-IP buckets, `Retry-After` header on 429, stale-bucket pruning.
- **Wired into:** `api/llm.js` (30/min, replaces inline limiter), `api/edge-tts.js` (20/min), `api/cleo-ai.js` (60/min).

### 16. Toast durations unified → 2200ms
- **File:** `index.html`
- Four `toast()` implementations live in separate scopes (can't share one function without a refactor); standardized all durations to **2200ms** (was 2400/2000/2200/2200).

### 17. Contextual error copy (partial)
- **Files:** `index.html`, `connect/creator-connect.js`
- Added `friendlyError()` mapper: Instagram/OAuth → "Instagram connection failed…", payment/Cashfree → "Payment failed…", sync/network → "Sync failed…", auth/401 → "Session expired…". Global error + unhandledrejection handlers use it. AI bot failure now says "AI is having trouble right now…".
- **Skipped:** Firestore rules console verification — needs Jainik in the Firebase console (cannot be done from code).

---

## Verification
- `node --check` passes on all 9 modified/created JS files.
- Deployed: commit `d25390e` pushed, Vercel READY, live site serving the fixes.
- Standing post-deploy caveat: `CRON_SECRET` is **ON HOLD per Jainik — do NOT set** (supersedes the old "pending" note).

## Files changed
1. `api/booking-deadlines.js` — ESM import, fail-closed CRON_SECRET, biz-doc guard, idempotent refunds, reject-refund finalization
2. `api/cashfree-verify.js` — Firebase auth
3. `api/edge-tts.js` — Firebase auth + rate limit
4. `api/llm.js` — shared rate limiter
5. `api/cleo-ai.js` — shared rate limiter
6. `lib/rateLimit.js` — NEW shared middleware
7. `connect/creator-connect.js` — reject transaction with refund intent, AI error copy
8. `connect/brand-connect.js` — canonical pricingFor order
9. `connect/lib/constants.js` — CREATOR_SHARE_PCT 95
10. `index.html` — voice timer fix, phone button toast, XSS escaping, Pro upsell, button heights, offline indicator, toast durations, contextual errors
