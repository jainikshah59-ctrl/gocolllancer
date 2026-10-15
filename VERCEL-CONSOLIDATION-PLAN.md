# Vercel Function Consolidation Plan (Item 19, Cycle 17)

**Status:** PROPOSAL ONLY — not implemented. Awaiting Jainik's approval.

## Current State: 11/12 Hobby Functions Used

| # | File | Lines | Purpose | Called By |
|---|------|-------|---------|-----------|
| 1 | `instagram-start.js` | 57 | OAuth authorize URL builder | Creator connect flow |
| 2 | `cashfree-verify.js` | 75 | Payment status verification | Post-checkout |
| 3 | `instagram-refresh.js` | 188 | Token refresh + profile re-sync | Manual sync / cron |
| 4 | `cashfree-order.js` | 191 | Create Cashfree PG order | Booking / top-up / Pro |
| 5 | `booking-action.js` | 209 | Approve/reject/deliver/dispute | Brand + creator actions |
| 6 | `llm.js` | 227 | AI proxy (Groq→CF→Gemini) | Cleo AI chat |
| 7 | `instagram-callback.js` | 231 | OAuth callback + token exchange | Meta redirect |
| 8 | `book-with-wallet.js` | 245 | Wallet-funded booking | Brand wallet pay |
| 9 | `booking-create.js` | 292 | Cashfree-funded booking | Brand card/UPI pay |
| 10 | `cashfree-webhook.js` | 344 | Cashfree webhook handler | Cashfree servers |
| 11 | `booking-deadlines.js` | 478 | Daily cron (refunds/payouts/expiry) | Vercel cron |

**Problem:** Only 1 slot remains. CIRCUIT identified a need for `/api/instagram-refresh`
(already added, using slot 11). Future needs (e.g., `/api/og` for per-profile share
images, `/api/health` for monitoring) have no room.

## Proposed Merges (saves 4 slots: 11 → 7)

### Merge A: Instagram trio → `api/instagram.js` (saves 2 slots)
- Combine: `instagram-start.js` (57) + `instagram-callback.js` (231) + `instagram-refresh.js` (188)
- Total: ~476 lines — manageable, single domain
- Routing: by `action` field in body, or separate POST handlers keyed on a path suffix
  - `action: 'start'` → build authorize URL
  - (GET with `code` param) → OAuth callback (must preserve exact redirect URI behavior)
  - `action: 'refresh'` → token refresh + re-sync
- **Risk:** LOW. All three share Instagram API helpers already. The callback's redirect
  URI (`/api/instagram-callback`) is registered with Meta — must add a Vercel rewrite
  or keep the old path as an alias during migration.

### Merge B: Cashfree duo → `api/cashfree.js` (saves 1 slot)
- Combine: `cashfree-order.js` (191) + `cashfree-verify.js` (75)
- Total: ~266 lines
- Routing: `action: 'create-order'` vs `action: 'verify'`
- **Risk:** LOW. Both are Cashfree PG client operations. The webhook (`cashfree-webhook.js`)
  stays separate (different auth model — HMAC, not Firebase UID).

### Merge C: Booking creators → `api/booking.js` (saves 1 slot)
- Combine: `booking-create.js` (292) + `book-with-wallet.js` (245)
- Total: ~537 lines — largest merged file, but single domain (booking creation)
- Routing: by `paymentMethod` in body (`'cashfree'` vs `'wallet'`)
- Shared logic already exists: `resolveRebookId`, `canonicalTotal`, self-deal guard
- **Risk:** MEDIUM. These are the two most critical money paths. Requires careful
  testing of both flows after merge. Recommend this as the LAST merge.

### Do NOT Merge
- `cashfree-webhook.js` — HMAC auth, called by Cashfree servers. Keep isolated.
- `booking-deadlines.js` — cron with 4 sweep sections. Already at 478 lines; merging
  would create an unmaintainable file. Keep isolated.
- `booking-action.js` — post-creation lifecycle (approve/deliver/dispute). Different
  auth patterns and state machine from creation. Keep isolated.
- `llm.js` — AI proxy, no shared code with money flows. Keep isolated.

## After Merges: 7/12 Functions

| # | File | Contents |
|---|------|----------|
| 1 | `api/instagram.js` | start + callback + refresh |
| 2 | `api/cashfree.js` | order create + verify |
| 3 | `api/booking.js` | cashfree booking + wallet booking |
| 4 | `api/booking-action.js` | (unchanged) |
| 5 | `api/booking-deadlines.js` | (unchanged) |
| 6 | `api/cashfree-webhook.js` | (unchanged) |
| 7 | `api/llm.js` | (unchanged) |

**Free slots: 5** — room for `/api/og` (share images), `/api/health` (monitoring),
and 3 future endpoints.

## Implementation Order (if approved)
1. Merge B (Cashfree) — lowest risk, smallest files
2. Merge A (Instagram) — medium risk, needs redirect URI alias
3. Merge C (Booking) — highest risk, do last with full money-flow testing

## Testing Required Per Merge
- `node --check` on merged file
- Import test: verify all exports resolve
- Live test on preview deployment before promoting to production
- For Merge C: test both Cashfree AND wallet booking flows end-to-end
