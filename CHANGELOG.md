# gocolllancer — CHANGELOG

All notable changes to this repository. Dates in UTC (Jainik's standing rules apply:
no deploy/push without explicit permission; connection changes need end-to-end
verification first).

---

## Cycle 16 backend batch (FORGE, 2026-10-15, uncommitted) — Jainik-approved items

**Item 24 — brand-cancel refund executor gap (FIXED):** `cancelBooking()`
attaches `refundRequested`/`refundAmount`/`statusBeforeCancel`/`cancelledByBiz`
but never writes `refundProcessed`, so cron §1b's
`refundProcessed == false` query missed every brand-cancelled booking and the
escrow sat in limbo. `api/booking-deadlines.js` §1b now runs a second pickup
query on `refundRequested == true` (doc ids deduped; the txn still skips
`refundProcessed === true`, so no double-refund). Refund math unchanged:
server-truth `paidAmount`/`platformFee`; Active cancels → `paidAmount −
platformFee` + 10% kill-fee, everything else → full refund. New composite
index `bookings(status ASC, refundRequested ASC)` added to
`firestore.indexes.json` — deploy with
`firebase deploy --only firestore:indexes` (manual, Jainik).

**Items 1+23 — `api/refund-request.js` DELETED:** zero callers (verified by
grep); its refund logic is now fully covered by cron §1b (which, after the
Item 24 fix, executes Pending/Active/Cancelled brand refunds with the same
math, ledger shape, and idempotency). Keeping a dead money-moving endpoint
was a drift liability. `api/` goes 11 → 10 files (headroom under the Vercel
Hobby 12-function limit). Instant (non-cron) brand refunds remain a possible
future endpoint; the wiring contract, if ever wanted, belongs in
`api/booking-action.js` as a `cancel` action, not a separate function.

**Item 2 — rebook history preservation (FIXED):** deterministic
`collab_{fingerprint}` ids meant a rebook overwrote the dead booking doc
(destroying the cancel audit trail and corrupting the deterministic
`refund_{id}`/`payout_{id}`/`killfee_{id}` money ids) and made rehire after
Completed impossible. New shared `lib/rebook.js` (`resolveRebookId`, used by
both `api/booking-create.js` and `api/book-with-wallet.js`): terminal docs
(Completed, or Cancelled with `refundProcessed === true`) are NEVER
overwritten — the rebook gets `collab_{fp}_r2`/`_r3`/… and the prior
lifecycle is archived into the new doc's `previousBookings` trail (bounded at
10). Non-terminal docs still 409 (double-submit idempotency);
Cancelled-with-pending-refund still 409 until the refund settles.
`book-with-wallet.js` ledger ids now derive from the final booking id so a
rebook cannot merge-overwrite the prior booking's deduction row.

**Item 12 — `/api/llm.js` per-uid quota hardened:** the 200/day/uid cap is now
Firestore-backed (`llm_quota/{uid}`, transactionally incremented, UTC-day
buckets, server-only collection) instead of in-memory per instance — an
in-memory map handed every cold serverless instance a fresh 200/day.
Fail-closed: any quota-check failure denies the call (429), never the
provider keys.

**Items 3, 5be, 13, 27 — verified holding, no change:** sub-₹100 shares queue
as `accumulating` in both `api/booking-action.js` and cron §2 (zero-share
skipped, no junk rows); self-deal guard (`creatorId == uid` → 400) present in
both booking endpoints plus the rules-layer `creatorId != uid` create guard;
cron headers state the true daily 02:00 UTC cadence; `api/cashfree-order.js`
never trusts `body.amount` for bookings/Pro (server rate-card recompute) and
`api/booking-create.js` rejects `|order_amount − expectedTotal| > 1`.

---

## Cycle 12 (Worker E — Docs & Decisions, 2026-10-14) — Jainik-approved

**Docs & config (no deploy):**

- **Item 20 — SPA unification note:** new `ARCHITECTURE.md` documents that
  `index.html` embeds the creator + brand SPAs as `text/plain` + iframe
  `srcdoc`, and that helpers, icon sets, pricing math, and card renderers are
  built twice. Recommends unifying to a single source of truth (shared
  helpers module, one pricing module, one parameterized SPA, real entry
  points instead of srcdoc). Documentation only — no refactor, needs
  Jainik's explicit go-ahead.
- **Item 21 — Paid Business Pro subscription:** `connect/brand-connect.js`
  now implements the paid-Pro logic: `proSubscription` schema
  (`status`/`startedAt`/`expiresAt`/`amount`) added to the `businesses` doc;
  new `isProActive()` gates the 5% Pro discount (paid subscription active +
  not expired, OR grandfathered legacy free Pro `isPro && proActive`);
  `pricingFor()` uses `isProActive()`. Wallet view gets a Business Pro
  section with a **"Go Pro — ₹999/month"** button (`A.gopro`) that creates a
  Cashfree order with `purpose: 'pro_subscription'` (verified PAID + amount
  server-side) and stamps `proSubscription` on the business doc. OPEN: move
  the post-payment stamp server-side (cashfree-webhook / dedicated API).
