// /api/b20-market — server-side market data, holders, trades, and wallet holdings.
// Proxies DexScreener / GeckoTerminal / Base Blockscout so the browser never has
// to make cross-origin calls (avoids CORS + rate-limit + indexing flakiness).
//
// GET ?token=0x..              → { ok, price, marketCap, volume24h, holders[], trades[], pool }
// GET ?holder=0x..[&tokens=..] → { ok, tokens:[{address,name,symbol,balance,decimals}] }  (B20, on-chain balanceOf)
// GET ?tokens=0x,0x            → { ok, markets:{addr:{price,marketCap,volume24h,lastTrade}} }
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
const RPC_URL    = 'https://mainnet.base.org';

async function getJson(url, timeout = 8000) {
  try {
    const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeout) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// ── Base RPC (ground-truth balances, independent of any indexer) ───────────────
async function rpcSingle(method, params) {
  try {
    const r = await fetch(RPC_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(9000),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d && d.result != null ? d.result : null;
  } catch { return null; }
}
async function rpcBatch(calls) {
  try {
    const body = calls.map((c, id) => ({ jsonrpc: '2.0', id, method: c.method, params: c.params }));
    const r = await fetch(RPC_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(9000),
    });
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d) ? d.sort((a, b) => a.id - b.id) : [];
  } catch { return []; }
}

function _strip0x(h) { return (h || '').startsWith('0x') ? h.slice(2) : (h || ''); }
function _decodeAbiString(hex) {
  const raw = _strip0x(hex);
  if (raw.length < 128) return '';
  const len = parseInt(raw.slice(64, 128), 16);
  if (!len || len > 256) return '';
  const chars = raw.slice(128, 128 + len * 2);
  let s = '';
  for (let i = 0; i < chars.length; i += 2) {
    const code = parseInt(chars.slice(i, i + 2), 16);
    if (code) s += String.fromCharCode(code);
  }
  return s;
}

// Upstash REST — read the "launched on Orlix" feed so holdings can be computed
// against every token we know about, not just what the client happened to pass.
async function redisCmd(args) {
  const url   = process.env.UPSTASH_REDIS_REST_URL   || process.env.STORAGE_UPSTASH_REDIS_REST_URL   || '';
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.STORAGE_UPSTASH_REDIS_REST_TOKEN || '';
  if (!url || !token) return undefined;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args.map(String)),
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return undefined;
    return (await r.json()).result;
  } catch { return undefined; }
}
async function fetchLaunchedAddresses() {
  const arr = await redisCmd(['LRANGE', 'b20:launched', '0', '199']);
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const s of arr) {
    let t; try { t = JSON.parse(s); } catch { continue; }
    if (t && t.address) out.push(t.address.toLowerCase());
  }
  return out;
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

// Batch market snapshot for the Discover card grid — one DexScreener multi-token
// call (up to 30 addresses) instead of one request per card. Picks the deepest
// pool per token and approximates "last trade" recency from m5/h1/h24 txn counts
// (DexScreener doesn't expose an exact last-trade timestamp in this endpoint).
async function getMarketBatch(addresses) {
  const uniq = [...new Set(addresses.map(a => a.toLowerCase()).filter(Boolean))].slice(0, 30);
  const out = {};
  if (!uniq.length) return out;
  const d = await getJson('https://api.dexscreener.com/latest/dex/tokens/' + uniq.join(','));
  const pairs = (d && d.pairs) || [];
  const byToken = {};
  for (const p of pairs) {
    const base = (p.baseToken?.address || '').toLowerCase();
    if (!uniq.includes(base)) continue;
    const liq = p.liquidity?.usd || 0;
    if (!byToken[base] || liq > (byToken[base].liquidity?.usd || 0)) byToken[base] = p;
  }
  for (const addr of uniq) {
    const p = byToken[addr];
    if (!p) { out[addr] = { price: null, marketCap: null, volume24h: null, lastTrade: null }; continue; }
    const txns = p.txns || {};
    const activity = (b) => (txns[b]?.buys || 0) + (txns[b]?.sells || 0) > 0;
    const lastTrade = activity('m5') ? 'm5' : activity('h1') ? 'h1' : activity('h6') ? 'h6' : activity('h24') ? 'h24' : null;
    out[addr] = {
      price:      p.priceUsd ? Number(p.priceUsd) : null,
      marketCap:  p.marketCap || p.fdv || null,
      volume24h:  p.volume?.h24 != null ? Number(p.volume.h24) : null,
      lastTrade,
    };
  }
  return out;
}

