# NEXUS 24/7 — Cycle 12 Fixes (2026-10-14)

All 29 approved items implemented. **NOT committed, NOT pushed, NOT deployed** (per standing rule).
Base: `0d46b93`. 11 files modified, 2 new files. All JS passes `node --check`.

> **Mission context:** "Make Collancer the Indian version of Collabstr" (Jainik, 2026-10-14).

---

## Launch-blocking (Items 1–9)

### 1. Four criticals fixed (Worker A — Backend)
- **1a — 409 collision:** `api/booking-create.js` no longer 409s on ANY existing `payment_orders/{orderId}` row. It consumes the pre-registered `status:'created'` row (flips to `'booked'` in the same txn). 409 only when status is `'booked'`/`'consumed'` or a bookingId already exists. Defense-in-depth: `purpose:'wallet_topup'` rows rejected with `400 wrong_order_purpose`.
- **1b — collaborationFingerprint:** `connect/brand-connect.js` `payWithCashfreeBooking` now computes `sha256hex(JSON.stringify(fingerprintParts()))` before calling booking-create. Same fix on the paid-but-unsaved retry path (`A.retrybk`).
- **1c — Creator reject refund server-side:** Removed client `tx.set` on `walletTransactions/refund_{id}` (bizId rule violation). Reject now sets only `refundRequested:true` + `refundAmount` (server-truth paidAmount) + `refundStatus:'pending'` on the booking doc; the cron finalizes (wallet credit + idempotent ledger entry).
- **1d — requestPayout rebuilt:** `connect/creator-connect.js` now lists Completed bookings with no payout, shows a picker, and creates doc id `payout_{bookingId}` with `amount = Math.round(creatorPrice*0.95)` — exactly matching the rules.

### 2. Wallet top-up (Worker A)
- `api/cashfree-order.js` accepts `purpose` (persisted in registry). `api/cashfree-webhook.js` on `PAYMENT_SUCCESS` for `purpose:'wallet_topup'` credits `businesses/{uid}.walletBalance` via `FieldValue.increment` + writes `walletTransactions/deposit_{orderId}`. Idempotent (registry flips `'created'→'credited'`; deterministic deposit id).

### 3. Reviews gated (Worker B — Rules)
- New `completedBookingWith()` helper: review create requires non-empty `bookingId` where booking is `Completed`, `bizId == request.auth.uid`, `creatorId == reviewee`. Fail-closed.

### 4. /registrations locked down (Worker B — Rules)
- `allow read` changed from `if true` → `isAuthed() && (uid == resource.data.uid || isAdmin())`. **Caveat:** CollancerWeb's unauthenticated dup-check query will now be denied — must move server-side.

### 5. Honest pricing (Worker C — Frontend)
- Deleted fabricated price fallback in `mapCreator()`. Empty prices → **"Custom rates"** everywhere (discovery card, profile, booking sheet). Creator gets a "Set your package prices" prompt.

### 6. Paid-but-unsaved retry (Worker C — Frontend)
- Dead-end failure now opens a modal with one-tap **Retry** (same orderId — idempotent via registry) + Dismiss.

### 7. Pro-discount line (Worker C — Frontend)
- Order summary now renders **"Pro discount (5%): −₹X"** between creator price and platform fee.

### 8. Ledger hardening (Worker B — Rules)
- `walletTransactions` create → `allow create: if false` (server-only). New explicit `match /wallet_ledger/{id}` deny-all.

### 9. Webhook HMAC (Worker A — Backend)
- Now uses Cashfree's documented scheme: `base64(HMAC-SHA256(x-webhook-timestamp + rawBody, CASHFREE_SECRET_KEY))` with `timingSafeEqual`. Fail-closed.

---

## Collabstr parity (Items 10–22)

### 10. Discovery filters + shortlist (Worker D)
Budget min/max, follower min, sort (followers/engagement/price), Clear control. Bookmark → `savedCreators/{uid}/creators/{creatorId}`.

### 11. In-booking chat + revisionNote (Worker D)
Full chat overlay both sides (backed by `booking_messages`). `revisionNote` renders as "Revision requested" on creator side.

### 12. Portfolio + share (Worker D)
Creator Content tab: pin up to 6 post URLs → `portfolioMediaIds`. Brand profile renders grid. Visible **Share profile** button → `/c/<handle>` link.

