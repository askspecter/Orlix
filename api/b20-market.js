// /api/b20-market — server-side market data, holders, trades, and wallet holdings.
// Proxies DexScreener / GeckoTerminal / Base Blockscout so the browser never has
// to make cross-origin calls (avoids CORS + rate-limit + indexing flakiness).
//
// GET ?token=0x..   → { ok, price, marketCap, volume24h, holders[], trades[], pool }
// GET ?holder=0x..  → { ok, tokens:[{address,name,symbol,balance,decimals}] }  (B20 only)
const { checkLimits, allowedOrigin } = require('./_guard');

const CORS = {
  'Access-Control-Allow-Origin': 'https://orlixai.xyz',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Vary': 'Origin',
  'Cache-Control': 's-maxage=15, stale-while-revalidate=45',
  'Content-Type': 'application/json',
};

const BLOCKSCOUT = 'https://base.blockscout.com/api/v2';

async function getJson(url, timeout = 8000) {
  try {
    const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeout) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// DexScreener price / market cap / 24h volume + the deepest pool address.
async function getMarket(ca) {
  const d = await getJson('https://api.dexscreener.com/latest/dex/tokens/' + ca);
  const pairs = (d && d.pairs) || [];
  if (!pairs.length) return { price: null, marketCap: null, volume24h: null, pool: null };
  const p = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
  return {
    price:      p.priceUsd ? Number(p.priceUsd) : null,
    marketCap:  p.marketCap || p.fdv || null,
    volume24h:  p.volume?.h24 != null ? Number(p.volume.h24) : null,
    pool:       p.pairAddress || null,
  };
}

// Base Blockscout: top holders + total supply → percentages.
async function getHolders(ca) {
  const [meta, hold] = await Promise.all([
    getJson(`${BLOCKSCOUT}/tokens/${ca}`),
    getJson(`${BLOCKSCOUT}/tokens/${ca}/holders`),
  ]);
  const items = (hold && hold.items) || [];
  let supply = 0n;
  try { supply = meta && meta.total_supply ? BigInt(meta.total_supply) : 0n; } catch {}
  return items.slice(0, 10).map(it => {
    const address = (it.address && it.address.hash) || it.address || '';
    let val = 0n; try { val = BigInt(it.value || '0'); } catch {}
    const pct = supply > 0n ? Number(val * 10000n / supply) / 100 : null;
    return { address, pct };
  });
}

// GeckoTerminal: recent pool trades.
async function getTrades(pool) {
  if (!pool) return [];
  const d = await getJson(`https://api.geckoterminal.com/api/v2/networks/base/pools/${pool}/trades`);
  const list = (d && d.data) || [];
  return list.slice(0, 12).map(t => {
    const a = t.attributes || {};
    return {
      kind: (a.kind || '').toLowerCase() === 'buy' ? 'buy' : 'sell',
      usd:  Number(a.volume_in_usd || 0),
      from: a.tx_from_address || '',
      ts:   a.block_timestamp ? Date.parse(a.block_timestamp) : null,
    };
  });
}

// Base Blockscout: ERC-20 tokens held by a wallet, filtered to B20 (0xb2… factory).
async function getHoldings(wallet) {
  const d = await getJson(`${BLOCKSCOUT}/addresses/${wallet}/tokens?type=ERC-20`);
  const items = (d && d.items) || [];
  const out = [];
  for (const it of items) {
    const tk = it.token || {};
    const addr = tk.address || tk.address_hash || '';
    if (!addr || !addr.toLowerCase().startsWith('0xb2')) continue;   // B20 only
    const dec = Number(tk.decimals) || 18;
    let bal = 0;
    try { bal = Number(BigInt(it.value || '0') / (10n ** BigInt(Math.max(dec - 6, 0)))) / 1e6; } catch {}
    out.push({
      address: addr,
      name:    tk.name || 'Unknown',
      symbol:  tk.symbol || '???',
      decimals: dec,
      balance: bal,
    });
    if (out.length >= 50) break;
  }
  return out;
}

module.exports = async (req, res) => {
  CORS['Access-Control-Allow-Origin'] = allowedOrigin(req);
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (req.method !== 'GET') { res.writeHead(405, CORS); return res.end(JSON.stringify({ ok: false, error: 'GET only' })); }

  const _lim = await checkLimits(req, { bucket: 'b20market', perMin: 60, perDay: 2000, globalDay: 40000 });
  if (_lim.blocked) { res.writeHead(_lim.status, CORS); return res.end(JSON.stringify({ ok: false, error: _lim.reason })); }

  try {
    const token  = String(req.query?.token  || '').trim();
    const holder = String(req.query?.holder || '').trim();

    if (holder && /^0x[0-9a-fA-F]{40}$/.test(holder)) {
      const tokens = await getHoldings(holder);
      res.writeHead(200, CORS);
      return res.end(JSON.stringify({ ok: true, tokens }));
    }

    if (!/^0x[0-9a-fA-F]{40}$/.test(token)) {
      res.writeHead(400, CORS);
      return res.end(JSON.stringify({ ok: false, error: 'valid ?token= or ?holder= address required' }));
    }

    const market  = await getMarket(token);
    const [holders, trades] = await Promise.all([getHolders(token), getTrades(market.pool)]);
    res.writeHead(200, CORS);
    return res.end(JSON.stringify({ ok: true, ...market, holders, trades }));
  } catch (e) {
    res.writeHead(200, CORS);
    return res.end(JSON.stringify({ ok: false, error: e.message || 'market fetch failed' }));
  }
};
