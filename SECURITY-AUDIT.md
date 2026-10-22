# gocolllancer — Security Audit Log

Running record of vulnerabilities found by the NEXUS 24/7 agent audits and how they
were fixed. Format: severity — what was wrong (file:line) — fix commit.

No exploit recipes: entries describe the weakness class and the fix, not how to
abuse them.

---

## Cycle 0 — NEXUS AI OFFICE audit (before NEXUS 24/7) → fixed in `5de7fb8` (2026-10-13)

| Sev | Finding | Fix |
|---|---|---|
| CRITICAL | `api/llm-keys.js` served API keys to any caller (public key oracle) | Endpoint **deleted** |
| CRITICAL | `api/llm-pool.js` dead code carrying key references | **Deleted** |
| HIGH | Creator payout computed at 93% while canonical share is 95% (underpayment) | 95% (`connect/brand-connect.js` / `constants.js`) |
| HIGH | Refund race — concurrent crons could double-credit the same refund | Atomic `FieldValue.increment` |
| HIGH | Payment DEMO bug — truthy check accepted non-paid order states | `order_status === 'PAID'` check |
| HIGH | `api/cashfree-order` accepted unauthenticated callers | Firebase ID-token auth, fail-closed, UID-bound orders |
| MEDIUM | `stopMic` crash (`aiSilTm` ReferenceError) | Guard fix |
| MEDIUM | XSS in creator cards (raw `c.id` in `data-v`) | `esc()` wrapper |

---

## Cycle 2 — NEXUS 24/7 audit (SENTINEL/SHERLOCK/ATLAS/AURA/MONET) → fixed in `d25390e` (2026-10-13)

| Sev | Finding | Fix (all in `d25390e`) |
|---|---|---|
| CRITICAL | `api/booking-deadlines.js:42` — `require()` inside an ESM module: the money cron threw on the first refund-eligible booking and was dead in production | Top-level `import`; added business-doc exists guard |
| CRITICAL | `connect/creator-connect.js:447–472` — creator rejection never refunded the brand (money stranded) | Atomic transaction + cron section 1b: `refund_{bookingId}` idempotent refund intent |
| HIGH | Pro discount formula order wrong (`brand-connect.js:270–274`) — 12% fee on full price, then 5% subtracted (~₹60 overpay per ₹10k booking) | Canonical order: 5% off price → 12% fee on discounted |
| HIGH | `connect/lib/constants.js:10` — `CREATOR_SHARE_PCT = 93` while payouts/UI said 95% | `93` → `95` |
| HIGH | `api/booking-deadlines` cron publicly triggerable when `CRON_SECRET` unset (auth was conditional) | `CRON_SECRET` mandatory, fail-closed (401) |
| MEDIUM | `api/cashfree-verify` — open order-status oracle, no auth | Firebase auth required |
| MEDIUM | `api/edge-tts` — open TTS proxy (no auth, no rate limit) | Firebase auth + 20 req/min/IP |
| MEDIUM | `/api/llm` only endpoint with rate limiting; limiter had no pruning, no `Retry-After` | Shared `lib/rateLimit.js` (pruning + `Retry-After`); wired into `llm`/`edge-tts`/`cleo-ai` |
| MEDIUM | Refund had no idempotency guard — overlapping crons could double-credit | Deterministic `refund_{bookingId}` ledger docs |
| MEDIUM | XSS incomplete (`data-v` IDs + detail-view fields unescaped; some `esc()` copies crashed on null) | Escaping completed in `index.html` |
| MEDIUM | `firestore.rules` — `walletTransactions` create rule too permissive | Tightened (see Cycle 4 B-M7) |
| MEDIUM | Refund batch dropped the business-doc exists guard (orphaned bookings aborted the batch) | Exists guard restored |

---

## Cycles 3+4 — BREAKER adversarial audit → fixed in `cda9399` (2026-10-14)

