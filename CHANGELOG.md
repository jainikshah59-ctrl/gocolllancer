# gocolllancer — CHANGELOG

All notable changes to this repository. Dates in UTC (Jainik's standing rules apply:
no deploy/push without explicit permission; connection changes need end-to-end
verification first).

---

---

## 2026-10-16 — NEXUS 24/7 approved-item batch (36 of 37 approved; #30 rejected)

> Jainik approved 36 of 37 audit-report items 2026-10-16 ~07:15 IST ("all
> approved excluding only no. 30 and for 33 do what collabstr does").
> Implemented + independently verified against HEAD `30252ac` plus the working
> tree. NOTHING committed, pushed, or deployed — awaiting Jainik's explicit
> deploy approval per standing rule. Entry keying `(inv. NN)` = report
> inventory number. Drafted Cycle 51; adversarially re-read Cycle 53 (one stale
> entry corrected below).

**Item 1 (inv. 1) — inr() global restore:** 3 top-level defs; all call sites
resolve in-scope — index.html:1272 (creator), :2452 (brand), :1965 (bk-IIFE
local). Canonical, zero drift.

**Item 2 (inv. 2) — referral ?ref=→sessionStorage bridge:** `referredBy` now
stored at signup — index.html shell capture → connect/creator-connect.js
getReferralCode (:667, write at :686). First-write-wins locked in
firestore.rules:105–115 (immutable once set; admin can correct).

**Item 3 (inv. 3) — bookingCreateMoneySafe circularity fix:** money fields
absent-or-zero enforced at the rules layer — firestore.rules:251–274
(paidAmount/paymentStatus/escrowStatus/paymentReference/refundAmount,
creatorPrice/amount/escrowAmount/platformFee/proDiscount, type forced
barter-or-absent, demoPayment never client-writable on create; upiMdr
absent-or-0 per BREAKER Cycle 35). Breaks the payout-rule circularity where a
forged client-created booking with inflated creatorPrice passed the 95%
payout check.

**Item 4 (inv. 4) — (description pending — held item text not on disk; not invented).**

**Item 5 (inv. 5) — (description pending — held item text not on disk; not invented).**

**Item 6 (inv. 6) — canonical purpose 'booking_payment' (F2):**
normalizePurpose at register — api/cashfree-order.js:87; recovery 409-guard —
api/booking-action.js:186–188 (purpose written ≠ 'booking_payment' → 409
`wrong_purpose`; genuine paid-but-unbooked orders are never blocked).

**Item 7 (inv. 7) — DPDP fixes:** instagram_tokens/{uid} deleted;
creatorHandles TOMBSTONE (not hard-delete); bookings/wallet anonymized (not
deleted); honest "anonymized not deleted" sheet copy; 3 money-guard composites
+ booking_messages ASC composite (22→25 indexes in firestore.indexes.json) —
api/booking-deadlines.js §5, firestore.indexes.json. — CORRECTED (Cycle 45,
replaces the stale "§3b never wallet-credits a Pro order" claim): the §3b
canCredit gate (api/booking-deadlines.js:527–528) treats a missing `purpose`
as bookable, so a Pro/top-up orphan whose registry write failed (purpose never
written) IS wallet-credited — no Pro activation, no admin signal.

**Item 8 (inv. 8) — UPI MDR kill-switch OFF by default:** UPI_MDR_ENABLED=false
— lib/pricing.js:33 (posture: deferred past Diwali; Jainik's absorb-vs-pass
call pending).

**Item 9 (inv. 9) — HELD-OPEN — unmapped (see held-open section below).**

**Item 10 (inv. 10) — (description pending — held item text not on disk; not invented).**

**Item 11 (inv. 11) — rateLimit raw-Node fix:** lib/rateLimit.js — Express-style
`res.status(429).json(...)` does not exist in raw Node serverless functions
(it throws and 500s the caller); now uses res.statusCode / res.setHeader /
res.end. Also takes the RIGHTMOST x-forwarded-for entry (leftmost is
attacker-controlled) and prunes idle buckets.

**Item 12 (inv. 12) — (description pending — held item text not on disk; not invented).**

**Item 13 (inv. 13) — earnings/refund status fixes:** accumulating counted into
pending (paintEarnings) + refundedAmount preferred in paintRefundStatus —
client totals no longer vanish. (13a: connect/creator-connect.js:1082–1086 —
'accumulating' is a real queued payout, counted with pending; 13b:
connect/brand-connect.js:496–502 — server-truth refundedAmount preferred.)

**Item 14 (inv. 14) — booking-wizard field collapse for paid package bookings —
CORRECTED (Cycle 53):** the 6→5 step collapse IS implemented — Review (step 4)
merges into Payment (step 5) via `b.skippedReview=true`, `b.step=5`
(connect/brand-connect.js:725–744, "Booking-field collapse (Cycle 21)"); the
sticky order-summary money strip carries the full money math so skipping the
review screen hides no rupee. Barter and custom-offer flows keep step 4 (their
confirm/offer screens live there). The Cycle-51 draft's "never happened
(RELAY-16 withdrawn)" note was STALE against this code — superseded here.

**Item 15 (inv. 15) — (description pending — held item text not on disk; not invented).**

**Item 16 (inv. 16) — (description pending — held item text not on disk; not invented).**

**Item 17 (inv. 17) — Instagram defer (held description; not expanded).**

**Item 18 (inv. 18) — HELD-OPEN — unmapped (see held-open section below).**

**Item 19 (inv. 19) — paid_no_registry sweep (self-service recovery):** cron
canCredit + handleRecoverPayment — api/booking-deadlines.js:527–528,
api/booking-action.js:186–188. — CORRECTED (Cycle 45, replaces the stale
"refund-request full-refund" claim): self-service is scoped to purpose-absent
or 'booking_payment'; any orphan row with a written purpose ≠ 'booking_payment'
(top-up/Pro orphans) 409s `wrong_purpose` → manual-admin-only.

**Item 20 (inv. 20) — (description pending — held item text not on disk; not invented).**

**Item 21 (inv. 21) — (description pending — held item text not on disk; not invented).**

**Item 22 (inv. 22) — cashfree-verify ownership check:** fail-closed 403,
api/cashfree-verify.js:70–88 (caller may only see an order bound to their UID
via Cashfree customer_details or their own payment_orders registry row);
payment_orders rules-absent = default deny. (SENTINEL-C50: the pre-fetch
registry gate must be SOFT, not fail-closed — registry write is best-effort;
fail-closed would strand legit payers.)

**Item 23 (inv. 23) — (description pending — held item text not on disk; not invented).**

**Item 24 (inv. 24) — Pro discount cap ₹999:**
Math.min(Math.round(creatorPrice*0.05), PRO_DISCOUNT_CAP_INR) —
lib/pricing.js:114 (cap ₹999/month; a ₹10L booking no longer hands back ₹50k).

**Item 25 (inv. 25) — TDS paid-time tracking:** flat payoutFY/payoutFYTotal AND
nested tdsTracking written in the SAME transaction (drift fixed) —
api/booking-action.js handlePayoutRelease (:357; write at :469–478), at
paid-time when the admin actually releases the money. 194J treatment gated on
a written CA opinion (Jainik manual).

**Item 26 (inv. 26) — Ask-a-question both sides:** prebooking_questions —
firestore.rules:799 (threads readable by participants, opened by the brand's
first question, creator can reply).

**Item 27 (inv. 27) — (description pending — held item text not on disk; not invented).**

**Item 28 (inv. 28) — (description pending — held item text not on disk; not invented).**

**Item 29 (inv. 29) — (description pending — held item text not on disk; not invented).**

**Item 30 (inv. 30) — REJECTED by Jainik — not implemented** (button-size
standardization 38/42/45/48px→44px reverted).

**Item 31 (inv. 31) — (description pending — held item text not on disk; not invented).**

**Item 32 (inv. 32) — HELD-OPEN — unmapped (see held-open section below).**

**Item 33 (inv. 33) — Collabstr-style payout-release admin UI** (Jainik: "do
what Collabstr does"): Founder Dashboard payouts queue with destination rows,
UTR collection, release confirm with creator identity — index.html
loadPayoutQueue (:2706; releasable = pending/accumulating/approved, latest 50),
api/booking-action.js action 'payout-release' (admins/{uid} gate :358–360,
fail-closed; terminal-state check — only 'Completed' escrow or 'Cancelled'
kill_fee releases; payoutnotif_ creator notification in the same transaction,
idempotent on retry).

**Item 34 (inv. 34) — HELD-OPEN — unmapped (see held-open section below).**

**Item 35 (inv. 35) — HELD-OPEN — unmapped (see held-open section below).**

**Item 36 (inv. 36) — payout-release.js merged into api/booking-action.js:**
zero dangling callers; api/ 12→11 (one slot headroom under the Vercel Hobby
12-function limit). Route contract kept identical
({ idToken, action: 'payout-release', payoutIds, paymentRef? }) so the admin
UI calls it directly. All stale *.md references to the deleted file updated
(ARCHITECTURE.md, README.md, PRE-DEPLOY-CHECKLIST.md,
VERCEL-CONSOLIDATION-PLAN.md); historical CHANGELOG notes kept as history.

**Item 37 (inv. 37) — HELD-OPEN — unmapped (see held-open section below).**

**HELD-OPEN — unmapped items (9/18/32/34/35/37):** cannot be resolved without
the missing Cycle-43 draft; descriptions are NOT invented. Candidate unnumbered
implementations from the SHERLOCK checklist (og:image wired,
instagram-refresh token-persist, paintChecklist on snapshot, 54 cities, Hindi
toggle, barter notify, vercel.json changes) await inventory mapping. NOTE:
"Item 37" in the held-inventory (RELAY's E1–E29 docs edit batch) is a DIFFERENT
numbering — the E-batch is RELAY-held, queued behind the Cycle-36 report, and
is not this changelog.

**Numbering caution (banked):** the missing Cycle-43 draft used its OWN entry
sequence, which does not match report inventory numbers — "Item 7/19" in the
draft ≠ inventory 7/19. Every entry above is keyed by `(inv. NN)` explicitly.

**Contradiction flag (C-A, Cycle 50 — for report-compile time):** FORGE-C49's
"every client forgery neutralized or self-harm-only" phrasing OVERSTATES —
SENTINEL-C48's cancelledByBiz-omission fee-theft (~12% platform fee stolen via
full refund on Active cancel) is PLATFORM-harm, not self-harm. Items 2–4 (rule
pins) remain REQUIRED and are NOT obviated. Correct the rationale at
report-compile time.

---

## Cycle 19 batch (NEXUS 24/7, 2026-10-15, commit `30252ac`) — Jainik-approved, all 21 items

**Item 1 — cron index hardening:** `api/booking-deadlines.js` per-query
try/catch on §1a auto-approve, §1b refund pickups, §2 auto-approve and the
reconcile job — a missing composite index now degrades to an empty snap for
that section instead of 500ing the whole daily cron. `firebase deploy --only
firestore:indexes` still required for the new queries (22 indexes in
`firestore.indexes.json`; manual, Jainik).

**Items 2+3 — UPI MDR provision:** `lib/pricing.js` adds
`UPI_MDR_RATE = 0.004`, threshold ₹2,000, cap ₹300 (`upiMdrCharge()`); order
summary shows a "UPI charges (0.4%)" line; `api/booking-create.js` accepts
`expectedTotal` OR `expectedTotal + upiMdrCharge` so the first legit UPI
booking ≥₹2,000 does not 400 on amount_mismatch.

**Item 4 — honest payment dead-end:** when Cashfree keys are unset on the
gocolllancer project, the booking Pay button reads "Payments coming soon"
(disabled) instead of "Opening secure payment…" → silent nothing.

**Item 7 — DPDP deletion processor:** new cron §5 in `api/booking-deadlines.js`
(booking-deadlines.js:532) drains `deletionRequests` (30-day grace, fail-closed
safety check — a failed check never deletes). Server-side recursive delete.

**Item 8 — creator DPDP parity:** legal links (Privacy / Terms / Data Deletion)
added to the creator profile. Creator deletion itself still uses a native
`confirm()` (connect/creator-connect.js:433) — the in-app deletion sheet
landed only brand-side (see Verification sweep notes).

**Item 9 — payout release API:** NEW `api/payout-release.js` (admin-only via
`admins/{uid}` doc + rate limit) — "Mark paid" writes to `payouts/{id}` with
deterministic `payoutrel_{id}` unified-ledger entries (`walletTransactions`,
type `payout_release`), idempotent on retry. `api/` is now **12/12** — the
Vercel Hobby function budget is FULL; no new endpoint without merging or
replacing an existing one.

**Item 10 — TDS/194J tracking:** `api/booking-action.js` + `api/booking-deadlines.js`
maintain per-creator FY payout totals (`payoutFY`/`payoutFYTotal`) and flag
`tdsApplicable` at the ₹50,000/FY threshold (`TDS_THRESHOLD_INR` in
`lib/pricing.js`); creator Earnings shows the FY line. 194J-vs-194O treatment
gated on a written CA opinion (Jainik manual).

**Item 11 — payout destination validation (rules):** `firestore.rules`
validates payout destinations server-side: UPI VPA regex, bank account
9–18 digits, IFSC format, holder > 2 chars. Client checks are bypassable; the
rules are the real enforcement.

**Item 12 — Invite & Earn caps copy:** caps (₹100 credit, first paid booking
₹500+, max 20/mo) now stated in the Invite & Earn UI instead of the open-ended
promise.

**Item 13 — Be On Top REMOVED:** the feature is gone entirely per Jainik's
"not wanted" — `connect/ai/knowledge.js` entries deleted (zero `beOnTop` /
"be on top" hits repo-wide); `firestore.rules` adCampaigns block kept as a
dead tombstone comment.

**Item 14 — booking Details collapsed:** step-3 wizard's 12 optional fields
moved behind a "More details (optional)" expander (`b.more` toggle,
index.html).

**Item 15 — server-side state-change notifications:** `api/booking-action.js`
new `notify` action (Admin SDK, owner-verified) — creator accept/reject and
brand approve/revise/dispute now notify the other party instead of relying on
client writes that rules deny.

**Item 16 — Hindi phase 3:** booking flow labels + offline strings
(`offline_banner`, `back_online_toast`) added to both dicts and wired
(index.html:2142/2151).

**Item 17 — vercel.json rewrite:** SPA catch-all now excludes `/api/*`
(`((?!api/).*)`), so API routes can never be swallowed by the homepage
fallback.

**Item 18 — referral guard:** fail-closed referral crediting + payout render
audit in `lib/referral.js` / `api/booking-deadlines.js`.

**Item 19 — referredBy first-write-wins:** `firestore.rules:105–115` — once
set, `referredBy` on the private contact doc is immutable (admins excepted),
closing the post-signup referral-steal vector.

**Item 20 — creator languages:** `cprof-languages` input writes a `languages[]`
array on the creator doc; discovery language filter can now actually match.

**Item 21 — nits:** city rename, offline drafts, native-popup cleanup.

**FIX — brand `rows()` unclosed paren:** was breaking the brand SPA render in
production.

Manual (Jainik): publish `firestore.rules` (payout-UPI + referredBy + contact
deltas), `firebase deploy --only firestore:indexes`.

## 92bccc0 — blank-screen fix (2026-10-15)
**Date:** 2026-10-15 18:59 UTC (Jainik-reported live bug)

After role selection → Continue, the app rendered only a blank screen. Root
cause: 2 JS syntax errors in the iframe app templates inside `index.html`:
(1) the `MONEY_I18N` `hi` dictionary ended with `'};` instead of `'}};`
(unclosed object literal, both creator + brand templates); (2) an extra `}`
in the voice-recognition `setTimeout(...,1600)` callback (both templates).
Fixed in 8 lines; browser-verified — creator app renders the home screen
("Hi, Jainik 👋", setup checklist, bottom nav) instead of blank.
Lesson: i18n/dictionary edits in index.html must be `node --check` validated
for BOTH src-creator and src-brand script blocks before deploy.

## 804b9d1 — Cycle 18: all 21 approved items (2026-10-15)
**Date:** 2026-10-15 18:28 UTC (Jainik: "all approved")

- **#1 SCOUT — real creator discovery:** no longer 2 hardcoded demos;
  creators fetched `limit(200)`, no orderBy, client-side sort/paginate.
- **#2 GATEKEEPER — scheduled Cycle-17 batch committed** (see `fe05f44`).
- **#3 ORACLE — UPI MDR provision** (0.4% above ₹2,000, capped ₹300).
- **#4 GROWTH — brand referral fixed** + creator Invite & Earn UI.
- **#5 CIRCUIT — Instagram refresh API:** NEW `api/instagram-refresh.js`
  (Firebase auth + 10/min/IP rate limit; token refresh for connected IG
  accounts).
- **#6 HUNTER — brand signup fixed** (+ creator signup verificationStatus fix).
- **#7 MONET — Pro pricing proposal** (no live change; decision with Jainik).
- **#8 FORGE — wallet rate-card verification** (parity with booking-create).
- **#9 PIXEL — bell & menu wired** (both apps; notif readers end the
  write-only `*Notifs` problem).
- **#10 STRATEGOS — Cleo Pro price 799 → 999** (consistent with live ₹999/mo).
- **#11 LEDGER — payout UPI details path** (creator "Add UPI" form).
- **#12 INSIGHT — analytics + founder dashboard** (needs `measurementId`).
- **#13 AURA — 36 cities** (was 5; now 46).
- **#14 DESI — legal pages + DPDP deletion** (brand side).
- **#15 DESI — Hindi phase 2.**
- **#16 SCOUT — portfolio checklist fix** (`portfolioMediaIds` written by
  profile save).