- **Item 23 — Fee model locked:** comment in `connect/lib/constants.js` —
  12% brand-side + 5% creator-side (Jainik decision 2026-10-14; do NOT
  change to Collabstr 10%/15% without explicit approval).
- **Item 25 — return_url domain:** `api/cashfree-order.js` default
  `return_url` moved from `collancer.in` to `gocolllancer.vercel.app`;
  `notify_url` already used the app URL. Remaining `noreply@collancer.in`
  email fallback flagged for Jainik's domain decision.
- **Item 26 — Cashfree TEST mode:** verified `CASHFREE_ENV` defaults to
  `test`/sandbox in all API files (`cashfree-order`, `cashfree-verify`,
  `cashfree-webhook`, `booking-create`, `booking-deadlines`). No change.
- **Item 28 — Unpriced creators:** discovery card shows a **"Custom rates"**
  label for creators with no prices (`_hasPrices` flag); label made
  consistent across `brand-connect.js` and the creator-side price banner
  ("Contact for rates" → "Custom rates").
- **Items 27/29 — Checklist:** `PRE-DEPLOY-CHECKLIST.md` now requires
  `CASHFREE_APP_ID`/`CASHFREE_SECRET_KEY`/`CASHFREE_ENV` on the
  **gocolllancer** Vercel project (test keys are on collancer-app, not
  gocolllancer); `firebase deploy --only firestore:indexes`; explicit
  GitHub remote `main` == local tree verification; `CRON_SECRET` ON HOLD
  status.

## cda9399 — NEXUS 24/7 Cycles 3+4: all approved fixes (34 items)
**Date:** 2026-10-14 02:26 UTC

Cycle 3 (UX/QA fixes) + Cycle 4 (adversarial BREAKER findings), all approved by Jainik
except Cycle 3 #5 (escrow release admin panel — skipped).

**Money/payment security (server-side):**
- NEW `POST /api/booking-create`: verifies Firebase ID token → fetches Cashfree order
  server-side → requires `order_status==='PAID'` → server-computes expected total
  (5% Pro discount first, then 12% fee; brand isPro read server-side) → rejects on
  amount mismatch → order registry `payment_orders/{orderId}` (409 on reuse) →
  atomic booking write with server-computed amounts.
- `api/cashfree-verify.js`: accepts `expected_amount`, returns `amount_matches`.
- `connect/brand-connect.js`: checkout now calls `booking-create` instead of direct
  client DB write; payment reuse → "This payment was already used" toast.
- **refundAmount server-computed** — creator reject takes it from the booking doc's
  `paidAmount` inside the transaction (client value ignored); cron trusts only
  `b.paidAmount`.
- Cron double-credit race fixed: wallet credit + `refundProcessed:true` flip guarded
  in a Firestore transaction; idempotent `refund_{bookingId}` ledger doc retained.

**Firestore rules hardening:**
- `/registrations`: `update`/`delete` → admin-only (was open).
- `payoutRequests` create: requires `bookingId` and `amount == round(booking.creatorPrice * 0.95)`.
- `walletTransactions` create: `bizId == request.auth.uid` (forgery closed).
- `bizNotifs`/`creatorNotifs` create: owner or admin only; `adminNotifs` create → admin only.
- Removed any-authed-user rating rewrite on `creators/{id}` (ratings now admin/server-only).

**API auth + rate limiting:**
- X-Forwarded-For spoofing fixed (`lib/rateLimit.js` takes rightmost entry).
- `api/cleo-ai.js`, `api/cleo-search.js`: Firebase auth + rate limiting added.

**Cron indexes:** 3 composite indexes added to `firestore.indexes.json` for
`booking-deadlines` queries (`status+acceptDeadline`, `status+refundProcessed`,
`status+reviewDeadline`).

**UI/UX (Cycle 3):**
- `tot()` in `index.html` now Pro-aware: 5% off creator price first, then 12% fee.
- Creator "Deliver work" button for Active bookings → `PendingCompletion` + 72h
  `reviewDeadline`; brand gets **Approve work / Request revision** buttons on
  delivered bookings.
- Additional XSS escaping (`esc()` on booking-sheet fields and success message).
- Toast unify verified (all 4 systems at 2200ms — no change needed).
- Button-height leftovers intentionally skipped (chips/tags/close buttons are design
  elements; CTAs enforced 44px via `btn()`).

**Skipped / manual-only:**
- Cycle 3 #5 (escrow release admin panel) — not approved, skipped.
- Needs Jainik in consoles: publish `firestore.rules` + `firestore.indexes.json`
  (Firebase), set `CRON_SECRET` (Vercel), Instagram redirect-URI verification (Meta),
  Cashfree webhook config.

