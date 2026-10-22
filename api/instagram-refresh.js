/* POST /api/instagram-refresh
 * Refreshes a creator's Instagram long-lived token and re-syncs their profile.
 *
 * Instagram long-lived tokens expire after 60 days. This endpoint:
 *  (a) reads instagram_tokens/{uid} via the Admin SDK (server-only collection;
 *      clients have no read access per firestore.rules),
 *  (b) calls Meta's refresh_access_token endpoint when the token expires
 *      within REFRESH_WINDOW_DAYS (7), or when the caller passes force:true,
 *  (c) re-runs buildInstagramObject(token) to pull fresh profile + insights,
 *  (d) updates the token doc (new token + expiry) and merges fresh metrics
 *      into creators/{uid}.
 *
 * It doubles as the manual "Sync Instagram" button backend: a sync-only call
 * (token still fresh) skips the refresh step and just re-syncs data.
 *
 * Input:  { idToken, force?: boolean }
 * Output: { refreshed: boolean, synced: boolean, followers: number|null,
 *           expiresInDays: number|null, syncedAt: string }
 * Errors: 401 auth_required | 404 not_connected | 410 token_invalid (revoked —
 *          creator must reconnect) | 502 refresh_failed / sync_failed
 */
import { getAdmin, verifyUid, readBody } from '../lib/firebaseAdmin.js';
import { buildInstagramObject } from '../lib/instagramSync.js';
import { FieldValue } from 'firebase-admin/firestore';

const REFRESH_WINDOW_DAYS = 7;
const TOKEN_DAYS = 60;
// HARDENING (item 37b): ~15s AbortController timeout on Graph API fetch calls
// so a hung Meta endpoint can't wedge the function.
const FETCH_TIMEOUT_MS = 15000;
// HARDENING (item 37b): outer wall-clock bound on the full profile+insights
// sync (the shared sync module does its own HTTP calls; this bounds the wait
// from our side).
const SYNC_TIMEOUT_MS = 55000;
// HARDENING (item 37c): short-lived per-user concurrency lock. TTL 5 min —
// self-clearing, so a crashed invocation can never wedge the user forever.
const LOCK_TTL_MS = 5 * 60 * 1000;

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

/* HARDENING (item 37b): fetch with an AbortController timeout. A hung Meta
 * endpoint aborts instead of hanging the serverless function. */
async function fetchGraph(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } catch (e) {
    if (e && e.name === 'AbortError') {
      const t = new Error('Meta request timed out');
      t.timedOut = true;
      throw t;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/* HARDENING (item 37b): bound an async operation's wall-clock time. Used
 * around buildInstagramObject, whose internal HTTP calls live in the shared
 * sync module. If the timeout wins we stop waiting — the detached sync work
 * is read-only (no Firestore writes), so it can't corrupt state. */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(label || 'operation timed out');
      e.timedOut = true;
      reject(e);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/* HARDENING (item 37c): short-lived per-user concurrency guard. Two
 * simultaneous refresh invocations for the same uid must not interleave
 * token writes and syncs. Implemented as a Firestore lock doc written via
 * the Admin SDK in a transaction: claim it only if it doesn't exist or has
 * expired. TTL 5 min keeps it self-clearing after a crash. */
const LOCK_COLLECTION = 'instagram_locks';

function lockExpiryMs(data) {
  try {
    const t = data && data.expiresAt;
    if (t && typeof t.toDate === 'function') return t.toDate().getTime();
    if (t instanceof Date) return t.getTime();
    const n = Number(t);
    return Number.isFinite(n) ? n : 0;
  } catch { return 0; }
}

async function acquireRefreshLock(db, uid) {
  try {
    const lockRef = db.collection(LOCK_COLLECTION).doc(uid);
    const claimed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(lockRef);
      const nowMs = Date.now();
      if (snap.exists && lockExpiryMs(snap.data()) > nowMs) return false; // held
      tx.set(lockRef, {
        lockedAt: FieldValue.serverTimestamp(),
        expiresAt: new Date(nowMs + LOCK_TTL_MS),
      }, { merge: true });
      return true;
    });
    return claimed === true;
  } catch (e) {
    // Lock infrastructure must never block a legitimate refresh.
    console.error('[instagram-refresh] lock acquire failed',
      String(e?.message || e).slice(0, 120));
    return true;
  }
}

