/* POST /api/cashfree-order
 * Creates a Cashfree PG order server-side (secret key never leaves the server).
 * Env: CASHFREE_APP_ID, CASHFREE_SECRET_KEY, CASHFREE_ENV ('test' | 'production', default 'test').
 * Input:  { amount, purpose, creatorId, creatorPrice, label, customer: { email, phone } }
 *          (`customer.id` is ignored — customer_id is always the verified UID.)
 * Output: { configured: true, payment_session_id, order_id, order_status, order_amount, purpose, env }
 *         or { configured: false } when keys are not set (frontend falls back to demo simulation).
 *
 * Security:
 *  - `purpose` is NORMALIZED server-side into the registry contract
 *    (lib/pricing.normalizePurpose): 'wallet_topup' | 'pro_subscription' |
 *    'booking_payment'. The client label can drift without changing what the
 *    webhook does — a label/purpose mismatch can never skip server-side
 *    money handling.
 *  - Amounts are RECOMPUTED server-side, never trusted from the client:
 *      * booking_payment: creatorPrice must match the creator's rate card
 *        (creators/{creatorId}.prices, Rs.1 tolerance); the charge is the
 *        canonical total (5% Pro off creator price first, then 12% fee —
 *        Pro status read server-side from businesses/{uid}).
 *      * wallet_topup: the brand chooses the amount, bounded Rs.100-1,00,000.
 *      * pro_subscription: fixed server constant (Rs.999); the client amount
 *        is ignored entirely.
 *  - return_url / notify_url are SERVER-PINNED (client values ignored):
 *    APP_URL + '/payment/return?order_id=…' and APP_URL + '/api/cashfree-webhook'.
 */
import { normalizePurpose, canonicalTotal, isProActiveBiz, listedPrices, PRO_SUBSCRIPTION_PRICE_INR } from '../lib/pricing.js';

const API_VERSION = '2023-08-01';
const APP_URL = process.env.APP_URL || 'https://gocolllancer.vercel.app';