- **#18 BREAKER — referral caps** (20/mo, min ₹500; transactional).
- **#19 ATLAS — Vercel consolidation plan** (doc; the 12-function budget).
- **#20 MOTION — native dialogs → in-app sheets.**
- **#21 DATAWAVE — index definitions** (manual Firebase deploy pending).
Also: `VERCEL-CONSOLIDATION-PLAN.md` added.

## fe05f44 — scheduled Cycle-17 batch (2026-10-15 18:20 UTC)
Rebook-safe ids, Firestore LLM quota, brand-signup fix, refund index:
- `api/refund-request.js` **deleted** (245 lines; zero callers) — refunds now
  run exclusively through cron §1b server-side math + ledger. `api/` went
  11 → 10 files at the time; now 12/12 with instagram-refresh.js +
  payout-release.js.
- `lib/rebook.js` tracked (rebook-safe `collab_{fp}_rN` ids; fixed the live
  `ERR_MODULE_NOT_FOUND` crash in booking-create).
- `/api/llm.js` per-uid quota moved to Firestore-backed buckets (fail-closed).
- Brand signup: `proSubscription:null` write removed (rule-whitelist
  violation that rejected the whole doc create).
- Composite index `bookings(status, refundRequested)` for the refund pickup.

## b35809b — discovery nano fix (2026-10-15 18:13 UTC)
Discovery previously took only the top-60 by followers — nano/micro creators
(India's real creator economy) were invisible. Now: creators fetched
`limit(200)` with no orderBy, client-side `recommended` sort
(`engagement*100 − log10(followers)*2`).

## 8595e11 — SENTINEL security fixes (2026-10-15 18:11 UTC)
- XSS in the review popup (`api/booking-action.js`, `index.html`).
- Referral farming guard (`lib/referral.js` + `api/booking-deadlines.js`).

## Cycle 16 backend batch (FORGE, 2026-10-15, committed as part of `fe05f44`)

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
  (Firebase); Instagram redirect-URI verification (Meta),
  Cashfree webhook config. (`CRON_SECRET` is ON HOLD per Jainik — do NOT set.)

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

**Standing caveat:** `CRON_SECRET` is **ON HOLD per Jainik — do NOT set**. The
scheduled money cron authenticates via Vercel's `x-vercel-cron: 1` header; the
secret only gates manual invocations.

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
