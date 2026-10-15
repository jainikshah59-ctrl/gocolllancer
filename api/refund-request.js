/* POST /api/refund-request
 * Brand-requested on-demand refund — the immediate counterpart of the cron
 * §1b finalize in api/booking-deadlines.js (a brand should not have to wait
 * for the daily cron to get money back).
 *
 * Same server-truth refund semantics as the cron:
 *  - only the owning brand (bookings/{id}.bizId === uid) can request
 *  - amount is server-truth b.paidAmount (never client-supplied)
 *  - the walletBalance increment + refundProcessed flip happen in ONE
 *    transaction, re-checked inside, so concurrent requests can never
 *    double-credit the wallet
 *  - deterministic ledger id refund_{bookingId} in walletTransactions
 *    (unified refund shape: { bizId, bookingId, type:'refund', amount,
 *    createdAt, note }) — idempotent on retried requests
 *
 * Eligible statuses:
 *  - 'Pending'   → the booking is cancelled and the escrow is refunded to
 *                  the brand wallet (creator never accepted). FULL refund.
 *  - 'Active'    → the brand cancels an Active booking: PARTIAL refund
 *                  (paidAmount - platformFee, platform fee retained) and the
 *                  creator is queued a 10% kill-fee from the retained fee
 *                  portion (payoutRequests/killfee_{bookingId}) — exactly the
 *                  cron §1b policy, executed instantly.
 *  - 'Cancelled' → finalizes a pending refund intent (e.g. creator declined
 *                  via creator-side flow) exactly like cron §1b: full refund,
 *                  or partial + kill-fee when the doc carries the Active
 *                  cancel policy (statusBeforeCancel === 'Active').
 * NOT refundable here: 'PendingCompletion' (delivered, under review),
 * 'Completed' (escrow released), 'Disputed' (needs admin resolution).
 * Barter bookings and Rs.0 bookings close the intent with nothing to refund.
 *
 * FRONTEND WIRING CONTRACT (Item 23): the brand cancel flow should call this
 * endpoint (POST { idToken, bookingId }) instead of relying on the daily
 * cron for instant refunds. The endpoint cancels Pending/Active bookings
 * itself and finalizes Cancelled ones.
 *
 * Input:  { idToken, bookingId }
 * Output: { ok: true, bookingId, refunded, already? } on success.
 */
