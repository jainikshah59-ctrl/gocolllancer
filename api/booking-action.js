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
 * Sub-₹100 shares are QUEUED with status 'accumulating' — never dropped,
 * so small creator earnings can be combined with future payouts by admin.
 *
 * Input:  { idToken, action: 'approve', bookingId }
 * Output: { ok: true, bookingId, payoutCreated, share, payoutStatus } on success.
 *
 * action 'payout-release' (Item 36): merged from api/payout-release.js
 * (deleted — api/ was at the 12-file Vercel limit). ADMIN-ONLY release of
 * queued payouts; external request/response contract is IDENTICAL to the
 * old endpoint so an admin UI can call this route directly:
 *
 * Input:  { idToken, action: 'payout-release', payoutIds: [<docId>, ...],
 *           paymentRef?: '<UTR / bank ref, max 64 chars>' }
 * Output: { ok: true, released: [{id, amount}], skipped: [{id, reason}],
 *           total, count }
 *
 * Statuses flipped: 'pending' | 'accumulating' | 'approved' -> 'paid'.
 * Already-paid / unknown / zero-amount docs are reported in `skipped`.
 * Ledger doc ids are deterministic (payoutrel_<payoutId>) — retries never
 * double-write. Admin gate: the caller must have an admins/{uid} doc
 * (mirrors firestore.rules isAdmin()). Fail closed.
 *
 * Item 33: the released creator is notified via creatorNotifs
 * (payoutnotif_<payoutId>, same transaction — no drift, no duplicates).
 *
 * Item 10: a payout can only be released if its booking is in a
 * terminal-approved state — status 'Completed' for normal escrow releases,
 * or status 'Cancelled' for kill_fee payouts. Anything else is skipped
 * (reason 'booking_not_completed') — money never leaves on a live booking.
 *
 * Item 25: TDS/194J tracking now happens HERE, at paid-time (when the admin
 * actually releases the money), not at queue-time. See the paid-time
 * tracking block below for the reversibility note.
 *
 * action 'payout-queue' (Items 14, 17): ADMIN queue listing for the Founder
 * Dashboard. Each row carries the payout destination MASKED (raj***@upi);
 * the full VPA is never returned here. The response also carries the FY
 * rollup: the sum of released payouts for the current Asia/Kolkata
 * April-March FY, plus the tdsTracked total with the TDS copy marker the
 * UI renders verbatim ("TDS tracked, not yet deducted — pending CA advice"
 * — copy only, no deduction logic). Input: { idToken,
 * action: 'payout-queue', limit? }. Output: { ok, payouts, count, fy }.
 *
 * action 'payout-detail' (Item 12): ADMIN single-payout confirmation path —
 * returns the FULL payout destination/VPA (the queue listing deliberately
 * stays masked). This is the data path the release confirmation step reads
 * before the admin hits Release. Input: { idToken, action: 'payout-detail',
 * payoutId }. Output: { ok, payout: { ..., destination (full) } }.
 *
 * action 'payout-reject' | 'payout-hold' (Item 19): ADMIN reject / hold for
 * the payout queue. Sets status 'rejected'/'held' with a reason string, a
 * server timestamp, and the admin uid. Batch-safe ({ updated, skipped }).
 * Input: { idToken, action, payoutIds: [...], reason }. Held/rejected
 * payouts are not releasable (RELEASABLE covers only pending/accumulating/
 * approved); a separate unhold path is NOT part of this item.
 *
 * payout-release extras: Item 16 — optional `utr` (light format check, max
 * 64 chars) stored on the payout record + ledger; Item 18 — the batch
 * release is built on the shared single-release helper (releaseSinglePayout);
 * Item 13 — malformed ids are skipped with reason 'malformed_id', over-50
 * batches are truncated AND reported (truncated:true, requested:N) — never
 * silent, and a bad id never 500s the batch.
 *
 * action 'payout-last-destination' (Item 30): creator-scoped — returns the
 * most recent payoutRequest's destination for the CALLER, for prefilling
 * their payout settings form. No admin gate; the caller can only see their
 * own payouts.
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
import { creatorShare, fyLabel, fyKey, TDS_THRESHOLD_INR } from '../lib/pricing.js';

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
        && !d.bookingId && (!d.purpose || d.purpose === 'booking_payment')) {
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
  // Item 6: canonical purpose is 'booking_payment' (the value normalizePurpose
  // registers in api/cashfree-order.js). Matching any other string ('booking')
  // would 409 genuine paid-but-unbooked recovery orders.
  if (reg.purpose && reg.purpose !== 'booking_payment') {
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
  // registered); it must agree with Cashfree's order amount within ₹1 —
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

  /* BACKEND-B (Cycle 19): the server-verified barter notification path.
   * Barter bookings are written client-side (collab_<fingerprint32>) and
   * bypass all 3 money endpoints, so the booking doc must be verified
   * server-side: it must exist (checked above), be a barter doc, and still
   * be Pending. Deterministic doc id barternotif_<bookingId> makes a
   * retried client call idempotent — the creator is never double-notified.
   * (A separate booking-create.js 'barter mode' was considered and
   * rejected: nothing calls booking-create for barter — the client writes
   * the doc directly — so a second server path would be dead code on a
   * money-critical endpoint. This is the wired path.) */
  if (kind === 'barter_received') {
    if (String(b.type || '') !== 'barter') return json(res, 409, { error: 'not_barter_booking' });
    if (String(b.status || '') !== 'Pending') return json(res, 409, { error: 'not_pending' });
    const nref = db.collection('creatorNotifs').doc('barternotif_' + bookingId);
    try {
      const ex = await nref.get().catch(() => null);
      if (ex && ex.exists) return json(res, 200, { ok: true, kind, duplicate: true });
      await nref.set({
        creatorId: String(b.creatorId), type: kind,
        title: spec.title, body: spec.body(b),
        bookingId, read: false, createdAt: FieldValue.serverTimestamp(),
      });
    } catch (e) {
      console.error('[booking-action] notify', kind, String(e && e.message || e).slice(0, 160));
      return json(res, 500, { error: 'notify_failed' });
    }
    return json(res, 200, { ok: true, kind });
  }

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

/* Item 36 — ADMIN-ONLY payout release, merged from api/payout-release.js
 * (the old file is deleted; this route keeps its request/response contract
 * IDENTICAL). Releasing payouts is no longer Firebase-console-only: an admin
 * marks queued payoutRequests docs as paid; every release is written to the
 * unified ledger (walletTransactions, type 'payout_release') so it is
 * auditable. Sub-₹100 'accumulating' payouts are released the same way —
 * the admin passes several payoutIds in one call and the combined total is
 * returned, so small earnings can be paid out together.
 *
 * Item 10: a payout can only be released when its booking is in a
 * terminal-approved state — status 'Completed' for normal escrow releases,
 * or status 'Cancelled' for 'kill_fee' payouts. Any other booking state
 * (or a missing booking) skips the payout (reason 'booking_not_completed')
 * — money never leaves on a live booking.
 *
 * Item 25 (TDS paid-time semantics): per-creator FY payout tracking is
 * written HERE, at paid-time — when the admin actually releases the money —
 * NOT at queue-time (the old approve-time tracking was removed). TRACKING
 * ONLY — TDS is NOT deducted: whether 194J or 194O applies needs a WRITTEN
 * CA opinion first (see fyKey in lib/pricing.js). This is REVERSIBLE: if the
 * CA's written advice says queue-time tracking is required instead, move
 * this block back into the approve txn above. Same txn as the status flip,
 * so tracking and released money can never drift apart.
 */
const RELEASABLE = new Set(['pending', 'accumulating', 'approved']);

/* ---- Items 12/13/14/16/17/18/19/30 payout-queue helpers. Everything lives
 * in THIS file: api/ is at the Vercel 12-file limit — NO new files. ---- */

/* Admin gate — mirrors firestore.rules isAdmin(): admins/{uid} must exist. */
async function requireAdmin(db, uid) {
  const s = await db.collection('admins').doc(String(uid)).get().catch(() => null);
  return !!(s && s.exists);
}

/* Item 13: payout doc ids are Firestore-safe slugs (letters, digits,
 * underscore, dash, max 64 chars). Anything else is skipped as malformed —
 * a bad id can never 500 the batch. */
const PAYOUT_ID_RE = /^[A-Za-z0-9_\-]{1,64}$/;

/* Item 13: sanitize a batch of payout ids — dedupe (the same id twice in
 * one batch must not double-release), skip malformed ids with a reason,
 * and report over-limit truncation instead of silently dropping ids. */
function sanitizePayoutIds(raw) {
  const arr = Array.isArray(raw) ? raw : [];
  const ids = [];
  const skipped = [];
  for (const x of arr) {
    const s = String(x || '').trim();
    if (!PAYOUT_ID_RE.test(s)) {
      skipped.push({ id: s.slice(0, 64), reason: 'malformed_id' });
      continue;
    }
    if (ids.indexOf(s) === -1) ids.push(s);
  }
  const MAX_BATCH = 50;
  const truncated = ids.length > MAX_BATCH;
  return { ids: ids.slice(0, MAX_BATCH), skipped, truncated, requested: arr.length };
}

/* Item 14: mask a UPI VPA for queue-card display — keep the first 3 chars of
 * the handle plus the full domain: 'rajkumar@okhdfc' -> 'raj***@okhdfc'.
 * The FULL value is returned ONLY by the admin payout-detail path
 * (Item 12); the queue listing never carries it. */
function maskVpa(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  const at = s.indexOf('@');
  if (at <= 0) return s.slice(0, 2) + '***';
  return s.slice(0, Math.min(3, at)) + '***@' + s.slice(at + 1);
}

/* Item 17: FY boundaries are April–March in Asia/Kolkata. Vercel runs on
 * UTC, so resolve the IST calendar date via Intl — never server-local Date
 * (which would flip the FY up to 5.5h early/late at the boundary). */
function istParts(d) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d instanceof Date ? d : new Date(d));
  const o = {};
  for (const p of parts) o[p.type] = p.value;
  return { y: Number(o.year), m: Number(o.month) }; // m: 1-indexed
}
function fyKeyIST(d) { const { y, m } = istParts(d); return 'fy' + (m >= 4 ? y : y - 1); }
function fyLabelIST(d) { const { y, m } = istParts(d); return m >= 4 ? y + '-' + String(y + 1).slice(2) : (y - 1) + '-' + String(y).slice(2); }

