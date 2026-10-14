/* Shared per-IP rate limiter for Vercel serverless API routes.
 * In-memory (per instance); sets Retry-After on 429. Prunes stale entries.
 * Usage:
 *   import { rateLimit } from '../lib/rateLimit.js';
 *   if (!rateLimit(req, res, { max: 30, windowMs: 60000 })) return; // already sent 429
 */
const buckets = new Map();

function clientIp(req) {
  const fwd = req.headers && req.headers['x-forwarded-for'];
  // Vercel (and most proxies) APPEND the real client IP as the LAST entry,
  // so take the rightmost — the leftmost entry is attacker-controlled.
  if (typeof fwd === 'string' && fwd) return fwd.split(',').pop().trim();
  if (req.socket && req.socket.remoteAddress) return req.socket.remoteAddress;
  return 'unknown';
}

export function rateLimit(req, res, opts) {
  const max = (opts && opts.max) || 30;
  const windowMs = (opts && opts.windowMs) || 60000;
  const key = (opts && opts.key ? opts.key + ':' : '') + clientIp(req);
  const now = Date.now();
  let rec = buckets.get(key);
  if (!rec || now > rec.reset) {
    rec = { count: 0, reset: now + windowMs };
    buckets.set(key, rec);
  }
  rec.count += 1;
  // Prune: drop buckets idle for > 2 windows (keeps memory bounded)
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) {
      if (now - v.reset > windowMs) buckets.delete(k);
      if (buckets.size <= 4000) break;
    }
  }
  if (rec.count > max) {
    const retryAfter = Math.max(1, Math.ceil((rec.reset - now) / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    res.status(429).json({ ok: false, error: 'rate_limited', retryAfter });
    return false;
  }
  return true;
}
