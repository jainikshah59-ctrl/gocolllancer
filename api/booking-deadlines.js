/* Booking deadline processor (Collabstr 72h model).
 * Called by cron every hour. Processes:
 * 1. Pending bookings past acceptDeadline → auto-cancel + refund brand
 * 1b. Finalize creator-reject refunds (pending refund intents)
 * 2. PendingCompletion bookings past reviewDeadline → auto-approve + payout creator
 * 3. Reconcile paid-but-unbooked Cashfree orders → unclaimed_payments + admin notif
 */
import { getAdmin } from '../lib/firebaseAdmin.js';
import { FieldValue } from 'firebase-admin/firestore';

export default async function handler(req, res) {
  // Auth (C6#1/C7#1): Vercel Cron sends `x-vercel-cron: 1` on scheduled
  // invocations — Vercel guarantees this header is present only on genuine
  // cron runs (it is stripped from external requests), so it authenticates the
  // scheduled path by itself. CRON_SECRET stays MANDATORY (fail closed) for
  // MANUAL invocations (no x-vercel-cron header): `Authorization: Bearer
  // <CRON_SECRET>`, the `x-cron-secret` header, or the `cron_secret` query.
  const vercelCron = String(req.headers['x-vercel-cron'] || '') === '1';
  const secret = process.env.CRON_SECRET;
  const gotAuth = String(req.headers['authorization'] || '');
  const gotHeader = String(req.headers['x-cron-secret'] || '');
  const gotQuery = String((req.query && req.query.cron_secret) || '');
  const okSecret = secret && (gotAuth === 'Bearer ' + secret || gotHeader === secret || gotQuery === secret);
  if (!vercelCron && !okSecret) return res.status(401).json({ ok: false, err: 'unauthorized' });
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
          // Ledger entry — UNIFIED: refunds are written to `walletTransactions`
          // (the collection the brand wallet UI actually reads, ordered by
          // createdAt), in the same shape as other entries
          // { bizId, type:'refund', amount, bookingId, createdAt, note }.
          // Deterministic id `refund_{bookingId}` so a retried cron run can
          // never double-refund (idempotency guard).
          const ledgerRef = db.collection('walletTransactions').doc('refund_' + doc.id);
          tx.set(ledgerRef, {
            bizId: b.bizId, bookingId: doc.id, type: 'refund',
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
        // Unified ledger (see above): the refund lands in `walletTransactions`
        // with type 'refund'. Same deterministic id — the creator client no
        // longer writes any ledger placeholder (rule-denied), so this cron
        // write is the single source of the refund row.
        const ledgerRef = db.collection('walletTransactions').doc('refund_' + doc.id);
        tx.set(ledgerRef, {
          bizId: b.bizId, bookingId: doc.id, type: 'refund',
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

    // 3. Reconcile paid-but-unbooked Cashfree orders (C7#16).
    // api/cashfree-order registers every order in payment_orders/{orderId} with
    // status 'created'. If the brand paid but the tab closed / booking-create
    // never ran, the order stays orphaned: money moved, no booking, nobody
    // notified. This sweep re-checks stale 'created' orders against Cashfree
    // (only those older than 1h, max 20/run), marks PAID ones
    // 'paid_unbooked', and flags them in unclaimed_payments + adminNotifs.
    const reconcile = { checked: 0, flagged: 0, abandoned: 0 };
    const cfAppId = process.env.CASHFREE_APP_ID;
    const cfSecret = process.env.CASHFREE_SECRET_KEY;
    const cfEnv = (process.env.CASHFREE_ENV || 'test').toLowerCase() === 'production' ? 'production' : 'test';
    const cfBase = cfEnv === 'production' ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg';
    if (cfAppId && cfSecret) {
      const staleBefore = new Date(now.getTime() - 3600 * 1000);
      const ordersSnap = await db.collection('payment_orders')
        .where('createdAt', '<', staleBefore)
        .limit(20)
        .get();
      for (const o of ordersSnap.docs) {
        const od = o.data() || {};
        if (od.status !== 'created' || od.bookingId) continue; // already handled
        reconcile.checked++;
        let status = 'unknown';
        try {
          const r = await fetch(cfBase + '/orders/' + encodeURIComponent(o.id), {
            headers: {
              'x-api-version': '2023-08-01',
              'x-client-id': cfAppId,
              'x-client-secret': cfSecret,
            },
          });
          const oj = await r.json().catch(() => ({}));
          status = String(oj.order_status || 'unknown');
        } catch { /* network blip — leave 'created', retry next run */ }
        if (status === 'PAID') {
          // Idempotent flag: deterministic unclaimed doc id, merge:true.
          await db.runTransaction(async (tx) => {
            const cur = await tx.get(o.ref);
            if (!cur.exists || cur.data().status !== 'created' || cur.data().bookingId) return;
            tx.update(o.ref, {
              status: 'paid_unbooked', reconciledAt: now, updatedAt: now,
            });
            tx.set(db.collection('unclaimed_payments').doc('unclaimed_' + o.id), {
              orderId: o.id, bizId: od.uid || null,
              amount: Number(od.amount || 0),
              reason: 'paid_no_booking', cashfreeEnv: cfEnv,
              resolved: false, source: 'cron_reconcile',
              createdAt: FieldValue.serverTimestamp(),
              updatedAt: FieldValue.serverTimestamp(),
            }, { merge: true });
          });
          await db.collection('adminNotifs').add({
            type: 'unclaimed_payment',
            title: 'Paid but unbooked payment',
            body: 'Cashfree order ' + o.id + ' is PAID (' +
              (od.uid || 'unknown brand') + ') but has no booking. Follow up with the brand.',
            orderId: o.id, bizId: od.uid || null,
            resolved: false, createdAt: now,
          });
          reconcile.flagged++;
        } else if (status && status !== 'unknown') {
          // Never paid (ACTIVE/EXPIRED/etc.) — stop scanning it every run.
          await o.ref.update({ status: 'abandoned', reconciledAt: now, updatedAt: now });
          reconcile.abandoned++;
        }
      }
    }
    results.reconcile = reconcile;

    return res.status(200).json({ ok: true, ...results });
  } catch (e) {
    return res.status(500).json({ ok: false, err: String(e?.message || e).slice(0, 200) });
  }
}
