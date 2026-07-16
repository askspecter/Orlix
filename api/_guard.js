'use strict';

// ── Shared abuse guard for paid / LLM endpoints ────────────────────────────────
// Stops anonymous bots from draining LLM / paid-API credits.
//
// Layers:
//   1. Per-IP per-minute limit   — burst protection
//   2. Per-IP per-day   limit   — sustained single-IP abuse
//   3. Global per-day budget cap — backstop against distributed (many-IP) abuse
//
// Backed by Upstash Redis (shared across all serverless instances). If Redis is
// not configured OR a call fails, it falls back to a per-instance in-memory
// limiter — it NEVER fails fully open.

const ALLOWED_ORIGINS = [
  'https://orlix.xyz',    'https://www.orlix.xyz',
  'https://orlixai.xyz',  'https://www.orlixai.xyz',
  'https://app.orlixai.xyz', 'https://docs.orlixai.xyz', 'https://b20.orlixai.xyz',
  'https://bridge.orlixai.xyz',
];

function getRedis() {
  return {
    url:   process.env.UPSTASH_REDIS_REST_URL   || process.env.STORAGE_UPSTASH_REDIS_REST_URL   || '',
    token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.STORAGE_UPSTASH_REDIS_REST_TOKEN || '',
  };
}

async function redisCmd(url, token, ...args) {
  // Encode each path segment — keys contain ':' (e.g. rl:chat:m:<ip>); an
  // unencoded path makes Upstash reject the request and silently breaks limiting.
  const r = await fetch(`${url}/${args.map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error('redis ' + r.status);
  return (await r.json()).result;
}

// ── In-memory fallback (per serverless instance) ───────────────────────────────
const _mem = new Map();
function _memHit(key, limit, windowSec) {
  const now = Date.now();
  let b = _mem.get(key);
  if (!b || now > b.reset) { b = { n: 0, reset: now + windowSec * 1000 }; _mem.set(key, b); }
  b.n++;
  return b.n > limit;
}
function _memSweep() {
  if (_mem.size < 5000) return;
  const now = Date.now();
  for (const [k, v] of _mem) if (now > v.reset) _mem.delete(k);
}

function clientIp(req) {
  const xf = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || req.headers['x-real-ip'] || (req.socket && req.socket.remoteAddress) || 'unknown';
}

function dayStamp() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

// Increment a counter; return true if it now EXCEEDS limit.
async function _hit(key, limit, windowSec) {
  const { url, token } = getRedis();
  if (!url) { _memSweep(); return _memHit(key, limit, windowSec); }
  try {
    const n = await redisCmd(url, token, 'INCR', key);
    if (n === 1) await redisCmd(url, token, 'EXPIRE', key, windowSec);
    return n > limit;
  } catch {
    return _memHit(key, limit, windowSec); // degrade to local limiter, never fully open
  }
}

/**
 * Multi-tier abuse guard.
 * @param {object} req
 * @param {{bucket:string, perMin?:number, perDay?:number, globalDay?:number}} opts
 * @returns {Promise<{blocked:boolean, status?:number, reason?:string}>}
 */
async function checkLimits(req, opts) {
  const ip = clientIp(req);
  const b  = opts.bucket;

  if (opts.perMin &&
      await _hit(`rl:${b}:m:${ip}`, opts.perMin, 60))
    return { blocked: true, status: 429, reason: 'Too many requests — slow down and try again in a minute.' };

  if (opts.perDay &&
      await _hit(`rl:${b}:d:${dayStamp()}:${ip}`, opts.perDay, 86400))
    return { blocked: true, status: 429, reason: 'Daily limit reached for this endpoint. Try again tomorrow.' };

  if (opts.globalDay &&
      await _hit(`rl:${b}:g:${dayStamp()}`, opts.globalDay, 86400))
    return { blocked: true, status: 503, reason: 'Service is busy right now. Please try again later.' };

  return { blocked: false };
}

// Reflect an allowed Origin, else fall back to the primary app origin.
// Same-origin app calls are unaffected (browsers don't enforce CORS same-origin);
// this only stops OTHER websites from using our endpoints from a browser.
function allowedOrigin(req) {
  const o = req.headers && req.headers['origin'];
  return (o && ALLOWED_ORIGINS.includes(o)) ? o : 'https://orlixai.xyz';
}

// CORS header object (for endpoints that spread a CORS object into writeHead).
function corsHeaders(req, extra) {
  return Object.assign({
    'Access-Control-Allow-Origin': allowedOrigin(req),
    'Vary': 'Origin',
  }, extra || {});
}

module.exports = { checkLimits, allowedOrigin, corsHeaders, clientIp, ALLOWED_ORIGINS };
