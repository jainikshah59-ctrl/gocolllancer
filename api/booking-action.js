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
 */
import { getAdmin, verifyUid, readBody } from '../lib/firebaseAdmin.js';
import { FieldValue } from 'firebase-admin/firestore';
import { creatorShare } from '../lib/pricing.js';

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
  if (action !== 'approve') return json(res, 400, { error: 'bad_action' });

  const bookingId = String(body.bookingId || '').slice(0, 128);
  if (!bookingId) return json(res, 400, { error: 'missing_booking' });

  const db = getAdmin().firestore();

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
        await maybeCreditReferral(db, { creatorId: bd.creatorId, bookingId, bookingType: bd.type });
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
