/* POST /api/cashfree-verify
 * Verifies a Cashfree order's payment status server-side. NEVER trust the
 * frontend checkout result alone — only order_status === 'PAID' counts.
 * Env: CASHFREE_APP_ID, CASHFREE_SECRET_KEY, CASHFREE_ENV.
 * Input:  { idToken, order_id, expected_amount? }
 * Output: { order_status, order_amount, cf_payment_id, env }  (order_status: PAID | ACTIVE | EXPIRED | ...)
 *
 * Item 22: the queried order must belong to the calling user. Ownership is
 * established two ways (either suffices): the order's Cashfree
 * customer_details.customer_id matches the caller's verified UID (bound at
 * order creation in api/cashfree-order.js), or our own
 * payment_orders/{orderId} registry row has uid === caller. An order for a
 * different user is rejected 403 — without this, any authed user could
 * probe arbitrary order IDs and learn their amounts/status.
 */
const API_VERSION = '2023-08-01';

// Item 2: per-IP rate limit (20/min) on this authed status oracle, so a
// compromised token cannot hammer Cashfree status reads at full speed.
// Pre-auth and fail-open: a limiter fault must never break verification.
import { rateLimit } from '../lib/rateLimit.js';

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
  const orderId = String(body.order_id || '').trim();
  if (!orderId) return json(res, 400, { error: 'missing_order_id' });

  // Item 2: rate limit BEFORE idToken verification (pre-auth). Fail open —
  // if the limiter itself throws, verification must still proceed.
  try { if (!rateLimit(req, res, { max: 20, windowMs: 60000, key: 'cashfree-verify' })) return; } catch (e) { /* fail open */ }

  // Require Firebase auth — this endpoint reveals order status and must not
  // be an open oracle for arbitrary order IDs.
  let uid;
  let admin;
  try {
    const mod = await import('../lib/firebaseAdmin.js');
    admin = mod.getAdmin();
    const idToken = body.idToken || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!idToken) return json(res, 401, { error: 'auth_required' });
    const decoded = await admin.auth().verifyIdToken(idToken);
    uid = decoded.uid;
  } catch (e) {
    return json(res, 401, { error: 'invalid_token' });
  }

  try {
    const cfRes = await fetch(base(env) + '/orders/' + encodeURIComponent(orderId), {
      headers: {
        'x-api-version': API_VERSION,
        'x-client-id': appId,
        'x-client-secret': secret,
      },
    });
    const data = await cfRes.json().catch(() => ({}));
    if (!cfRes.ok) {
      console.error('[cashfree-verify]', cfRes.status, JSON.stringify(data).slice(0, 200));
      return json(res, 502, { error: 'verify_failed' });
    }
    // Item 22: order-ownership check BEFORE returning anything. Fail closed:
    // a caller may only see an order if (a) Cashfree's customer_details
    // binds it to their verified UID (set at order creation), or (b) our
    // own payment_orders registry row has uid === caller. Anything else is
    // someone else's order — 403, no status leaked.
    let owns = false;
    const custId = data.customer_details && data.customer_details.customer_id;
    if (custId && String(custId) === String(uid)) owns = true;
    if (!owns) {
      try {
        const reg = await admin.firestore().collection('payment_orders').doc(orderId).get();
        if (reg.exists && String((reg.data() || {}).uid) === String(uid)) owns = true;
      } catch { /* fail closed below */ }
    }
    if (!owns) return json(res, 403, { error: 'not_your_order' });
    return json(res, 200, {
      order_status: data.order_status,
      order_amount: data.order_amount,
      cf_payment_id: data.cf_order_id || null,
      env,
      // Optional caller-supplied amount check: the caller (booking flow)
      // sends the server/client-expected total so a PAID order for a
      // different amount can be rejected before a booking is written.
      ...(Number.isFinite(Number(body.expected_amount)) ? {
        amount_matches: Math.abs(Number(data.order_amount) - Number(body.expected_amount)) < 0.01,
      } : {}),
    });
  } catch (e) {
    console.error('[cashfree-verify] network', String(e && e.message || e).slice(0, 160));
    return json(res, 502, { error: 'network' });
  }
}