async function releaseRefreshLock(db, uid) {
  try {
    await db.collection(LOCK_COLLECTION).doc(uid).delete();
  } catch { /* TTL expiry covers a missed release */ }
}

async function refreshLongLivedToken(token, appSecret) {
  // Meta: GET /refresh_access_token?grant_type=ig_refresh_token&access_token=...
  const url =
    `https://graph.instagram.com/refresh_access_token` +
    `?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`;
  const r = await fetchGraph(url, FETCH_TIMEOUT_MS);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j?.error || !j?.access_token) {
    const e = new Error(String(j?.error?.message || 'token refresh failed').slice(0, 160));
    e.metaCode = j?.error?.code ?? null;
    e.metaType = j?.error?.type ?? null;
    e.status = r.status;
    // OAuthException with code 190 = token revoked / user deauthorized.
    e.revoked = r.status === 400 && Number(j?.error?.code) === 190;
    throw e;
  }
  const expiresIn = Number(j.expires_in);
  return {
    token: j.access_token,
    expiresAt: new Date(Date.now() +
      (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : TOKEN_DAYS * 86400) * 1000),
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  // This endpoint can trigger a heavy full sync — keep it tight.
  try {
    const { rateLimit } = await import('../lib/rateLimit.js');
    if (!rateLimit(req, res, { max: 10, windowMs: 60000, key: 'instagram-refresh' })) return;
  } catch { /* rate limiter must never block the happy path */ }

  let uid;
  let body = {};
  try {
    body = readBody(req);
    uid = await verifyUid(body.idToken || (req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  } catch (e) {
    return json(res, 401, { error: 'auth_required' });
  }
  const force = body.force === true;

  const firebaseAdmin = getAdmin();
  const db = firebaseAdmin.firestore();
  const now = FieldValue.serverTimestamp();

  // 1b. Concurrency guard (item 37c): bail with 429 if a refresh for this
  // user is already in flight. Released in the finally block at the end.
  const lockClaimed = await acquireRefreshLock(db, uid);
  if (!lockClaimed) {
    return json(res, 429, {
      error: 'refresh_in_progress',
      message: 'Instagram sync already running. Try again shortly.',
    });
  }
  try {
    // 1. Load the stored token (server-only collection).
    const tokenRef = db.collection('instagram_tokens').doc(uid);
    const tokenSnap = await tokenRef.get().catch(() => null);
    if (!tokenSnap || !tokenSnap.exists) {
      return json(res, 404, { error: 'not_connected' });
    }
    const stored = tokenSnap.data() || {};
    let token = String(stored.token || '');
    if (!token) return json(res, 404, { error: 'not_connected' });

    let expiresAtMs = null;
    try {
      const t = stored.expiresAt;
      expiresAtMs = t && typeof t.toDate === 'function' ? t.toDate().getTime()
        : (t instanceof Date ? t.getTime() : (Number(t) || null));
    } catch { /* treat as unknown */ }
    const msLeft = expiresAtMs == null ? -1 : expiresAtMs - Date.now();
    const needsRefresh = force || msLeft < 0 || msLeft < REFRESH_WINDOW_DAYS * 86400000;

    // 2. Refresh the long-lived token when it is expiring (or on force).
    let refreshed = false;
    let newExpiresAt = expiresAtMs != null ? new Date(expiresAtMs) : null;
    if (needsRefresh) {
      try {
        const out = await refreshLongLivedToken(token);
        token = out.token;
        newExpiresAt = out.expiresAt;
        refreshed = true;
        // HARDENING (Cycle 19): persist the fresh token BEFORE the sync call
        // below. A sync failure returns 502 — without this write the new token
        // would be lost and the stored (possibly Meta-invalidated) token would
        // keep failing on every retry (error loop).
        try {
          await tokenRef.set({
            token, expiresAt: newExpiresAt,
            revoked: FieldValue.delete(), revokedAt: FieldValue.delete(),
            updatedAt: now,
          }, { merge: true });
        } catch (e) {
          console.error('[instagram-refresh] early token persist failed',
            String(e?.message || e).slice(0, 160));
          // Non-fatal: step 4 re-writes the token after a successful sync.
        }
      } catch (e) {
        console.error('[instagram-refresh] token refresh failed', {
          uid: String(uid).slice(0, 12),
          status: e?.status ?? null,
          metaCode: e?.metaCode ?? null,
          message: String(e?.message || 'refresh failed').slice(0, 160),
        });
        if (e?.revoked) {
          // The user revoked access at Meta — flag it so the app can prompt
          // a clean re-connect instead of retrying a dead token forever.
          await tokenRef.set({ revoked: true, revokedAt: now }, { merge: true }).catch(() => {});
          return json(res, 410, { error: 'token_invalid', message: 'Instagram access was revoked. Please reconnect.' });
        }
        return json(res, 502, { error: 'refresh_failed' });
      }
    }

    // 3. Full profile + insights re-sync (same shared module as the callback,
    //    so connect-time and refresh-time data have identical shape).
    let instagram;
    try {
      // HARDENING (item 37b): outer timeout so a hung Meta endpoint during the
      // heavy sync can't wedge the function.
      instagram = await withTimeout(buildInstagramObject(token), SYNC_TIMEOUT_MS, 'instagram sync timed out');
    } catch (e) {
      console.error('[instagram-refresh] sync failed', {
        uid: String(uid).slice(0, 12),
        message: String(e?.message || 'sync failed').slice(0, 160),
      });
      return json(res, 502, { error: 'sync_failed' });
    }
    instagram.lastSyncedAt = now;

    // 4. Persist: token (if refreshed) + fresh creator metrics.
    const creatorRef = db.collection('creators').doc(uid);
    const creatorSnap = await creatorRef.get().catch(() => null);
    const prev = creatorSnap && creatorSnap.exists ? creatorSnap.data() : {};
    const prevIg = (prev && prev.instagram) || {};
    // Never clobber the original connect timestamp with a refresh timestamp.
    if (prevIg.connectedAt) instagram.connectedAt = prevIg.connectedAt;
    // A transient media API failure must not erase a previously saved library.
    if (instagram.dataQuality?.mediaFetchError && Array.isArray(prevIg.recentMedia)) {
      instagram.recentMedia = prevIg.recentMedia;
      instagram.mediaCount = prevIg.mediaCount ?? instagram.mediaCount;
    }

    const batch = db.batch();
    if (refreshed) {
      batch.set(tokenRef, {
        token, igId: String(instagram.igId), expiresAt: newExpiresAt,
        revoked: FieldValue.delete(), revokedAt: FieldValue.delete(), updatedAt: now,
      }, { merge: true });
    } else {
      batch.set(tokenRef, { igId: String(instagram.igId), updatedAt: now }, { merge: true });
    }
    batch.set(creatorRef, {
      pfp: instagram.profilePic || prev.pfp || '',
      bio: instagram.bio || prev.bio || '',
      followers: instagram.followersCount,
      engagement: instagram.engagementRate ?? FieldValue.delete(),
      avgViews: instagram.avgViews ?? FieldValue.delete(),
      avgLikes: instagram.avgLikes ?? FieldValue.delete(),
      reach: instagram.accountInsights?.metricStatus?.reach?.available ? instagram.reach : FieldValue.delete(),
      profileViews: instagram.accountInsights?.metricStatus?.profile_views?.available ? instagram.profileViews : FieldValue.delete(),
      instagram,
      updatedAt: now,
    }, { merge: true });
    await batch.commit();

    const expiresInDays = newExpiresAt
      ? Math.max(0, Math.round((newExpiresAt.getTime() - Date.now()) / 86400000))
      : null;
    return json(res, 200, {
      refreshed,
      synced: true,
      followers: instagram.followersCount,
      expiresInDays,
      syncedAt: new Date().toISOString(),
    });
  } finally {
    await releaseRefreshLock(db, uid);
  }
}
