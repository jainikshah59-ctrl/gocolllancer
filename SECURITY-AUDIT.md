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

## Cycles 5–7 — re-verified holding, new findings → NOT YET FIXED (open at `cda9399`)

These were confirmed at HEAD `cda9399`. Nothing fixed yet; all await Jainik's approval.

| Sev | Finding | Status |
|---|---|---|
| CRITICAL | `api/booking-deadlines` doesn't accept Vercel's `x-vercel-cron: 1` header — the scheduled cron 401s EVEN AFTER `CRON_SECRET` is set; `vercel.json` says daily `0 2 * * *` while the header says "every hour" | OPEN — cron structurally dead in production |
| CRITICAL | Fake wallet credit — rules don't constrain `paidAmount`/`paymentStatus` at booking create; a fake `escrow_held` booking auto-refunded by the cron credits real wallet funds | OPEN |
| HIGH | `api/llm.js` accepts a client-supplied `system` prompt (up to 4000 chars) into the Groq/Cloudflare/Gemini lanes → prompt-injection + quota burn on paid keys | OPEN — fix must move the prompt server-side, not just reject |
| HIGH | Refund ledger split: cron writes refunds to `wallet_ledger` (no Firestore rule, read by nothing) while brand wallet UI reads `walletTransactions` → refunds invisible in wallet history | OPEN |
| HIGH | `payWithWallet` does a client-side `tx.update(walletBalance)`, but repo rules allow only admin updates → permission-denied under repo rules (live-console comparison still manual-only) | OPEN |
| MEDIUM | `booking-create` doesn't verify `creatorPrice` against `creators/{id}` prices (last client-controlled pricing input) | OPEN |
| MEDIUM | Bookings create rule still allows client writes of `paidAmount`/`paymentStatus`/`escrowStatus`/`paymentReference` | OPEN |
| MEDIUM | Paid-but-tab-closed gap: PAID at Cashfree, no booking written, nobody notified | OPEN (webhook design proposed, needs Cashfree dashboard config by Jainik) |
| LOW | B-L10 (order-ownership check on `cashfree-verify`) | OPEN |
| LOW | `scamAlerts` creatorName spoofable; `requirements` owner can change `bizId` on update; real Cashfree bookings mislabeled `demoPayment=true` | OPEN |

**Standing manual-only blockers (can never be fixed in code):**
1. Publish `firestore.rules` + `firestore.indexes.json` in the Firebase console (Jainik).
2. Set `CRON_SECRET` in Vercel env (Jainik) — *insufficient alone until the cron-auth code fix ships*.
3. Live Firebase console `firestore.rules` vs repo rules comparison (Jainik).
4. Cashfree VCIP video-KYC call (original physical PAN or DigiLocker e-PAN on camera).
5. GitHub remote `main` == `cda9399` verification.

---

## Commit map
- `5de7fb8` (2026-10-13 19:01 UTC) — Cycle 0 audit batch
- `d25390e` (2026-10-13 21:06 UTC) — Cycle 2, 17 fixes (deployed)
- `cda9399` (2026-10-14 02:26 UTC) — Cycles 3+4, 34 fixes
