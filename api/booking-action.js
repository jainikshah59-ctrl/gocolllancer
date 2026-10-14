/* POST /api/booking-action
 * Server-side booking lifecycle actions (Item 15 — escrow auto-release).
 *
 * action 'approve': the brand approves delivered work (PendingCompletion ->
 * Completed). The escrowed amount is released as a creator payout in the SAME
 * transaction: payoutRequests/payout_{bookingId} with the canonical 95% of
 * creatorPrice. Never trusts the client for amounts or ownership.
 *
 * Input:  { idToken, action: 'approve', bookingId }
 * Output: { ok: true, bookingId, payoutCreated, share } on success.
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

      // Canonical creator share: Math.round(creatorPrice * 0.95), exactly as
      // the payoutRequests rule demands. Deterministic id payout_{bookingId}
      // so a retried approve can never queue a duplicate payout.
      const share = Math.round(Number(b.creatorPrice || 0) * 0.95);
      let payoutCreated = false;
      if (share >= 100 && b.creatorId) {
        const payoutRef = db.collection('payoutRequests').doc('payout_' + bookingId);
        const payoutSnap = await tx.get(payoutRef);
        if (!payoutSnap.exists) {
          tx.set(payoutRef, {
            bookingId, creatorId: b.creatorId, bizId: uid,
            amount: share, status: 'pending',
            createdAt: FieldValue.serverTimestamp(),
            note: 'Booking approved by brand: escrow released',
          });
          payoutCreated = true;
        }
      }
      return { payoutCreated, share };
    });
    return json(res, 200, { ok: true, bookingId, ...out });
  } catch (e) {
    if (e && e.code === 'NOT_FOUND') return json(res, 404, { error: 'not_found' });
    if (e && e.code === 'FORBIDDEN') return json(res, 403, { error: 'not_your_booking' });
    if (e && e.code === 'WRONG_STATUS') return json(res, 400, { error: 'wrong_status' });
    console.error('[booking-action]', String(e && e.message || e).slice(0, 200));
    return json(res, 500, { error: 'action_failed' });
  }
}