### 13. Custom offer (Worker D)
"Make custom offer" in booking sheet → creator Accept / Counter / Decline. Counters via typed chat. Brand pays via `book-with-wallet` at agreed price.

### 14. Campaign view (Worker D)
Spend-summary card (total / in escrow / completed) + Campaigns list. Performance snapshot placeholder on Completed bookings.

### 15. Escrow auto-release (Worker A — Backend)
**NEW `api/booking-action.js`:** `action:'approve'` verifies brand ownership + `PendingCompletion` status, then atomically sets `Completed` and creates `payoutRequests/payout_{bookingId}` with canonical 95% share. `reviewBooking` approve branch now calls this endpoint.

### 16. Review submit flow (Worker D)
"Rate creator" on Completed bookings → 5-star + text → `reviews` with bookingId.

### 17. Verified-brand badge (Worker D)
`vbadge()` chip from `businesses.verified`, shown on brand name, marketplace posts, and creator booking details.

### 18. GST invoice (Worker D)
"Download invoice" on paid bookings → printable modal (brand GSTIN, line items, 18% GST on platform fee) → Print / Save PDF.

### 19. Dispute evidence (Worker D)
Dispute form (description + up to 3 evidence URLs) → `disputeEvidence[]`. Fraud-signal line shows prior-dispute count.

### 20. SPA unification note (Worker E — Docs)
**NEW `ARCHITECTURE.md`:** documents the dual-SPA structure and recommends single source of truth. Documentation only.

### 21. Paid Business Pro (Worker E — Docs/Logic)
`proSubscription` schema on brand doc; `isProActive()` gates the 5% discount (paid active OR grandfathered legacy). "Go Pro — ₹999/month" button → Cashfree order with `purpose:'pro_subscription'`. **Flag:** Pro stamp is currently a client write post-payment — should move server-side.

### 22. Hindi microcopy (Worker C — Frontend)
`MONEY_I18N` EN/HI dictionary (~28 keys), toggle on wallet/checkout/earnings screens, `localStorage` persisted.

---

## Decisions (Items 23–29)

| # | Decision | Action |
|---|---|---|
| 23 | Fee model | **KEPT** 12% + 5%. Documented in `constants.js` — do NOT change without explicit approval. |
| 24 | Brand-cancel refunds | **Implemented:** Pending → full refund; Active → refund minus platform fee. Enforced in rules. |
| 25 | return_url domain | Changed to `https://gocolllancer.vercel.app` (was `collancer.in`). |
| 26 | Cashfree mode | Verified TEST/sandbox default. **No change.** |
| 27 | Cashfree keys | **Flag for Jainik:** set `CASHFREE_APP_ID`/`SECRET`/`ENV` on gocolllancer Vercel project. |
| 28 | Unpriced creators | Shown with "Custom rates" (not hidden). |
| 29 | Manual ops | Added to `PRE-DEPLOY-CHECKLIST.md`: rules publish, index deploy, remote verify, CRON_SECRET hold. |

---

## ⚠️ Flags for Jainik (manual-only)

1. **Firestore rules MUST be published manually** in Firebase console (all Worker B + D rule changes).
2. **CRON_SECRET stays ON HOLD** until legacy paidAmount audit (standing blocker).
3. **Vercel function count: 12/12** (Hobby limit reached with new `booking-action.js`). No more API files without removing one.
4. **Cashfree keys** need setting on the gocolllancer project (Item 27).
5. **VCIP** still pending for Cashfree production.
6. Pro subscription stamp should move server-side (currently client write).
7. `noreply@collancer.in` email fallback left as-is (not a URL; needs domain decision).

## Files changed
- `api/booking-action.js` (NEW), `api/booking-create.js`, `api/booking-deadlines.js`, `api/cashfree-order.js`, `api/cashfree-webhook.js`
- `connect/brand-connect.js`, `connect/creator-connect.js`, `connect/lib/constants.js`
- `firestore.rules`, `index.html`
- `ARCHITECTURE.md` (NEW), `CHANGELOG.md`, `PRE-DEPLOY-CHECKLIST.md`
- `FIXES-CYCLE12.md` (this file)
