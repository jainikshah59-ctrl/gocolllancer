/* Rebook-ID resolution (Item 2, Cycle 16).
 *
 * bookingIds are deterministic: 'collab_' + sha256(fingerprint). That gives
 * idempotency for double-submits, but it means a genuine REBOOK of the same
 * collaboration lands on the SAME doc id as the dead booking. Two hazards:
 *
 *  1. Overwriting a Cancelled doc destroys the cancel audit trail — and it
 *     corrupts the deterministic money ids from the prior lifecycle
 *     (refund_{id}, payout_{id}, killfee_{id}): a later cancel of the rebook
 *     would merge-overwrite the OLD refund ledger row.
 *  2. A Completed doc can never be rebooked (409 forever) — brands could not
 *     rehire a creator for the same collaboration shape.
 *
 * Resolution (server-side, inside the booking txn):
 *  - Non-terminal existing doc (Pending/Active/PendingCompletion/Disputed)
 *    -> 409 DUPLICATE_BOOKING (unchanged idempotency behavior).
 *  - Cancelled doc with refundProcessed !== true -> 409
 *    REBOOK_BLOCKED_PENDING_REFUND (the pending refund must settle first;
 *    fail closed on legacy docs with no flag).
 *  - Terminal doc (Completed, or Cancelled with refundProcessed === true)
 *    -> the rebook gets a NEW suffixed id (collab_{fp}_r2, _r3, ...). The
 *    prior doc is NEVER touched; its snapshot is archived into the new
 *    doc's `previousBookings` trail (bounded), so history is never
 *    destroyed. A suffixed candidate that exists but is non-terminal means
 *    a concurrent duplicate submit -> 409, never a second booking.
 */

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isTerminalForRebook(d) {
  if (!d || typeof d !== 'object') return false;
  if (d.status === 'Completed') return true;
  if (d.status === 'Cancelled' && d.refundProcessed === true) return true;
  return false;
}

function archiveSnapshot(docSnap, trail) {
  const d = docSnap.data() || {};
  trail.push({
    bookingId: docSnap.id,
    status: d.status || null,
    type: d.type || null,
    paidAmount: numOrNull(d.paidAmount),
    platformFee: numOrNull(d.platformFee),
    refundedAmount: numOrNull(d.refundedAmount),
    refundStatus: d.refundStatus || null,
    refundedAt: d.refundedAt || null,
    killFee: numOrNull(d.killFee),
    killFeeQueued: !!d.killFeeQueued,
    statusBeforeCancel: d.statusBeforeCancel || null,
    cancelReason: d.cancelReason || null,
    cancelledAt: d.cancelledAt || null,
    cancelledByBiz: !!d.cancelledByBiz,
    completedAt: d.approvedAt || d.completedAt || null,
    createdAt: d.createdAt || null,
  });
  // Carry forward older archives (bounded so the doc cannot grow forever).
  if (Array.isArray(d.previousBookings)) {
    for (const p of d.previousBookings.slice(0, 8)) trail.push(p);
  }
}

function duplicateBooking(msg) {
  const e = new Error(msg || 'A booking with this fingerprint already exists.');
  e.code = 'DUPLICATE_BOOKING';
  throw e;
}

function blockedPendingRefund() {
  const e = new Error(
    'This booking was cancelled with a pending refund. Wait for the refund to settle before rebooking.'
  );
  e.code = 'REBOOK_BLOCKED_PENDING_REFUND';
  throw e;
}

/* Resolve the doc id for a (re)booking inside an active Firestore txn.
 * Returns { bookingId, previousBookings, rebookOf, rebookAttempt }.
 * Throws DUPLICATE_BOOKING / REBOOK_BLOCKED_PENDING_REFUND. */
export async function resolveRebookId(tx, db, baseId) {
  const bookings = db.collection('bookings');
  const baseSnap = await tx.get(bookings.doc(baseId));
  if (!baseSnap.exists) {
    return { bookingId: baseId, previousBookings: [], rebookOf: null, rebookAttempt: 0 };
  }
  const existing = baseSnap.data() || {};
  if (!isTerminalForRebook(existing)) {
    if (existing.status === 'Cancelled') blockedPendingRefund();
    duplicateBooking();
  }
  const trail = [];
  archiveSnapshot(baseSnap, trail);
  // Find a free suffixed id. A live (non-terminal) candidate means a
  // concurrent duplicate of an in-flight rebook -> 409, never a double booking.
  for (let n = 2; n <= 25; n++) {
    const candId = baseId + '_r' + n;
    const csnap = await tx.get(bookings.doc(candId));
    if (!csnap.exists) {
      return {
        bookingId: candId,
        previousBookings: trail.slice(0, 10),
        rebookOf: baseId,
        rebookAttempt: n,
      };
    }
    const cd = csnap.data() || {};
    if (!isTerminalForRebook(cd)) duplicateBooking();
    archiveSnapshot(csnap, trail);
  }
  duplicateBooking('Too many rebooks for this collaboration. Please contact support.');
}
