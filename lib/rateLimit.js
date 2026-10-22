/* Shared per-IP rate limiter for Vercel serverless API routes.
 * In-memory (per instance); sets Retry-After on 429. Prunes stale entries.
 *
 * Item 11: this runtime is raw Node serverless functions — Express-style
 * res.status(429).json(...) DOES NOT EXIST here (it throws and 500s the
 * caller). Use the res.statusCode / res.setHeader / res.end pattern that
 * every other endpoint in this repo uses.
 *
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
    // Item 11: raw Node serverless response — res.status().json() is
    // Express-only and would throw here. Set statusCode + headers and end.
    res.statusCode = 429;
    res.setHeader('Retry-After', String(retryAfter));
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ ok: false, error: 'rate_limited', retryAfter }));
    return false;
  }
  return true;
}
