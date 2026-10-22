# gocolllancer — Architecture note (Item 20, Cycle 12)

Written 2026-10-14. Documentation only — no code was refactored.

## How the app is assembled

`index.html` is a **role-picker shell**, not the app itself:

1. **Landing + role picker** (top of file): marketing hero, creator/brand role
   cards, hidden iframes `#f-creator` / `#f-brand`, and the shell bootstrap JS.
2. **Creator SPA source**, embedded as raw text in
   `<script type="text/plain" id="src-creator">` — a *complete standalone
   HTML document*: its own `<head>`/CSS, SVG `<symbol>` icon defs, body
   markup, inline app JS, then Firebase compat SDKs +
   `connect/firebase-config.js` + `connect/ai/index.js` +
   `connect/creator-connect.js`.
3. **Brand SPA source**, embedded the same way in
   `<script type="text/plain" id="src-brand">` — same pattern, loading
   `connect/brand-connect.js` instead.
4. **Shell bootstrap** (`load(role)`): reads `src-<role>` textContent,
   un-escapes `<!--` / `</script`, and injects it as the iframe's `srcdoc`.
   `/c/<handle>` deep links skip the picker and open the brand app with the
   handle passed via `sessionStorage`.
5. **Backend wiring layer**: `connect/creator-connect.js`,
   `connect/brand-connect.js`, `connect/shell-connect.js`. These IIFEs
   override the embedded SPAs' globals (`A` action map, `C`, `S`,
   `window.finish`, …) to swap demo state for real Firestore/API behavior.
   Shared domain constants/pricing live in `connect/lib/constants.js` and
   `connect/lib/format.js`. Server APIs live in `api/` (Vercel functions).

## The duplication problem

Each embedded SPA is a full copy of the app's presentation layer, so
**features are built twice**:

- **Inline helpers duplicated per SPA**: `inr()`, `esc()`, `toast()`,
  `ic()`, `btn()`, `ghost()`, `rows()`, `stat()`, `empty()`, `wrow()`,
  `fmtCount()`, `agoStr()` exist in the creator SPA source, the brand SPA
  source, *and* again in the `-connect.js` wiring files.
- **SVG icon sets duplicated**: both SPAs carry full `<defs>` blocks and
  `P = {...}` icon tables with overlapping icon names.
- **Pricing math expressed 3+ ways**: `priceBreakup()` in
  `connect/lib/constants.js`, `pricingFor()` in `connect/brand-connect.js`,
  and `tot()` inline in the brand SPA — all encoding the same canonical
  rule (5% Pro discount off the creator price first, then 12% fee on the
  discounted price). A rule change must be applied in every copy.
- **Discovery card renderers duplicated**: `card(b,i)` (creator SPA) and
  `card(c)` (brand SPA) are near-identical markup maintained separately.
- **Real behavior lives in the override layer**: the embedded sources are
  demo-first; the `-connect.js` files monkey-patch them at boot. Two
  sources of truth for every screen: the inline demo implementation and
  its real-data override.

This is how pricing-label drift ("Contact for rates" vs "Custom rates"),
fee-math drift, and icon/markup drift happen — a fix applied to one copy
silently misses the others.

## Recommendation: unify to a single source of truth

*(Not implemented — requires Jainik's explicit approval; listed here so the
decision is on record.)*

1. **Extract shared presentation helpers** (`inr`, `esc`, `toast`, `ic`,
   `btn`, the icon defs/table, tab bar, glass-card primitives) into one
   shared JS module that both embedded SPAs load instead of inlining.
2. **One pricing module**: `connect/lib/constants.js` (`priceBreakup`,
   `creatorShareOf`) becomes the *only* place booking math lives; the
   inline `pricingFor`/`tot()` copies are deleted and import it.
3. **Converge the two inline app bundles** into one parameterized SPA
   (`role = creator | brand`) — one `card()` renderer, one booking sheet,
   one wallet — with role-specific views as thin branches, not full copies.
4. **Long-term: stop embedding SPAs as `text/plain` + `srcdoc`.** Build two
   proper entry points (`/creator`, `/brand`) served as real pages; the
   shell becomes a plain landing page with links. This removes the
   double-escaping hazard (`<\\/script` un-escaping) and lets each page be
   cached, indexed, and debugged independently.

