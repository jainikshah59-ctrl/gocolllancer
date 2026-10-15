/* Booking deadline processor (Collabstr 72h model).
 * Called by the Vercel cron daily at 02:00 (Hobby plan: daily only). Processes:
 * 1. GHOSTING PROTECTION: Pending bookings past acceptDeadline (72h after
 *    creation) → auto-cancel + FULL refund to the brand. If the creator
 *    never accepts within 72h, the booking is dead — no brand money may be
 *    held. (Post-acceptance ghosting is handled by the brand cancelling an
 *    Active booking, which keeps the platform fee and pays the creator a
 *    10% kill-fee — see section 1b.)
 * 1b. Finalize creator-reject + brand-cancel refunds (pending refund intents).
 *    Brand-cancelled ACTIVE bookings get a partial refund (paidAmount minus
 *    platformFee) and the creator is queued a 10% kill-fee from the retained
 *    fee portion (payoutRequests/killfee_{bookingId}). Everything else gets a
 *    full refund.
 * 2. PendingCompletion bookings past reviewDeadline → auto-approve + payout creator
 * 3. Reconcile paid-but-unbooked Cashfree orders → unclaimed_payments + admin notif
 * 4. Expire Business Pro subscriptions past their 30-day term.
 * 5. DPDP data deletion requests (deletionRequests, status pending) → erase
 *    profile/contact/tokens, anonymize financial rows (Item 7, Cycle 19).
 */
