/* Booking deadline processor (Collabstr 72h model).
 * Called by cron every hour. Processes:
 * 1. Pending bookings past acceptDeadline → auto-cancel + refund brand
 * 2. PendingCompletion bookings past reviewDeadline → auto-approve + payout creator
 */
import { getAdmin } from '../lib/firebaseAdmin.js';
import { FieldValue } from 'firebase-admin/firestore';

export default async function handler(req, res) {
  // Auth: CRON_SECRET is MANDATORY (fail closed). The cron must send either
  // `Authorization: Bearer <CRON_SECRET>` (Vercel Cron does this automatically)
  // or the `x-cron-secret` header / `cron_secret` query param.
  const secret = process.env.CRON_SECRET;
  const gotAuth = String(req.headers['authorization'] || '');
  const gotHeader = String(req.headers['x-cron-secret'] || '');
  const gotQuery = String((req.query && req.query.cron_secret) || '');
  const okSecret = secret && (gotAuth === 'Bearer ' + secret || gotHeader === secret || gotQuery === secret);
  if (!okSecret) return res.status(401).json({ ok: false, err: 'unauthorized' });
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ ok: false });
  }
  try {
    const app = getAdmin();
    const db = app.firestore();
    const now = new Date();
    const results = { cancelled: [], approved: [] };

    // 1. Auto-cancel expired Pending bookings
    const pendingSnap = await db.collection('bookings')
      .where('status', '==', 'Pending')
      .where('acceptDeadline', '<', now)
      .limit(50)
      .get();

    for (const doc of pendingSnap.docs) {
      // Transaction-guarded: the refund credit + refundProcessed flip happen
      // atomically, and the guard is re-checked INSIDE the transaction so a
      // concurrent/duplicate cron run can never double-credit the wallet.
      const outcome = await db.runTransaction(async (tx) => {
        const snap = await tx.get(doc.ref);
        if (!snap.exists) return 'skip';
        const b = snap.data() || {};
        if (b.status !== 'Pending' || b.autoCancelled) return 'skip';
        // SERVER-TRUTH amount only: b.paidAmount was written by
        // api/booking-create.js; never trust a client-set refundAmount.
        const amt = Number(b.paidAmount || 0);
        const bizRef = b.bizId ? db.collection('businesses').doc(b.bizId) : null;
        const bizSnap = bizRef ? await tx.get(bizRef) : null;
        let refunded = false;
        if (bizSnap && bizSnap.exists && amt > 0 && !b.barter) {
          tx.update(bizRef, { walletBalance: FieldValue.increment(amt) });
          // Ledger entry — deterministic id `refund_{bookingId}` so a retried
          // cron run can never double-refund (idempotency guard).
          const ledgerRef = db.collection('wallet_ledger').doc('refund_' + doc.id);
          tx.set(ledgerRef, {
            bizId: b.bizId, bookingId: doc.id, type: 'refund_auto_cancel',
            amount: amt, createdAt: now,
            note: 'Auto-refund: creator did not accept within 72h',
          }, { merge: true });
          refunded = true;
        }
        tx.update(doc.ref, {
          status: 'Cancelled', autoCancelled: true,
          cancelReason: 'Creator did not accept within 72 hours (auto-cancelled)',
          refundProcessed: refunded,
          refundedAt: refunded ? now : null,
          updatedAt: now,
        });
        return 'cancelled';
      });
      if (outcome === 'cancelled') results.cancelled.push(doc.id);
    }

    // 1b. Finalize creator-reject refunds (bookings cancelled by creator with
    // a pending refund intent). Runs as admin; idempotent via refund_{id}.
    const rejectSnap = await db.collection('bookings')
      .where('status', '==', 'Cancelled')
      .where('refundProcessed', '==', false)
      .limit(50)
      .get();

    for (const doc of rejectSnap.docs) {
      // Transaction-guarded: re-check refundProcessed INSIDE the transaction
      // so concurrent/duplicate cron runs can't double-credit the wallet.
      const outcome = await db.runTransaction(async (tx) => {
        const snap = await tx.get(doc.ref);
        if (!snap.exists) return 'skip';
        const b = snap.data() || {};
        if (b.refundProcessed === true) return 'skip';
        // SERVER-TRUTH amount only: paidAmount was written by
        // api/booking-create.js (or the legacy wallet flow). Never use the
        // client-set refundAmount field.
        const amt = Number(b.paidAmount || 0);
        if (!(b.bizId && amt > 0 && !b.barter)) {
          // Nothing refundable — mark processed so we don't loop forever.
          tx.update(doc.ref, { refundProcessed: true, updatedAt: now });
          return 'marked';
        }
        const bizRef = db.collection('businesses').doc(b.bizId);
        const bizSnap = await tx.get(bizRef);
        if (!bizSnap.exists) return 'skip'; // retry next run
        tx.update(bizRef, { walletBalance: FieldValue.increment(amt) });
        const ledgerRef = db.collection('wallet_ledger').doc('refund_' + doc.id);
        tx.set(ledgerRef, {
          bizId: b.bizId, bookingId: doc.id, type: 'refund_creator_reject',
          amount: amt, createdAt: now,
          note: 'Refund: creator declined booking',
        }, { merge: true });
        tx.update(doc.ref, {
          refundProcessed: true, refundStatus: 'completed', refundedAt: now, updatedAt: now,
        });
        return 'refunded';
      });
      if (outcome === 'refunded') results.cancelled.push(doc.id + ':refunded');
    }

    // 2. Auto-approve expired PendingCompletion bookings
    const reviewSnap = await db.collection('bookings')
      .where('status', '==', 'PendingCompletion')
      .where('reviewDeadline', '<', now)
      .limit(50)
      .get();

    for (const doc of reviewSnap.docs) {
      // Transaction-guarded: re-check status/autoApproved INSIDE the txn so
      // a concurrent cron run can't create a duplicate payout request.
      const outcome = await db.runTransaction(async (tx) => {
        const snap = await tx.get(doc.ref);
        if (!snap.exists) return 'skip';
        const b = snap.data() || {};
        if (b.status !== 'PendingCompletion' || b.autoApproved) return 'skip';
        // Payout to creator (95% of creator price, platform keeps rest).
        // Note: actual payout goes through admin queue; mark as approved.
        tx.update(doc.ref, {
          status: 'Completed', autoApproved: true,
          completedAt: now, updatedAt: now,
          payoutStatus: 'pending_admin_release',
          note: 'Auto-approved: brand did not review within 72 hours',
        });
        // Notify admin via payouts queue — deterministic id `payout_{bookingId}`
        // so a retried cron run can never queue a duplicate payout.
        const payoutRef = db.collection('payoutRequests').doc('payout_' + doc.id);
        tx.set(payoutRef, {
          bookingId: doc.id, creatorId: b.creatorId,
          amount: Math.round((b.creatorPrice || 0) * 0.95), // 95% creator share (canonical)
          status: 'pending', createdAt: now,
          note: 'Auto-approved booking payout',
        }, { merge: true });
        return 'approved';
      });
      if (outcome === 'approved') results.approved.push(doc.id);
    }

    return res.status(200).json({ ok: true, ...results });
  } catch (e) {
    return res.status(500).json({ ok: false, err: String(e?.message || e).slice(0, 200) });
  }
}