/* Item 17: the exact copy the UI renders next to the TDS-tracked total.
 * Copy only — no deduction logic anywhere. */
const TDS_NOTE = 'TDS tracked, not yet deducted — pending CA advice';

/* Item 18: the SINGLE-payout release logic — shared by the batch loop below
 * (and any future single-release path). Runs inside the caller's Firestore
 * transaction; pushes into ctx.released / ctx.skipped. A bad payout doc is
 * SKIPPED, never thrown — one bad item can never abort the batch (#13).
 * The Item 10 booking-terminal-state check and the Item 25 paid-time TDS
 * accumulation live here so both stay in lockstep with the status flip. */
async function releaseSinglePayout(tx, db, pid, ctx) {
  const ref = db.collection('payoutRequests').doc(pid);
  const snap = await tx.get(ref);
  if (!snap.exists) { ctx.skipped.push({ id: pid, reason: 'not_found' }); return; }
  const p = snap.data() || {};
  if (p.status === 'paid') { ctx.skipped.push({ id: pid, reason: 'already_paid' }); return; }
  if (!RELEASABLE.has(String(p.status))) {
    ctx.skipped.push({ id: pid, reason: 'bad_status_' + String(p.status || 'missing') });
    return;
  }
  const amount = Math.floor(Number(p.amount) || 0);
  if (amount <= 0) { ctx.skipped.push({ id: pid, reason: 'zero_amount' }); return; }

  // Item 10: the linked booking must be terminal-approved before any
  // money is released. Normal escrow payouts need 'Completed';
  // 'kill_fee' payouts need 'Cancelled' (kill-fees are queued when the
  // brand cancels an Active booking). Missing booking ref = fail
  // closed — skip, never release blind.
  let bookingOk = false;
  if (p.bookingId) {
    const bSnap = await tx.get(db.collection('bookings').doc(String(p.bookingId)));
    if (bSnap.exists) {
      const bst = String((bSnap.data() || {}).status || '');
      bookingOk = bst === 'Completed'
        || (String(p.kind || '') === 'kill_fee' && bst === 'Cancelled');
    }
  }
  if (!bookingOk) { ctx.skipped.push({ id: pid, reason: 'booking_not_completed' }); return; }

  ctx.total += amount;
  const now = ctx.now;
  tx.update(ref, {
    status: 'paid',
    paidAt: now,
    releasedBy: ctx.uid,
    paymentRef: ctx.paymentRef,
    utr: ctx.utr, /* Item 16: optional UTR stored on the payout record */
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
    releasedBy: ctx.uid,
    paymentRef: ctx.paymentRef,
    utr: ctx.utr, /* Item 16: auditable on the ledger too */
    createdAt: now,
    note: 'Payout released by admin'
      + (String(p.status) === 'accumulating' ? ' (combined accumulating payout)' : ''),
  }, { merge: true });

  ctx.released.push({ id: pid, amount });
  /* Item 33 (Cycle 19): the creator is notified that their payout was
   * released — written in the SAME transaction as the status flip, so
   * the notification can never drift from the money. Deterministic id
   * payoutnotif_<pid> makes a retried release idempotent: the creator
   * is never double-notified. */
  if (p.creatorId) {
    tx.set(db.collection('creatorNotifs').doc('payoutnotif_' + pid), {
      creatorId: String(p.creatorId), type: 'payout_released',
      title: 'Payout released',
      body: '₹' + amount.toLocaleString('en-IN')
        + ' from your Collancer payout has been released'
        + (ctx.utr ? ' (UTR: ' + ctx.utr + ')'
          : (ctx.paymentRef ? ' (ref: ' + ctx.paymentRef + ')' : '')) + '.',
      bookingId: p.bookingId || null, payoutId: pid, amount,
      read: false, createdAt: now,
    }, { merge: true });
  }
  // Item 25: accumulate paid-time totals per creator for the TDS
  // tracking write after the loop (same txn).
  if (p.creatorId) {
    const cid = String(p.creatorId);
    ctx.tdsByCreator.set(cid, (ctx.tdsByCreator.get(cid) || 0) + amount);
  }
}

