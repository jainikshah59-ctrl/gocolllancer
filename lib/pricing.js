/* Shared server-side pricing helpers for the gocolllancer API functions.
 * Single source of the Collancer money formula (canonical pricing):
 *   Business Pro = 5% off the CREATOR PRICE first,
 *   then a 12% platform fee on the DISCOUNTED price.
 *   Creator share (payouts) = 95% of the creatorPrice.
 * Never trust client-computed amounts — every money-moving endpoint
 * recomputes from the server-truth inputs with these helpers.
 */

/** Business Pro subscription price, Rs./month (Jainik decision 2026-10-14). */
export const PRO_SUBSCRIPTION_PRICE_INR = 999;

/** 30-day subscription duration. */
export const PRO_SUBSCRIPTION_DAYS = 30;

/** Business Pro discount cap, Rs. (Item 24): the 5%-off-creator-price Pro
 * discount is capped at Rs.999/month — without a cap a Rs.10L booking would
 * hand out a Rs.50,000 discount. Semantics unchanged: 5% off the creator
 * price first, then the 12% fee on the discounted price; the discount is
 * just min(5%, Rs.999). */
export const PRO_DISCOUNT_CAP_INR = 999;

/** Rs.1 floor for gateway orders and minimum paid bookings. */
export const MIN_ORDER_INR = 100;

/* UPI MDR (Merchant Discount Rate) — NPCI DEFERRED post-Diwali (2026).
 * KILL-SWITCH (Item 8): MDR computation is gated behind this ONE constant.
 * It defaults to OFF. Flip to `true` ONLY when (a) NPCI/MoF actually turns
 * MDR back on AND (b) Jainik has decided absorb-vs-pass. Do NOT bake the
 * absorb-or-pass decision in code — that is his call; until then the flag
 * stays off and upiMdr is 0 everywhere.
 */
export const UPI_MDR_ENABLED = false;

/* MDR pricing (used only when UPI_MDR_ENABLED is true):
 * 0.4% on UPI payments of Rs.2,000 and above, capped at Rs.300 per
 * transaction. Below Rs.2,000: zero MDR.
 */
export const UPI_MDR_RATE = 0.004;
export const UPI_MDR_THRESHOLD_INR = 2000;
export const UPI_MDR_CAP_INR = 300;

/**
 * UPI MDR charge for a given payable amount (Rs.).
 * Returns 0 when the UPI_MDR_ENABLED kill-switch is OFF (default), or when
 * amount < Rs.2,000; else 0.4% capped at Rs.300.
 */
export function upiMdrCharge(amount) {
  if (!UPI_MDR_ENABLED) return 0; // Item 8: kill-switch — MDR is off until NPCI goes live AND Jainik decides absorb-vs-pass.
  const a = Number(amount || 0);
  if (!(a >= UPI_MDR_THRESHOLD_INR)) return 0;
  return Math.min(Math.round(a * UPI_MDR_RATE), UPI_MDR_CAP_INR);
}

/**
 * Extract the creator's listed package prices from a creators/{id} doc.
 * Same source the brand discovery UI builds its package list from:
 * `prices` (object label -> price) with `packages` (array) as fallback.
 */
export function listedPrices(creatorData) {
  const listed = [];
  const cd = creatorData && typeof creatorData === 'object' ? creatorData : {};
  if (cd.prices && typeof cd.prices === 'object') {
    for (const k of Object.keys(cd.prices)) {
      const v = cd.prices[k];
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) listed.push(n);
      else if (v && typeof v === 'object') {
        for (const f of ['price', 'sale', 'amount', 'rate']) {
          const m = Number(v[f]);
          if (Number.isFinite(m) && m > 0) listed.push(m);
        }
      }
    }
  }
  if (Array.isArray(cd.packages)) {
    for (const p of cd.packages) {
      let m = NaN;
      if (p && typeof p === 'object') {
        m = Number(p.price != null ? p.price : (p.amount != null ? p.amount : p.rate));
      } else {
        m = Number(p);
      }
      if (Number.isFinite(m) && m > 0) listed.push(m);
    }
  }
  return listed;
}

/**
 * Canonical payable total for a paid booking from server-truth inputs.
 * Returns { discount, fee, upiMdr, total }.
 *
 * Item 24: the Pro discount is 5% off the creator price but CAPPED at
 * PRO_DISCOUNT_CAP_INR (Rs.999/month) — a Rs.10L booking no longer hands
 * out a Rs.50k discount. Semantics unchanged: 5% off creator price first,
 * then 12% fee on the discounted price.
 *
 * Item 8: upiMdr is 0 while the UPI_MDR_ENABLED kill-switch is OFF (the
 * default) — when enabled, the MDR is 0.4% on the gateway charge >= Rs.2,000,
 * capped Rs.300.
 *
 * Item 21: the client-controlled paymentMethod hint is IGNORED for MDR
 * decisions — the server decides MDR from the actual payment path. Only the
 * explicit server-side 'wallet' flag (internal ledger, e.g. book-with-wallet,
 * which never touches the gateway) is exempt. api/cashfree-order.js no
 * longer forwards the client's paymentMethod at all, so a hint of 'card'
 * can never dodge MDR on a gateway order.
 *
 * opts.paymentMethod: 'wallet' (server-set, internal ledger only).
 */