| Sev | Finding | Fix (all in `cda9399`) |
|---|---|---|
| CRITICAL | B-C1: booking payment fields client-controlled — `cashfree-order` accepted the client-supplied amount, `cashfree-verify` checked only status PAID; bookings written client-side with arbitrary `paidAmount`/`escrowAmount`/`paymentReference`; one PAID `order_id` reusable for unlimited bookings (no order registry, no webhook) | NEW `POST /api/booking-create`: server-side Cashfree order fetch → PAID check → server-computed total → rejects on mismatch → `payment_orders/{orderId}` registry (409 on reuse) → atomic booking write; checkout calls it instead of direct client writes |
| CRITICAL | B-C2: creator reject could set arbitrary `refundAmount` (rule had no value constraint); cron trusted `b.refundAmount \|\| b.paidAmount` → refund inflation | `refundAmount` taken from the booking doc's `paidAmount` inside the transaction; cron uses only `b.paidAmount` |
| HIGH | B-H3: `/registrations/{id}` — open read + open update/delete, no auth (PII read/modify/wipe) | `firestore.rules:520`: update/delete → admin-only |
| HIGH | B-H4: `payoutRequests` create allowed self-set arbitrary amounts ≥100; brand could queue any amount per completed booking | Rules now require `bookingId` and `amount == round(booking.creatorPrice * 0.95)` |
| HIGH | B-H5: rate-limit bypass via X-Forwarded-For spoofing — `clientIp()` trusted the leftmost (attacker-controlled) entry | Takes the rightmost entry (Vercel appends the real client IP last) |
| MEDIUM | B-M6: `api/cleo-ai` unauthenticated (60/min keyed-LLM burn); `api/cleo-search` unauthenticated AND un-rate-limited (free search-scrape proxy) | Both require Firebase auth; `cleo-search` 30/min/IP |
| MEDIUM | B-M7: `walletTransactions` create lacked `bizId == auth.uid` → anyone could forge deposit/refund ledger entries for any business | Create rule binds `bizId` to the caller |
| MEDIUM | B-M8: `bizNotifs`/`creatorNotifs`/`adminNotifs` create open to any signed-in user → notification phishing | Create restricted to owner or admin (`adminNotifs` → admin only) |
| MEDIUM | B-M9: any signed-in user could rewrite any creator's `rating` 0–5; reviews needed no completed booking | Rating-update path removed from any-authed users (admin/server-only) |
| LOW | B-L10: `cashfree-verify` had auth but no order-ownership check — authed users could probe arbitrary `order_id`s | **OPEN** — still unverified at `cda9399` |

Cron double-credit race: credit + `refundProcessed:true` flip moved into a
transaction (checks `refundProcessed !== true` before crediting).

---

## Cycles 16–21 — implementation batches → `fe05f44` (2026-10-15), `804b9d1` (2026-10-15), `30252ac` (2026-10-16)

Adversarial findings closed by these commits (Jainik-approved), plus the status
changes of earlier rows:

| Sev | Finding | Fix |
|---|---|---|
| CRITICAL | Fake wallet credit via client-writable `paidAmount` on booking create (C6 SENTINEL N1) | `bookingCreateMoneySafe()` in `firestore.rules` + server-set `paidAmount` — closed both layers (`fe05f44`) |
| CRITICAL | `api/llm.js` POST had **no auth** — open keyed-LLM quota burn + jailbreak oracle (C8 B-M6 residual) | `POST /api/llm` requires Firebase auth (`verifyUid`); client `system` prompt ignored, server-built prompt (`fe05f44`); api/llm.js:163–173 |
| CRITICAL | `api/booking-deadlines` 401'd on Vercel's scheduled cron — accepted only Bearer/`x-cron-secret`/query | `x-vercel-cron: 1` accepted for the scheduled path; `CRON_SECRET` remains mandatory fail-closed for manual invocations (api/booking-deadlines.js:25–31) |
| HIGH | `/api/refund-request.js` refunded FULL `paidAmount` on Active-cancel (server disagreed on fee math); had zero callers | Endpoint **deleted** (245 lines) — refunds run exclusively through cron §1b server-truth math (`fe05f44`) |
| HIGH | Cron §1b refund pickup had no `try/catch` on first query — a missing composite index 500'd the whole daily cron | Per-query try/catch on every cron section (1a, 1b, 2, reconcile) — index miss degrades to empty snap (`30252ac`) |
| HIGH | Booking amount mismatch on UPI payments ≥₹2,000 — `booking-create` didn't tolerate the UPI MDR the order pipeline added | Accepts `expectedTotal` OR `expectedTotal + upiMdrCharge` (`30252ac`) |
| MEDIUM | Payout destination (UPI VPA / bank) had no server validation — malformed destinations stalled the admin queue | Rules-side validation: VPI regex, 9–18 digit account, IFSC format, holder > 2 chars (`30252ac`) |
| MEDIUM | `referredBy` mutable post-signup — referral-farming vector (re-visit `?ref=<attacker>`) | First-write-wins in `firestore.rules:105–115` (immutable once set; admins excepted) — **live-effective only after console publish** |
| MEDIUM | Cross-party notifications were client-written and rules-denied — invisible/silent | `api/booking-action.js` `notify` action: server-owned notification via Admin SDK (`30252ac`) |
| LOW | XSS in review popup | Escaping fix (`8595e11`) |
| LOW | Referral farming via duplicate credit | Fail-closed transactional caps in `lib/referral.js` (`8595e11`, `30252ac`) |

**Live-effectiveness caveat (2026-10-16):** the firestore.rules deltas above
(payout-UPI validation, referredBy lock, contact create/update tightening,
765 lines) are repo-truth; the console publish at ~22:20 IST predates them
(659 lines). Until Jainik publishes, production enforces the OLD rules.

---

## OPEN rows (2026-10-16)

