/* POST /api/booking-create
 * Server-side booking creation after a Cashfree payment (B-C1 fix).
 * Never trusts the client for amounts, payment status, or order reuse.
 *
 * Input:  { idToken, orderId, booking } where `booking` is the draft from
 *         buildBooking() (whitelisted fields only; amounts recomputed).
 * Output: { bookingId } on success.
 *
 * Steps:
 *  (a) verifyIdToken -> uid (booking.bizId is forced to uid)
 *  (b) fetch Cashfree order -> require order_status === 'PAID'
 *  (c) server-compute expected total from booking.creatorPrice:
 *      5% Pro discount off the creator price first (brand isPro read
 *      server-side from businesses/{uid}), then 12% fee on the discounted
 *      price. Reject if |order_amount - expectedTotal| > 1.
 *  (d) order registry payment_orders/{orderId}: 409 REUSE if it exists;
 *      otherwise create it + the booking doc atomically in one transaction.
 */
import { getAdmin, verifyUid, readBody } from '../lib/firebaseAdmin.js';
import { FieldValue } from 'firebase-admin/firestore';

const CF_API_VERSION = '2023-08-01';
function cfBase(env) {
  return env === 'production' ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg';
}
function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}
function s(v, max) { return String(v == null ? '' : v).slice(0, max || 200); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  // Light rate limit: booking creation is expensive + money-moving.
  try {
    const { rateLimit } = await import('../lib/rateLimit.js');
    if (!rateLimit(req, res, { max: 20, windowMs: 60000, key: 'booking-create' })) return;
  } catch { /* rate limiter must never block the happy path */ }

  // (a) auth
  let uid;
  let body = {};
  try {
    body = readBody(req);
    uid = await verifyUid(body.idToken || (req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  } catch (e) {
    return json(res, 401, { error: 'auth_required' });
  }

  const appId = process.env.CASHFREE_APP_ID;
  const secret = process.env.CASHFREE_SECRET_KEY;
  const env = (process.env.CASHFREE_ENV || 'test').toLowerCase() === 'production' ? 'production' : 'test';
  if (!appId || !secret) return json(res, 503, { error: 'payments_not_configured' });

  const orderId = s(body.orderId, 64).trim();
  if (!orderId) return json(res, 400, { error: 'missing_order_id' });

  const draft = (body.booking && typeof body.booking === 'object') ? body.booking : {};
  const fp = s(draft.collaborationFingerprint, 64);
  if (!/^[0-9a-f]{32}$/i.test(fp)) return json(res, 400, { error: 'bad_fingerprint' });
  const creatorPrice = num(draft.creatorPrice);
  if (!(creatorPrice > 0) || creatorPrice > 10000000) return json(res, 400, { error: 'bad_creator_price' });
  const creatorId = s(draft.creatorId, 64);
  if (!creatorId) return json(res, 400, { error: 'missing_creator' });

  // (b) fetch the Cashfree order server-side
  let order;
  try {
    const cfRes = await fetch(cfBase(env) + '/orders/' + encodeURIComponent(orderId), {
      headers: {
        'x-api-version': CF_API_VERSION,
        'x-client-id': appId,
        'x-client-secret': secret,
      },
    });
    order = await cfRes.json().catch(() => ({}));
    if (!cfRes.ok) {
      console.error('[booking-create] order fetch', cfRes.status);
      return json(res, 502, { error: 'order_verify_failed' });
    }
  } catch (e) {
    console.error('[booking-create] order fetch network', String(e && e.message || e).slice(0, 160));
    return json(res, 502, { error: 'network' });
  }
  if (order.order_status !== 'PAID') return json(res, 400, { error: 'order_not_paid', order_status: order.order_status });
  // The order must have been created for THIS brand (cashfree-order binds customer_id to the Firebase UID).
  const orderCust = order.customer_details && order.customer_details.customer_id;
  if (orderCust && String(orderCust) !== uid) return json(res, 403, { error: 'order_owner_mismatch' });

  // (c) server-computed expected total — canonical pricing formula.
  // Business Pro = 5% off the CREATOR PRICE first, then 12% fee on the discounted price.
  let isPro = false;
  try {
    const db = getAdmin().firestore();
    const bizSnap = await db.collection('businesses').doc(uid).get();
    const biz = bizSnap.exists ? bizSnap.data() : null;
    isPro = !!(biz && biz.isPro && biz.proActive);
  } catch (e) {
    return json(res, 500, { error: 'brand_lookup_failed' });
  }
  const discount = isPro ? Math.round(creatorPrice * 0.05) : 0;
  const discounted = creatorPrice - discount;
  const fee = Math.round(discounted * 0.12);
  const expectedTotal = discounted + fee;
  const orderAmount = num(order.order_amount);
  if (Math.abs(orderAmount - expectedTotal) > 1) {
    return json(res, 400, { error: 'amount_mismatch', expected: expectedTotal, got: orderAmount });
  }
  if (!(expectedTotal > 0)) return json(res, 400, { error: 'bad_total' });

  // (d) transaction: order-reuse registry + booking write, atomically.
  const bookingId = 'collab_' + fp;
  const now = new Date();
  const db = getAdmin().firestore();
  try {
    await db.runTransaction(async (tx) => {
      const regRef = db.collection('payment_orders').doc(orderId);
      const regSnap = await tx.get(regRef);
      if (regSnap.exists) {
        const e = new Error('This payment was already used for a booking.');
        e.code = 'ORDER_REUSED';
        throw e;
      }
      const bookRef = db.collection('bookings').doc(bookingId);
      const bookSnap = await tx.get(bookRef);
      if (bookSnap.exists && bookSnap.data() && bookSnap.data().status !== 'Cancelled') {
        const e = new Error('A booking with this fingerprint already exists.');
        e.code = 'DUPLICATE_BOOKING';
        throw e;
      }
      // Server-side booking doc: whitelist client draft fields; all money
      // fields and lifecycle fields are recomputed/forced here.
      const doc = {
        creatorId, creatorName: s(draft.creatorName, 120), creatorHandle: s(draft.creatorHandle, 120),
        creatorPlatform: s(draft.creatorPlatform, 60), creatorNiche: s(draft.creatorNiche, 80),
        creatorCity: s(draft.creatorCity, 80), creatorPfp: s(draft.creatorPfp, 500) || null,
        bizId: uid, bizName: s(draft.bizName, 120) || 'Business', bizPfp: s(draft.bizPfp, 500) || null,
        bizIsPro: isPro,
        type: draft.type === 'barter' ? 'barter' : 'paid',
        packageKey: draft.packageKey == null ? null : s(draft.packageKey, 64),
        campaignName: s(draft.campaignName, 160), productName: s(draft.productName, 160),
        brief: s(draft.brief, 4000), deliverables: s(draft.deliverables, 2000),
        platform: s(draft.platform, 60), deadline: s(draft.deadline, 40),
        targetAudience: s(draft.targetAudience, 400), category: s(draft.category, 80),
        hashtags: s(draft.hashtags, 400), websiteLink: s(draft.websiteLink, 500),
        cta: s(draft.cta, 200), usageRights: s(draft.usageRights, 800),
        revisions: s(draft.revisions, 80), exclusivity: s(draft.exclusivity, 200),
        requirements: s(draft.requirements, 2000), contactNumber: s(draft.contactNumber, 40),
        contact: s(draft.contact, 40), shipping: s(draft.shipping, 400),
        mediaFiles: Array.isArray(draft.mediaFiles) ? draft.mediaFiles.slice(0, 20).map((m) => s(m, 500)) : [],
        amount: expectedTotal, creatorPrice,
        escrowAmount: expectedTotal, platformFee: fee, proDiscount: discount,
        paidAmount: expectedTotal,
        paymentMethod: 'cashfree', paymentStatus: 'escrow_held', escrowStatus: 'held',
        paymentReference: orderId, demoPayment: false,
        cashfreeEnv: env, paymentApproved: false, refundProcessed: false, refundStatus: null,
        status: 'Pending', seenByCreator: false, seenByBiz: true,
        collaborationFingerprint: fp,
        acceptDeadline: new Date(now.getTime() + 72 * 3600 * 1000),
        reviewDeadline: null, autoCancelled: false, autoApproved: false,
        paidAt: FieldValue.serverTimestamp(), createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };
      tx.set(regRef, {
        uid, bookingId, amount: orderAmount, expectedTotal, creatorPrice,
        cfPaymentId: order.cf_order_id || null, cashfreeEnv: env,
        paidAt: FieldValue.serverTimestamp(), createdAt: FieldValue.serverTimestamp(),
      });
      tx.set(bookRef, doc);
    });
  } catch (e) {
    if (e && e.code === 'ORDER_REUSED') return json(res, 409, { error: 'order_reused', message: e.message });
    if (e && e.code === 'DUPLICATE_BOOKING') return json(res, 409, { error: 'duplicate_booking', message: e.message });
    console.error('[booking-create] txn', String(e && e.message || e).slice(0, 200));
    return json(res, 500, { error: 'booking_failed' });
  }

  return json(res, 200, { bookingId });
}