// Top holders, read straight from the chain. B20 tokens are precompile-based, so
// indexers (Blockscout/DexScreener) don't reliably list their holders — the chain
// is the source of truth. Scan Transfer events to discover every address that
// ever touched the token, then read live balanceOf and rank. For fresh tokens
// this is exact; the range cap keeps it fast for busy ones.
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
async function getHolders(ca) {
  try {
    const latestHex = await rpcSingle('eth_blockNumber', []);
    const latest = latestHex ? parseInt(latestHex, 16) : 0;
    if (!latest) return [];

    // Scan Transfer logs in small chunks and in one batched request — a single
    // 200k-block eth_getLogs times out on the public Base RPC, which is why the
    // holders came back empty. ~90k blocks ≈ 2 days on Base covers fresh tokens.
    const CHUNK = 9000, CHUNKS = 10;
    const ranges = [];
    for (let i = 0; i < CHUNKS; i++) {
      const hi = latest - i * CHUNK;
      const lo = Math.max(hi - CHUNK + 1, 0);
      if (hi < 0) break;
      ranges.push([lo, hi]);
      if (lo === 0) break;
    }
    const logResults = await rpcBatch(ranges.map(([lo, hi]) => ({
      method: 'eth_getLogs',
      params: [{ address: ca, fromBlock: '0x' + lo.toString(16), toBlock: '0x' + hi.toString(16), topics: [TRANSFER_TOPIC] }],
    })));

    const addrs = new Set();
    for (const r of logResults) {
      const logs = r && r.result;
      if (!Array.isArray(logs)) continue;
      for (const l of logs) {
        const t = l.topics || [];
        if (t[1]) addrs.add('0x' + t[1].slice(26).toLowerCase()); // from
        if (t[2]) addrs.add('0x' + t[2].slice(26).toLowerCase()); // to
      }
    }
    addrs.delete('0x0000000000000000000000000000000000000000');
    const list = [...addrs].slice(0, 120);
    if (!list.length) return [];

    const [bals, supHex] = await Promise.all([
      rpcBatch(list.map(a => ({ method: 'eth_call', params: [{ to: ca, data: '0x70a08231' + '000000000000000000000000' + a.slice(2) }, 'latest'] }))),
      rpcSingle('eth_call', [{ to: ca, data: '0x18160ddd' }, 'latest']),
    ]);
    let supply = 0n; try { supply = BigInt(supHex || '0x0'); } catch {}

    const held = [];
    list.forEach((a, i) => {
      let b = 0n; try { b = BigInt(bals[i] && bals[i].result || '0x0'); } catch {}
      if (b > 0n) held.push({ address: a, raw: b });
    });
    held.sort((x, y) => (x.raw < y.raw ? 1 : x.raw > y.raw ? -1 : 0));
    return held.slice(0, 10).map(h => ({
      address: h.address,
      pct: supply > 0n ? Number(h.raw * 10000n / supply) / 100 : null,
    }));
  } catch { return []; }
}

// GeckoTerminal: the token's deepest pool (address used for both the chart embed
// and the trades feed, so everything on the dashboard comes from one source).
async function getGeckoPool(ca) {
  const d = await getJson(`https://api.geckoterminal.com/api/v2/networks/base/tokens/${ca}/pools?page=1`);
  const pools = (d && d.data) || [];
  if (!pools.length) return null;
  // Pick the highest 24h-volume pool (GT usually returns them ranked already).
  const best = pools.sort((a, b) =>
    Number(b.attributes?.volume_usd?.h24 || 0) - Number(a.attributes?.volume_usd?.h24 || 0))[0];
  return (best && best.attributes && best.attributes.address) || null;
}

// GeckoTerminal: recent pool trades (buys/sells).
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

// Blockscout: discover extra B20 addresses a wallet touched (best-effort — only
// used to widen the candidate set; balances are always confirmed on-chain below).
async function discoverB20FromBlockscout(wallet) {
  const d = await getJson(`${BLOCKSCOUT}/addresses/${wallet}/tokens?type=ERC-20`);
  const items = (d && d.items) || [];
  const out = [];
  for (const it of items) {
    const tk = it.token || {};
    const addr = (tk.address || tk.address_hash || '').toLowerCase();
    if (addr && addr.startsWith('0xb2')) out.push(addr);
  }
  return out;
}