Detail: `FIXES-CYCLE34.md`.

---

## d25390e — NEXUS 24/7 Cycle 2: all 17 approved fixes
**Date:** 2026-10-13 21:06 UTC

All 17 agent suggestions approved by Jainik. **Deployed live to gocolllancer
production** (Jainik said "krdo"). Post-deploy: `/api/llm-keys` verified still
closed (410 gone), API responding.

**Critical:**
1. `api/booking-deadlines.js`: ESM `require()` → top-level `import` (the cron was
   crashing on first refund-eligible booking). Added business-doc exists guard
   before wallet touches.
2. Creator-reject refund: atomic transaction in `connect/creator-connect.js` —
   reads booking, computes refundable amount, writes `Cancelled` + refund intent
   `walletTransactions/refund_{bookingId}`; cron section **1b** finalizes the
   refund idempotently.

**High:**
3. `CRON_SECRET` mandatory fail-closed for `api/booking-deadlines` (401 unless
   Bearer/`x-cron-secret`/`cron_secret` matches `process.env.CRON_SECRET`).
4. `pricingFor` canonical order: 5% Pro discount on creator price FIRST, then 12%
   fee on discounted price (fixes ₹60-overpay-per-₹10k bug).
5. `CREATOR_SHARE_PCT` 93 → **95** (`connect/lib/constants.js`).

**Medium:**
- Firebase auth on `api/cashfree-verify` (closed open order-status oracle).
- Firebase auth + 20/min/IP rate limit on `api/edge-tts`.
- Shared rate-limit middleware `lib/rateLimit.js` (pruning + `Retry-After` on 429);
  wired into `api/llm.js` (30/min), `api/edge-tts.js` (20/min), `api/cleo-ai.js`
  (60/min).
- Refund idempotency via deterministic `refund_{bookingId}` doc IDs.
- Brand voice timer leak fixed (`clearTimeout(aiSilTm)`).
- XSS escaping completed (`esc()` on `data-v` IDs and detail-view fields).
- Primary CTA buttons standardized to 44px; toast durations unified to 2200ms.
- Persistent offline banner + "Back online" toast.
- Dead "Continue with Phone" button now gives feedback toast.
- Pro upsell nudge at checkout ("Go Pro and save ₹X").
- Contextual error copy (`friendlyError()` mapper).

#17 (firestore-rules review) left manual for Jainik in the Firebase console.
Detail: `FIXES-CYCLE2.md`.

**Standing caveat:** `CRON_SECRET` must be set in the Vercel dashboard or the money
cron returns 401 (still pending).

---

## 5de7fb8 — NEXUS AI OFFICE audit fixes: security, money bugs, UI, voice
**Date:** 2026-10-13 19:01 UTC

First hardened baseline of the `gocolllancer` redesign, commissioned by Jainik.
Deployed to gocolllancer production.

**Security:**
- Deleted `api/llm-keys.js` (was serving API keys publicly) and dead
  `api/llm-pool.js`.
- Firebase auth wired on `api/cashfree-order` (fail-closed, UID-bound orders).

**Money bugs:**
- Creator payout 93% → 95% of package price.
- Refund race fixed (atomic `FieldValue.increment`).
- Payment DEMO bug fixed (`order_status` check instead of truthy).

**UI:**
- XSS fix in creator cards (`esc()` wrapper).
- Primary button heights standardized (44px).
- Phone button fixed (no longer triggers Google); second Connect Instagram button wired.
- Global error handlers + offline detection; SEO meta/OG tags; share helpers
  (Web Share API + WhatsApp fallback); analytics helper.

**Voice:**
- `stopMic` crash fixed (`aiSilTm` ReferenceError).

**AI:**
- Collancer AI refactored to 100% free 3-lane serverless LLM pool — Pollinations
  fully removed; `connect/ai/llmPool.js` calls server-side `/api/llm` proxy with
  sequential failover **Groq → Cloudflare → Gemini** → local 276-entry KB fallback.
  Keys only from Vercel env vars (`GROQ_API_KEY`, `CLOUDFLARE_API_KEY`,
  `CLOUDFLARE_ACCOUNT_ID`, `GEMINI_API_KEY`) — never in git.
- Groq model updated after Groq retired `llama-3.1-8b-instant`: now
  `openai/gpt-oss-20b`.
- Setup guide: `LLM-SETUP-GUIDE.md`.

---

## Earlier (non-security batches)
- **c6ab21e** (2026-10-11): compact display font sizes.
- **477f1c9** (2026-10-11): compact creator-side Market/Bookings/Earnings/Profile
  component sizes in `index.html`. Both deployed live; live site verified serving
  the new sizes.
- **a4998a7**: initial 3-lane free LLM pool refactor (Groq → Cloudflare → Gemini).
- **b4b24a4**: `/api/llm-keys` secure key injection (later superseded — deleted in
  5de7fb8).
