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
 *    raw string as a uid); a handle that resolves to NOTHING (e.g. brand
 *    invite-link ?ref=<bizhandle> dead data, Cycle 21) is dropped as a
 *    credit-bearing referrer — archived to referredBySource (analytics
 *    only) and the referredBy field deleted, so it stops failing silently
 *    on every future booking
 *  - transient lookup failure ≠ missing handle (Item 8, Cycle 19): a
 *    Firestore error during creatorHandles/{handle} resolution returns
 *    status 'lookup_failed' and NEVER deletes/overwrites attribution —
 *    the attribution is kept and the credit is simply denied this run
 *  - self-referral denied (referrer uid === referred uid)
 *  - referrer-is-brand denied (sockpuppet farming guard)
 *  - paid bookings only (barter excluded — prevents fake-booking farming;
 *    admin still gatekeeps the actual release)
 *  - minimum first-booking value: the referred creator's first paid booking
 *    must have paidAmount >= Rs.500 (BREAKER-18 — makes Rs.100 minimum-price
 *    farming loops unprofitable: the attacker spends >= Rs.500 real money to
 *    earn a Rs.100 credit)
 *  - monthly cap: max 20 referral credits per referrer per calendar month
 *    (BREAKER-18 — tracked in `referralCaps/{referrerUid}` as {yYYYYmM: n},
 *    server-only collection; denies with reason 'cap_reached')
 *  - idempotent: the deterministic doc id means a second completion finds
 *    the credit already queued and skips — double-credit is impossible,
 *    even across the brand-approve and cron auto-approve paths. The
 *    idempotency check + cap check + credit write + counter increment run
 *    inside one transaction, so concurrent completions cannot double-count.
 *
 * Call it best-effort AFTER the booking-completion transaction commits
 * (same pattern as the money-moment notifications). Never throws.
 */
import { FieldValue } from 'firebase-admin/firestore';

/* No existing referral constant anywhere in the repo (searched api/, lib/,
 * connect/, index.html 2026-10-15) — Rs.100 set here, Cycle 17. */
export const REFERRAL_CREDIT_AMOUNT = 100;

/* BREAKER-18: anti-farming caps. */
export const REFERRAL_MAX_CREDITS_PER_MONTH = 20;   // per referrer, calendar month
export const REFERRAL_MIN_FIRST_BOOKING_AMOUNT = 500; // Rs. paidAmount on the first paid booking

