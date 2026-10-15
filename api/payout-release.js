/* POST /api/payout-release
 * Admin-only payout release (MONET #9 — Cycle 19).
 *
 * Releasing payouts is no longer Firebase-console-only. An admin marks one
 * or more queued payoutRequests docs as paid; every release is written to
 * the unified ledger (walletTransactions, type 'payout_release') so it is
 * auditable. Sub-Rs.100 'accumulating' payouts are released the same way —
 * the admin passes several payoutIds in one call and the combined total is
 * returned, so small earnings can be paid out together.
 *
 * Statuses flipped: 'pending' | 'accumulating' | 'approved' -> 'paid'.
 * Already-paid / unknown / zero-amount docs are reported in `skipped`,
 * never retried blindly. Ledger doc ids are deterministic
 * (payoutrel_<payoutId>) so a retried call can never double-write.
 *
 * Admin gate: the caller must have an admins/{uid} doc, matching the
 * isAdmin() rule in firestore.rules. Fail closed.
 *
 * Input:  { idToken, action: 'mark_paid', payoutIds: [<docId>, ...],
 *           paymentRef?: '<UTR / bank ref, max 64 chars>' }
 * Output: { ok: true, released: [{id, amount}], skipped: [{id, reason}],
 *           total, count }
 */
import { getAdmin, verifyUid, readBody } from '../lib/firebaseAdmin.js';
import { FieldValue } from 'firebase-admin/firestore';

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

const RELEASABLE = new Set(['pending', 'accumulating', 'approved']);

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  // Light rate limit: mark_paid moves real money.
  try {
    const { rateLimit } = await import('../lib/rateLimit.js');
    if (!rateLimit(req, res, { max: 30, windowMs: 60000, key: 'payout-release' })) return;
  } catch { /* rate limiter must never block the happy path */ }

  let uid;
  let body = {};
  try {
    body = readBody(req);
    uid = await verifyUid(body.idToken || (req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  } catch (e) {
    return json(res, 401, { error: 'auth_required' });
  }

  const action = String(body.action || 'mark_paid');
  if (action !== 'mark_paid') return json(res, 400, { error: 'bad_action' });

  const db = getAdmin().firestore();

  // Admin gate — mirrors firestore.rules isAdmin(): admins/{uid} must exist.
  const adminSnap = await db.collection('admins').doc(uid).get().catch(() => null);
  if (!adminSnap || !adminSnap.exists) return json(res, 403, { error: 'admin_only' });

  const payoutIds = (Array.isArray(body.payoutIds) ? body.payoutIds : [])
    .map((x) => String(x || '').slice(0, 128).trim())
    .filter(Boolean)
    .slice(0, 50);
  if (!payoutIds.length) return json(res, 400, { error: 'missing_payouts' });

  const paymentRef = String(body.paymentRef || '').slice(0, 64).trim() || null;

  try {
    const out = await db.runTransaction(async (tx) => {
      const now = FieldValue.serverTimestamp();
      const released = [];
      const skipped = [];
      let total = 0;

      for (const pid of payoutIds) {
        const ref = db.collection('payoutRequests').doc(pid);
        const snap = await tx.get(ref);
        if (!snap.exists) { skipped.push({ id: pid, reason: 'not_found' }); continue; }
        const p = snap.data() || {};
        if (p.status === 'paid') { skipped.push({ id: pid, reason: 'already_paid' }); continue; }
        if (!RELEASABLE.has(String(p.status))) {
          skipped.push({ id: pid, reason: 'bad_status_' + String(p.status || 'missing') });
          continue;
        }
        const amount = Math.floor(Number(p.amount) || 0);
        if (amount <= 0) { skipped.push({ id: pid, reason: 'zero_amount' }); continue; }

        total += amount;
        tx.update(ref, {
          status: 'paid',
          paidAt: now,
          releasedBy: uid,
          paymentRef,
          updatedAt: now,
        });

        // Unified ledger entry — deterministic id => idempotent on retry.
        tx.set(db.collection('walletTransactions').doc('payoutrel_' + pid), {
          creatorId: p.creatorId || null,
          bizId: p.bizId || null,
          type: 'payout_release',
          amount,
          payoutId: pid,
          bookingId: p.bookingId || null,
          releasedBy: uid,
          paymentRef,
          createdAt: now,
          note: 'Payout released by admin'
            + (String(p.status) === 'accumulating' ? ' (combined accumulating payout)' : ''),
        }, { merge: true });

        released.push({ id: pid, amount });
      }
      return { released, skipped, total };
    });

    return json(res, 200, { ok: true, ...out, count: out.released.length });
  } catch (e) {
    console.error('[payout-release]', String((e && e.message) || e).slice(0, 200));
    const code = e && e.code === 'NOT_FOUND' ? 404 : 500;
    return json(res, code, { error: 'release_failed' });
  }
}
