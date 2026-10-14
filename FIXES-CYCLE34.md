# NEXUS 24/7 — Cycle 3 + Cycle 4 Approved Fixes

**Date:** 2026-10-14 | **Base:** d25390e (Cycle 2) | **Status:** Implemented locally, NOT committed/pushed/deployed
**Approval:** Jainik approved ALL Cycle 4 items + ALL Cycle 3 items EXCEPT #5 (escrow admin panel — skipped)

---

## CRITICAL

### B-C1: Server-side booking payment validation
**Files:** `api/booking-create.js` (NEW), `api/cashfree-verify.js`, `connect/brand-connect.js`
- New `POST /api/booking-create`: verifies Firebase idToken → fetches Cashfree order server-side → requires `order_status==='PAID'` → server-computes expected total (5% Pro off creator price first, then 12% fee; brand isPro read server-side) → rejects if `|order_amount - expected| > 1` → order registry `payment_orders/{orderId}` (409 on reuse) → writes booking atomically in one transaction with server-computed amounts.
- `cashfree-verify.js`: accepts `expected_amount`, returns `amount_matches` boolean.
- `brand-connect.js` `payWithCashfreeBooking()`: now calls `booking-create` instead of direct client DB write. 409 reuse → "This payment was already used" toast.

### B-C2: refundAmount server-computed
**Files:** `connect/creator-connect.js`, `api/booking-deadlines.js`
- Creator reject: refundAmount taken from the booking doc's `paidAmount` inside the transaction (never client value).
- Cron: refunds use only `b.paidAmount`, never client-set `b.refundAmount`.

### Cron double-credit race
**File:** `api/booking-deadlines.js`
- Wallet credit + `refundProcessed:true` flip now guarded in a Firestore transaction checking `refundProcessed !== true` before crediting. Idempotent `refund_{bookingId}` ledger doc retained.

---

## HIGH

### B-H3: /registrations locked down
**File:** `firestore.rules` — `update, delete: if true` → `if isAdmin()`. Public read + validated create kept (CollancerWeb dup-check). Admin tooling must use Admin SDK.

### B-H4: payoutRequests amount validation
**File:** `firestore.rules` — both create branches now require `bookingId` and `amount == round(booking.creatorPrice * 0.95)`. Missing doc/field fails closed (deny).

### B-H5: X-Forwarded-For spoofing fixed
**File:** `lib/rateLimit.js` — `clientIp()` now takes the RIGHTMOST XFF entry (Vercel appends real client IP last). Leftmost was attacker-controlled.

### B-M6: cleo-ai / cleo-search auth
**Files:** `api/cleo-ai.js`, `api/cleo-search.js` — Firebase idToken auth + rate limiting added to both.

### B-M7: walletTransactions forgery
**File:** `firestore.rules` — create now requires `request.resource.data.bizId == request.auth.uid`.

### B-M8: notification phishing
**File:** `firestore.rules` — `bizNotifs`/`creatorNotifs` create restricted to own uid or admin; `adminNotifs` create → admin only.
⚠️ If app code creates cross-user notifs client-side (e.g. creator→brand), those writes will now deny — must move server-side before deploy.

### B-M9: rating manipulation
**File:** `firestore.rules` — removed the any-authed-user rating rewrite on `creators/{id}`; added `rating` to the owner-update exclusion list. Ratings now admin/server-only.
⚠️ Any client flow writing `creators/{uid}.rating` must move server-side.

### Cron composite indexes
**File:** `firestore.indexes.json` — added 3 indexes for booking-deadlines queries: `(status, acceptDeadline)`, `(status, refundProcessed)`, `(status, reviewDeadline)`. 17 total, existing 14 untouched.

---

## CYCLE 3 (skip #5)

### C3-1: tot() canonical formula ✅
**File:** `index.html` — `tot()` now Pro-aware via `window.collancerIsPro` (exposed from brand-connect.js): 5% off creator price first (if Pro), then 12% fee on discounted. Verified: ₹10k → Pro ₹10,640 / non-Pro ₹11,200.

### C3-3: Deliver action ✅
**Files:** `index.html`, `connect/creator-connect.js`
- Creator booking detail shows "Deliver work" button for Active bookings → status `In review`, calls `onAction(b,'deliver')`.
- creator-connect.js handles `action==='deliver'`: verifies creator ownership, sets `PendingCompletion` + `deliveredAt` + 72h `reviewDeadline`, notifies brand.

### C3-4: Brand review UI ✅
**Files:** `index.html`, `connect/brand-connect.js`
- Brand dashboard campaign cards show "In review · action needed" tag + **Approve work** / **Request revision** buttons for delivered bookings.
- `window.collancerReviewBooking(bookingId, 'approve'|'revision', note)` in brand-connect.js: verifies bizId, sets Completed (or back to Active with revision note).

### C3-6: Toast unify — already done
Cycle 2 unified all 4 toast systems to 2200ms. Verified: 4 instances, all 2200ms. No change needed.

### C3-7: Button heights — intentionally skipped
Remaining variances (38/42/46px) are chips, tags, close buttons — intentional design elements, not primary CTAs. `btn()` helper enforces 44px for CTAs. Changing them would violate "don't touch the design."

### C3-8: XSS fixes ✅
**File:** `index.html` — `esc()` applied to `c.name`, `c.h`, `c.pk[b.pk][0]` in booking-sheet step-4 header; `c.name` in booking-success message.

### C3-9: CIRCUIT suggestions
1. ESM require() fix — done in Cycle 2, verified still holding.
2. cashfree-verify auth + amount check — done (Cycle 2 auth + this cycle amount_matches).
3. edge-tts auth — done in Cycle 2.
4. Instagram redirect_uri — MANUAL ONLY: needs Jainik to verify exact URI in Meta dashboard + check Vercel `APP_URL` env value.
5. Cashfree webhook — MANUAL ONLY: needs Jainik's Cashfree dashboard config (webhook URL, events, secret → Vercel env).

---

## SKIPPED (not approved)
- Cycle 3 #5: escrow release admin panel.

## MANUAL-ONLY (needs Jainik)
1. Publish `firestore.rules` + `firestore.indexes.json` in Firebase console (Vercel doesn't auto-publish).
2. Set `CRON_SECRET` in Vercel env (from Cycle 2 — still pending).
3. Instagram redirect_uri verification in Meta dashboard.
4. Cashfree webhook setup in Cashfree dashboard.
5. Audit client-side cross-user notification writes (B-M8) and rating writes (B-M9) before deploy — they will now be denied by rules.

## Verification
- `node --check` passes on all 8 JS files (api × 5, lib × 1, connect × 2).
- `tot()` functionally tested: Pro/non-Pro totals correct.
- `act('deliver')` functionally tested: status → In review, onAction fires.
- `dashboard()` functionally tested: review buttons render for In-review bookings only.
- firestore.rules: manual block re-read (no executable checker); brace/paren counts balanced; indexes.json parses as valid JSON.
