/* POST /api/refund-request
 * Brand-requested on-demand refund — the immediate counterpart of the cron
 * §1b finalize in api/booking-deadlines.js (a brand should not have to wait
 * for the hourly cron to get money back).
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
 *                  the brand wallet (creator never accepted).
 *  - 'Cancelled' → finalizes a pending refund intent (e.g. creator declined
 *                  via creator-side flow) exactly like cron §1b.
 * NOT refundable here: 'PendingCompletion' (delivered, under review),
 * 'Completed' (escrow released), 'Disputed' (needs admin resolution).
 * Barter bookings and Rs.0 bookings close the intent with nothing to refund.
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
      if (b.status !== 'Pending' && b.status !== 'Cancelled') {
        const e = new Error('This booking cannot be refunded in its current state.');
        e.code = 'NOT_REFUNDABLE';
        throw e;
      }
      // SERVER-TRUTH amount only: paidAmount was written by
      // /api/booking-create.js (or the legacy wallet flow). Never use a
      // client-set refundAmount field.
      const amt = Number(b.paidAmount || 0);
      const wasPending = b.status === 'Pending';
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
      tx.update(bizRef, { walletBalance: FieldValue.increment(amt) });
      // Unified ledger (same shape as cron §1): the refund lands in
      // walletTransactions with type 'refund' under the deterministic id
      // refund_{bookingId} — a retried request can never double-refund.
      tx.set(db.collection('walletTransactions').doc('refund_' + bookingId), {
        bizId: b.bizId, bookingId, type: 'refund',
        amount: amt, createdAt: now,
        note: 'Refund: brand requested refund' + (wasPending ? ' (cancelled before creator accepted)' : ' (booking declined)'),
      }, { merge: true });
      const upd = {
        refundProcessed: true, refundStatus: 'completed',
        refundedAt: now, refundReason: 'brand_request',
        updatedAt: now,
      };
      if (wasPending) {
        upd.status = 'Cancelled';
        upd.cancelReason = 'Cancelled by brand — refund requested';
        upd.autoCancelled = false;
      }
      tx.update(ref, upd);
      return { refunded: amt, cancelled: wasPending };
    });

    // Notifications (outside the txn; best-effort).
    try {
      await db.collection('bizNotifs').add({
        bizId: uid, type: 'refund_issued',
        title: 'Refund issued',
        body: 'Rs.' + Number(out.refunded || 0).toLocaleString('en-IN') +
          ' was refunded to your Collancer wallet for booking ' + bookingId + '.',
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
          ' — Rs.' + Number(out.refunded || 0).toLocaleString('en-IN') + ' credited to wallet.',
        bookingId, bizId: uid, resolved: false,
        createdAt: FieldValue.serverTimestamp(),
      });
    } catch (e) {
      console.error('[refund-request] adminNotif', String(e && e.message || e).slice(0, 160));
    }
    if (out.cancelled) {
      try {
        const bSnap = await db.collection('bookings').doc(bookingId).get();
        const creatorId = bSnap.exists ? (bSnap.data() || {}).creatorId : null;
        if (creatorId) {
          await db.collection('creatorNotifs').add({
            creatorId, type: 'booking_cancelled',
            title: 'Booking cancelled',
            body: 'The brand cancelled the booking and the escrow was returned. No action needed.',
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