| Sev | Finding | Status |
|---|---|---|
| HIGH | DPDP deletion processor: UI promised 30-day deletion that never ran (SENTINEL, C19) | **IMPLEMENTED in `30252ac`** (cron §5, fail-closed) — execution unverified pending first real cron run; needs one `deletionRequests` request in prod to prove the path end-to-end |
| HIGH | Payout-UPI rules + referredBy lock + contact deltas not yet live in prod | Pending **manual** `firestore.rules` console publish (Jainik); until then creator "Add UPI" is permission-denied |
| MEDIUM | TDS gated on CA opinion | `30252ac` added **tracking only** (FY totals, ₹50k threshold flag) — 194J-vs-194O fork is a 100x difference; needs a written CA opinion before any deduction |
| — | Creator DPDP deletion — which handler is canonical (dual path clarified) | **Canonical:** the in-app deletion sheet owned by the profile script in `index.html` (`[data-cdel]` → `[data-cdelpanel]` panel, Cycle 19 Item 8). The legacy native-`confirm()` interception in `connect/creator-connect.js` was REMOVED (Cycle 21 — it fired in capture phase and shadowed the sheet). Server-side execution runs in the booking-deadlines cron §5 against `deletionRequests` (30-day grace, fail-closed). |
| LOW | B-L10: `cashfree-verify` order-ownership check | Still open (order-owner check fail-open when customer_id missing) |
| LOW | `instagram-refresh.js` stale-token 400 with no retry/backoff (partial-write risk) | Open; auth + 10/min/IP rate limit present |

## Cycles 5–7 — RETIRED 2026-10-16 (all 8 rows fixed in later cycles)

The rows below were true at HEAD `cda9399` (2026-10-14) and are now all **fixed**
in Cycles 17/18/19. Kept here only as history — the current open findings are
in the table above.

| Sev | Finding | How it was fixed |
|---|---|---|
| CRITICAL | `api/booking-deadlines` didn't accept Vercel's `x-vercel-cron: 1` header — cron 401'd even after `CRON_SECRET` was set | `api/booking-deadlines.js:29` accepts the `x-vercel-cron: 1` scheduled path; the cron runs **daily 02:00 UTC** (`vercel.json`) — it was never "every hour" |
| CRITICAL | Fake wallet credit — rules didn't constrain `paidAmount`/`paymentStatus` at booking create | `bookingCreateMoneySafe` rules guard + server-truth amounts on booking-create |
| HIGH | `api/llm.js` accepted a client-supplied `system` prompt (up to 4000 chars) | POST now requires Firebase auth, prompt lives server-side, per-uid daily quota |
| HIGH | Refund ledger split: cron wrote to `wallet_ledger` while the wallet UI read `walletTransactions` | Refunds now write to server-owned `walletTransactions` |
| HIGH | `payWithWallet` did a client-side `tx.update(walletBalance)` that repo rules deny | All wallet balance writes are server-owned |
| MEDIUM | `booking-create` didn't verify `creatorPrice` against `creators/{id}` prices | Creator price now verified server-side against the creator doc |
| MEDIUM | Bookings create rule allowed client writes of `paidAmount`/`paymentStatus`/`escrowStatus`/`paymentReference` | Blocked by rules — client can no longer write money fields |
| MEDIUM | Paid-but-tab-closed gap: PAID at Cashfree, no booking written, nobody notified | Closed via `api/cashfree-webhook.js` + the booking-deadlines reconcile sweep |

**Standing manual-only blockers (can never be fixed in code):**
1. Publish `firestore.rules` + `firestore.indexes.json` in the Firebase console (Jainik).
2. **`CRON_SECRET`: ON HOLD per Jainik — do NOT set.**
3. Live Firebase console `firestore.rules` vs repo rules comparison (Jainik).
4. Cashfree VCIP video-KYC call (original physical PAN or DigiLocker e-PAN on camera).
5. GitHub remote `main` == HEAD verification.

---

## Commit map
- `5de7fb8` (2026-10-13 19:01 UTC) — Cycle 0 audit batch
- `d25390e` (2026-10-13 21:06 UTC) — Cycle 2, 17 fixes (deployed)
- `cda9399` (2026-10-14 02:26 UTC) — Cycles 3+4, 34 fixes
- `fe05f44` (2026-10-15 18:20 UTC) — Cycle 17 batch (refund-request deleted, LLM quota, rebook-safe ids, brand-signup fix, refund index)
- `8595e11` / `b35809b` (2026-10-15) — SENTINEL XSS + referral-farming guard; discovery nano fix
- `804b9d1` (2026-10-15 18:28 UTC) — Cycle 18, 21 approved items (instagram-refresh API, payout-UPI path, Hindi phase 2, legal pages)
- `92bccc0` (2026-10-15 18:59 UTC) — blank-screen fix (MONEY_I18N brace + setTimeout brace); pushed as `240f778f`
- `30252ac` (2026-10-15 19:36 UTC) — Cycle 19, all 21 approved items (Jainik: all approved); deployed as `1808f0f3` (Jainik: "jo bacha sab deploy krdo")

Live baseline 2026-10-16: **1808f0f3** on Vercel (browser-verified: creator home + brand Discover render). Rules live at the ~22:20 IST console publish — the 765-line repo rules (payout-UPI validation, referredBy lock) are NOT yet published.
