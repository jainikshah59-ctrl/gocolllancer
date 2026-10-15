/* POST /api/booking-action
 * Server-side booking lifecycle actions (Item 15 — escrow auto-release).
 *
 * action 'approve': the brand approves delivered work (PendingCompletion ->
 * Completed). The escrowed amount is released as a creator payout in the SAME
 * transaction: payoutRequests/payout_{bookingId} with the canonical 95% of
 * creatorPrice. Never trusts the client for amounts or ownership.
 *
 * Customer-id hardening (C13): for cashfree bookings, the booking's
 * paymentReference order is re-fetched from Cashfree and its customer_id
 * must match the booking's brand (fail closed — a missing customer binding
 * denies the approve instead of skipping the check).
 *
 * Sub-Rs.100 shares are QUEUED with status 'accumulating' — never dropped,
 * so small creator earnings can be combined with future payouts by admin.
 *
 * Input:  { idToken, action: 'approve', bookingId }
 * Output: { ok: true, bookingId, payoutCreated, share, payoutStatus } on success.
 *
 * action 'notify' (Item 15, Cycle 19): server-owned cross-party booking
 * notifications. Firestore rules forbid a user from creating notifications for
 * the OTHER party (anti-phishing), so state changes made via client-side
 * writes (creator accept, brand revision request, brand dispute, barter
 * request) call this endpoint best-effort afterwards and the server writes
 * the notification via the Admin SDK.
 *
 * Input:  { idToken, action: 'notify', bookingId, kind }
 * kind ∈ 'booking_accepted' | 'revision_requested' | 'dispute_opened' |
 *        'barter_received'
 * The caller must be a party to the booking, and the kind's direction must
 * match the caller's side (brand kinds <- bizId caller, creator kinds <-
 * creatorId caller). Output: { ok: true, kind } on success.
 */
import { getAdmin, verifyUid, readBody } from '../lib/firebaseAdmin.js';
import { FieldValue } from 'firebase-admin/firestore';
import { creatorShare, fyLabel, TDS_THRESHOLD_INR } from '../lib/pricing.js';

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

/* Verify the Cashfree order that funded this booking is bound to the brand.
 * Fail closed: missing customer_id (or any verify failure) denies. */
async function verifyOrderOwner(orderId, bizId) {
  const appId = process.env.CASHFREE_APP_ID;
  const secret = process.env.CASHFREE_SECRET_KEY;
  if (!appId || !secret) return { ok: false, error: 'payment_verify_unavailable' };
  const env = (process.env.CASHFREE_ENV || 'test').toLowerCase() === 'production' ? 'production' : 'test';
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
    if (!cfRes.ok) return { ok: false, error: cfRes.status === 404 ? 'order_not_found' : 'order_verify_failed' };
  } catch {
    return { ok: false, error: 'order_verify_failed' };
  }
  const cust = order.customer_details && order.customer_details.customer_id;
  if (!cust) return { ok: false, error: 'order_not_bound' };
  if (String(cust) !== String(bizId)) return { ok: false, error: 'order_owner_mismatch' };
  return { ok: true };
}

/* Item 19 (Cycle 19, LEDGER): fail-closed payment verification for the
 * paid-but-unbooked recovery path. Cashfree must report the order PAID and
 * customer-bound to the caller — any verify failure denies the recovery. */
async function verifyOrderPaidAndOwned(orderId, bizId) {
  const appId = process.env.CASHFREE_APP_ID;
  const secret = process.env.CASHFREE_SECRET_KEY;
  if (!appId || !secret) return { ok: false, error: 'payment_verify_unavailable' };
  const env = (process.env.CASHFREE_ENV || 'test').toLowerCase() === 'production' ? 'production' : 'test';
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
    if (!cfRes.ok) return { ok: false, error: cfRes.status === 404 ? 'order_not_found' : 'order_verify_failed' };
  } catch {
    return { ok: false, error: 'order_verify_failed' };
  }
  if (order.order_status !== 'PAID') return { ok: false, error: 'order_not_paid', order_status: order.order_status };
  const cust = order.customer_details && order.customer_details.customer_id;
  if (!cust) return { ok: false, error: 'order_not_bound' };
  if (String(cust) !== String(bizId)) return { ok: false, error: 'order_owner_mismatch' };
  return { ok: true, amount: Number(order.order_amount || 0) };
}

