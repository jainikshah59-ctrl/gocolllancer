/* POST /api/book-with-wallet
 * Server-side wallet booking (C6#10/C7#3).
 *
 * The client used to run a Firestore transaction directly:
 *   tx.update(businesses/{uid}.walletBalance)
 * which is permission-denied under repo firestore.rules (admin-only update
 * on businesses), so wallet bookings silently failed. The client must call
 * THIS endpoint instead of writing businesses.walletBalance itself.
 *
 * Input:  { idToken, fingerprint, booking } where `booking` is the draft from
 *         buildBooking() (whitelisted fields only; amounts recomputed).
 * Output: { bookingId, total } on success.
 *
 * Steps:
 *  (a) verifyIdToken -> uid (booking.bizId is forced to uid)
 *  (b) read businesses/{uid} server-side: walletBalance + isPro (proActive)
 *  (c) server-compute canonical total: 5% Pro discount off the CREATOR PRICE
 *      first, then 12% fee on the discounted price. Reject if total <= 0
 *      (paid) or balance < total.
 *  (d) atomic transaction: debit wallet + create booking + ledger row
 *      walletTransactions/booking_{fp} (deterministic id = idempotent).
 */
import { getAdmin, verifyUid, readBody } from '../lib/firebaseAdmin.js';
import { FieldValue } from 'firebase-admin/firestore';
import { isProActiveBiz } from '../lib/pricing.js';

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

  // Light rate limit: wallet bookings are money-moving.
  try {
    const { rateLimit } = await import('../lib/rateLimit.js');
    if (!rateLimit(req, res, { max: 20, windowMs: 60000, key: 'book-with-wallet' })) return;
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

  const fp = s(body.fingerprint, 64);
  if (!/^[0-9a-f]{32}$/i.test(fp)) return json(res, 400, { error: 'bad_fingerprint' });
  const draft = (body.booking && typeof body.booking === 'object') ? body.booking : {};
  const creatorId = s(draft.creatorId, 64);
  if (!creatorId) return json(res, 400, { error: 'missing_creator' });
  // Item 5 (Cycle 16): self-deal guard — a user can never book themselves.
  if (creatorId === uid) return json(res, 400, { error: 'self_booking' });
  const creatorPrice = num(draft.creatorPrice);
  const barter = draft.type === 'barter';
  if (!barter && (!(creatorPrice > 0) || creatorPrice > 10000000))
    return json(res, 400, { error: 'bad_creator_price' });

  // (b) server-side brand state (admin bypasses client-facing rules)
  const db = getAdmin().firestore();
  const bizRef = db.collection('businesses').doc(uid);
  let biz;
  try {
    const bizSnap = await bizRef.get();
    biz = bizSnap.exists ? (bizSnap.data() || {}) : null;
    if (!biz) return json(res, 404, { error: 'brand_not_found' });
  } catch (e) {
    console.error('[book-with-wallet] brand lookup', String(e && e.message || e).slice(0, 160));
    return json(res, 500, { error: 'brand_lookup_failed' });
  }
  // Item 13 (Cycle 16): unified on lib/pricing isProActiveBiz (respects the
  // 30-day subscription expiry; the old inline check never expired).
  const isPro = isProActiveBiz(biz);

  // (c) canonical pricing — computed server-side, never from the client.
  // Business Pro = 5% off the CREATOR PRICE first, then 12% fee on the discounted price.
  const discount = (!barter && isPro) ? Math.round(creatorPrice * 0.05) : 0;
  const discounted = barter ? 0 : (creatorPrice - discount);
  const fee = barter ? 0 : Math.round(discounted * 0.12);
  const total = barter ? 0 : (discounted + fee);
  if (!barter && !(total > 0)) return json(res, 400, { error: 'bad_total' });

  // (d) atomic transaction: balance check + debit + booking + ledger
  const bookingId = 'collab_' + fp;
  const now = new Date();
  try {
    await db.runTransaction(async (tx) => {
      const bookRef = db.collection('bookings').doc(bookingId);
      const bookSnap = await tx.get(bookRef);
      if (bookSnap.exists) {
        const existing = bookSnap.data() || {};
        if (existing.status !== 'Cancelled') {
          const e = new Error('A booking with this fingerprint already exists.');
          e.code = 'DUPLICATE_BOOKING';
          throw e;
        }
        // Item 2 (Cycle 16): never overwrite a Cancelled booking while its
        // refund intent is unprocessed — the rebook would destroy the pending
        // refund and the cancel audit trail. Fail closed on legacy docs.
        if (existing.refundProcessed !== true) {
          const e = new Error('This booking was cancelled with a pending refund. Wait for the refund to settle before rebooking.');
          e.code = 'REBOOK_BLOCKED_PENDING_REFUND';
          throw e;
        }
      }
      const bs = await tx.get(bizRef);
      const bal = Number((bs.data() || {}).walletBalance || 0);
      if (!barter && bal < total) {
        const e = new Error('Insufficient wallet balance.');
        e.code = 'INSUFFICIENT_BALANCE';
        throw e;
      }
      if (!barter && total > 0) {
        tx.update(bizRef, {
          walletBalance: FieldValue.increment(-total),
          updatedAt: now,
        });
      }
      // Server-side booking doc: whitelist client draft fields; all money
      // fields and lifecycle fields are recomputed/forced here.
      const doc = {
        creatorId, creatorName: s(draft.creatorName, 120), creatorHandle: s(draft.creatorHandle, 120),
        creatorPlatform: s(draft.creatorPlatform, 60), creatorNiche: s(draft.creatorNiche, 80),
        creatorCity: s(draft.creatorCity, 80), creatorPfp: s(draft.creatorPfp, 500) || null,
        bizId: uid, bizName: s(draft.bizName, 120) || 'Business', bizPfp: s(draft.bizPfp, 500) || null,
        bizIsPro: isPro,
        type: barter ? 'barter' : 'paid',
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
        amount: total, creatorPrice: barter ? 0 : creatorPrice,
        escrowAmount: total, platformFee: fee, proDiscount: discount,
        paidAmount: total,
        paymentMethod: 'wallet', paymentStatus: barter ? 'not_required' : 'escrow_held',
        escrowStatus: barter ? 'not_required' : 'held',
        paymentReference: barter ? null : 'wallet_' + fp.slice(0, 12),
        demoPayment: false,
        paymentApproved: false, refundProcessed: false, refundStatus: null,
        status: 'Pending', seenByCreator: false, seenByBiz: true,
        collaborationFingerprint: fp,
        acceptDeadline: new Date(now.getTime() + 72 * 3600 * 1000),
        reviewDeadline: null, autoCancelled: false, autoApproved: false,
        paidAt: barter ? null : FieldValue.serverTimestamp(),
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };
      tx.set(bookRef, doc);
      // Ledger row — deterministic id so a retried request can never double-debit.
      if (!barter) {
        tx.set(db.collection('walletTransactions').doc('booking_' + fp), {
          id: 'booking_' + fp, bizId: uid, type: 'booking_deduction',
          amount: -total, bookingId, creatorId, creatorName: s(draft.creatorName, 120),
          createdAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
    });
  } catch (e) {
    if (e && e.code === 'DUPLICATE_BOOKING') return json(res, 409, { error: 'duplicate_booking', message: e.message });
    if (e && e.code === 'INSUFFICIENT_BALANCE') return json(res, 402, { error: 'insufficient_balance', message: e.message });
    if (e && e.code === 'REBOOK_BLOCKED_PENDING_REFUND') return json(res, 409, { error: 'rebook_blocked_pending_refund', message: e.message });
    console.error('[book-with-wallet] txn', String(e && e.message || e).slice(0, 200));
    return json(res, 500, { error: 'booking_failed' });
  }

  // Notify the creator (best-effort, outside the txn).
  try {
    await db.collection('creatorNotifs').add({
      creatorId, type: 'booking_received', title: 'New collaboration request',
      body: (biz.bizName || 'A brand') + ' booked ' + (s(draft.campaignName, 120) || 'a campaign') + '.',
      bookingId, read: false, createdAt: FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.error('[book-with-wallet] creatorNotif', String(e && e.message || e).slice(0, 160));
  }

  return json(res, 200, { bookingId, total, proDiscount: discount, platformFee: fee });
}
