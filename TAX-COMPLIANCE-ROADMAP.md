# Collancer Tax Compliance Roadmap — India (DRAFT, not legal advice)

> **Status: RESEARCH DOCUMENT ONLY. No tax logic is implemented in the app.**
> A practicing Chartered Accountant must confirm every rule below before any
> code is written. This roadmap exists so the product team knows what to ask
> the CA, and what the implementation surface will be.

---

## 1. TDS on creator payments — Section 194J (fees for professional services)

- **What:** Payments to creators for content/creative work are typically
  treated as "fees for professional services" under Section 194J of the
  Income-tax Act, 1961.
- **Rate:** 10% TDS on the payment credited/paid to the creator (2% only for
  the narrow sub-clauses of 194J that do not apply to creator work — CA to
  confirm the 10% bucket).
- **Threshold:** TDS kicks in when payments to **one payee exceed ₹50,000 in a
  financial year** (aggregate, not per-booking). Below the threshold, no TDS —
  but the threshold must be tracked per creator per FY.
- **Who deducts:** Collancer, as the payer releasing the creator's 95% share
  (and kill-fees), must deduct and deposit the TDS.
- **Implementation surface (once confirmed):**
  - Track per-creator cumulative paid-out amount per FY (`creators/{id}.tdsTracking.{fy}`).
  - When a payout (escrow release or kill-fee) would cross ₹50,000 cumulative
    for that creator in the FY, deduct 10% TDS from that payout onward.
  - Store on each payout: `tdsDeducted`, `tdsRate`, `tdsFy`, `netPaid`.
  - Quarterly: generate Form 26Q inputs; issue Form 16A to creators.
  - Collect creator PAN (mandatory once TDS applies; 20% TDS without PAN).

## 2. GST on the platform fee (E-commerce operator model)

- **What:** Collancer charges a 12% platform fee on the brand side. Under the
  GST law's Electronic Commerce Operator (ECO) provisions (Section 52 CGST Act
  context), the ECO is liable to pay GST on the services it supplies through
  the platform.
- **Treatment:** GST is payable on the **platform fee component only** — the
  creator's package price is the creator's own supply to the brand, not
  Collancer's.
- **Invoice:** The brand must receive a proper **tax invoice** for the
  platform fee with 18% GST shown (the app already ships a "Download invoice"
  modal with brand GSTIN, line items, and 18% GST on the fee — see Cycle 12
  item 18; Collancer's own GSTIN is currently a placeholder
  `29XXXXX0000X1Z5` and must be replaced with the real one after registration).
- **Implementation surface (once confirmed):**
  - GSTIN config (env/server config, never hardcoded).
  - Per-booking tax breakup already exists (`platformFee`, invoice math);
    reconcile with actual GST returns (GSTR-1/GSTR-3B).
  - Inter-state vs intra-state: SGST+CGST vs IGST split on the invoice.

## 3. TCS under Section 52 (ECO collection at source)

- **What:** An ECO is required to collect **TCS @ 2% (1% CGST + 1% SGST, or
  2% IGST)** on the net value of taxable supplies made through it by other
  suppliers — i.e., on the creator's package price flowing through the
  platform — and deposit it.
- **Applicability to Collancer:** This is the part the CA must rule on
  definitively. If Collancer is the ECO and creators supply through it, TCS
  may apply on the creator-price component of every paid booking, with
  monthly GSTR-8 filing and TCS certificates to creators.
- **Implementation surface (once confirmed):**
  - Compute 2% TCS on the taxable supply value per paid booking.
  - Show TCS on the brand's payment breakup and the creator's earnings.
  - Monthly GSTR-8 data export.

## 4. Ghosting protection (implemented — logic summary)

- **72-hour creator-response window:** Every paid booking is created with
  `acceptDeadline = createdAt + 72h`.
- If the creator does not accept within 72h, the hourly cron
  (`api/booking-deadlines.js`, section 1) **auto-cancels the booking and
  refunds the brand in full** (server-truth `paidAmount`, idempotent via
  `refund_{bookingId}`).
- Post-acceptance ghosting: the brand can cancel an **Active** booking. The
  brand is refunded `paidAmount − platformFee` and the creator is queued a
  **10% kill-fee** (of `paidAmount`, from the retained platform-fee portion)
  via `payoutRequests/killfee_{bookingId}` for admin release.

## 5. What needs the CA before implementation

1. Confirm 194J @ 10% is the correct head for creator payouts (vs 194C etc.).
2. Confirm the ₹50,000/payee/FY TDS threshold tracking approach.
3. Confirm ECO treatment: who pays GST on what, and whether Section 52 TCS
   @ 2% applies to the creator-price flow.
4. Confirm invoice format requirements (place of supply, HSN/SAC codes).
5. Confirm TDS on the kill-fee (it is creator income — likely yes under 194J).

**Do not implement any tax deduction/collection logic until the CA signs off
on all five points.**