function base(env) {
  return env === 'production' ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg';
}

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  const appId = process.env.CASHFREE_APP_ID;
  const secret = process.env.CASHFREE_SECRET_KEY;
  const env = (process.env.CASHFREE_ENV || 'test').toLowerCase() === 'production' ? 'production' : 'test';
  if (!appId || !secret) return json(res, 200, { configured: false });

  let body = {};
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch { return json(res, 400, { error: 'bad_json' }); }

  // Require Firebase auth — bind customer.id to verified UID
  let uid = null;
  let db = null;
  try {
    const { getAdmin } = await import('../lib/firebaseAdmin.js');
    const admin = getAdmin();
    db = admin.firestore();
    const idToken = body.idToken || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!idToken) return json(res, 401, { error: 'auth_required' });
    const decoded = await admin.auth().verifyIdToken(idToken);
    uid = decoded.uid;
  } catch (e) {
    return json(res, 401, { error: 'invalid_token' });
  }

  // Purpose is normalized server-side so the client label can never drift
  // out of the registry contract the webhook consumes.
  const label = String(body.purpose || '').trim();
  const purpose = normalizePurpose(label);

  // Server-side amount — never trusts body.amount for bookings or Pro.
  let chargeAmount;
  let creatorId = null;
  if (purpose === 'pro_subscription') {
    // Fixed server constant; any client-sent amount is ignored.
    chargeAmount = PRO_SUBSCRIPTION_PRICE_INR;
  } else if (purpose === 'wallet_topup') {
    const amt = Number(body.amount);
    if (!Number.isFinite(amt) || amt < 100 || amt > 100000)
      return json(res, 400, { error: 'bad_amount', detail: 'Top-up must be between Rs.100 and Rs.1,00,000.' });
    chargeAmount = Math.round(amt * 100) / 100;
  } else {
    // booking_payment: recompute the canonical total from the creator's
    // rate card. The client only names the creator + package price; the
    // server verifies and prices the order.
    creatorId = String(body.creatorId || '').slice(0, 64);
    const creatorPrice = Number(body.creatorPrice);
    if (!creatorId) return json(res, 400, { error: 'missing_creator' });
    if (!Number.isFinite(creatorPrice) || creatorPrice <= 0 || creatorPrice > 10000000)
      return json(res, 400, { error: 'bad_creator_price' });
    let creatorSnap;
    try { creatorSnap = await db.collection('creators').doc(creatorId).get(); }
    catch { return json(res, 500, { error: 'creator_lookup_failed' }); }
    const listed = listedPrices(creatorSnap.exists ? creatorSnap.data() : null);
    // Creators with no rate card get a computed floor price client-side —
    // accept rather than false-reject, mirroring /api/booking-create.
    if (listed.length > 0 && !listed.some((p) => Math.abs(p - creatorPrice) <= 1))
      return json(res, 400, { error: 'creator_price_mismatch' });
    let isPro = false;
    try {
      const bizSnap = await db.collection('businesses').doc(uid).get();
      isPro = isProActiveBiz(bizSnap.exists ? bizSnap.data() : null);
    } catch { return json(res, 500, { error: 'brand_lookup_failed' }); }
    chargeAmount = canonicalTotal(isPro, creatorPrice).total;
    if (!(chargeAmount > 0)) return json(res, 400, { error: 'bad_total' });
  }

  const customer = body.customer || {};
  const orderId = 'cf_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const orderAmount = Math.round(chargeAmount * 100) / 100;

  try {
    const cfRes = await fetch(base(env) + '/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-version': API_VERSION,
        'x-client-id': appId,
        'x-client-secret': secret,
      },
      body: JSON.stringify({
        order_id: orderId,
        order_amount: orderAmount,
        order_currency: 'INR',
        customer_details: {
          customer_id: uid, // Use verified Firebase UID, not client-provided
          customer_email: String(customer.email || 'noreply@collancer.in').slice(0, 128),
          customer_phone: String(customer.phone || '9999999999').replace(/\D/g, '').slice(-10) || '9999999999',
        },
        order_meta: {
          // Server-pinned: client-supplied return_url / notify_url are ignored
          // (a caller-controlled notify_url would route webhooks elsewhere).
          return_url: APP_URL + '/payment/return?order_id=' + orderId,
          // Server webhook for the paid-but-tab-closed case (api/cashfree-webhook).
          notify_url: APP_URL + '/api/cashfree-webhook',
        },
        order_note: String(body.label || (purpose === 'wallet_topup' ? 'Collancer wallet top-up'
          : purpose === 'pro_subscription' ? 'Collancer Business Pro subscription (Rs.' + PRO_SUBSCRIPTION_PRICE_INR + ')'
          : (label || 'Collancer payment'))).slice(0, 200),
      }),
    });
    const data = await cfRes.json().catch(() => ({}));
    if (!cfRes.ok || !data.payment_session_id) {
      console.error('[cashfree-order]', cfRes.status, JSON.stringify(data).slice(0, 300));
      return json(res, 502, { error: 'order_failed', detail: String(data.message || '').slice(0, 160) });
    }
    // Register the order server-side (C7#5): /api/booking-create consumes it,
    // and the cron reconcile (api/booking-deadlines) re-checks 'created'
    // orders that never became bookings. Best-effort — the order itself is
    // already live at Cashfree even if this write fails.
    try {
      const { getAdmin } = await import('../lib/firebaseAdmin.js');
      const { FieldValue } = await import('firebase-admin/firestore');
      await getAdmin().firestore().collection('payment_orders').doc(orderId).set({
        uid, amount: orderAmount, currency: 'INR',
        purpose, // 'wallet_topup' | 'pro_subscription' | 'booking_payment' (normalized above)
        creatorId, // booking orders only (null otherwise)
        status: 'created', bookingId: null,
        customerEmail: String(customer.email || 'noreply@collancer.in').slice(0, 128),
        cashfreeEnv: env, createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    } catch (e) {
      console.error('[cashfree-order] registry write failed', String(e && e.message || e).slice(0, 160));
    }
    return json(res, 200, {
      configured: true,
      payment_session_id: data.payment_session_id,
      order_id: data.order_id,
      order_status: data.order_status,
      // Server-computed charge (the caller must verify against THIS, not its
      // own client-side total).
      order_amount: orderAmount,
      purpose,
      env,
    });
  } catch (e) {
    console.error('[cashfree-order] network', String(e && e.message || e).slice(0, 160));
    return json(res, 502, { error: 'network' });
  }
}