**Do not refactor yet.** The standing design boundary ("do not touch the
app's design") plus the deploy-permission rule mean any unification work
needs Jainik's explicit go-ahead and a dedicated, verified workstream.

---

## Backend architecture (added 2026-10-16)

### Money chain (server-owned, end to end)

1. **Order:** brand pays via `POST /api/cashfree-order` (Firebase auth; server
   recomputes the charge from the rate card — client `amount` honored only for
   `wallet_topup` within ₹100–₹1,00,000). Cashfree order registered in
   `payment_orders/{orderId}` as `created`; `notify_url` → webhook.
2. **Booking:** `POST /api/booking-create` (Firebase auth) fetches the Cashfree
   order server-side → requires `order_status === 'PAID'` → server-recomputes
   the expected total via `lib/pricing.js` canonical math → 409s on order reuse
   → atomic booking + registry write. Wallet path goes through
   `/api/book-with-wallet` (same math). Barter bookings are client-written
   `collab_{fp}` docs.
3. **State changes:** `POST /api/booking-action` (`approve` / `revise` /
   `dispute` / `cancel` / `notify`) — auth, ownership checks, deterministic
   `payout_{bookingId}` docs on approve, kill-fee math on cancel. Cross-party
   notifications go out through the server (`notify` action) because rules
   deny client writes to the other party's feed.
4. **Release:** admin marks payouts paid via `POST /api/booking-action`
   (body `action: 'payout-release'`, `admins/{uid}` doc required) →
   `payoutrel_{id}` ledger rows in the unified `walletTransactions` collection.
   (`api/payout-release.js` was merged into `api/booking-action.js`; the old
   endpoint is gone — same request contract, admin UI unchanged.)
5. **Webhook safety net:** `POST /api/cashfree-webhook` (HMAC-SHA256
   `timestamp+rawBody` signature, idempotent `cashfree_events`) credits wallet
   top-ups and Pro subscriptions; paid-but-unbooked orders land in
   `unclaimed_payments` for the daily reconcile.

### Canonical pricing (`lib/pricing.js` — the server source of truth)

- Brand total: **5% Pro discount off the creator price FIRST, then 12%
  platform fee on the discounted price** (`canonicalTotal()`).
- Creator share: **95% of the listed package price** (`creatorShare()`).
- UPI MDR: 0.4% on the payable amount for UPI hinted orders ≥ ₹2,000, capped
  at ₹300 (`upiMdrCharge()`); shown as an explicit line item.
- TDS hooks: `TDS_THRESHOLD_INR = 50000`, `fyLabel()`, `tdsApplicable` flags on
  payout docs. 194J-vs-194O deduction treatment is NOT implemented — gated on
  a written CA opinion.
- No GST anywhere in the money math (Jainik: removed entirely until turnover
  nears ₹20L/yr).

### Firestore rules posture

- Money-flow enforcement lives in `firestore.rules` (765 lines) and is
  server-enforced only **after a manual console publish** (deploys never
  publish rules). Key guards: `bookingCreateMoneySafe` (server-truth amounts),
  refund clamp (`refundAmount ≤ paidAmount`), payout destination format
  validation, `referredBy` first-write-wins, private-contact PII lockdown,
  `walletTransactions` server-owned.
- Client-side rules-deny on cross-party notifs is deliberate; the server
  `notify` action is the write path.

### Cron jobs (`api/booking-deadlines.js`, daily 02:00 UTC, vercel.json)

1. Auto-cancel expired Pending bookings (with try/catch per query — a missing
   index degrades instead of 500ing the whole run).
2. Auto-approve expired PendingCompletion bookings (creator payout queued).
3. Refund pickup §1b: `refundProcessed == false` + `refundRequested == true`
   (server-truth `paidAmount`/`platformFee`; idempotent).
4. Reconcile paid-but-unbooked Cashfree orders.
5. Expire Business Pro subscriptions (30-day).
6. DPDP data deletion requests (30-day grace, fail-closed safety check).

Auth: Vercel's `x-vercel-cron: 1` header for the scheduled path; `CRON_SECRET`
Bearer for manual invocations (fail-closed; currently ON HOLD per Jainik).

### API function budget

Vercel Hobby allows **12 serverless functions**; `api/` is now **11/12**
(book-with-wallet, booking-action, booking-create, booking-deadlines,
cashfree-order, cashfree-verify, cashfree-webhook, instagram-callback,
instagram-refresh, instagram-start, llm) — `api/payout-release.js` was merged
into `api/booking-action.js` (one slot headroom). Any new endpoint must still
merge into an existing file or replace a removed one. `api/` and `lib/`
are imported across boundaries — every import must resolve to a TRACKED file
(the `lib/rebook.js` lesson: a live `ERR_MODULE_NOT_FOUND` took bookings
down because the file was never committed).