/* Calendar-month counter key, e.g. 'y2026m10'. UTC so all servers agree. */
function currentMonthKey() {
  const d = new Date();
  return 'y' + d.getUTCFullYear() + 'm' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

export async function maybeCreditReferral(db, { creatorId, bookingId, bookingType, bizId }) {
  try {
    if (!creatorId || !bookingId) return { credited: false, reason: 'missing_ids' };
    if (bookingType === 'barter') return { credited: false, reason: 'barter_excluded' };

    // 1. Who referred this creator?
    const contactRef = db.collection('creators').doc(String(creatorId))
      .collection('private').doc('contact');
    const contactSnap = await contactRef.get().catch(() => null);
    const referredBy = contactSnap && contactSnap.exists
      ? String((contactSnap.data() || {}).referredBy || '').toLowerCase().trim() : '';
    if (!referredBy) return { credited: false, reason: 'not_referred' };

    // 2. Resolve the handle to the referrer's uid.
    // Item 8 (Cycle 19): distinguish a TRANSIENT lookup failure from a
    // definitively-absent handle. The old `.catch(() => null)` pattern
    // made a network blip look identical to a missing document — and the
    // dead-handle cleanup below then DELETED valid referredBy
    // attribution. Fail closed: on 'lookup_failed' the existing
    // attribution is left untouched and the credit is denied this run (a
    // later run retries once the lookup succeeds). Only a confirmed
    // 'not_found' runs the dead-data cleanup.
    let handleSnap = null;
    let handleLookupFailed = false;
    try {
      handleSnap = await db.collection('creatorHandles').doc(referredBy).get();
    } catch (e) {
      handleLookupFailed = true;
    }
    if (handleLookupFailed || !handleSnap) {
      return { credited: false, reason: 'lookup_failed' };
    }
    const referrerUid = handleSnap.exists
      ? String((handleSnap.data() || {}).creatorId || '') : '';
    if (!referrerUid) {
      // Cycle 21 (dead-referrer cleanup): the stored referredBy handle
      // resolves to no creator — this is the brand-invite-link dead data
      // (?ref=<bizhandle>, written by storeReferral before this guard
      // existed). There is no brand referral program, so the handle can
      // never earn a credit. Drop it as a credit-bearing referrer: archive
      // to referredBySource (analytics only) and delete the field, so it
      // stops resolving to nothing on every booking. Admin SDK bypasses
      // the client-side first-write-wins immutability (Item 19) — the
      // owner can never do this themselves. Creator ?ref=<handle> flow
      // is untouched: valid handles resolve and return before this line.
      try {
        await contactRef.update({
          referredBy: FieldValue.delete(),
          referredBySource: referredBy, // analytics only, never credit-bearing
          referredByClearedAt: FieldValue.serverTimestamp(),
          referredByClearReason: 'bad_referrer_handle',
          updatedAt: FieldValue.serverTimestamp(),
        });
      } catch { /* best-effort cleanup; the deny below stands regardless */ }
      return { credited: false, reason: 'not_found' };
    }

    // 3. Self-referral guard.
    if (referrerUid === String(creatorId)) return { credited: false, reason: 'self_referral' };

    // 3b. Sockpuppet farming guard (SENTINEL-S2): the referrer must not be the
    // paying brand on this booking. Otherwise A refers B, A-as-brand books B
    // for Rs.100, and pockets Rs.195 in liabilities on Rs.112 revenue.
    // FAIL-CLOSED (Item 18, Cycle 19): bizId MUST be present to evaluate
    // this guard. A missing bizId means we cannot verify the referrer is
    // not the paying brand — deny the credit instead of silently skipping
    // the check. Both callers (booking-action brand-approve, booking-deadlines
    // cron auto-approve) pass bizId from the booking doc; a booking without
    // bizId is malformed and must never earn a referral credit.
    if (!bizId) return { credited: false, reason: 'missing_biz_id' };
    if (String(bizId) === referrerUid) return { credited: false, reason: 'referrer_is_brand' };

    // 4. Idempotency (fast path): one credit per referred creator, ever.
    // Re-checked inside the transaction below for atomicity.
    const creditRef = db.collection('payoutRequests').doc('ref_' + creatorId);
    const creditSnap = await creditRef.get().catch(() => null);
    if (creditSnap && creditSnap.exists) return { credited: false, reason: 'already_credited' };

    // 4b. Minimum first-booking value (BREAKER-18): the referred creator's
    // first paid booking must carry real money. paidAmount is the brand's
    // total (creator price + 12% fee, after Pro discount) — server-truth.
    const bookingSnap = await db.collection('bookings').doc(String(bookingId)).get().catch(() => null);
    const paidAmount = bookingSnap && bookingSnap.exists
      ? Number((bookingSnap.data() || {}).paidAmount || 0) : 0;
    if (!(paidAmount >= REFERRAL_MIN_FIRST_BOOKING_AMOUNT)) {
      return { credited: false, reason: 'below_minimum_amount' };
    }

    // 5. Atomic: re-check idempotency + monthly cap, then write the credit
    // and bump the referrer's monthly counter. The transaction returns its
    // own verdict instead of throwing, so Firestore never pointlessly
    // retries a deliberate denial.
    const capRef = db.collection('referralCaps').doc(referrerUid);
    const monthKey = currentMonthKey();
    const verdict = await db.runTransaction(async (tx) => {
      const cSnap = await tx.get(creditRef);
      if (cSnap.exists) return { ok: false, reason: 'already_credited' };
      const capSnap = await tx.get(capRef);
      const capData = capSnap.exists ? (capSnap.data() || {}) : {};
      const used = Number(capData[monthKey] || 0);
      if (used >= REFERRAL_MAX_CREDITS_PER_MONTH) return { ok: false, reason: 'cap_reached' };
      tx.set(creditRef, {
        kind: 'referral_credit',
        bookingId: String(bookingId),
        creatorId: referrerUid,          // the referrer gets paid
        referredCreatorId: String(creatorId),
        amount: REFERRAL_CREDIT_AMOUNT,
        status: 'pending',               // admin releases, like all payouts
        createdAt: FieldValue.serverTimestamp(),
        note: 'Referral credit: a referred creator completed their first paid booking',
      });
      const next = {};
      next[monthKey] = used + 1;
      next.updatedAt = FieldValue.serverTimestamp();
      tx.set(capRef, next, { merge: true });
      return { ok: true };
    });
    if (!verdict.ok) return { credited: false, reason: verdict.reason };

    // 6. Tell the referrer (best-effort, outside the transaction).
    await db.collection('creatorNotifs').add({
      creatorId: referrerUid,
      type: 'referral_credit',
      title: 'Referral credit earned',
      body: 'A creator you referred completed their first booking. ₹' +
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