import { getAdmin, verifyUid, readBody } from '../lib/firebaseAdmin.js';
import { FieldValue } from 'firebase-admin/firestore';

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  // Light rate limit: refunds are money-moving.
  try {
    const { rateLimit } = await import('../lib/rateLimit.js');
    if (!rateLimit(req, res, { max: 20, windowMs: 60000, key: 'refund-request' })) return;
  } catch { /* rate limiter must never block the happy path */ }

  let uid;
  let body = {};
  try {
    body = readBody(req);
    uid = await verifyUid(body.idToken || (req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  } catch (e) {
    return json(res, 401, { error: 'auth_required' });
  }

  const bookingId = String(body.bookingId || '').slice(0, 128);
  if (!bookingId) return json(res, 400, { error: 'missing_booking' });

  const db = getAdmin().firestore();
  const now = new Date();

  try {
    const out = await db.runTransaction(async (tx) => {
      const ref = db.collection('bookings').doc(bookingId);
      const snap = await tx.get(ref);
      if (!snap.exists) {
        const e = new Error('Booking not found.');
        e.code = 'NOT_FOUND';
        throw e;
      }
      const b = snap.data() || {};
      // Only the owning brand can request a refund.
      if (String(b.bizId) !== String(uid)) {
        const e = new Error('This booking does not belong to your account.');
        e.code = 'FORBIDDEN';
        throw e;
      }
      // Idempotent: a processed refund never refunds again.
      if (b.refundProcessed === true) return { already: true, refunded: 0 };
      if (b.status !== 'Pending' && b.status !== 'Active' && b.status !== 'Cancelled') {
        const e = new Error('This booking cannot be refunded in its current state.');
        e.code = 'NOT_REFUNDABLE';
        throw e;
      }
      // SERVER-TRUTH amounts only: paidAmount/platformFee were written by
      // /api/booking-create.js (or the legacy wallet flow). Never use a
      // client-set refundAmount field.
      const amt = Number(b.paidAmount || 0);
      const fee = Number(b.platformFee || 0);
      const wasPending = b.status === 'Pending';
      const wasActive = b.status === 'Active';
      if (!(amt > 0 && !b.barter)) {
        // Nothing refundable — close the intent so it never loops.
        tx.update(ref, { refundProcessed: true, refundStatus: 'nothing_to_refund', updatedAt: now });
        return { refunded: 0 };
      }
      const bizRef = db.collection('businesses').doc(b.bizId);
      const bizSnap = await tx.get(bizRef);
      if (!bizSnap.exists) {
        const e = new Error('Brand account not found.');
        e.code = 'BRAND_MISSING';
        throw e;
      }
      // Kill-fee decision (mirrors cron §1b, Cycle 13+14+15): when the BRAND
      // cancels an ACTIVE booking, the brand is refunded paidAmount -
      // platformFee and the creator gets 10% of paidAmount as a kill-fee,
      // paid out of the retained fee portion. Active is detected directly
      // (wasActive) or via the client-recorded statusBeforeCancel / the
      // Active-policy refundAmount attached to a Cancelled doc.
      const activePolicyRefund = amt - fee;
      const claimsActive =
        wasActive ||
        b.statusBeforeCancel === 'Active' ||
        (b.cancelledByBiz === true && fee > 0 &&
          Number(b.refundAmount || -1) === activePolicyRefund);
      let refundToBrand = amt;
      let killFee = 0;
      if (claimsActive && activePolicyRefund >= 0 && b.cancelledByBiz !== false) {
        // Direct Active cancel via this endpoint, or a Cancelled doc
        // carrying the Active policy — partial refund + kill-fee.
        // (wasActive implies brand-initiated: only the owning brand reaches
        // this endpoint, verified above.)
        refundToBrand = activePolicyRefund;
        killFee = Math.min(Math.round(amt * 0.10), fee);
      }
      tx.update(bizRef, { walletBalance: FieldValue.increment(refundToBrand) });
      // Unified ledger (same shape as cron §1): the refund lands in
      // walletTransactions with type 'refund' under the deterministic id
      // refund_{bookingId} — a retried request can never double-refund.
      let refundNote = 'Refund: brand requested refund';
      if (wasPending) refundNote += ' (cancelled before creator accepted)';
      else if (wasActive) refundNote += ' (brand cancelled Active booking: platform fee retained, 10% kill-fee queued to creator)';
      else if (killFee > 0) refundNote += ' (brand cancelled Active booking: platform fee retained, 10% kill-fee queued to creator)';
      else refundNote += ' (booking declined)';
      tx.set(db.collection('walletTransactions').doc('refund_' + bookingId), {
        bizId: b.bizId, bookingId, type: 'refund',
        amount: refundToBrand, createdAt: now,
        note: refundNote,
      }, { merge: true });
      // Queue the creator kill-fee for admin release (same payout queue as
      // escrow releases). Deterministic id `killfee_{bookingId}` so a
      // retried request can never queue a duplicate.
      let killFeeQueued = false;
      if (killFee > 0 && b.creatorId) {
        tx.set(db.collection('payoutRequests').doc('killfee_' + bookingId), {
          bookingId, creatorId: b.creatorId, bizId: b.bizId,
          kind: 'kill_fee', amount: killFee, status: 'pending',
          createdAt: now,
          note: 'Kill-fee (10% of paid amount): brand cancelled an Active booking',
        }, { merge: true });
        killFeeQueued = true;
      }
      const upd = {
        refundProcessed: true, refundStatus: 'completed',
        refundedAt: now, refundedAmount: refundToBrand, refundReason: 'brand_request',
        updatedAt: now,
      };
      if (killFeeQueued) {
        upd.killFee = killFee;
        upd.killFeeQueued = true;
      }
      if (wasPending || wasActive) {
        upd.status = 'Cancelled';
        upd.cancelReason = wasActive
          ? 'Cancelled by brand (Active booking) — partial refund, platform fee retained'
          : 'Cancelled by brand — refund requested';
        upd.cancelledByBiz = true;
        if (wasActive) upd.statusBeforeCancel = 'Active';
        upd.autoCancelled = false;
      }
      tx.update(ref, upd);
      return { refunded: refundToBrand, killFee: killFeeQueued ? killFee : 0, cancelled: wasPending || wasActive };
    });

    // Notifications (outside the txn; best-effort).
    try {
      const refundNote = out.killFee > 0
        ? ' (platform fee retained for Active cancellation)'
        : '';
      await db.collection('bizNotifs').add({
        bizId: uid, type: 'refund_issued',
        title: 'Refund issued',
        body: 'Rs.' + Number(out.refunded || 0).toLocaleString('en-IN') +
          ' was refunded to your Collancer wallet for booking ' + bookingId + refundNote + '.',
        bookingId, read: false, createdAt: FieldValue.serverTimestamp(),
      });
    } catch (e) {
      console.error('[refund-request] bizNotif', String(e && e.message || e).slice(0, 160));
    }
    try {
      await db.collection('adminNotifs').add({
        type: 'refund_requested',
        title: 'Brand requested refund',
        body: 'Brand ' + uid + ' requested a refund for booking ' + bookingId +
          ' — Rs.' + Number(out.refunded || 0).toLocaleString('en-IN') + ' credited to wallet.' +
          (out.killFee > 0 ? ' Kill-fee Rs.' + Number(out.killFee).toLocaleString('en-IN') + ' queued to creator.' : ''),
        bookingId, bizId: uid, resolved: false,
        createdAt: FieldValue.serverTimestamp(),
      });
    } catch (e) {
      console.error('[refund-request] adminNotif', String(e && e.message || e).slice(0, 160));
    }
    if (out.cancelled) {
      try {
        const bSnap = await db.collection('bookings').doc(bookingId).get();
        const bd = bSnap.exists ? (bSnap.data() || {}) : {};
        const creatorId = bd.creatorId || null;
        if (creatorId) {
          const wasActiveCancel = bd.statusBeforeCancel === 'Active';
          await db.collection('creatorNotifs').add({
            creatorId, type: 'booking_cancelled',
            title: 'Booking cancelled',
            body: wasActiveCancel
              ? 'The brand cancelled an Active booking. A 10% kill-fee has been queued to your payouts.'
              : 'The brand cancelled the booking and the escrow was returned. No action needed.',
            bookingId, read: false, createdAt: FieldValue.serverTimestamp(),
          });
        }
      } catch (e) {
        console.error('[refund-request] creatorNotif', String(e && e.message || e).slice(0, 160));
      }
    }

    return json(res, 200, { ok: true, bookingId, ...out });
  } catch (e) {
    if (e && e.code === 'NOT_FOUND') return json(res, 404, { error: 'not_found' });
    if (e && e.code === 'FORBIDDEN') return json(res, 403, { error: 'not_your_booking' });
    if (e && e.code === 'NOT_REFUNDABLE') return json(res, 400, { error: 'not_refundable' });
    if (e && e.code === 'BRAND_MISSING') return json(res, 500, { error: 'brand_missing' });
    console.error('[refund-request]', String(e && e.message || e).slice(0, 200));
    return json(res, 500, { error: 'refund_failed' });
  }
}
