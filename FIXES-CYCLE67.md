# FIXES — NEXUS 24/7 Cycles 6+7 (all approved, 2026-10-14)

Jainik approved ALL items from both Cycle 6 (16) and Cycle 7 (18), deduped.
Base: cda9399. Nothing committed/pushed/deployed — local only.

## Backend API (new endpoints + hardening)

| File | Change |
|---|---|
| `api/booking-deadlines.js` | Accepts Vercel `x-vercel-cron: 1` for scheduled path; CRON_SECRET still mandatory fail-closed for manual calls. New section 3: `payment_orders` reconcile sweep (PAID-but-unbooked → `unclaimed_payments`, never-paid → `abandoned`) |
| `api/llm.js` | System prompt moved server-side (`systemForScope('creator'|'brand')`, canonical 5%-then-12% fee); client `system` ignored — kills prompt-injection + quota burn |
| `connect/ai/llmPool.js` | Now sends `{scope, user}` instead of `{system, user}` |
| `api/cashfree-webhook.js` (NEW) | HMAC-SHA256 verify (`timingSafeEqual`), `bodyParser:false`, idempotent `cashfree_events/{eventId}`; PAYMENT_SUCCESS → booking ack / `paid_unbooked` flag + notifs |
| `api/cashfree-order.js` | `notify_url` defaults to `APP_URL + '/api/cashfree-webhook'`; registers every order in `payment_orders/{orderId}` (status `created`) |
| `api/booking-create.js` | Registry write `merge:true` → `status:'booked'`; new step (a2): verifies `creatorPrice` against `creators/{id}` listed prices (₹1 tolerance; fails open when no rate card) |
| `api/book-with-wallet.js` (NEW) | Server-side wallet booking: auth → server-read balance+isPro → canonical total → atomic txn (dup check `collab_{fp}`, debit, booking, ledger `walletTransactions/booking_{fp}`, creator notif). 409 duplicate, 402 insufficient |

## Money paths + Firestore rules

| File | Change |
|---|---|
| `api/booking-deadlines.js` | Cron refunds now write `walletTransactions` (unified shape, id `refund_{bookingId}`) — zero `wallet_ledger` refs remain |
| `firestore.rules` | bookings create: money fields (`paidAmount`, `paymentStatus`, `escrowStatus`, `paymentReference`, `refundAmount`) must be absent/default — `bookingCreateMoneySafe()`; payoutRequests: doc id bound to `payout_<bookingId>` (dup prevention); creator-reject: `refundAmount ≤ paidAmount`, fail-closed |

**MANUAL STEP (Jainik): publish `firestore.rules` in Firebase console — deploys don't auto-publish.**

## Frontend (connect/*.js + index.html)

- Booking-state UI: brand Cancel (`bcancel`), Dispute (`bdispute`), delivery-proof URL prompt on Deliver (→`driveLink`), revision-cap enforcement. **Fixed 2 rule-mismatch bugs**: `deliveredAt`→`deliverySubmittedAt`, `completedAt`→`approvedAt` (both were denied under repo rules — flows were broken)
- Creator notification listener (`loadCreatorNotifications`, mirrors brand pattern)
- Pay in-flight guard (`cashfreeInFlight`; second tap → "Payment is already being processed")
- `payWithWallet` → calls `FB.api('book-with-wallet')`; `S.wallet` refreshed from server; `priceBreakup` synced canonical (zero usages repo-wide)
- Brand Google signup: `bizName` default `displayName → email prefix → 'My Business'`
- `/c/<handle>` deep links: outer page stashes handle → brand app public `handleLower` lookup → profile view
- Offline: `updateOnlineStatus()` on cold load; brand SPA got its own banner + listeners; announce collapsed to banner-only (back-online toast kept)
- Honest copy: 7 "…opens in the app" → "…not available yet"; approve toast + Earnings explainer corrected
- Buttons: 48.5px→44px (creator login, proposals), `.sbtn` 42px→44px
- Hardened: 3 null-unsafe `esc` copies, brand `inr` (was ₹NaN on null)

**Deliberately NOT done:** dead brand toast @2281 (Cycle-7 claim wrong — it's the live global toast; deletion would break brand `toast()`); `stopMic`×2 / `esc`×5 are per-document copies, can't merge; paid-cancel refunds need Jainik's money-policy decision; referrals still demo.

## Docs

- `CHANGELOG.md` (new), `PRE-DEPLOY-CHECKLIST.md` (new, 7 standing rules), `SECURITY-AUDIT.md` (new, severity + file:line, no exploit recipes)
- Refreshed: `FIXES-CYCLE2.md` status, `DEPLOY_NOTES.md` (CRON_SECRET REQUIRED, Pollinations removed), `LLM-SETUP-GUIDE.md` (llm-keys.js refs removed), `api/llm.js` + `llmPool.js` model headers, `instagram-callback.js` comments

## Env vars needed (Jainik, Vercel dashboard)
- `CRON_SECRET` — REQUIRED (cron 401s without it; note: now works with `x-vercel-cron: 1` scheduled path)
- `CASHFREE_WEBHOOK_SECRET` — from Cashfree dashboard → Webhooks
- `APP_URL` — optional (defaults to gocolllancer.vercel.app)

## Skipped (need Jainik decisions)
- Domain decision: `APP_URL`/cashfree `return_url` still default `collancer.in` (C6#14/C7#11)
- Active-paid brand-cancel money policy (C7#8 decision)
- Admin payout verification UI (pending)
- Cycle 3#5 escrow admin panel (never approved)
