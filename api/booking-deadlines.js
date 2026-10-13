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
      const b = doc.data();
      if (b.autoCancelled) continue;
      const batch = db.batch();
      // Refund brand wallet (atomic increment to prevent race conditions).
      // Guard: the business doc must exist before we touch the wallet.
      var refunded = false;
      if (b.bizId && b.paidAmount > 0 && !b.barter) {
        const bizRef = db.collection('businesses').doc(b.bizId);
        const bizSnap = await bizRef.get();
        if (bizSnap.exists) {
          batch.update(bizRef, { walletBalance: FieldValue.increment(b.paidAmount) });
          // Ledger entry — deterministic id `refund_{bookingId}` so a retried
          // cron run can never double-refund (idempotency guard).
          const ledgerRef = db.collection('wallet_ledger').doc('refund_' + doc.id);
          batch.set(ledgerRef, {
            bizId: b.bizId, bookingId: doc.id, type: 'refund_auto_cancel',
            amount: b.paidAmount, createdAt: now,
            note: 'Auto-refund: creator did not accept within 72h',
          }, { merge: true });
          refunded = true;
        }
      }
      batch.update(doc.ref, {
        status: 'Cancelled', autoCancelled: true,
        cancelReason: 'Creator did not accept within 72 hours (auto-cancelled)',
        refundProcessed: refunded,
        refundedAt: refunded ? now : null,
        updatedAt: now,
      });
      await batch.commit();
      results.cancelled.push(doc.id);
    }

    // 1b. Finalize creator-reject refunds (bookings cancelled by creator with
    // a pending refund intent). Runs as admin; idempotent via refund_{id}.
    const rejectSnap = await db.collection('bookings')
      .where('status', '==', 'Cancelled')
      .where('refundProcessed', '==', false)
      .limit(50)
      .get();

    for (const doc of rejectSnap.docs) {
      const b = doc.data();
      const amt = Number(b.refundAmount || b.paidAmount || 0);
      if (!(b.bizId && amt > 0 && !b.barter)) {
        // Nothing refundable — mark processed so we don't loop forever.
        await doc.ref.update({ refundProcessed: true, updatedAt: now });
        continue;
      }
      const bizRef = db.collection('businesses').doc(b.bizId);
      const bizSnap = await bizRef.get();
      if (!bizSnap.exists) continue; // retry next run
      const batch = db.batch();
      batch.update(bizRef, { walletBalance: FieldValue.increment(amt) });
      const ledgerRef = db.collection('wallet_ledger').doc('refund_' + doc.id);
      batch.set(ledgerRef, {
        bizId: b.bizId, bookingId: doc.id, type: 'refund_creator_reject',
        amount: amt, createdAt: now,
        note: 'Refund: creator declined booking',
      }, { merge: true });
      batch.update(doc.ref, {
        refundProcessed: true, refundStatus: 'completed', refundedAt: now, updatedAt: now,
      });
      await batch.commit();
      results.cancelled.push(doc.id + ':refunded');
    }

    // 2. Auto-approve expired PendingCompletion bookings
    const reviewSnap = await db.collection('bookings')
      .where('status', '==', 'PendingCompletion')
      .where('reviewDeadline', '<', now)
      .limit(50)
      .get();

    for (const doc of reviewSnap.docs) {
      const b = doc.data();
      if (b.autoApproved) continue;
      const batch = db.batch();
      // Payout to creator (95% of creator price, platform keeps rest)
      // Note: actual payout goes through admin queue; mark as approved
      batch.update(doc.ref, {
        status: 'Completed', autoApproved: true,
        completedAt: now, updatedAt: now,
        payoutStatus: 'pending_admin_release',
        note: 'Auto-approved: brand did not review within 72 hours',
      });
      // Notify admin via payouts queue
      const payoutRef = db.collection('payoutRequests').doc();
      batch.set(payoutRef, {
        bookingId: doc.id, creatorId: b.creatorId,
        amount: Math.round((b.creatorPrice || 0) * 0.95), // 95% creator share (canonical)
        status: 'pending', createdAt: now,
        note: 'Auto-approved booking payout',
      });
      await batch.commit();
      results.approved.push(doc.id);
    }

    return res.status(200).json({ ok: true, ...results });
  } catch (e) {
    return res.status(500).json({ ok: false, err: String(e?.message || e).slice(0, 200) });
  }
}