// Wallet's B20 holdings — read straight from the chain via balanceOf so it works
// the instant a token launches, independent of any indexer's crawl lag. Candidate
// set = the Orlix launched feed ∪ client-passed addresses ∪ Blockscout discovery;
// only the on-chain balance decides what's actually held.
async function getHoldings(wallet, extraTokens = []) {
  const [feed, discovered] = await Promise.all([
    fetchLaunchedAddresses(),
    discoverB20FromBlockscout(wallet).catch(() => []),
  ]);
  const candidates = [...new Set(
    [...feed, ...extraTokens, ...discovered]
      .map(a => (a || '').toLowerCase())
      .filter(a => /^0x[0-9a-f]{40}$/.test(a) && a.startsWith('0xb2'))
  )].slice(0, 80);
  if (!candidates.length) return [];

  const walletArg = '000000000000000000000000' + wallet.slice(2).toLowerCase();
  const balResults = await rpcBatch(candidates.map(addr => ({
    method: 'eth_call', params: [{ to: addr, data: '0x70a08231' + walletArg }, 'latest'],
  })));

  const held = [];
  candidates.forEach((addr, i) => {
    let raw = 0n;
    try { raw = BigInt(balResults[i]?.result || '0x0'); } catch {}
    if (raw > 0n) held.push({ address: addr, raw });
  });
  if (!held.length) return [];

  // Fetch name/symbol/decimals for the held tokens in one more batch.
  const metaCalls = [];
  held.forEach(h => {
    metaCalls.push({ method: 'eth_call', params: [{ to: h.address, data: '0x06fdde03' }, 'latest'] }); // name
    metaCalls.push({ method: 'eth_call', params: [{ to: h.address, data: '0x95d89b41' }, 'latest'] }); // symbol
    metaCalls.push({ method: 'eth_call', params: [{ to: h.address, data: '0x313ce567' }, 'latest'] }); // decimals
  });
  const meta = await rpcBatch(metaCalls);

  return held.map((h, i) => {
    const name   = _decodeAbiString(meta[i * 3]?.result) || 'Unknown';
    const symbol = _decodeAbiString(meta[i * 3 + 1]?.result) || '???';
    let dec = 18;
    try { dec = parseInt(meta[i * 3 + 2]?.result || '0x12', 16) || 18; } catch {}
    // Scale down without precision loss on huge balances.
    const balance = Number(h.raw / (10n ** BigInt(Math.max(dec - 6, 0)))) / 1e6;
    return { address: h.address, name, symbol, decimals: dec, balance };
  }).sort((a, b) => b.balance - a.balance);
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
    const tokensCsv = String(req.query?.tokens || '').trim();

    if (holder && /^0x[0-9a-fA-F]{40}$/.test(holder)) {
      // The client may pass ?tokens= to widen the candidate set with addresses it
      // already knows about (its created tokens, whatever's on Discover, etc.).
      const extra = tokensCsv ? tokensCsv.split(',').map(s => s.trim()).filter(a => /^0x[0-9a-fA-F]{40}$/.test(a)) : [];
      const tokens = await getHoldings(holder, extra);
      res.writeHead(200, CORS);
      return res.end(JSON.stringify({ ok: true, tokens }));
    }

    if (tokensCsv) {
      const addrs = tokensCsv.split(',').map(s => s.trim()).filter(a => /^0x[0-9a-fA-F]{40}$/.test(a));
      const markets = await getMarketBatch(addrs);
      res.writeHead(200, CORS);
      return res.end(JSON.stringify({ ok: true, markets }));
    }

    if (!/^0x[0-9a-fA-F]{40}$/.test(token)) {
      res.writeHead(400, CORS);
      return res.end(JSON.stringify({ ok: false, error: 'valid ?token= or ?holder= address required' }));
    }

    const [market, geckoPool] = await Promise.all([getMarket(token), getGeckoPool(token)]);
    // Trades come from GeckoTerminal's pool (fall back to the DexScreener pool if
    // GT hasn't indexed one yet); holders are read on-chain.
    const [holders, trades] = await Promise.all([
      getHolders(token),
      getTrades(geckoPool || market.pool),
    ]);
    res.writeHead(200, CORS);
    return res.end(JSON.stringify({ ok: true, ...market, geckoPool, holders, trades }));
  } catch (e) {
    res.writeHead(200, CORS);
    return res.end(JSON.stringify({ ok: false, error: e.message || 'market fetch failed' }));
  }
};