/* Item 19 (Cycle 19, LEDGER): list this brand's Cashfree orders that are
 * PAID but never became a booking — the "Payments awaiting recovery" list
 * in the brand wallet. Reads via Admin SDK because clients have no read
 * access to payment_orders (default deny) and must never see other brands'
 * orders. */
async function handleListRecoverable(res, db, uid) {
  try {
    const snap = await db.collection('payment_orders').where('uid', '==', String(uid)).get().catch(() => null);
    const out = [];
    if (snap) snap.forEach(function (doc) {
      const d = doc.data() || {};
      const st = String(d.status || '');
      if ((st === 'paid_unbooked' || st === 'paid_no_booking' || st === 'paid_no_registry')
        && !d.bookingId && (!d.purpose || d.purpose === 'booking')) {
        out.push({
          orderId: doc.id,
          amount: Number(d.amount || 0),
          paidAt: d.updatedAt && d.updatedAt.toMillis ? d.updatedAt.toMillis() : null,
        });
      }
    });
    return json(res, 200, { ok: true, orders: out });
  } catch (e) {
    console.error('[booking-action] list_recoverable', String(e && e.message || e).slice(0, 160));
    return json(res, 500, { error: 'list_failed' });
  }
}

/* Item 19 (Cycle 19, LEDGER): recover one paid-but-unbooked order to the
 * brand's wallet. Server-truth payment check (fail closed) happens BEFORE
 * the transaction: Cashfree must say PAID + customer-bound to the caller.
 * Inside the transaction: re-verify the registry row still has no bookingId
 * and the unclaimed doc is unresolved, then credit
 * businesses/{uid}.walletBalance, write the deterministic ledger entry
 * walletTransactions/recover_{orderId}, flip the registry row to
 * 'recovered_to_wallet', and mark unclaimed_payments/unclaimed_{orderId}
 * resolved. A retried call finds status 'recovered_to_wallet' and returns
 * { ok:true, duplicate:true } — money can never be credited twice. */