import { getAdmin } from '../lib/firebaseAdmin.js';
import { FieldValue } from 'firebase-admin/firestore';
import { creatorShare, fyLabel, TDS_THRESHOLD_INR } from '../lib/pricing.js';

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

    // 1. Auto-cancel expired Pending bookings.
    // Composite index bookings(status ASC, acceptDeadline ASC) — declared in
    // firestore.indexes.json; deploy with `firebase deploy --only
    // firestore:indexes`. Until it is deployed this query throws
    // FAILED_PRECONDITION; catch it (like §1b below) so one missing index
    // cannot 500 the entire cron run (no refunds, no auto-approve, no
    // pro-expiry that day).
    let pendingSnap = { docs: [] };
    try {
      pendingSnap = await db.collection('bookings')
        .where('status', '==', 'Pending')
        .where('acceptDeadline', '<', now)
        .limit(50)
        .get();
    } catch (e) {
      console.error('[booking-deadlines] §1 auto-cancel query (index missing?)',
        String((e && e.message) || e).slice(0, 160));
    }

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
        return { cancelled: true, refunded, amt, bizId: b.bizId || null, creatorId: b.creatorId || null };
      });
      if (outcome && outcome.cancelled) {
        results.cancelled.push(doc.id);
        // Item 12 (Cycle 16): money moved without the brand watching — tell
        // them. Best-effort, outside the txn.
        if (outcome.bizId && outcome.refunded) {
          try {
            await db.collection('bizNotifs').add({
              bizId: outcome.bizId, type: 'refund_issued',
              title: 'Booking auto-cancelled — refund issued',
              body: 'The creator did not accept within 72 hours. Rs.' +
                Number(outcome.amt || 0).toLocaleString('en-IN') +
                ' was refunded to your Collancer wallet for booking ' + doc.id + '.',
              bookingId: doc.id, read: false, createdAt: FieldValue.serverTimestamp(),
            });
          } catch (e) {
            console.error('[booking-deadlines] bizNotif auto-cancel', String(e && e.message || e).slice(0, 160));
          }
        }
      }
    }

    // 1b. Finalize creator-reject + brand-cancel refunds (bookings cancelled
    // with a pending refund intent). Runs as admin; idempotent via refund_{id}.
    // KILL-FEE POLICY (Cycle 13+14+15): when the BRAND cancels an ACTIVE
    // booking, the brand is refunded paidAmount - platformFee (Item 24) and
    // the creator gets 10% of paidAmount as a kill-fee, paid out of the
    // retained platform-fee portion (queued to payoutRequests/killfee_{id}
    // for admin release). Active is detected via the client-recorded
    // statusBeforeCancel, with the client-attached refundAmount as backstop.
    // Pending cancels and creator rejects always get a full refund.
    //
    // Two pickup queries (Item 24, Cycle 16): creator-reject writes
    // refundProcessed=false explicitly, but brand cancelBooking() attaches
    // refundRequested/refundAmount/statusBeforeCancel/cancelledByBiz WITHOUT
    // ever writing refundProcessed — so the == false query alone missed
    // every brand-cancelled booking and the escrow sat in limbo. The second
    // query picks up intents by refundRequested. Doc ids are deduped; the
    // txn re-checks refundProcessed === true -> skip, so a doc matching both
    // queries can never double-refund.
    // Composite index bookings(status ASC, refundProcessed ASC) — declared in
    // firestore.indexes.json; deploy with `firebase deploy --only
    // firestore:indexes`. Guarded like the second pickup query below: a
    // missing index must not 500 the entire cron run.
    let rejectSnap = { docs: [] };
    try {
      rejectSnap = await db.collection('bookings')
        .where('status', '==', 'Cancelled')
        .where('refundProcessed', '==', false)
        .limit(50)
        .get();
    } catch (e) {
      console.error('[booking-deadlines] §1b creator-reject query (index missing?)',
        String((e && e.message) || e).slice(0, 160));
    }
    // Composite index bookings(status ASC, refundRequested ASC) — see
    // firestore.indexes.json. Deploy it with:
    //   firebase deploy --only firestore:indexes
    // Until it is deployed this query throws FAILED_PRECONDITION; catch it
    // so the rest of the cron (auto-cancel, auto-approve, reconcile,
    // pro-expiry) keeps running on the legacy query alone.
    let brandCancelSnap = { docs: [] };
    try {
      brandCancelSnap = await db.collection('bookings')
        .where('status', '==', 'Cancelled')
        .where('refundRequested', '==', true)
        .limit(50)
        .get();
    } catch (e) {
      console.error('[booking-deadlines] §1b brand-cancel query (index missing?)',
        String((e && e.message) || e).slice(0, 160));
    }
    const refundDocs = new Map();
    for (const d of rejectSnap.docs) refundDocs.set(d.id, d);
    for (const d of brandCancelSnap.docs) refundDocs.set(d.id, d);

    for (const doc of refundDocs.values()) {
      // Transaction-guarded: re-check refundProcessed INSIDE the transaction
      // so concurrent/duplicate cron runs can't double-credit the wallet.
      const outcome = await db.runTransaction(async (tx) => {
        const snap = await tx.get(doc.ref);
        if (!snap.exists) return 'skip';
        const b = snap.data() || {};
        if (b.refundProcessed === true) return 'skip';
        // SERVER-TRUTH amounts only: paidAmount/platformFee were written by
        // api/booking-create.js (or the legacy wallet flow). Never use the
        // client-set refundAmount field — it is only a hint.
        const amt = Number(b.paidAmount || 0);
        const fee = Number(b.platformFee || 0);
        if (!(b.bizId && amt > 0 && !b.barter)) {
          // Nothing refundable — mark processed so we don't loop forever.
          tx.update(doc.ref, { refundProcessed: true, updatedAt: now });
          return 'marked';
        }
        const bizRef = db.collection('businesses').doc(b.bizId);
        const bizSnap = await tx.get(bizRef);
        if (!bizSnap.exists) return 'skip'; // retry next run

        // Kill-fee decision (Cycle 13+14+15): brand cancelled an Active
        // booking. Brand refund = paidAmount - platformFee; creator kill-fee
        // = min(10% of paidAmount, platformFee) — always within the retained
        // fee portion (fee is 12% of the discounted price, so 10% of the
        // ~112% total ≈ 11.2% of the price < fee; the min() is a guard).
        // Transitional bookings without statusBeforeCancel but with the
        // Active-policy refundAmount attached are treated the same;
        // anything else gets a full refund (fail-safe, brand-favorable).
        const activePolicyRefund = amt - fee;
        const claimsActive =
          b.statusBeforeCancel === 'Active' ||
          (b.cancelledByBiz === true && fee > 0 &&
            Number(b.refundAmount || -1) === activePolicyRefund);
        let refundToBrand = amt;
        let killFee = 0;
        if (b.cancelledByBiz === true && claimsActive && activePolicyRefund >= 0) {
          refundToBrand = activePolicyRefund;
          killFee = Math.min(Math.round(amt * 0.10), fee);
        }

        tx.update(bizRef, { walletBalance: FieldValue.increment(refundToBrand) });
        // Unified ledger (see above): the refund lands in `walletTransactions`
        // with type 'refund'. Same deterministic id — the creator client no
        // longer writes any ledger placeholder (rule-denied), so this cron
        // write is the single source of the refund row.
        const ledgerRef = db.collection('walletTransactions').doc('refund_' + doc.id);
        let refundNote = 'Refund: creator declined booking';
        if (b.cancelledByBiz === true) {
          refundNote = killFee > 0
            ? 'Refund: brand cancelled Active booking (platform fee retained; 10% kill-fee queued to creator)'
            : 'Refund: brand cancelled booking';
        } else if (b.autoCancelled) {
          refundNote = 'Auto-refund: creator did not accept within 72h';
        }
        tx.set(ledgerRef, {
          bizId: b.bizId, bookingId: doc.id, type: 'refund',
          amount: refundToBrand, createdAt: now,
          note: refundNote,
        }, { merge: true });

        // Queue the creator kill-fee for admin release (same payout queue as
        // escrow releases). Deterministic id `killfee_{bookingId}` so a
        // retried cron run can never queue a duplicate.
        if (killFee > 0 && b.creatorId) {
          const killRef = db.collection('payoutRequests').doc('killfee_' + doc.id);
          tx.set(killRef, {
            bookingId: doc.id, creatorId: b.creatorId, bizId: b.bizId,
            kind: 'kill_fee', amount: killFee, status: 'pending',
            createdAt: now,
            note: 'Kill-fee (10% of paid amount): brand cancelled an Active booking',
          }, { merge: true });
          // Item 10 (Cycle 19): kill-fee is creator income — count it toward
          // the FY payout total for TDS tracking.
          const cRef = db.collection('creators').doc(b.creatorId);
          const cSnap = await tx.get(cRef);
          const cData = cSnap.exists ? (cSnap.data() || {}) : {};
          const fy = fyLabel(now);
          const fyTotal = (cData.payoutFY === fy ? Number(cData.payoutFYTotal || 0) : 0) + killFee;
          tx.set(cRef, {
            payoutFY: fy, payoutFYTotal: fyTotal,
            tdsApplicable: fyTotal >= TDS_THRESHOLD_INR,
            updatedAt: now,
          }, { merge: true });
        }

        const bookingPatch = {
          refundProcessed: true, refundStatus: 'completed', refundedAt: now,
          refundedAmount: refundToBrand, updatedAt: now,
        };
        if (killFee > 0) {
          bookingPatch.killFee = killFee;
          bookingPatch.killFeeQueued = true;
        }
        tx.update(doc.ref, bookingPatch);
        return { refunded: true, refundToBrand, killFee, bizId: b.bizId || null, creatorId: b.creatorId || null };
      });
      if (outcome && outcome.refunded) {
        results.cancelled.push(doc.id + ':refunded');
        // Item 12 (Cycle 16): the refund executed while nobody was watching —
        // notify both sides. Best-effort, outside the txn.
        try {
          if (outcome.bizId) {
            await db.collection('bizNotifs').add({
              bizId: outcome.bizId, type: 'refund_issued',
              title: 'Refund issued',
              body: 'Rs.' + Number(outcome.refundToBrand || 0).toLocaleString('en-IN') +
                ' was refunded to your Collancer wallet for booking ' + doc.id + '.',
              bookingId: doc.id, read: false, createdAt: FieldValue.serverTimestamp(),
            });
          }
        } catch (e) {
          console.error('[booking-deadlines] bizNotif §1b', String(e && e.message || e).slice(0, 160));
        }
        try {
          if (outcome.creatorId && outcome.killFee > 0) {
            await db.collection('creatorNotifs').add({
              creatorId: outcome.creatorId, type: 'kill_fee_queued',
              title: 'Kill-fee queued',
              body: 'A brand cancelled an Active booking. Rs.' +
                Number(outcome.killFee).toLocaleString('en-IN') +
                ' kill-fee has been queued to your payouts for booking ' + doc.id + '.',
              bookingId: doc.id, read: false, createdAt: FieldValue.serverTimestamp(),
            });
          }
        } catch (e) {
          console.error('[booking-deadlines] creatorNotif kill-fee', String(e && e.message || e).slice(0, 160));
        }
      }
    }

    // 2. Auto-approve expired PendingCompletion bookings.
    // Composite index bookings(status ASC, reviewDeadline ASC) — declared in
    // firestore.indexes.json; deploy with `firebase deploy --only
    // firestore:indexes`. Guarded like §1/§1b: a missing index must not 500
    // the entire cron run.
    let reviewSnap = { docs: [] };
    try {
      reviewSnap = await db.collection('bookings')
        .where('status', '==', 'PendingCompletion')
        .where('reviewDeadline', '<', now)
        .limit(50)
        .get();
    } catch (e) {
      console.error('[booking-deadlines] §2 auto-approve query (index missing?)',
        String((e && e.message) || e).slice(0, 160));
    }

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
        // Item 3 (Cycle 16): canonical creator share via lib/pricing (95%,
        // exactly as the payoutRequests rule demands). Shares <= 0 are
        // SKIPPED (no junk amount-0 rows). Sub-Rs.100 shares use the
        // 'accumulating' convention from /api/booking-action — small
        // creator earnings must never vanish; admin combines them with
        // future payouts.
        const share = creatorShare(b.creatorPrice);
        const payoutStatus = share >= 100 ? 'pending' : (share > 0 ? 'accumulating' : 'none');
        let payoutCreated = false;
        if (share > 0 && b.creatorId) {
          const payoutRef = db.collection('payoutRequests').doc('payout_' + doc.id);
          const payoutSnap = await tx.get(payoutRef);
          if (!payoutSnap.exists) {
            tx.set(payoutRef, {
              bookingId: doc.id, creatorId: b.creatorId,
              amount: share, status: payoutStatus, createdAt: now,
              note: payoutStatus === 'pending'
                ? 'Auto-approved booking payout'
                : 'Auto-approved booking payout — share below the Rs.100 payout floor, accumulates with future payouts',
            }, { merge: true });
            payoutCreated = true;
            // Item 10 (Cycle 19): TDS/194J — track per-creator FY payout
            // totals. Same txn, so the total can never drift from the queue.
            const cRef = db.collection('creators').doc(b.creatorId);
            const cSnap = await tx.get(cRef);
            const cData = cSnap.exists ? (cSnap.data() || {}) : {};
            const fy = fyLabel(now);
            const fyTotal = (cData.payoutFY === fy ? Number(cData.payoutFYTotal || 0) : 0) + share;
            tx.set(cRef, {
              payoutFY: fy, payoutFYTotal: fyTotal,
              tdsApplicable: fyTotal >= TDS_THRESHOLD_INR,
              updatedAt: now,
            }, { merge: true });
          }
        }
        return { approved: true, payoutCreated, share, payoutStatus, creatorId: b.creatorId || null };
      });
      if (outcome && outcome.approved) {
        results.approved.push(doc.id);
        // Item 12 (Cycle 16): the brand never reviewed, but the creator's
        // money moved — they must be told. Best-effort, outside the txn.
        if (outcome.creatorId) {
          try {
            const shareTxt = Number(outcome.share || 0) > 0
              ? ' Rs.' + Number(outcome.share).toLocaleString('en-IN') + ' has been queued to your payouts'
              : ' Your payout has been queued';
            await db.collection('creatorNotifs').add({
              creatorId: outcome.creatorId, type: 'booking_auto_approved',
              title: 'Booking auto-approved',
              body: 'The brand did not review in time, so the booking was auto-approved.' + shareTxt +
                (outcome.payoutStatus === 'accumulating' ? ' (below the Rs.100 floor — it accumulates with your future payouts).' : '.'),
              bookingId: doc.id, read: false, createdAt: FieldValue.serverTimestamp(),
            });
          } catch (e) {
            console.error('[booking-deadlines] creatorNotif auto-approve', String(e && e.message || e).slice(0, 160));
          }
          // Referral credit (Cycle 17): same first-paid-completion rule as the
          // brand-approve path — idempotent via payoutRequests/ref_{creatorId}.
          try {
            const { maybeCreditReferral } = await import('../lib/referral.js');
            await maybeCreditReferral(db, {
              creatorId: outcome.creatorId, bookingId: doc.id,
              bookingType: (doc.data() || {}).type, bizId: (doc.data() || {}).bizId,
            });
          } catch (e) {
            console.error('[booking-deadlines] referral auto-approve', String(e && e.message || e).slice(0, 160));
          }
        }
      }
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

    // 4. Expire Business Pro subscriptions (Item 13, Cycle 16).
    // The webhook stamps proSubscription{status:'active', expiresAt:+30d} but
    // never flips it back — without this pass Pro would last forever
    // (revenue leak). Expired subs get status 'expired' + proActive false;
    // the server-truth read path (lib/pricing isProActiveBiz) already treats
    // them as inactive. Query is single-field (no composite index needed);
    // expiry is filtered in code.
    const proExpired = [];
    try {
      const proSnap = await db.collection('businesses')
        .where('proSubscription.status', '==', 'active')
        .limit(100)
        .get();
      for (const pdoc of proSnap.docs) {
        const pd = pdoc.data() || {};
        const sub = pd.proSubscription || {};
        const exp = sub.expiresAt;
        const expMs = exp && typeof exp.toMillis === 'function'
          ? exp.toMillis()
          : Date.parse(exp);
        if (expMs && expMs < now.getTime()) {
          await pdoc.ref.update({
            'proSubscription.status': 'expired',
            proActive: false,
            updatedAt: now,
          });
          proExpired.push(pdoc.id);
          try {
            await db.collection('bizNotifs').add({
              bizId: pdoc.id, type: 'pro_expired',
              title: 'Business Pro expired',
              body: 'Your Business Pro subscription has ended. Renew to keep the 5% creator-price discount.',
              read: false, createdAt: FieldValue.serverTimestamp(),
            });
          } catch (e) {
            console.error('[booking-deadlines] bizNotif pro_expired', String(e && e.message || e).slice(0, 160));
          }
        }
      }
    } catch (e) {
      console.error('[booking-deadlines] pro expiry pass', String(e && e.message || e).slice(0, 160));
    }
    results.proExpired = proExpired;

    // 5. DPDP data deletion requests (Item 7, Cycle 19).
    // The ?legal=data-deletion UI queues requests in `deletionRequests`
    // { uid, email, status:'pending', createdAt }. This pass processes them:
    // erase profile/contact/tokens, anonymize financial rows (keep amounts
    // for tax/audit, drop PII). 30-day SLA — runs on the next daily cron
    // after a 24h grace period (accidental requests).
    //
    // Collections touched:
    //   creators/{uid}                       -> DELETE (profile, contact, tokens)
    //   creators/{uid}/private/contact       -> DELETE (subcollection)
    //   businesses/{uid}                    -> DELETE (same uid may be a brand too)
    //   creatorHandles/* (creatorId==uid)    -> DELETE (handle reservation)
    //   bookings (creatorId/bizId==uid)      -> ANONYMIZE (keep amounts/status)
    //   creatorNotifs (creatorId==uid)       -> DELETE
    //   bizNotifs (bizId==uid)               -> DELETE
    //   walletTransactions (bizId==uid)      -> ANONYMIZE (keep amount/type)
    //   payoutRequests (creatorId==uid)      -> ANONYMIZE (keep amount/status)
    //   deletionRequests/{reqId}             -> status:'completed'
    const deletion = { processed: [], skipped: [] };
    try {
      const delSnap = await db.collection('deletionRequests')
        .where('status', '==', 'pending')
        .limit(20)
        .get();
      const graceMs = 24 * 3600 * 1000;
      for (const reqDoc of delSnap.docs) {
        const rq = reqDoc.data() || {};
        const uid = String(rq.uid || '');
        if (!uid) {
          await reqDoc.ref.update({ status: 'invalid', processedAt: now, updatedAt: now });
          deletion.skipped.push(reqDoc.id + ':no-uid');
          continue;
        }
        // 24h grace period from request time.
        const created = rq.createdAt;
        const createdMs = created && typeof created.toMillis === 'function'
          ? created.toMillis() : Date.parse(created);
        if (createdMs && (now.getTime() - createdMs) < graceMs) {
          deletion.skipped.push(reqDoc.id + ':grace-period');
          continue;
        }
        // Safety: never delete a user with unsettled money. Active money
        // (wallet balance, pending payouts, non-terminal bookings) blocks
        // deletion until settled — the UI already warns about this.
        let blocked = '';
        try {
          const [bizSnap, paySnap, bookSnap] = await Promise.all([
            db.collection('businesses').doc(uid).get(),
            db.collection('payoutRequests').where('creatorId', '==', uid)
              .where('status', 'in', ['pending', 'accumulating']).limit(1).get(),
            db.collection('bookings')
              .where('creatorId', '==', uid)
              .where('status', 'in', ['Pending', 'Active', 'PendingCompletion']).limit(1).get(),
          ]);
          const bizData = bizSnap.exists ? (bizSnap.data() || {}) : {};
          if (Number(bizData.walletBalance || 0) > 0) blocked = 'wallet_balance';
          else if (!paySnap.empty) blocked = 'pending_payouts';
          else if (!bookSnap.empty) blocked = 'active_bookings';
          if (!blocked) {
            const bbSnap = await db.collection('bookings')
              .where('bizId', '==', uid)
              .where('status', 'in', ['Pending', 'Active', 'PendingCompletion']).limit(1).get();
            if (!bbSnap.empty) blocked = 'active_bookings';
          }
        } catch (e) {
          // If the safety check itself fails, do NOT delete (fail-closed).
          console.error('[booking-deadlines] deletion safety check', String(e && e.message || e).slice(0, 160));
          deletion.skipped.push(reqDoc.id + ':safety-check-failed');
          continue;
        }
        if (blocked) {
          await reqDoc.ref.update({
            status: 'blocked', blockedReason: blocked, updatedAt: now,
          });
          try {
            await db.collection('adminNotifs').add({
              type: 'deletion_blocked',
              title: 'Data deletion blocked — unsettled money',
              body: 'Deletion request ' + reqDoc.id + ' (uid ' + uid + ') blocked: ' + blocked +
                '. Settle first, then re-queue.',
              uid, resolved: false, createdAt: now,
            });
          } catch (e) {}
          deletion.skipped.push(reqDoc.id + ':blocked-' + blocked);
          continue;
        }

        // Execute deletion in batches (500 writes/batch limit).
        const BATCH = 400;
        let batch = db.batch();
        let ops = 0;
        const flush = async () => { if (ops > 0) { await batch.commit(); batch = db.batch(); ops = 0; } };
        const del = (ref) => { batch.delete(ref); ops++; };
        const upd = (ref, data) => { batch.update(ref, data); ops++; };
        const maybeFlush = async () => { if (ops >= BATCH) await flush(); };

        // 1. Creator + business profile docs + private contact subcollection.
        del(db.collection('creators').doc(uid));
        del(db.collection('businesses').doc(uid));
        try {
          const contactSnap = await db.collection('creators').doc(uid).collection('private').get();
          for (const d of contactSnap.docs) { del(d.ref); await maybeFlush(); }
        } catch (e) {}
        try {
          const bContactSnap = await db.collection('businesses').doc(uid).collection('private').get();
          for (const d of bContactSnap.docs) { del(d.ref); await maybeFlush(); }
        } catch (e) {}

        // 2. Handle reservations.
        try {
          const hSnap = await db.collection('creatorHandles').where('creatorId', '==', uid).get();
          for (const d of hSnap.docs) { del(d.ref); await maybeFlush(); }
        } catch (e) {}

        // 3. Notifications.
        for (const [coll, field] of [['creatorNotifs', 'creatorId'], ['bizNotifs', 'bizId']]) {
          try {
            const nSnap = await db.collection(coll).where(field, '==', uid).limit(200).get();
            for (const d of nSnap.docs) { del(d.ref); await maybeFlush(); }
          } catch (e) {}
        }

        // 4. Bookings — ANONYMIZE (financial rows retained for tax/audit).
        for (const field of ['creatorId', 'bizId']) {
          try {
            const bSnap = await db.collection('bookings').where(field, '==', uid).limit(200).get();
            for (const d of bSnap.docs) {
              upd(d.ref, {
                [field]: 'deleted',
                deletedPII: true, updatedAt: now,
              });
              await maybeFlush();
            }
          } catch (e) {}
        }

        // 5. Wallet transactions — ANONYMIZE (keep amount/type for ledger).
        try {
          const wSnap = await db.collection('walletTransactions').where('bizId', '==', uid).limit(200).get();
          for (const d of wSnap.docs) {
            upd(d.ref, { bizId: 'deleted', note: '[deleted]', deletedPII: true, updatedAt: now });
            await maybeFlush();
          }
        } catch (e) {}

        // 6. Payout requests — ANONYMIZE (keep amount/status for audit).
        try {
          const pSnap = await db.collection('payoutRequests').where('creatorId', '==', uid).limit(200).get();
          for (const d of pSnap.docs) {
            upd(d.ref, {
              creatorId: 'deleted', bizId: 'deleted',
              note: '[deleted]', deletedPII: true, updatedAt: now,
            });
            await maybeFlush();
          }
        } catch (e) {}
        try {
          const pbSnap = await db.collection('payoutRequests').where('bizId', '==', uid).limit(200).get();
          for (const d of pbSnap.docs) {
            upd(d.ref, { bizId: 'deleted', note: '[deleted]', deletedPII: true, updatedAt: now });
            await maybeFlush();
          }
        } catch (e) {}

        await flush();

        // 7. Mark the request completed.
        await reqDoc.ref.update({
          status: 'completed', processedAt: now, updatedAt: now,
          processedBy: 'cron',
        });
        deletion.processed.push(reqDoc.id);
        try {
          await db.collection('adminNotifs').add({
            type: 'deletion_completed',
            title: 'Data deletion completed',
            body: 'Deletion request ' + reqDoc.id + ' (uid ' + uid + ') processed. Profile erased; financial rows anonymized.',
            uid, resolved: false, createdAt: now,
          });
        } catch (e) {}
      }
    } catch (e) {
      console.error('[booking-deadlines] deletion pass', String(e && e.message || e).slice(0, 160));
    }
    results.deletion = deletion;

    return res.status(200).json({ ok: true, ...results });
  } catch (e) {
    return res.status(500).json({ ok: false, err: String(e?.message || e).slice(0, 200) });
  }
}