async function handlePayoutRelease(res, db, uid, body) {
  if (!(await requireAdmin(db, uid))) return json(res, 403, { error: 'admin_only' });

  // Item 13: malformed ids are skipped (reason 'malformed_id'); over-50
  // batches are truncated AND reported (truncated:true, requested:N) —
  // truncation is never silent, and a bad id never aborts the batch.
  const { ids: payoutIds, skipped: malformed, truncated, requested } = sanitizePayoutIds(body.payoutIds);
  if (!payoutIds.length && !malformed.length) return json(res, 400, { error: 'missing_payouts' });

  const paymentRef = String(body.paymentRef || '').slice(0, 64).trim() || null;

  /* Item 16: optional UTR collected during release — light format check
   * (max 64 chars, UTR-safe charset). Stored on the payout record. */
  let utr = String(body.utr == null ? '' : body.utr).trim().slice(0, 64) || null;
  if (utr && !/^[A-Za-z0-9][A-Za-z0-9/\-_. ]{0,63}$/.test(utr)) {
    return json(res, 400, { error: 'bad_utr' });
  }

  try {
    const out = await db.runTransaction(async (tx) => {
      // Item 18: the batch reuses the shared single-release logic above —
      // one bad item can never abort the batch (it lands in ctx.skipped).
      const ctx = {
        uid,
        now: FieldValue.serverTimestamp(),
        paymentRef,
        utr,
        released: [],
        skipped: malformed.slice(), /* Item 13: malformed ids reported too */
        total: 0,
        // Item 25: per-creator aggregates for paid-time TDS tracking.
        tdsByCreator: new Map(),
      };
      for (const pid of payoutIds) {
        await releaseSinglePayout(tx, db, pid, ctx);
      }

      // Item 25 (paid-time TDS tracking, REVERSIBLE pending Jainik's CA
      // written advice on 194J vs 194O): for each creator paid in this batch,
      // roll the released amounts into their FY counters. Same txn as the
      // status flips — paid money and FY tracking can never drift apart.
      // Defensive Number() guards mean a malformed existing doc can never
      // throw and block the release — worst case the counters restart from
      // this payout. TRACKING ONLY — no TDS is deducted.
      // SENTINEL-287 (privacy): the counters live in the PRIVATE
      // subcollection creators/{cid}/private/tdsTracking — never on the
      // world-readable public creators doc (firestore.rules: allow read
      // if true for discovery), where they would expose every creator's
      // FY earnings. FY key/label use the IST helpers so the per-creator
      // key can never disagree with the platform rollup around April 1.
      for (const [cid, paidAmt] of ctx.tdsByCreator) {
        const tRef = db.collection('creators').doc(cid).collection('private').doc('tdsTracking');
        const tSnap = await tx.get(tRef);
        const tData = tSnap.exists ? (tSnap.data() || {}) : {};
        const fy = fyLabelIST(new Date());
        const fyTotal = (tData.payoutFY === fy ? Number(tData.payoutFYTotal || 0) : 0) + paidAmt;
        const fyk = fyKeyIST(new Date());
        const prevTds = tData.tdsTracking && typeof tData.tdsTracking === 'object'
          ? (tData.tdsTracking[fyk] || {}) : {};
        const tdsTotalPaid = (Number(prevTds.totalPaid) || 0) + paidAmt;
        const tdsPayouts = (Number(prevTds.payouts) || 0) + 1;
        tx.set(tRef, {
          payoutFY: fy, payoutFYTotal: fyTotal,
          tdsApplicable: fyTotal >= TDS_THRESHOLD_INR,
          tdsTracking: { [fyk]: { totalPaid: tdsTotalPaid, payouts: tdsPayouts } },
        }, { merge: true });
      }

      // Item 17: platform-wide FY rollup in the SAME txn as the releases —
      // queue totals can never drift from released money. The Asia/Kolkata
      // FY key means the boundary is April 1, 00:00 IST. The rollup starts
      // from this deploy (payouts released earlier are NOT backfilled — the
      // admin can add a one-time backfill later if needed).
      if (ctx.total > 0) {
        const rfy = fyKeyIST(new Date());
        tx.set(db.collection('payoutMetrics').doc(rfy), {
          fyKey: rfy,
          fyLabel: fyLabelIST(new Date()),
          releasedTotal: FieldValue.increment(ctx.total),
          tdsTrackedTotal: FieldValue.increment(ctx.total),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }

      return { released: ctx.released, skipped: ctx.skipped, total: ctx.total };
    });

    return json(res, 200, {
      ok: true, ...out, count: out.released.length,
      requested, truncated, /* Item 13: truncation reported, never silent */
    });
  } catch (e) {
    console.error('[booking-action] payout-release', String((e && e.message) || e).slice(0, 200));
    return json(res, 500, { error: 'release_failed' });
  }
}

/* Items 14 + 17 — ADMIN payout-queue listing for the Founder Dashboard.
 * Item 14: each row carries the payout DESTINATION in MASKED form
 * (raj***@upi) for card display. The full VPA is NEVER returned here —
 * only via payout-detail (Item 12). Item 17: the response also carries the
 * FY rollup (released + TDS-tracked totals for the current Asia/Kolkata
 * April–March FY) with the TDS copy marker the UI renders verbatim.
 *
 * Input:  { idToken, action: 'payout-queue', limit?: 1..100 (default 50) }
 * Output: { ok, payouts: [{ id, amount, bookingId, creatorId, status, kind,
 *           destination (masked|null), utr, paymentRef, createdAt(ms),
 *           creator: { name, handle, tds } }],
 *           fy: { key, label, releasedTotal, tdsTrackedTotal, tdsNote },
 *           count } */
async function handlePayoutQueue(res, db, uid, body) {
  if (!(await requireAdmin(db, uid))) return json(res, 403, { error: 'admin_only' });
  const limit = Math.min(100, Math.max(1, Math.floor(Number(body.limit) || 50)));
  try {
    // Same releasable set the dashboard queue shows; sorted newest-first in
    // JS (no composite index needed — single-field 'in' + limit only).
    const snap = await db.collection('payoutRequests')
      .where('status', 'in', Array.from(RELEASABLE))
      .limit(limit)
      .get();
    const rows = [];
    snap.forEach(function (doc) {
      const d = doc.data() || {};
      rows.push({
        id: doc.id,
        amount: Math.floor(Number(d.amount) || 0),
        bookingId: String(d.bookingId || ''),
        creatorId: String(d.creatorId || ''),
        status: String(d.status || ''),
        kind: String(d.kind || ''),
        destination: maskVpa(d.destination || d.upi), /* Item 14: masked only; upi is the creator-saved field */
        utr: d.utr ? String(d.utr) : null,
        paymentRef: d.paymentRef ? String(d.paymentRef) : null,
        createdAt: d.createdAt && d.createdAt.toMillis ? d.createdAt.toMillis() : 0,
      });
    });
    rows.sort(function (a, b) { return b.createdAt - a.createdAt; });
    // Bounded creator lookups for card display (name/handle/TDS flag).
    const seen = {}, need = [];
    rows.forEach(function (r) {
      if (r.creatorId && !seen[r.creatorId]) { seen[r.creatorId] = 1; need.push(r.creatorId); }
    });
    const cmap = {};
    await Promise.all(need.map(async function (cid) {
      const s = await db.collection('creators').doc(cid).get().catch(() => null);
      const d = s && s.exists ? (s.data() || {}) : {};
      // SENTINEL-287: the TDS flag lives in the private subcollection,
      // not on the public creators doc.
      const ts = await db.collection('creators').doc(cid).collection('private').doc('tdsTracking').get().catch(() => null);
      const td = ts && ts.exists ? (ts.data() || {}) : {};
      cmap[cid] = {
        name: String(d.name || d.displayName || ''),
        handle: String(d.handle || d.username || ''),
        tds: !!td.tdsApplicable,
      };
    }));
    rows.forEach(function (r) {
      r.creator = cmap[r.creatorId] || { name: '', handle: '', tds: false };
    });

    // Item 17: FY totals from the rollup doc — ONE read, no collection
    // scan. The rollup is written by the release txn; before any release
    // happens the totals are honestly 0.
    const fyk = fyKeyIST(new Date());
    const mSnap = await db.collection('payoutMetrics').doc(fyk).get().catch(() => null);
    const m = mSnap && mSnap.exists ? (mSnap.data() || {}) : {};
    return json(res, 200, {
      ok: true,
      payouts: rows,
      count: rows.length,
      fy: {
        key: fyk,
        label: fyLabelIST(new Date()),
        releasedTotal: Math.floor(Number(m.releasedTotal) || 0),
        tdsTrackedTotal: Math.floor(Number(m.tdsTrackedTotal) || 0),
        tdsNote: TDS_NOTE,
      },
    });
  } catch (e) {
    console.error('[booking-action] payout-queue', String(e && e.message || e).slice(0, 160));
    return json(res, 500, { error: 'queue_failed' });
  }
}

/* Item 12 — ADMIN single-payout confirmation path. Returns the FULL payout
 * destination/VPA (the queue listing deliberately stays masked — Item 14).
 * This is the data path the release confirmation step reads before the
 * admin hits Release: it confirms WHERE the money is going.
 *
 * Input:  { idToken, action: 'payout-detail', payoutId }
 * Output: { ok, payout: { id, bookingId, creatorId, bizId, amount, status,
 *           kind, destination (FULL), utr, paymentRef, note, rejectReason,
 *           holdReason, createdAt, paidAt, rejectedAt, heldAt, releasedBy } } */
async function handlePayoutDetail(res, db, uid, body) {
  if (!(await requireAdmin(db, uid))) return json(res, 403, { error: 'admin_only' });
  const pid = String(body.payoutId || '').trim();
  if (!PAYOUT_ID_RE.test(pid)) return json(res, 400, { error: 'bad_payout_id' });
  try {
    const snap = await db.collection('payoutRequests').doc(pid).get().catch(() => null);
    if (!snap || !snap.exists) return json(res, 404, { error: 'not_found' });
    const d = snap.data() || {};
    const ms = function (v) { return v && v.toMillis ? v.toMillis() : null; };
    return json(res, 200, {
      ok: true,
      payout: {
        id: snap.id,
        bookingId: String(d.bookingId || ''),
        creatorId: String(d.creatorId || ''),
        bizId: String(d.bizId || ''),
        amount: Math.floor(Number(d.amount) || 0),
        status: String(d.status || ''),
        kind: String(d.kind || ''),
        destination: (d.destination || d.upi) ? String(d.destination || d.upi) : null, /* FULL VPA — admin confirmation only */
        utr: d.utr ? String(d.utr) : null,
        paymentRef: d.paymentRef ? String(d.paymentRef) : null,
        note: d.note ? String(d.note).slice(0, 500) : null,
        rejectReason: d.rejectReason ? String(d.rejectReason) : null,
        holdReason: d.holdReason ? String(d.holdReason) : null,
        createdAt: ms(d.createdAt),
        paidAt: ms(d.paidAt),
        rejectedAt: ms(d.rejectedAt),
        heldAt: ms(d.heldAt),
        releasedBy: d.releasedBy ? String(d.releasedBy) : null,
      },
    });
  } catch (e) {
    console.error('[booking-action] payout-detail', String(e && e.message || e).slice(0, 160));
    return json(res, 500, { error: 'detail_failed' });
  }
}

/* Item 19 — ADMIN reject / hold for the payout queue. Sets the payout
 * status to 'rejected' | 'held' with a reason string, a server timestamp,
 * and the admin uid. Batch-safe: one bad item never aborts the batch
 * ({ updated, skipped }). Held/rejected payouts are not releasable.
 *
 * Input:  { idToken, action: 'payout-reject' | 'payout-hold',
 *           payoutIds: [...], reason: '<required, max 500 chars>' }
 * Output: { ok, action, updated: [{id, status}], skipped: [{id, reason}],
 *           count, requested, truncated } */
async function handlePayoutRejectHold(res, db, uid, body, mode) {
  if (!(await requireAdmin(db, uid))) return json(res, 403, { error: 'admin_only' });
  const reason = String(body.reason || '').trim().slice(0, 500);
  if (!reason) return json(res, 400, { error: 'missing_reason' });
  const { ids: payoutIds, skipped: malformed, truncated, requested } = sanitizePayoutIds(body.payoutIds);
  if (!payoutIds.length && !malformed.length) return json(res, 400, { error: 'missing_payouts' });
  const newStatus = mode === 'reject' ? 'rejected' : 'held';
  const fromStatuses = mode === 'reject'
    ? new Set(['pending', 'accumulating', 'approved', 'held'])
    : new Set(['pending', 'accumulating', 'approved']);
  try {
    const out = await db.runTransaction(async (tx) => {
      const updated = [];
      const skipped = malformed.slice();
      for (const pid of payoutIds) {
        const ref = db.collection('payoutRequests').doc(pid);
        const snap = await tx.get(ref);
        if (!snap.exists) { skipped.push({ id: pid, reason: 'not_found' }); continue; }
        const st = String((snap.data() || {}).status || '');
        if (st === 'paid') { skipped.push({ id: pid, reason: 'already_paid' }); continue; }
        if (st === newStatus) { skipped.push({ id: pid, reason: 'already_' + newStatus }); continue; }
        if (!fromStatuses.has(st)) { skipped.push({ id: pid, reason: 'bad_status_' + (st || 'missing') }); continue; }
        const now = FieldValue.serverTimestamp();
        const w = { status: newStatus, updatedAt: now };
        if (mode === 'reject') {
          w.rejectedAt = now; w.rejectedBy = uid; w.rejectReason = reason;
        } else {
          w.heldAt = now; w.heldBy = uid; w.holdReason = reason;
        }
        tx.update(ref, w);
        updated.push({ id: pid, status: newStatus });
      }
      return { updated, skipped };
    });
    return json(res, 200, {
      ok: true, action: mode, ...out,
      count: out.updated.length, requested, truncated,
    });
  } catch (e) {
    console.error('[booking-action] payout-' + mode, String(e && e.message || e).slice(0, 160));
    return json(res, 500, { error: mode + '_failed' });
  }
}

/* Item 30 — creator's last-used payout destination, for prefilling their
 * payout settings form. Caller-scoped: the caller (a creator) can only see
 * THEIR OWN payouts — never another creator's. Returns the most recent
 * payoutRequest with a non-empty `destination` (FULL value — this is the
 * creator's own data).
 *
 * Input:  { idToken, action: 'payout-last-destination' }
 * Output: { ok, destination: '<vpa>' | null } */
async function handleLastDestination(res, db, uid) {
  try {
    // Single-field query (no composite index needed); pick the newest in
    // JS so this works with zero index setup.
    const snap = await db.collection('payoutRequests')
      .where('creatorId', '==', String(uid))
      .limit(25)
      .get()
      .catch(() => null);
    let best = null;
    let bestAt = -1;
    let bestDoc = null;
    if (snap) snap.forEach(function (doc) {
      const d = doc.data() || {};
      const dest = String(d.destination || d.upi || '').trim();
      if (!dest && !d.holder && !d.account) return;
      const c = d.createdAt;
      const at = c && c.toMillis ? c.toMillis() : (c && c.seconds ? Number(c.seconds) * 1000 : 0);
      if (at >= bestAt) { bestAt = at; best = dest; bestDoc = d; }
    });
    // Item 30 fix: return the FULL last-used destination (method + bank
    // fields), not just the single destination string, so the client can
    // prefill the bank form too. `destination` kept for backward compat.
    const bd = bestDoc || {};
    return json(res, 200, {
      ok: true,
      destination: best,
      method: String(bd.method || (bd.holder || bd.account ? 'bank' : '')),
      upi: String(bd.upi || ''),
      holder: String(bd.holder || ''),
      account: String(bd.account || ''),
      ifsc: String(bd.ifsc || ''),
    });
  } catch (e) {
    console.error('[booking-action] payout-last-destination', String(e && e.message || e).slice(0, 160));
    return json(res, 500, { error: 'lookup_failed' });
  }
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
  // Items 12/13/14/16/17/18/19/30: the payout-queue actions share this route
  // (api/ is at the Vercel 12-file limit — NO new files). 'payout-release',
  // 'payout-queue', 'payout-detail', 'payout-reject', 'payout-hold' are
  // admin-gated inside their handlers; 'payout-last-destination' is
  // creator-scoped (caller can only see their own payouts).
  const PAYOUT_ACTIONS = ['payout-release', 'payout-queue', 'payout-detail', 'payout-reject', 'payout-hold', 'payout-last-destination'];
  if (action !== 'approve' && action !== 'notify' && action !== 'list_recoverable' && action !== 'recover_payment' && PAYOUT_ACTIONS.indexOf(action) === -1) {
    return json(res, 400, { error: 'bad_action' });
  }

  const db = getAdmin().firestore();

  /* Item 36: admin payout release (merged from api/payout-release.js — the
   * route contract is documented above and kept stable for the future admin
   * UI: { idToken, action: 'payout-release', payoutIds, paymentRef? }). */
  if (action === 'payout-release') {
    return handlePayoutRelease(res, db, uid, body);
  }

  /* Items 12/14/17/19: admin payout-queue actions — no bookingId needed,
   * branched before the bookingId requirement below (same as payout-release). */
  if (action === 'payout-queue') {
    return handlePayoutQueue(res, db, uid, body);
  }
  if (action === 'payout-detail') {
    return handlePayoutDetail(res, db, uid, body);
  }
  if (action === 'payout-reject') {
    return handlePayoutRejectHold(res, db, uid, body, 'reject');
  }
  if (action === 'payout-hold') {
    return handlePayoutRejectHold(res, db, uid, body, 'hold');
  }
  /* Item 30: creator-scoped last-used destination — no admin gate, no
   * bookingId; the handler scopes reads to the caller's own payouts. */
  if (action === 'payout-last-destination') {
    return handleLastDestination(res, db, uid);
  }

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
      // Sub-₹100 shares are QUEUED with status 'accumulating' — small
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
              : 'Booking approved by brand: escrow released — share below the ₹100 payout floor, accumulates with future payouts',
          });
          payoutCreated = true;
          // Item 25: TDS/194J tracking is NO LONGER done here at queue-time.
          // It moved to the paid-time payout-release path below (track when
          // the admin actually releases the money — REVERSIBLE, pending
          // Jainik's CA written advice on 194J vs 194O). The payout queue
          // write stays exactly as before.
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
          ? ' ₹' + Number(out.share).toLocaleString('en-IN') + ' has been queued to your payouts'
          : ' Your payout has been queued';
        await db.collection('creatorNotifs').add({
          creatorId: bd.creatorId, type: 'booking_approved',
          title: 'Booking approved — payout queued',
          body: 'The brand approved your delivery.' + shareTxt +
            (out.payoutStatus === 'accumulating' ? ' (below the ₹100 floor — it accumulates with your future payouts).' : '.'),
          bookingId, read: false, createdAt: FieldValue.serverTimestamp(),
        });
      }
    } catch (e) {
      console.error('[booking-action] creatorNotif approve', String(e && e.message || e).slice(0, 160));
    }
    // Referral credit (Cycle 17): a referred creator's first PAID completed
    // booking earns the referrer ₹100 (lib/referral.js — idempotent via
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
