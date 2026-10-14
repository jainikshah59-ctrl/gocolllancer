/* POST /api/cashfree-webhook
 * Cashfree PG server webhook (C7#5). Closes the "paid but tab closed" gap:
 * a brand can pay at Cashfree and never reach /api/booking-create, leaving
 * money moved with no booking and nobody notified.
 *
 * Security (Item 9):
 *  - Signature verified per Cashfree's documented scheme: signedPayload =
 *    x-webhook-timestamp + RAW body, HMAC-SHA256 keyed by the client secret
 *    (CASHFREE_SECRET_KEY), base64 digest, compared with
 *    crypto.timingSafeEqual. Fail closed: no secret configured, missing
 *    headers, or bad signature -> reject. bodyParser is disabled (raw body
 *    required) — never re-serialize parsed JSON for verification.
 *  - Idempotent via cashfree_events/{eventId} docs — Cashfree retries
 *    webhooks, and duplicate processing must never double-flag.
 *
 * Wallet top-ups (Item 2):
 *  - Orders registered with purpose:'wallet_topup' (see /api/cashfree-order)
 *    are credited to the business wallet SERVER-SIDE on PAYMENT_SUCCESS:
 *    businesses/{uid}.walletBalance is incremented and a `deposit` entry is
 *    written to walletTransactions with the deterministic id deposit_{orderId}.
 *    The registry row flips 'created' -> 'credited' inside the transaction,
 *    so retried webhooks can never double-credit.
 *
 * PAYMENT_SUCCESS flow:
 *  - payment_orders/{orderId} exists WITH bookingId -> already booked: ack.
 *  - payment_orders/{orderId} exists WITHOUT bookingId -> mark
 *    'paid_unbooked', flag unclaimed_payments/unclaimed_{orderId}, notify
 *    the brand (bizNotifs) + admin (adminNotifs).
 *  - payment_orders/{orderId} MISSING (order predates the registry or was
 *    created out-of-band) -> still flag in unclaimed_payments with reason
 *    'paid_unknown_order' so admin can match it manually.
 *
 * Other event types are recorded and acked (200) so Cashfree stops retrying.
 */
import crypto from 'crypto';
import { getAdmin } from '../lib/firebaseAdmin.js';
import { FieldValue } from 'firebase-admin/firestore';

export const config = { api: { bodyParser: false } };


function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/* Cashfree's documented webhook scheme (Item 9):
 *   signedPayload = x-webhook-timestamp + rawBody
 *   expectedSignature = base64( HMAC-SHA256(signedPayload, clientSecret) )
 * Compare against the x-webhook-signature header. */
