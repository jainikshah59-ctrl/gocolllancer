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
import { isProActiveBiz, canonicalTotal } from '../lib/pricing.js';
import { resolveRebookId } from '../lib/rebook.js';

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

  // Item 8 (Cycle 17, FORGE): verify creatorPrice against the creator's
  // listed package prices — mirrors the check in api/booking-create.js
  // (C7#6). Without this, the wallet path was the last client-controlled
  // pricing input: a tampered creatorPrice underpays the creator
  // (brand-approve / auto-approve pays 95% of it). Barter bookings skip
  // (no price to verify).
  if (!barter) {
    let creatorSnap = null;
    try {
      creatorSnap = await db.collection('creators').doc(creatorId).get();
    } catch (e) {
      return json(res, 500, { error: 'creator_lookup_failed' });
    }
    const cd = creatorSnap && creatorSnap.exists ? creatorSnap.data() : null;
    const listed = [];
    if (cd && cd.prices && typeof cd.prices === 'object') {
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
    if (cd && Array.isArray(cd.packages)) {
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
    // Creators with no rate card get a computed floor price client-side, so
    // there is nothing server-side to verify against — accept rather than
    // false-reject legitimate bookings.
    if (listed.length > 0) {
      const ok = listed.some((p) => Math.abs(p - creatorPrice) <= 1);
      if (!ok) return json(res, 400, { error: 'creator_price_mismatch' });
    } else {
      console.warn('[book-with-wallet] no rate card for creator ' + creatorId + ' — price check skipped');
    }
  }

  // (c) canonical pricing — computed server-side via lib/pricing.canonicalTotal,
  // never from the client. Wallet is an internal transfer: no UPI MDR applies
  // (MDR only hits gateway payments via /api/cashfree-order with paymentMethod='upi').
  const pr = barter ? { discount: 0, fee: 0, upiMdr: 0, total: 0 }
    : canonicalTotal(isPro, creatorPrice, { paymentMethod: 'wallet' });
  const discount = pr.discount;
  const fee = pr.fee;
  const total = pr.total;
  if (!barter && !(total > 0)) return json(res, 400, { error: 'bad_total' });

  // (d) atomic transaction: balance check + debit + booking + ledger
  const bookingId = 'collab_' + fp;
  const now = new Date();
  let finalBookingId = bookingId; // may become a suffixed rebook id (Item 2)
  try {
    await db.runTransaction(async (tx) => {
      // Item 2 (Cycle 16): rebook-safe id resolution (lib/rebook.js). A
      // terminal doc (Completed, or Cancelled with settled refund) is NEVER
      // overwritten — the rebook gets a suffixed id and the prior doc is
      // archived into previousBookings. Non-terminal docs still 409
      // (double-submit idempotency); Cancelled+pending-refund still 409.
      const rb = await resolveRebookId(tx, db, bookingId);
      finalBookingId = rb.bookingId;
      const finalBookRef = db.collection('bookings').doc(finalBookingId);
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
        // Item 2 (Cycle 16): rebook audit trail — archived prior
        // lifecycle(s) of this collaboration. Never overwritten, only appended.
        previousBookings: rb.previousBookings,
        rebookOf: rb.rebookOf,
        rebookAttempt: rb.rebookAttempt,
      };
      tx.set(finalBookRef, doc);
      // Ledger row — deterministic id so a retried request can never
      // double-debit. Derived from the FINAL booking id (Item 2): a rebook
      // must not merge-overwrite the prior booking's deduction row.
      const ledgerId = 'booking_' + finalBookingId.replace(/^collab_/, '');
      if (!barter) {
        tx.set(db.collection('walletTransactions').doc(ledgerId), {
          id: ledgerId, bizId: uid, type: 'booking_deduction',
          amount: -total, bookingId: finalBookingId, creatorId, creatorName: s(draft.creatorName, 120),
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
      bookingId: finalBookingId, read: false, createdAt: FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.error('[book-with-wallet] creatorNotif', String(e && e.message || e).slice(0, 160));
  }

  return json(res, 200, { bookingId: finalBookingId, total, proDiscount: discount, platformFee: fee });
}
