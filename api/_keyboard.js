// /api/keyboard — compact, fast endpoint for the Orlix Keyboard (mobile IME).
// Served through /api/search?__svc=kb (rewritten from /api/keyboard) so it does
// NOT count as an extra Vercel serverless function.
//
//   GET /api/keyboard?q=PEPE        → one best-match token, compact
//   GET /api/keyboard?q=0x…         → same, by address
//   GET /api/keyboard?trending=1    → top 5 chips for the suggestion strip
//
// Designed for keyboards: tiny payloads, ~1 RTT, s-maxage CDN cache, and a
// deterministic heuristic "signal" (NOT AI — keyboards need <1s responses).
const { checkLimits, allowedOrigin } = require('./_guard');

const CORS = {
  'Access-Control-Allow-Origin': '*',        // keyboard app is not a browser page
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 's-maxage=30, stale-while-revalidate=60',
  'Content-Type': 'application/json',
};

const CHAINS = new Set(['robinhood']);

function fmtUsd(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + n.toFixed(2);
}
function fmtPrice(p) {
  p = Number(p) || 0;
  if (p === 0) return '$0';
  if (p >= 1) return '$' + p.toFixed(2);
  if (p >= 0.001) return '$' + p.toFixed(4);
  return '$' + p.toPrecision(2);
}

// Deterministic quick signal — honest heuristics, not an AI verdict.
function signalOf(p) {
  const liq = p.liquidity?.usd || 0;
  const vol = p.volume?.h24 || 0;
  const ch = p.priceChange?.h24 ?? 0;
  if (liq < 5000)  return { tag: 'RISKY',  note: 'Very low liquidity' };
  if (liq < 25000) return { tag: 'WATCH',  note: 'Thin liquidity — trade small' };
  if (vol < 1000)  return { tag: 'QUIET',  note: 'Almost no 24h volume' };
  if (ch <= -30)   return { tag: 'WATCH',  note: 'Down sharply today' };
  return { tag: 'ACTIVE', note: 'Healthy liquidity & volume' };
}

function pick(pairs) {
  return (pairs || [])
    .filter(p => CHAINS.has(p.chainId) && p.baseToken?.address)
    .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0] || null;
}

function compact(p) {
  const sig = signalOf(p);
  const ch = p.priceChange?.h24;
  return {
    symbol: p.baseToken.symbol,
    name:   p.baseToken.name,
    chain:  p.chainId,
    address: p.baseToken.address.toLowerCase(),
    price:  fmtPrice(p.priceUsd),
    ch24:   ch != null ? (ch >= 0 ? '+' : '') + Number(ch).toFixed(1) + '%' : null,
    up:     (ch ?? 0) >= 0,
    mcap:   p.marketCap || p.fdv ? fmtUsd(p.marketCap || p.fdv) : null,
    liq:    fmtUsd(p.liquidity?.usd || 0),
    signal: sig.tag,
    note:   sig.note,
    url:    `https://orlixai.xyz/app`,
    dex:    p.url || `https://dexscreener.com/${p.chainId}/${p.baseToken.address}`,
    // Ready-to-insert chat text — one tap on the keyboard commits this string.
    insert: `$${p.baseToken.symbol} ${fmtPrice(p.priceUsd)} (${ch != null ? (ch >= 0 ? '+' : '') + Number(ch).toFixed(1) + '%' : '—'} 24h) · via Orlix`,
  };
}

const TRENDING_SEEDS = ['ORLIX', 'BRETT', 'DEGEN', 'VIRTUAL', 'AERO'];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (req.method !== 'GET') { res.writeHead(405, CORS); return res.end(JSON.stringify({ ok: false, error: 'GET only' })); }

  const _lim = await checkLimits(req, { bucket: 'kb', perMin: 60, perDay: 3000, globalDay: 100000 });
  if (_lim.blocked) { res.writeHead(_lim.status, CORS); return res.end(JSON.stringify({ ok: false, error: _lim.reason })); }

  try {
    // Trending chips for the suggestion strip
    if (req.query?.trending) {
      const results = await Promise.all(TRENDING_SEEDS.map(q =>
        fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(6000) })
          .then(r => r.ok ? r.json() : null).catch(() => null)));
      const chips = [];
      for (const r of results) {
        const p = pick(r?.pairs);
        if (p) chips.push(compact(p));
        if (chips.length >= 5) break;
      }
      res.writeHead(200, CORS);
      return res.end(JSON.stringify({ ok: true, chips }));
    }

    const q = String(req.query?.q || '').trim().replace(/^\$/, '').slice(0, 64);
    if (!q) { res.writeHead(400, CORS); return res.end(JSON.stringify({ ok: false, error: 'q required (ticker or 0x address)' })); }

    const r = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(7000) });
    if (!r.ok) throw new Error('upstream ' + r.status);
    const d = await r.json();

    // Prefer exact symbol match on our chains, then deepest liquidity.
    const exact = (d.pairs || []).filter(p =>
      CHAINS.has(p.chainId) && (p.baseToken?.symbol || '').toUpperCase() === q.toUpperCase());
    const best = pick(exact.length ? exact : d.pairs);

    if (!best) { res.writeHead(200, CORS); return res.end(JSON.stringify({ ok: true, found: false, q })); }
    res.writeHead(200, CORS);
    return res.end(JSON.stringify({ ok: true, found: true, token: compact(best) }));
  } catch (e) {
    res.writeHead(502, CORS);
    return res.end(JSON.stringify({ ok: false, error: e.message || 'lookup failed' }));
  }
};