function verifySignature(rawBody, signature, timestamp, secret) {
  if (!secret || !signature || !timestamp) return false;
  let expected;
  try {
    expected = crypto.createHmac('sha256', secret)
      .update(String(timestamp))
      .update(rawBody)
      .digest('base64');
  } catch { return false; }
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  // The webhook is signed with the Cashfree client secret (x-client-secret).
  const secret = process.env.CASHFREE_SECRET_KEY;
  if (!secret) {
    // Fail closed: without the client secret there is nothing trustworthy to verify.
    return json(res, 503, { ok: false, err: 'webhook_not_configured' });
  }

  let raw;
  try { raw = await readRawBody(req); }
  catch { return json(res, 400, { ok: false, err: 'bad_body' }); }

  const signature = req.headers['x-webhook-signature'];
  const timestamp = req.headers['x-webhook-timestamp'];
  if (!verifySignature(raw, signature, timestamp, secret)) {
    return json(res, 401, { ok: false, err: 'bad_signature' });
  }

  let body;
  try { body = JSON.parse(raw.toString('utf8')); }
  catch { return json(res, 400, { ok: false, err: 'bad_json' }); }
  body = body && typeof body === 'object' ? body : {};

  const type = String(body.type || '');
  const data = (body.data && typeof body.data === 'object') ? body.data : {};
  const orderData = (data.order && typeof data.order === 'object') ? data.order : {};
  const paymentData = (data.payment && typeof data.payment === 'object') ? data.payment : {};
  const orderId = String(orderData.order_id || '');
  const cfPaymentId = String(paymentData.cf_payment_id || orderData.cf_payment_id || '');
  const amount = Number(orderData.order_amount || paymentData.payment_amount || 0) || 0;
  // event_time from Cashfree; fall back to the payload id for idempotency.
  const eventId = String(body.id || (orderId && type + '_' + orderId + '_' + cfPaymentId) || '');
  if (!eventId) return json(res, 200, { ok: true, ignored: true });

  const db = getAdmin().firestore();
  const now = new Date();
  const eventRef = db.collection('cashfree_events').doc(eventId);

  // Idempotency: Cashfree retries webhooks — process each event exactly once.
  try {
    const evSnap = await eventRef.get();
    if (evSnap.exists) return json(res, 200, { ok: true, duplicate: true });
  } catch (e) {
    console.error('[cashfree-webhook] event lookup', String(e && e.message || e).slice(0, 160));
    return json(res, 500, { ok: false, err: 'event_lookup_failed' });
  }

  // Only PAYMENT_SUCCESS needs money handling; other events are recorded + acked.
  if (type !== 'PAYMENT_SUCCESS_WEBHOOK') {
    await eventRef.set({ type, orderId: orderId || null, ignored: true, receivedAt: now }, { merge: true });
    return json(res, 200, { ok: true, ignored: true });
  }
  if (!orderId) {
    await eventRef.set({ type, ignored: true, reason: 'missing_order_id', receivedAt: now }, { merge: true });
    return json(res, 200, { ok: true, ignored: true });
  }

  try {
    const outcome = await db.runTransaction(async (tx) => {
      const ev = await tx.get(eventRef);
      if (ev.exists) return 'duplicate'; // retried concurrently — already processed
      tx.set(eventRef, {
        type, orderId, cfPaymentId: cfPaymentId || null, amount,
        receivedAt: now,
      }, { merge: true });

      const regRef = db.collection('payment_orders').doc(orderId);
      const regSnap = await tx.get(regRef);
      const reg = regSnap.exists ? (regSnap.data() || {}) : null;
      const bizId = (reg && reg.uid) || null;

      if (reg && reg.bookingId) {
        // Already booked via /api/booking-create — enrich the registry row only.
        tx.set(regRef, {
          cfPaymentId: cfPaymentId || null, status: 'booked',
          webhookReceivedAt: now, updatedAt: now,
        }, { merge: true });
        return 'booked';
      }

      // Item 2 — WALLET TOP-UP: credit the business wallet server-side.
      // The order is distinguished by its purpose tag in the registry
      // (written by /api/cashfree-order). Idempotent: the registry row flips
      // 'created' -> 'credited' inside this transaction and the deposit ledger
      // entry has the deterministic id deposit_{orderId}, so a retried
      // webhook can never double-credit the wallet. Amount is server-truth
      // (the registry row / webhook payload), never client-supplied.
      if (reg && reg.purpose === 'wallet_topup') {
        if (reg.status === 'credited') return 'topup_duplicate';
        const credit = Number(reg.amount || amount || 0);
        const bizRef = bizId ? db.collection('businesses').doc(bizId) : null;
        const bizSnap = bizRef ? await tx.get(bizRef) : null;
        if (bizSnap && bizSnap.exists && credit > 0) {
          tx.update(bizRef, { walletBalance: FieldValue.increment(credit) });
          tx.set(db.collection('walletTransactions').doc('deposit_' + orderId), {
            bizId, orderId, type: 'deposit', amount: credit,
            cfPaymentId: cfPaymentId || null, createdAt: now,
            note: 'Wallet top-up via Cashfree',
          }, { merge: true });
          tx.set(regRef, {
            status: 'credited', cfPaymentId: cfPaymentId || null,
            paidViaWebhook: true, creditedAt: now, updatedAt: now,
          }, { merge: true });
          return 'topup_credited';
        }
        // Cannot credit (unknown business / bad amount) — fall through to
        // the unclaimed flagging below so admin can follow up.
      }

      if (regSnap.exists) {
        tx.set(regRef, {
          status: 'paid_unbooked', cfPaymentId: cfPaymentId || null,
          paidViaWebhook: true, reconciledAt: now, updatedAt: now,
        }, { merge: true });
      } else {
        // Order predates the registry (or was created out-of-band): create a
        // registry row so the cron reconcile and admin tooling can see it.
        tx.set(regRef, {
          uid: null, amount, currency: 'INR', status: 'paid_no_registry',
          bookingId: null, cfPaymentId: cfPaymentId || null,
          cashfreeEnv: (process.env.CASHFREE_ENV || 'test'),
          createdAt: now, webhookReceivedAt: now, updatedAt: now,
        }, { merge: true });
      }

      // Deterministic unclaimed doc — webhook + cron reconcile dedup on it.
      tx.set(db.collection('unclaimed_payments').doc('unclaimed_' + orderId), {
        orderId, bizId, amount, cfPaymentId: cfPaymentId || null,
        reason: reg ? 'paid_no_booking' : 'paid_unknown_order',
        cashfreeEnv: (process.env.CASHFREE_ENV || 'test'),
        resolved: false, source: 'cashfree_webhook',
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return 'unclaimed';
    });

    // Wallet top-up outcomes: ack only (plus a credit confirmation for the
    // brand on first credit). No unclaimed/admin noise for top-ups.
    if (outcome === 'topup_credited' || outcome === 'topup_duplicate' || outcome === 'booked') {
      if (outcome === 'topup_credited') {
        const regSnap = await db.collection('payment_orders').doc(orderId).get();
        const bizId = regSnap.exists ? (regSnap.data() || {}).uid : null;
        if (bizId) {
          try {
            await db.collection('bizNotifs').add({
              bizId, type: 'wallet_credited',
              title: 'Wallet credited',
              body: 'Your Collancer wallet was topped up by Rs.' +
                Number(amount || 0).toLocaleString('en-IN') + ' via Cashfree.',
              orderId, read: false, createdAt: FieldValue.serverTimestamp(),
            });
          } catch (e) {
            console.error('[cashfree-webhook] bizNotif', String(e && e.message || e).slice(0, 160));
          }
        }
      }
      return json(res, 200, { ok: true, outcome });
    }
    if (outcome === 'duplicate') {
      return json(res, 200, { ok: true, duplicate: true });
    }

    // Notifications (outside the txn; best-effort).
    const regSnap = await db.collection('payment_orders').doc(orderId).get();
    const bizId = regSnap.exists ? (regSnap.data() || {}).uid : null;
    if (bizId) {
      try {
        await db.collection('bizNotifs').add({
          bizId, type: 'payment_no_booking',
          title: 'Payment received — finish your booking',
          body: 'Your Cashfree payment for order ' + orderId +
            ' succeeded but no booking was created. Tap to complete your booking or contact support.',
          orderId, read: false, createdAt: FieldValue.serverTimestamp(),
        });
      } catch (e) {
        console.error('[cashfree-webhook] bizNotif', String(e && e.message || e).slice(0, 160));
      }
    }
    try {
      await db.collection('adminNotifs').add({
        type: 'unclaimed_payment',
        title: 'Webhook: paid but unbooked payment',
        body: 'Cashfree order ' + orderId + ' is PAID (' + (bizId || 'unknown brand') +
          ') but has no booking. Follow up with the brand.',
        orderId, bizId: bizId || null, resolved: false,
        createdAt: FieldValue.serverTimestamp(),
      });
    } catch (e) {
      console.error('[cashfree-webhook] adminNotif', String(e && e.message || e).slice(0, 160));
    }

    return json(res, 200, { ok: true, flagged: 'unclaimed' });
  } catch (e) {
    console.error('[cashfree-webhook] txn', String(e && e.message || e).slice(0, 200));
    return json(res, 500, { ok: false, err: 'processing_failed' });
  }
}
