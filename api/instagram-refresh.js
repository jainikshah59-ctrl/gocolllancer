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

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

async function refreshLongLivedToken(token, appSecret) {
  // Meta: GET /refresh_access_token?grant_type=ig_refresh_token&access_token=...
  const url =
    `https://graph.instagram.com/refresh_access_token` +
    `?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`;
  const r = await fetch(url);
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
    instagram = await buildInstagramObject(token);
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
}