export function canonicalTotal(isPro, creatorPrice, opts) {
  const discount = isPro
    ? Math.min(Math.round(creatorPrice * 0.05), PRO_DISCOUNT_CAP_INR)
    : 0;
  const discounted = creatorPrice - discount;
  const fee = Math.round(discounted * 0.12);
  const subtotal = discounted + fee;
  const pm = opts && typeof opts.paymentMethod === 'string' ? opts.paymentMethod.toLowerCase() : '';
  // Item 21 (SENTINEL): only the explicit server-side 'wallet' flag (internal
  // ledger — never touches the Cashfree gateway) exempts MDR. The client
  // paymentMethod hint is not accepted here; callers with gateway orders
  // (api/cashfree-order.js) simply do not pass a hint. Item 8: with the
  // UPI_MDR_ENABLED kill-switch OFF, upiMdrCharge returns 0 anyway.
  const upiMdr = pm === 'wallet' ? 0 : upiMdrCharge(subtotal);
  return { discount, fee, upiMdr, total: subtotal + upiMdr };
}

/**
 * Full refundable amount for a booking doc, INCLUDING the MDR line.
 * Item 12: the brand actually paid `paidAmount + upiMdr` at the gateway, but
 * bookings store them separately. A refund that only uses paidAmount
 * silently shorts the brand by up to Rs.300 on UPI bookings. Refund paths
 * (api/booking-deadlines.js §1 auto-cancel and §1b intents) must compute
 * refunds from THIS helper — it is forward-compatible: bookings without an
 * upiMdr field (written before Item 12) refund exactly as before.
 */
export function refundableBookingTotal(b) {
  const amt = Number((b && b.paidAmount) || 0);
  const raw = Number((b && b.upiMdr) || 0);
  // BREAKER Cycle 35: never trust a raw upiMdr value — cap at the maximum
  // legitimate charge (Rs.300) and only count it when real money moved
  // (paidAmount > 0). A forged upiMdr on a client-written doc can never
  // inflate a refund.
  const mdr = amt > 0 ? Math.min(Math.max(raw, 0), 300) : 0;
  return amt + mdr;
}

/**
 * Canonical creator share for a payout: 95% of the creator price.
 */
export function creatorShare(creatorPrice) {
  return Math.round(Number(creatorPrice || 0) * 0.95);
}

/**
 * TDS threshold for creator payouts (Item 10, Cycle 19).
 * When a creator's cumulative payouts in a financial year cross Rs.50,000,
 * tdsApplicable is flagged on creators/{uid}/private/tdsTracking for
 * admin/TDS handling (SENTINEL-287: never on the public creators doc).
 */
export const TDS_THRESHOLD_INR = 50000;

/**
 * Indian financial-year label for a date, e.g. Oct 2026 -> "2026-27",
 * Feb 2027 -> "2026-27". FY runs April-March.
 */
export function fyLabel(d) {
  const dt = d instanceof Date ? d : new Date(d);
  const y = dt.getFullYear(), m = dt.getMonth(); // 0-indexed
  return m >= 3
    ? y + '-' + String(y + 1).slice(2)
    : (y - 1) + '-' + String(y).slice(2);
}

/**
 * Compact FY key for nested tracking maps, e.g. Oct 2026 -> "fy2026",
 * Feb 2027 -> "fy2026". FY runs April-March.
 *
 * TDS/194J-vs-194O GATE (Cycle 19): creator-payout TDS is NOT deducted —
 * whether 194J or 194O applies needs a WRITTEN CA opinion first. Until then
 * this key is tracking-only: it feeds the per-FY cumulative totals the CA
 * will need, nothing more.
 */
export function fyKey(d) {
  const dt = d instanceof Date ? d : new Date(d);
  const y = dt.getFullYear(), m = dt.getMonth(); // 0-indexed
  return 'fy' + (m >= 3 ? y : y - 1);
}

/**
 * Server-truth Pro state for a businesses/{uid} doc. Mirrors the client-side
 * isProActive() (connect/brand-connect.js): an active paid subscription
 * counts, and grandfathered legacy free Pro (isPro && proActive, with NO
 * subscription record) counts.
 *
 * Item 13 (Cycle 16) — EXPIRY FIX: the old version fell through to
 * `isPro && proActive` even when a paid subscription had EXPIRED (the
 * webhook leaves isPro/proActive true forever), so Pro never lapsed — a
 * revenue leak. Now: when a proSubscription record exists, ONLY an
 * unexpired 'active' subscription counts; the legacy flags cannot revive
 * an expired subscription.
 */
export function isProActiveBiz(biz) {
  if (!biz || typeof biz !== 'object') return false;
  const sub = biz.proSubscription;
  if (sub && typeof sub === 'object') {
    if (sub.status !== 'active') return false;
    const exp = sub.expiresAt;
    const expMs = exp && typeof exp.toMillis === 'function' ? exp.toMillis() : Date.parse(exp);
    return !!(expMs && expMs > Date.now());
  }
  // Grandfathered legacy free Pro (no subscription record at all).
  return !!(biz.isPro && biz.proActive);
}

/**
 * Normalize a client-sent purpose label into the registry purpose contract
 * consumed by /api/cashfree-webhook:
 *   'wallet_topup'      — wallet credit (credited server-side)
 *   'pro_subscription'  — Business Pro activation (stamped server-side)
 *   'booking_payment'   — everything else (consumed by /api/booking-create)
 * Any client label variant ('Wallet top-up', 'wallet_topup', …) maps to the
 * canonical tag, so a label/purpose drift can never silently skip
 * server-side money handling.
 */
export function normalizePurpose(raw) {
  const pl = String(raw || '')
    .toLowerCase()
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (pl === 'wallet topup' || pl === 'wallet top up') return 'wallet_topup';
  if (pl === 'pro subscription') return 'pro_subscription';
  if (pl === 'wallet_topup') return 'wallet_topup';
  if (pl === 'pro_subscription') return 'pro_subscription';
  return 'booking_payment';
}
