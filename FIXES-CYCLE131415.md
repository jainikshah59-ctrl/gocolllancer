# FIXES — NEXUS 24/7 Cycles 13+14+15 (2026-10-14)

All items from Cycles 13, 14, and 15 approved by Jainik. Implemented locally, verified, NOT committed/pushed/deployed.

## Summary

**11 files modified, 3 new files, 2 deleted files.**

### New files
- `api/refund-request.js` — on-demand brand refund endpoint (immediate, not just cron)
- `lib/pricing.js` — shared server-side pricing (canonical totals, purpose normalization, rate-card)
- `TAX-COMPLIANCE-ROADMAP.md` — TDS/GST/TCS research (CA must confirm before implementation)

### Deleted files (zero callers, freed Vercel slots)
- `api/cleo-ai.js` — backed up to /tmp/dead-api-backup/
- `api/edge-tts.js` — backed up to /tmp/dead-api-backup/
- API count now: 11/12 (was 12/12)

## Cycle 13 items

1. **Brand-cancel refund policy** — Pending=full refund, Active=paidAmount−platformFee, PendingCompletion=no cancel. Implemented in firestore.rules + cancelBooking client fields.
2. **10% kill-fee** — Active-cancel: creator gets min(10% of paidAmount, platformFee) via payoutRequests/killfee_{bookingId}. Implemented in booking-deadlines.js §1b.
3. **Ghosting protection** — 72h accept window auto-cancel already in cron; documented.
4. **TDS/GST roadmap** — TAX-COMPLIANCE-ROADMAP.md created. NO tax logic implemented (CA must confirm).
5. **walletTransactions create→false** — already done in Cycle 12, verified.
6. **HOLD Item 24** — skipped per instruction.
7. **HOLD Item 4** — registrations read already closed, left as-is.
8. **Reviews bookingId binding** — already done, verified.
9. **Refund executor** — cancelBooking now writes refundRequested/refundAmount/refundStatus/statusBeforeCancel. Cancel dialog shows exact ₹ math.
10. **Creator Reject un-break** — verified no client ledger write exists; cron finalizes via Admin SDK.
11. **Math.round fix** — replaced with integer arithmetic (±50/×100 tolerance).
12. **Barter cancel** — brandCancelBarterOk() allows cancel without refund fields.
13. **Cancel dialog copy** — exact refund amounts shown.
14. **Specs** — review/chat/escrow already wired, verified.
15. **On-demand refund** — NEW api/refund-request.js endpoint.

## Cycle 14 items

1. **Brand-cancel refund executor** — fixed money limbo; cron §1b now handles brand-cancelled bookings.
2. **BUSINESS approve branch removed** — only server can mark Completed.
3. **409-consume fail-closed** — missing customer_id → 403 (was fail-open).
4. **Sub-₹100 payouts** — queued as 'accumulating', never dropped.
5. **Math.round** — deduped with C13#11.
6. **firestore.indexes.json** — 4 missing indexes added.
7. **Reviews guard** — one-per-booking (doc id = bookingId) + self-deal guard (creatorId != uid).
8-21. notifyUrl/returnUrl server-pinned; cashfree-order amount recomputed server-side; notifications removed (client writes denied); etc.

## Cycle 15 items

1. **Wallet top-up fixed** — purpose contract normalized ('Wallet top-up'→'wallet_topup'); webhook credits correctly.
2. **Pro ₹999 activation server-side** — webhook stamps isPro/proSubscription on businesses/{uid}; client polls for activation.
3. **Math.round** — deduped.
4. **Approve branch** — deduped.
5. **Notifications server-side** — client writes removed (were 100% denied).
6-31. Refund policy, URL pinning, sub-₹100, llm auth (POST now requires Firebase), indexes, GST invoice (printable), rehire blocker documented, etc.

## Verification

- `node --check`: all 12 JS files pass
- `firestore.rules`: braces 0/0, parens 0/0 (balanced)
- `firestore.indexes.json`: valid JSON
- API count: 11/12 (under Vercel Hobby limit)

## Flags for Jainik (manual-only)

1. **Firestore rules need manual Firebase console publish** (all rule changes are repo-only)
2. **CRON_SECRET stays ON HOLD** (standing blocker)
3. **Cashfree keys** must be set on gocolllancer Vercel project
4. **VCIP** still pending for production
5. **Firestore indexes** need deploy via Firebase console/CLI
6. Pro subscription stamp is client-side post-payment polling — webhook is primary path
