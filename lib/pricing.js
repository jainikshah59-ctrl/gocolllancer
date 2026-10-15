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

/** Floor price for a Cashfree order, Rs. */
export const MIN_ORDER_INR = 100;

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
 * Returns { discount, fee, total }.
 */
export function canonicalTotal(isPro, creatorPrice) {
  const discount = isPro ? Math.round(creatorPrice * 0.05) : 0;
  const discounted = creatorPrice - discount;
  const fee = Math.round(discounted * 0.12);
  return { discount, fee, total: discounted + fee };
}

/**
 * Canonical creator share for a payout: 95% of the creator price.
 */
export function creatorShare(creatorPrice) {
  return Math.round(Number(creatorPrice || 0) * 0.95);
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