async function handleRecoverPayment(res, db, uid, orderId) {
  if (!orderId) return json(res, 400, { error: 'missing_order' });
  const regRef = db.collection('payment_orders').doc(orderId);
  const regSnap = await regRef.get().catch(() => null);
  if (!regSnap || !regSnap.exists) return json(res, 404, { error: 'order_not_found' });
  const reg = regSnap.data() || {};
  if (String(reg.uid) !== String(uid)) return json(res, 403, { error: 'not_your_order' });
  if (reg.bookingId) return json(res, 409, { error: 'already_booked' });
  const st = String(reg.status || '');
  if (st === 'recovered_to_wallet') return json(res, 200, { ok: true, duplicate: true });
  if (st !== 'paid_unbooked' && st !== 'paid_no_booking' && st !== 'paid_no_registry') {
    return json(res, 409, { error: 'not_recoverable', status: st });
  }
  if (reg.purpose && reg.purpose !== 'booking') {
    return json(res, 409, { error: 'wrong_purpose' });
  }
  const amount = Number(reg.amount || 0);
  if (!(amount > 0)) return json(res, 409, { error: 'bad_amount' });

  // Server-truth payment verification (fail closed): Cashfree must report
  // PAID and the order must be customer-bound to this brand. Network I/O
  // stays outside the transaction.
  const v = await verifyOrderPaidAndOwned(orderId, uid);
  if (!v.ok) {
    console.error('[booking-action] recover verify', v.error, orderId.slice(0, 24));
    return json(res, 403, { error: v.error });
  }
  // The recovered amount is our own registry amount (what cashfree-order.js
  // registered); it must agree with Cashfree's order amount within Rs.1 —
  // the same tolerance booking-create uses. Fail closed on mismatch.
  if (Math.abs(Number(v.amount || 0) - amount) > 1) {
    console.error('[booking-action] recover amount mismatch', orderId.slice(0, 24));
    return json(res, 409, { error: 'amount_mismatch' });
  }

  try {
    const out = await db.runTransaction(async (tx) => {
      const rSnap = await tx.get(regRef);
      const r = rSnap.exists ? (rSnap.data() || {}) : {};
      if (r.bookingId) { const e = new Error('already booked'); e.code = 'ALREADY_BOOKED'; throw e; }
      if (String(r.status) === 'recovered_to_wallet') return { duplicate: true, credited: 0 };
      const uncRef = db.collection('unclaimed_payments').doc('unclaimed_' + orderId);
      const uSnap = await tx.get(uncRef);
      if (uSnap.exists && (uSnap.data() || {}).resolved === true) {
        const e = new Error('already resolved'); e.code = 'ALREADY_RESOLVED'; throw e;
      }
      const bizRef = db.collection('businesses').doc(String(uid));
      const bSnap = await tx.get(bizRef);
      if (!bSnap.exists) { const e = new Error('no business'); e.code = 'NO_BIZ'; throw e; }
      tx.update(bizRef, { walletBalance: FieldValue.increment(amount) });
      tx.set(db.collection('walletTransactions').doc('recover_' + orderId), {
        bizId: String(uid), orderId, type: 'recovery_credit', amount,
        createdAt: FieldValue.serverTimestamp(),
        note: 'Recovered paid-but-unbooked Cashfree payment to wallet',
      }, { merge: true });
      tx.set(regRef, {
        status: 'recovered_to_wallet', recoveredAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      if (uSnap.exists) {
        tx.set(uncRef, {
          resolved: true, resolvedVia: 'brand_self_service',
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
      return { duplicate: false, credited: amount };
    });
    return json(res, 200, { ok: true, credited: out.credited, duplicate: !!out.duplicate });
  } catch (e) {
    if (e && e.code === 'ALREADY_BOOKED') return json(res, 409, { error: 'already_booked' });
    if (e && e.code === 'ALREADY_RESOLVED') return json(res, 409, { error: 'already_resolved' });
    if (e && e.code === 'NO_BIZ') return json(res, 404, { error: 'business_not_found' });
    console.error('[booking-action] recover_payment', String(e && e.message || e).slice(0, 200));
    return json(res, 500, { error: 'recover_failed' });
  }
}

/* Item 15 (Cycle 19): server-owned cross-party booking notifications.
 * Client-side state changes (creator accept, brand revision/dispute, barter
 * request) cannot write the other party's notification feed — firestore.rules
 * allow create only for one's own uid (anti-phishing). So the client calls
 * this endpoint best-effort after its own write succeeds, and the server
 * (Admin SDK) writes the notification. Direction is enforced: a brand-side
 * caller can only trigger creator-bound kinds and vice versa. */
const NOTIFY_KINDS = {
  booking_accepted: { to: 'brand', title: 'Booking accepted', body: (b) => 'The creator accepted your booking' + (b.campaignName ? ' "' + String(b.campaignName).slice(0, 80) + '"' : '') + '.' },
  revision_requested: { to: 'creator', title: 'Revision requested', body: (b) => 'The brand requested changes' + (b.campaignName ? ' on "' + String(b.campaignName).slice(0, 80) + '"' : '') + (b.revisionNote ? ': ' + String(b.revisionNote).slice(0, 120) : '.') },
  dispute_opened: { to: 'creator', title: 'Dispute opened', body: (b) => 'The brand opened a dispute' + (b.campaignName ? ' on "' + String(b.campaignName).slice(0, 80) + '"' : '') + '. Our team will review it.' },
  barter_received: { to: 'creator', title: 'New barter request', body: (b) => (b.bizName ? String(b.bizName).slice(0, 80) : 'A brand') + ' sent a barter collaboration request.' },
};

async function handleNotify(req, res, db, uid, body, bookingId) {
  const kind = String(body.kind || '');
  const spec = NOTIFY_KINDS[kind];
  if (!spec) return json(res, 400, { error: 'bad_kind' });

  const snap = await db.collection('bookings').doc(bookingId).get().catch(() => null);
  if (!snap || !snap.exists) return json(res, 404, { error: 'not_found' });
  const b = snap.data() || {};
  const isBrand = String(b.bizId || '') === String(uid);
  const isCreator = String(b.creatorId || '') === String(uid);
  if (!isBrand && !isCreator) return json(res, 403, { error: 'not_your_booking' });
  // Direction enforcement: brand callers may only fire creator-bound kinds.
  if (spec.to === 'creator' && !isBrand) return json(res, 403, { error: 'wrong_side' });
  if (spec.to === 'brand' && !isCreator) return json(res, 403, { error: 'wrong_side' });

  try {
    if (spec.to === 'creator') {
      await db.collection('creatorNotifs').add({
        creatorId: String(b.creatorId), type: kind,
        title: spec.title, body: spec.body(b),
        bookingId, read: false, createdAt: FieldValue.serverTimestamp(),
      });
    } else {
      await db.collection('bizNotifs').add({
        bizId: String(b.bizId), type: kind,
        title: spec.title, body: spec.body(b),
        bookingId, read: false, createdAt: FieldValue.serverTimestamp(),
      });
    }
  } catch (e) {
    console.error('[booking-action] notify', kind, String(e && e.message || e).slice(0, 160));
    return json(res, 500, { error: 'notify_failed' });
  }
  return json(res, 200, { ok: true, kind });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  // Light rate limit: approve is a money-moving action.
  try {
    const { rateLimit } = await import('../lib/rateLimit.js');
    if (!rateLimit(req, res, { max: 30, windowMs: 60000, key: 'booking-action' })) return;
  } catch { /* rate limiter must never block the happy path */ }

  let uid;
  let body = {};
  try {
    body = readBody(req);
    uid = await verifyUid(body.idToken || (req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  } catch (e) {
    return json(res, 401, { error: 'auth_required' });
  }

  const action = String(body.action || '');
  if (action !== 'approve' && action !== 'notify' && action !== 'list_recoverable' && action !== 'recover_payment') {
    return json(res, 400, { error: 'bad_action' });
  }

  const db = getAdmin().firestore();

  /* Item 19 (Cycle 19, LEDGER): brand self-service recovery for
   * paid-but-unbooked orders. These actions work on payment_orders, not
   * bookings — branched before the bookingId requirement below. */
  if (action === 'list_recoverable') {
    return handleListRecoverable(res, db, uid);
  }
  if (action === 'recover_payment') {
    return handleRecoverPayment(res, db, uid, String(body.orderId || '').slice(0, 128));
  }

  const bookingId = String(body.bookingId || '').slice(0, 128);

  /* Item 15 (Cycle 19): cross-party state-change notifications, server-owned.
   * Branched before the approve money path — no payout logic here. */
  if (action === 'notify') {
    if (!bookingId) return json(res, 400, { error: 'missing_booking' });
    return handleNotify(req, res, db, uid, body, bookingId);
  }

  if (!bookingId) return json(res, 400, { error: 'missing_booking' });

  // Customer-id hardening (fail closed) for cashfree-funded bookings: the
  // order that funded this booking must be bound to the brand. Done BEFORE
  // the transaction (network I/O does not belong inside a retried txn).
  {
    const pre = await db.collection('bookings').doc(bookingId).get().catch(() => null);
    if (!pre || !pre.exists) return json(res, 404, { error: 'not_found' });
    const b0 = pre.data() || {};
    if (String(b0.bizId) !== String(uid)) return json(res, 403, { error: 'not_your_booking' });
    if (String(b0.paymentMethod || '') === 'cashfree') {
      const orderId = String(b0.paymentReference || '');
      if (!orderId) return json(res, 403, { error: 'payment_reference_missing' });
      const chk = await verifyOrderOwner(orderId, b0.bizId);
      if (!chk.ok) {
        console.error('[booking-action] order owner check', chk.error, orderId.slice(0, 24));
        return json(res, 403, { error: chk.error });
      }
    }
  }

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
      // Only the owning brand can approve.
      if (String(b.bizId) !== String(uid)) {
        const e = new Error('This booking does not belong to your account.');
        e.code = 'FORBIDDEN';
        throw e;
      }
      if (b.status !== 'PendingCompletion') {
        const e = new Error('This booking is not awaiting review.');
        e.code = 'WRONG_STATUS';
        throw e;
      }

      // Escrow release: escrowStatus flips held -> released; the payout queue
      // doc is the creator-facing release (admin releases the money).
      tx.update(ref, {
        status: 'Completed',
        approvedAt: FieldValue.serverTimestamp(),
        approvedByBiz: true,
        escrowStatus: b.escrowStatus === 'held' ? 'released' : (b.escrowStatus || null),
        payoutStatus: 'pending_admin_release',
        updatedAt: FieldValue.serverTimestamp(),
        seenByBiz: true,
      });

      // Canonical creator share: 95% of creatorPrice (lib/pricing), exactly as
      // the payoutRequests rule demands. Deterministic id payout_{bookingId}
      // so a retried approve can never queue a duplicate payout.
      // Sub-Rs.100 shares are QUEUED with status 'accumulating' — small
      // creator earnings must never vanish; admin combines them with
      // future payouts.
      const share = creatorShare(b.creatorPrice);
      const payoutStatus = share >= 100 ? 'pending' : (share > 0 ? 'accumulating' : 'none');
      let payoutCreated = false;
      if (share > 0 && b.creatorId) {
        const payoutRef = db.collection('payoutRequests').doc('payout_' + bookingId);
        const payoutSnap = await tx.get(payoutRef);
        if (!payoutSnap.exists) {
          tx.set(payoutRef, {
            bookingId, creatorId: b.creatorId, bizId: uid,
            amount: share, status: payoutStatus,
            createdAt: FieldValue.serverTimestamp(),
            note: payoutStatus === 'pending'
              ? 'Booking approved by brand: escrow released'
              : 'Booking approved by brand: escrow released — share below the Rs.100 payout floor, accumulates with future payouts',
          });
          payoutCreated = true;
          // Item 10 (Cycle 19): TDS/194J — track per-creator FY payout
          // totals. Same txn, so the total can never drift from the queue.
          const cRef = db.collection('creators').doc(b.creatorId);
          const cSnap = await tx.get(cRef);
          const cData = cSnap.exists ? (cSnap.data() || {}) : {};
          const fy = fyLabel(new Date());
          const fyTotal = (cData.payoutFY === fy ? Number(cData.payoutFYTotal || 0) : 0) + share;
          tx.set(cRef, {
            payoutFY: fy, payoutFYTotal: fyTotal,
            tdsApplicable: fyTotal >= TDS_THRESHOLD_INR,
          }, { merge: true });
        }
      }
      return { payoutCreated, share, payoutStatus };
    });
    // Item 12 (Cycle 16): the brand approved — the creator's money moment.
    // Tell them the escrow released and what was queued. Best-effort.
    let bd = {};
    try {
      const bSnap = await db.collection('bookings').doc(bookingId).get();
      bd = bSnap.exists ? (bSnap.data() || {}) : {};
      if (bd.creatorId) {
        const shareTxt = Number(out.share || 0) > 0
          ? ' Rs.' + Number(out.share).toLocaleString('en-IN') + ' has been queued to your payouts'
          : ' Your payout has been queued';
        await db.collection('creatorNotifs').add({
          creatorId: bd.creatorId, type: 'booking_approved',
          title: 'Booking approved — payout queued',
          body: 'The brand approved your delivery.' + shareTxt +
            (out.payoutStatus === 'accumulating' ? ' (below the Rs.100 floor — it accumulates with your future payouts).' : '.'),
          bookingId, read: false, createdAt: FieldValue.serverTimestamp(),
        });
      }
    } catch (e) {
      console.error('[booking-action] creatorNotif approve', String(e && e.message || e).slice(0, 160));
    }
    // Referral credit (Cycle 17): a referred creator's first PAID completed
    // booking earns the referrer Rs.100 (lib/referral.js — idempotent via
    // payoutRequests/ref_{creatorId}, so the cron auto-approve path can call
    // it too without double-credit). Best-effort, never blocks the response.
    try {
      if (bd.creatorId) {
        const { maybeCreditReferral } = await import('../lib/referral.js');
        await maybeCreditReferral(db, { creatorId: bd.creatorId, bookingId, bookingType: bd.type, bizId: bd.bizId });
      }
    } catch (e) {
      console.error('[booking-action] referral', String(e && e.message || e).slice(0, 160));
    }
    return json(res, 200, { ok: true, bookingId, ...out });
  } catch (e) {
    if (e && e.code === 'NOT_FOUND') return json(res, 404, { error: 'not_found' });
    if (e && e.code === 'FORBIDDEN') return json(res, 403, { error: 'not_your_booking' });
    if (e && e.code === 'WRONG_STATUS') return json(res, 400, { error: 'wrong_status' });
    console.error('[booking-action]', String(e && e.message || e).slice(0, 200));
    return json(res, 500, { error: 'action_failed' });
  }
}
