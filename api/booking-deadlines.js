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
 *    profile/contact/tokens, anonymize financial rows (Item 7, Cycle 19;
 *    coverage gaps closed: instagram_tokens, walletDeposits, referralCaps,
 *    savedCreators, booking_messages, reviews + handle TOMBSTONE, Items 5/7;
 *    blocked while money unsettled: wallet balance, pending/accumulating/
 *    APPROVED payouts, Pending/Active/PendingCompletion/DISPUTED bookings,
 *    Item 23).
 */
import { getAdmin } from '../lib/firebaseAdmin.js';
import { FieldValue, FieldPath } from 'firebase-admin/firestore';
import { creatorShare, refundableBookingTotal } from '../lib/pricing.js';

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
        // Item 12: refund the FULL amount the brand paid (paidAmount + upiMdr).
        const amt = refundableBookingTotal(b);
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
          // Item 6 (this report): the auto-cancel IS a full refund to the
          // brand (see header), so stamp the refund outcome explicitly —
          // same shape as the §1b refund path (refundStatus:'completed',
          // refundedAmount = actual refunded sum). When no money moved
          // (barter / amt 0 / brand doc missing) the fields are 'none' / 0,
          // and §1b picks the row up to mark refundProcessed on the same
          // cron run.
          refundProcessed: refunded,
          refundStatus: refunded ? 'completed' : 'none',
          refundedAmount: refunded ? amt : 0,
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
              body: 'The creator did not accept within 72 hours. ₹' +
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
    // booking, the brand is refunded the refundable total (paidAmount +
    // upiMdr, Item 12/24) minus platformFee, and the creator gets 10% of
    // the refundable total as a kill-fee, paid out of the retained
    // platform-fee portion (queued to payoutRequests/killfee_{id}
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
        // Item 12: refund the FULL amount the brand paid (paidAmount + upiMdr).
        const amt = refundableBookingTotal(b);
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
        // booking. Brand refund = refundableTotal - platformFee; creator
        // kill-fee = min(10% of refundableTotal, platformFee) — always
        // within the retained fee portion (fee is 12% of the discounted
        // price, so 10% of the ~112% total ≈ 11.2% of the price < fee;
        // the min() is a guard). refundableTotal = paidAmount + upiMdr.
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
          // Item 25 (paid-time TDS, REVERSIBLE pending Jainik's CA advice on
          // 194J vs 194O): kill-fee FY tracking moved from queue-time to
          // paid-time. The kill_fee payoutRequest carries creatorId, so the
          // payout-release txn in api/booking-action.js counts it when the
          // money is actually released. No queue-time increment here —
          // otherwise the fee would be double-counted.
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
              body: '₹' + Number(outcome.refundToBrand || 0).toLocaleString('en-IN') +
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
              body: 'A brand cancelled an Active booking. ₹' +
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
        // SKIPPED (no junk amount-0 rows). Sub-₹100 shares use the
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
                : 'Auto-approved booking payout — share below the ₹100 payout floor, accumulates with future payouts',
            }, { merge: true });
            payoutCreated = true;
            // Item 25 (paid-time TDS, REVERSIBLE pending Jainik's CA advice on
            // 194J vs 194O): FY tracking moved from queue-time to paid-time.
            // This payoutRequest carries creatorId + amount, so the
            // payout-release txn in api/booking-action.js counts it when the
            // money is actually released. No queue-time increment here —
            // otherwise the share would be double-counted.
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
              ? ' ₹' + Number(outcome.share).toLocaleString('en-IN') + ' has been queued to your payouts'
              : ' Your payout has been queued';
            await db.collection('creatorNotifs').add({
              creatorId: outcome.creatorId, type: 'booking_auto_approved',
              title: 'Booking auto-approved',
              body: 'The brand did not review in time, so the booking was auto-approved.' + shareTxt +
                (outcome.payoutStatus === 'accumulating' ? ' (below the ₹100 floor — it accumulates with your future payouts).' : '.'),
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

    // 3. Reconcile paid-but-unbooked Cashfree orders (C7#16) + orphaned
    // paid_no_registry rows (Item 7).
    // api/cashfree-order registers every order in payment_orders/{orderId} with
    // status 'created'. If the brand paid but the tab closed / booking-create
    // never ran, the order stays orphaned: money moved, no booking, nobody
    // notified. This sweep re-checks stale 'created' orders against Cashfree
    // (only those older than 1h, max 20/run), marks PAID ones
    // 'paid_unbooked', and flags them in unclaimed_payments + adminNotifs.
    // §3b then sweeps paid_no_registry rows (webhook landed but the registry
    // row was missing — money moved, never credited): re-verify PAID,
    // bind/credit the brand wallet when possible, else flag + admin notif.
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
          // Item 28: the transaction is a no-op when another run already
          // flipped the row (guard returns false) — the admin notification
          // must be skipped then, or the same order notifies every run.
          const didFlag = await db.runTransaction(async (tx) => {
            const cur = await tx.get(o.ref);
            if (!cur.exists || cur.data().status !== 'created' || cur.data().bookingId) return false;
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
            return true;
          });
          if (didFlag) {
            await db.collection('adminNotifs').add({
              type: 'unclaimed_payment',
              title: 'Paid but unbooked payment',
              body: 'Cashfree order ' + o.id + ' is PAID (' +
                (od.uid || 'unknown brand') + ') but has no booking. Follow up with the brand.',
              orderId: o.id, bizId: od.uid || null,
              resolved: false, createdAt: now,
            });
            reconcile.flagged++;
          }
        } else if (status && status !== 'unknown') {
          // Never paid (ACTIVE/EXPIRED/etc.) — stop scanning it every run.
          await o.ref.update({ status: 'abandoned', reconciledAt: now, updatedAt: now });
          reconcile.abandoned++;
        }
      }

      // 3b. Sweep paid_no_registry rows (Item 7). The webhook wrote these when
      // PAYMENT_SUCCESS arrived for an order with NO registry row (the order
      // predates the registry or was created out-of-band): status
      // 'paid_no_registry', uid null. Money moved, never credited, and no
      // brand notification was possible. For each row: re-verify PAID against
      // Cashfree (server-truth), try to bind the order to a brand via
      // Cashfree's customer_details.customer_id, and either credit the brand
      // wallet (idempotent, deterministic ledger id) or flag it paid_unbooked
      // + write an admin notification — never silent. Item 1 (this report):
      // PURPOSE-AWARE: a row whose purpose is NOT a booking payment
      // ('pro_subscription', 'wallet_topup', ...) is never wallet-credited;
      // it flips to 'paid_no_registry_pro' / 'paid_no_registry_nonbooking'
      // for admin review + admin notification instead. Each row is swept
      // exactly once: the flip out of 'paid_no_registry' is guarded inside
      // the transaction, so a concurrent/duplicate run cannot double-credit.
      const pnr = { checked: 0, recovered: 0, flagged: 0, purposeReview: 0 };
      try {
        const pnrSnap = await db.collection('payment_orders')
          .where('status', '==', 'paid_no_registry')
          .limit(20)
          .get();
        for (const o of pnrSnap.docs) {
          const od = o.data() || {};
          if (od.status !== 'paid_no_registry' || od.bookingId) continue;
          pnr.checked++;
          let ostatus = 'unknown';
          let custId = null;
          let cfAmt = 0;
          try {
            const r = await fetch(cfBase + '/orders/' + encodeURIComponent(o.id), {
              headers: {
                'x-api-version': '2023-08-01',
                'x-client-id': cfAppId,
                'x-client-secret': cfSecret,
              },
            });
            const oj = await r.json().catch(() => ({}));
            ostatus = String(oj.order_status || 'unknown');
            cfAmt = Number(oj.order_amount || 0);
            const cd = (oj.customer_details && typeof oj.customer_details === 'object')
              ? oj.customer_details : {};
            custId = cd.customer_id ? String(cd.customer_id) : null;
          } catch { /* network blip — leave the row, retry next run */ }
          if (ostatus !== 'PAID') continue;
          const amt = Number(od.amount || cfAmt || 0);
          const bizSnap = custId ? await db.collection('businesses').doc(custId).get() : null;

          // Item 1 (this report): PURPOSE-AWARE recovery. The wallet-credit
          // path below is ONLY valid for genuine booking payments. A
          // paid_no_registry row carrying a non-booking purpose
          // ('pro_subscription', 'wallet_topup', anything else) must NEVER
          // be wallet-credited: a Pro subscription is an entitlement, not
          // wallet money. Mark it distinctly (swept exactly once — the flip
          // out of 'paid_no_registry' is txn-guarded, same as every other
          // path) and flag it for admin review instead.
          const purpose = String(od.purpose || '').trim();
          const isBookingPurpose = !purpose || purpose === 'booking_payment';
          if (!isBookingPurpose) {
            const proOrder = purpose === 'pro_subscription';
            const newStatus = proOrder ? 'paid_no_registry_pro' : 'paid_no_registry_nonbooking';
            // Item 28: only notify when the flip actually happened — a
            // concurrent run may have swept this row first (no-op guard).
            const didFlip = await db.runTransaction(async (tx) => {
              const cur = await tx.get(o.ref);
              if (!cur.exists || cur.data().status !== 'paid_no_registry' || cur.data().bookingId) return false;
              tx.set(o.ref, {
                status: newStatus, reconciledAt: now, updatedAt: now,
              }, { merge: true });
              tx.set(db.collection('unclaimed_payments').doc('unclaimed_' + o.id), {
                orderId: o.id, bizId: custId || null, amount: amt,
                reason: proOrder ? 'paid_pro_no_registry' : 'paid_nonbooking_no_registry',
                purpose, cashfreeEnv: od.cashfreeEnv || cfEnv,
                resolved: false, source: 'cron_reconcile',
                createdAt: FieldValue.serverTimestamp(),
                updatedAt: FieldValue.serverTimestamp(),
              }, { merge: true });
              return true;
            });
            if (!didFlip) continue;
            try {
              await db.collection('adminNotifs').add({
                type: 'unclaimed_payment',
                title: proOrder ? 'Pro payment without registry row — review' : 'Non-booking payment without registry row — review',
                body: 'Cashfree order ' + o.id + ' is PAID (₹' +
                  Number(amt).toLocaleString('en-IN') + ') with purpose "' + purpose +
                  '" but has no registry row. ' +
                  (proOrder
                    ? 'Business Pro must be activated (or refunded) manually — NOT wallet-credited.'
                    : 'Do NOT wallet-credit — resolve manually.'),
                orderId: o.id, bizId: custId || null,
                resolved: false, createdAt: now,
              });
            } catch (e) {
              console.error('[booking-deadlines] adminNotif paid_no_registry_purpose', String(e && e.message || e).slice(0, 160));
            }
            pnr.purposeReview++;
            continue;
          }

          const canCredit = bizSnap && bizSnap.exists && amt > 0 &&
            (!od.purpose || od.purpose === 'booking_payment');
          if (canCredit) {
            // Bind + credit the brand wallet.
            // Item 28: capture whether the transaction actually credited —
            // a concurrent run may have flipped the row first (guard
            // returns false → no-op), and the biz notification must be
            // skipped then, or the brand is notified twice for one credit.
            const didCredit = await db.runTransaction(async (tx) => {
              const cur = await tx.get(o.ref);
              if (!cur.exists || cur.data().status !== 'paid_no_registry' || cur.data().bookingId) return false;
              tx.update(db.collection('businesses').doc(custId), {
                walletBalance: FieldValue.increment(amt),
              });
              tx.set(db.collection('walletTransactions').doc('recover_' + o.id), {
                bizId: custId, orderId: o.id, type: 'deposit', amount: amt,
                cfPaymentId: od.cfPaymentId || null, createdAt: now,
                note: 'Recovered orphaned payment (registry missing) — credited by cron',
              }, { merge: true });
              tx.set(o.ref, {
                status: 'recovered_to_wallet', uid: custId, bizId: custId,
                reconciledAt: now, updatedAt: now,
              }, { merge: true });
              tx.set(db.collection('unclaimed_payments').doc('unclaimed_' + o.id), {
                resolved: true, resolvedAt: now, resolvedVia: 'cron_reconcile',
                updatedAt: now,
              }, { merge: true });
              return true;
            });
            if (didCredit) {
            try {
              await db.collection('bizNotifs').add({
                bizId: custId, type: 'payment_recovered',
                title: 'Recovered payment credited',
                body: 'A Cashfree payment of ₹' + Number(amt).toLocaleString('en-IN') +
                  ' (order ' + o.id + ') that never reached your wallet has been credited.',
                orderId: o.id, read: false, createdAt: FieldValue.serverTimestamp(),
              });
            } catch (e) {
              console.error('[booking-deadlines] bizNotif payment_recovered', String(e && e.message || e).slice(0, 160));
            }
            pnr.recovered++;
            }
          } else {
            // Cannot bind to a brand — flip to paid_unbooked (visible in the
            // brand's recoverable list + admin tooling) and notify admin.
            // Item 28: same no-op guard — skip the admin notification when
            // the transaction wrote nothing (row already flipped).
            const didFlag = await db.runTransaction(async (tx) => {
              const cur = await tx.get(o.ref);
              if (!cur.exists || cur.data().status !== 'paid_no_registry' || cur.data().bookingId) return false;
              tx.set(o.ref, {
                status: 'paid_unbooked', reconciledAt: now, updatedAt: now,
              }, { merge: true });
              tx.set(db.collection('unclaimed_payments').doc('unclaimed_' + o.id), {
                orderId: o.id, bizId: custId || null, amount: amt,
                reason: 'paid_unknown_order', cashfreeEnv: od.cashfreeEnv || cfEnv,
                resolved: false, source: 'cron_reconcile',
                createdAt: FieldValue.serverTimestamp(),
                updatedAt: FieldValue.serverTimestamp(),
              }, { merge: true });
              return true;
            });
            if (didFlag) {
            try {
              await db.collection('adminNotifs').add({
                type: 'unclaimed_payment',
                title: 'Orphaned paid order (registry missing)',
                body: 'Cashfree order ' + o.id + ' is PAID (₹' +
                  Number(amt).toLocaleString('en-IN') + ') ' +
                  (custId ? 'but customer ' + custId + ' has no business profile — match manually.'
                          : 'with no customer binding and no registry row — match manually.'),
                orderId: o.id, bizId: custId || null,
                resolved: false, createdAt: now,
              });
            } catch (e) {
              console.error('[booking-deadlines] adminNotif paid_no_registry', String(e && e.message || e).slice(0, 160));
            }
            pnr.flagged++;
            }
          }
        }
      } catch (e) {
        console.error('[booking-deadlines] paid_no_registry sweep', String(e && e.message || e).slice(0, 160));
      }
      results.paidNoRegistry = pnr;
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

    // 5. DPDP data deletion requests (Item 7, Cycle 19; Items 5/23 — this report).
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
    //   instagram_tokens/{uid}              -> DELETE (Meta long-lived token)
    //   creatorHandles/* (creatorId==uid)    -> TOMBSTONE (keep handle taken,
    //                                            never hard-delete — Item 5g)
    //   bookings (creatorId/bizId==uid)      -> ANONYMIZE (keep amounts/status)
    //   booking_messages (of those bookings)-> DELETE
    //   reviews (creatorId/bizId==uid)       -> ANONYMIZE (keep stars, strip PII)
    //   creatorNotifs (creatorId==uid)       -> DELETE
    //   bizNotifs (bizId==uid)               -> DELETE
    //   walletTransactions (bizId==uid)      -> ANONYMIZE (keep amount/type)
    //   walletDeposits (bizId==uid)          -> ANONYMIZE (keep amount/status)
    //   payoutRequests (creatorId/bizId==uid)-> ANONYMIZE (keep amount/status)
    //   referralCaps/{uid}                  -> DELETE (referrer-side counters)
    //   savedCreators/*/creators/{uid}      -> DELETE (dangling shortlist refs)
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
              .where('status', 'in', ['pending', 'accumulating', 'approved']).limit(1).get(),
            db.collection('bookings')
              .where('creatorId', '==', uid)
              .where('status', 'in', ['Pending', 'Active', 'PendingCompletion', 'Disputed']).limit(1).get(),
          ]);
          const bizData = bizSnap.exists ? (bizSnap.data() || {}) : {};
          if (Number(bizData.walletBalance || 0) > 0) blocked = 'wallet_balance';
          else if (!paySnap.empty) blocked = 'pending_payouts';
          else if (!bookSnap.empty) blocked = 'active_bookings';
          if (!blocked) {
            const bbSnap = await db.collection('bookings')
              .where('bizId', '==', uid)
              .where('status', 'in', ['Pending', 'Active', 'PendingCompletion', 'Disputed']).limit(1).get();
            if (!bbSnap.empty) blocked = 'active_bookings';
          }
          if (!blocked) {
            // Item 10 (this report): pending refund intents are unsettled
            // money. A Cancelled booking whose refund has not settled
            // (refundRequested with refundProcessed !== true, or an
            // explicit refundProcessed:false from §1/§1b pickup) must NOT
            // be anonymized — the §1b refund sweep needs the original
            // bizId/creatorId to credit the wallet / queue the kill-fee;
            // anonymizing first would strand the refund. Settled refunds
            // (refundProcessed:true) are NOT blockers — their preserved
            // refund fields (refundRequested, refundStatus, refundedAmount,
            // refundProcessed) pass this check.
            // Single-field queries only (no composite index needed); the
            // refund-intent filter is applied in code.
            const [rcSnap, rbSnap] = await Promise.all([
              db.collection('bookings').where('creatorId', '==', uid)
                .where('status', '==', 'Cancelled').limit(50).get(),
              db.collection('bookings').where('bizId', '==', uid)
                .where('status', '==', 'Cancelled').limit(50).get(),
            ]);
            const seenRefundDocs = new Set();
            const hasPendingRefund = [...rcSnap.docs, ...rbSnap.docs].some((d) => {
              if (seenRefundDocs.has(d.id)) return false;
              seenRefundDocs.add(d.id);
              const b = d.data() || {};
              // Unsettled = the §1b refund sweep would still act on it
              // (it skips only refundProcessed === true). A settled refund
              // (refundProcessed:true) is NOT pending even if
              // refundRequested is still attached — its preserved fields
              // pass this check.
              return b.refundProcessed !== true &&
                (b.refundRequested === true || b.refundProcessed === false);
            });
            if (hasPendingRefund) blocked = 'pending_refunds';
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
        // Item 9e (Cycle 22, DPDP): Firestore rules cannot delete the
        // Firebase Auth user — rules only govern Firestore data. The Auth
        // identity is erased in step 14 below via the Admin SDK
        // (app.auth().deleteUser(uid)); otherwise the account would stay
        // sign-in-able after its data is gone.
        const BATCH = 400;
        let batch = db.batch();
        let ops = 0;
        const flush = async () => { if (ops > 0) { await batch.commit(); batch = db.batch(); ops = 0; } };
        const del = (ref) => { batch.delete(ref); ops++; };
        const upd = (ref, data) => { batch.update(ref, data); ops++; };
        const tset = (ref, data) => { batch.set(ref, data, { merge: true }); ops++; };
        const maybeFlush = async () => { if (ops >= BATCH) await flush(); };

        // 1. Creator + business profile docs + private contact subcollection
        // + Instagram OAuth tokens (Meta long-lived tokens must not survive
        // "full" deletion — Item 5a).
        del(db.collection('creators').doc(uid));
        del(db.collection('businesses').doc(uid));
        del(db.collection('instagram_tokens').doc(uid));
        try {
          const contactSnap = await db.collection('creators').doc(uid).collection('private').get();
          for (const d of contactSnap.docs) { del(d.ref); await maybeFlush(); }
        } catch (e) {}
        try {
          const bContactSnap = await db.collection('businesses').doc(uid).collection('private').get();
          for (const d of bContactSnap.docs) { del(d.ref); await maybeFlush(); }
        } catch (e) {}

        // 2. Handle reservations — TOMBSTONE, never hard-delete (Item 5g).
        // The doc id IS the handle: keeping a tombstone keeps the handle
        // un-registerable, so nobody can squat/impersonate it after deletion.
        // Handle-availability checks treat ANY existing doc (including
        // tombstoned ones) as taken — there is no such check in this file.
        try {
          const hSnap = await db.collection('creatorHandles').where('creatorId', '==', uid).get();
          for (const d of hSnap.docs) {
            tset(d.ref, {
              creatorId: 'deleted', deleted: true, deletedAt: now,
              deletedPII: true, updatedAt: now,
            });
            await maybeFlush();
          }
        } catch (e) {}

        // 3. Notifications.
        for (const [coll, field] of [['creatorNotifs', 'creatorId'], ['bizNotifs', 'bizId']]) {
          try {
            const nSnap = await db.collection(coll).where(field, '==', uid).limit(200).get();
            for (const d of nSnap.docs) { del(d.ref); await maybeFlush(); }
          } catch (e) {}
        }

        // 4. Bookings — ANONYMIZE (financial rows retained for tax/audit).
        // Collect the booking ids too — §8 deletes their messages.
        // Item 10 (this report): pending refund intent fields
        // (refundRequested, refundStatus, refundedAmount, refundProcessed,
        // and any pending-refund markers) are INTENTIONALLY PRESERVED —
        // this update() merges, so it only touches the PII field and never
        // wipes refund fields. They ride through on the anonymized record;
        // only unsettled intents are blocked earlier at the safety check,
        // so a settled refund's fields never trip it.
        const bookingIds = [];
        for (const field of ['creatorId', 'bizId']) {
          try {
            const bSnap = await db.collection('bookings').where(field, '==', uid).limit(200).get();
            for (const d of bSnap.docs) {
              bookingIds.push(d.ref.id);
              upd(d.ref, {
                [field]: 'deleted',
                deletedPII: true, updatedAt: now,
              });
              await maybeFlush();
            }
          } catch (e) {}
        }

        // 5. Wallet transactions — ANONYMIZE (keep amount/type for ledger).
        // Sweeps BOTH keyings: brand-side rows (bizId) and creator-side rows
        // (creatorId) — the creator-keyed sweep was missing (Item 9 fix).
        for (const field of ['bizId', 'creatorId']) {
          try {
            const wSnap = await db.collection('walletTransactions').where(field, '==', uid).limit(200).get();
            for (const d of wSnap.docs) {
              upd(d.ref, { [field]: 'deleted', note: '[deleted]', deletedPII: true, updatedAt: now });
              await maybeFlush();
            }
          } catch (e) {}
        }

        // 6. Payout requests — ANONYMIZE (keep amount/status for audit).
        // Item 9 fix: payout destination PII (method/upi/holder/account/ifsc/
        // destination) is STRIPPED via FieldValue.delete() — the previous
        // version only blanked the ids and left the VPA/bank details intact.
        const stripPayoutPII = (u, dd) => {
          for (const k of ['method', 'upi', 'holder', 'account', 'ifsc', 'destination']) {
            if (dd[k] !== undefined && dd[k] !== null && dd[k] !== '') u[k] = FieldValue.delete();
          }
          return u;
        };
        try {
          const pSnap = await db.collection('payoutRequests').where('creatorId', '==', uid).limit(200).get();
          for (const d of pSnap.docs) {
            upd(d.ref, stripPayoutPII({
              creatorId: 'deleted', bizId: 'deleted',
              note: '[deleted]', deletedPII: true, updatedAt: now,
            }, d.data() || {}));
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

        // 7. Wallet deposits — ANONYMIZE (financial rows retained for audit).
        // Manual-UPI deposit docs can carry payer PII (payer id / UTR / name);
        // strip those while keeping amount/status for the ledger.
        try {
          const depSnap = await db.collection('walletDeposits').where('bizId', '==', uid).limit(200).get();
          for (const d of depSnap.docs) {
            const dd = d.data() || {};
            const u = { bizId: 'deleted', deletedPII: true, updatedAt: now };
            for (const k of ['payerName', 'payerId', 'upiId', 'upiRef', 'utr', 'payerUtr', 'note', 'email', 'phone', 'name']) {
              if (dd[k] !== undefined && dd[k] !== null) u[k] = FieldValue.delete();
            }
            upd(d.ref, u);
            await maybeFlush();
          }
        } catch (e) {}

        // 8. Booking messages — DELETE (chat for the user's bookings).
        try {
          const seenMsg = new Set();
          for (const bid of bookingIds) {
            if (seenMsg.has(bid)) continue;
            seenMsg.add(bid);
            const mSnap = await db.collection('booking_messages').where('bookingId', '==', bid).limit(200).get();
            for (const d of mSnap.docs) { del(d.ref); await maybeFlush(); }
          }
        } catch (e) {}

        // 9. Reviews — ANONYMIZE (aggregate integrity: keep stars + bookingId;
        // strip PII: ids, brand name, review text).
        for (const field of ['creatorId', 'bizId']) {
          try {
            const rSnap = await db.collection('reviews').where(field, '==', uid).limit(200).get();
            for (const d of rSnap.docs) {
              upd(d.ref, {
                [field]: 'deleted', bizName: 'Deleted', text: '[deleted]',
                deletedPII: true, updatedAt: now,
              });
              await maybeFlush();
            }
          } catch (e) {}
        }

        // 10. Referral caps — DELETE (referrer-side monthly counters).
        try { del(db.collection('referralCaps').doc(uid)); } catch (e) {}

        // 11. Saved-creator shortlists — DELETE dangling references where
        // other users saved this creator (savedCreators/{bizUid}/creators/{uid}).
        try {
          const sSnap = await db.collectionGroup('creators')
            .where(FieldPath.documentId(), '==', uid).get();
          for (const d of sSnap.docs) { del(d.ref); await maybeFlush(); }
        } catch (e) {}

        // 12. Pre-booking question threads — ANONYMIZE the deleter's side
        // (Item 9 fix: previously zero §5 coverage). Thread docs are shared
        // brand<->creator, so only the requesting party's PII is stripped:
        // brand-side (brandId/brandName) or creator-side (creatorId/
        // creatorHandle). The thread itself survives for the other party.
        for (const field of ['brandId', 'creatorId']) {
          try {
            const qSnap = await db.collection('prebooking_questions').where(field, '==', uid).limit(200).get();
            for (const d of qSnap.docs) {
              const u = { [field]: 'deleted', deletedPII: true, updatedAt: now };
              if (field === 'brandId') u.brandName = 'Deleted';
              else u.creatorHandle = 'deleted';
              upd(d.ref, u);
              await maybeFlush();
            }
          } catch (e) {}
        }

        // 13. Payment orders — ANONYMIZE (Item 9 fix: previously zero §5
        // coverage). Docs are keyed by orderId and carry uid (+creatorId on
        // booking orders) and customerEmail. Strip the email, blank the ids;
        // keep amount/purpose/status for the financial audit trail.
        for (const field of ['uid', 'creatorId']) {
          try {
            const oSnap = await db.collection('payment_orders').where(field, '==', uid).limit(200).get();
            for (const d of oSnap.docs) {
              const od = d.data() || {};
              const u = { [field]: 'deleted', deletedPII: true, updatedAt: now };
              if (od.customerEmail !== undefined && od.customerEmail !== null) {
                u.customerEmail = FieldValue.delete();
              }
              upd(d.ref, u);
              await maybeFlush();
            }
          } catch (e) {}
        }

        await flush();

        // 14. Firebase Auth identity — DELETE via Admin SDK (Item 9e).
        // Firestore rules cannot touch the Auth user; without this the
        // account stays sign-in-able after its data is gone. Best-effort:
        // a missing user (already deleted) must not fail the pass.
        try {
          await app.auth().deleteUser(uid);
        } catch (e) {
          console.error('[booking-deadlines] auth deleteUser', String(e && e.message || e).slice(0, 120));
        }

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
