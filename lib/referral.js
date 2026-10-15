/* Shared referral-credit helper (Cycle 17 — referral credit server-side).
 *
 * Client capture (PIXEL, Cycle 16): `?ref=<handle>` at signup is stored in
 * `creators/{newUid}/private/contact` as `referredBy` — the REFERRER'S
 * HANDLE, lowercased. The referral code IS the handle (see
 * connect/creator-connect.js getReferralCode/storeReferral).
 *
 * Server rule: when a referred creator completes their FIRST PAID booking,
 * the referrer earns a Rs.100 credit, queued in `payoutRequests` for admin
 * release — the same queue as escrow/kill-fee payouts (deterministic id
 * `ref_{referredUid}`).
 *
 * Guards:
 *  - handle -> uid resolution via creatorHandles/{handle} (never trusts the
 *    raw string as a uid)
 *  - self-referral denied (referrer uid === referred uid)
 *  - paid bookings only (barter excluded — prevents fake-booking farming;
 *    admin still gatekeeps the actual release)
 *  - idempotent: the deterministic doc id means a second completion finds
 *    the credit already queued and skips — double-credit is impossible,
 *    even across the brand-approve and cron auto-approve paths
 *
 * Call it best-effort AFTER the booking-completion transaction commits
 * (same pattern as the money-moment notifications). Never throws.
 */
import { FieldValue } from 'firebase-admin/firestore';

/* No existing referral constant anywhere in the repo (searched api/, lib/,
 * connect/, index.html 2026-10-15) — Rs.100 set here, Cycle 17. */
export const REFERRAL_CREDIT_AMOUNT = 100;

export async function maybeCreditReferral(db, { creatorId, bookingId, bookingType }) {
  try {
    if (!creatorId || !bookingId) return { credited: false, reason: 'missing_ids' };
    if (bookingType === 'barter') return { credited: false, reason: 'barter_excluded' };

    // 1. Who referred this creator?
    const contactSnap = await db.collection('creators').doc(String(creatorId))
      .collection('private').doc('contact').get().catch(() => null);
    const referredBy = contactSnap && contactSnap.exists
      ? String((contactSnap.data() || {}).referredBy || '').toLowerCase().trim() : '';
    if (!referredBy) return { credited: false, reason: 'not_referred' };

    // 2. Resolve the handle to the referrer's uid.
    const handleSnap = await db.collection('creatorHandles').doc(referredBy).get().catch(() => null);
    const referrerUid = handleSnap && handleSnap.exists
      ? String((handleSnap.data() || {}).creatorId || '') : '';
    if (!referrerUid) return { credited: false, reason: 'bad_referrer_handle' };

    // 3. Self-referral guard.
    if (referrerUid === String(creatorId)) return { credited: false, reason: 'self_referral' };

    // 4. Idempotency: one credit per referred creator, ever.
    const creditRef = db.collection('payoutRequests').doc('ref_' + creatorId);
    const creditSnap = await creditRef.get().catch(() => null);
    if (creditSnap && creditSnap.exists) return { credited: false, reason: 'already_credited' };

    // 5. Queue the credit for admin release + tell the referrer.
    await creditRef.set({
      kind: 'referral_credit',
      bookingId: String(bookingId),
      creatorId: referrerUid,          // the referrer gets paid
      referredCreatorId: String(creatorId),
      amount: REFERRAL_CREDIT_AMOUNT,
      status: 'pending',               // admin releases, like all payouts
      createdAt: FieldValue.serverTimestamp(),
      note: 'Referral credit: a referred creator completed their first paid booking',
    });
    await db.collection('creatorNotifs').add({
      creatorId: referrerUid,
      type: 'referral_credit',
      title: 'Referral credit earned',
      body: 'A creator you referred completed their first booking. Rs.' +
        Number(REFERRAL_CREDIT_AMOUNT).toLocaleString('en-IN') +
        ' has been queued to your payouts.',
      bookingId: String(bookingId),
      read: false,
      createdAt: FieldValue.serverTimestamp(),
    });
    return { credited: true, referrerUid };
  } catch (e) {
    console.error('[referral] maybeCreditReferral', String((e && e.message) || e).slice(0, 160));
    return { credited: false, reason: 'error' };
  }
}
