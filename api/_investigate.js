// Orlix AI — Onchain Investigation Engine
// Shared detective toolkit for the Telegram bot (and anywhere else).
//
// Give it one clue — a wallet, a token, a deployer — and it unrolls the rest
// of the network: money trails, side-wallet clusters, deployer rap sheets,
// early buyers, and full rug dossiers. Everything is request-driven and built
// on public data (Basescan + Blockscout + DexScreener), cached in Upstash so a
// repeated trace comes back instantly.

const BASE_RPC = 'https://mainnet.base.org';
const BSCAN     = 'https://api.basescan.org/api';
const BLOCKSCOUT = 'https://base.blockscout.com/api/v2';
const WETH      = '0x4200000000000000000000000000000000000006';

const short = a => a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '?';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Basescan helper (free tier: ~5 req/s, so we self-throttle) ───────────────
let _lastCall = 0;
async function bscan(params, { timeout = 9000 } = {}) {
  const key = process.env.BASESCAN_API_KEY || '';
  const wait = 220 - (Date.now() - _lastCall);
  if (wait > 0) await sleep(wait);
  _lastCall = Date.now();
  const qs = new URLSearchParams({ ...params, apikey: key }).toString();
  const r = await fetch(`${BSCAN}?${qs}`, { signal: AbortSignal.timeout(timeout) }).catch(() => null);
  if (!r || !r.ok) return { status: '0', result: [] };
  return r.json().catch(() => ({ status: '0', result: [] }));
}

async function rpc(method, params = []) {
  const r = await fetch(BASE_RPC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(8000),
  }).catch(() => null);
  if (!r) return null;
  const d = await r.json().catch(() => ({}));
  return d.result ?? null;
}

// ── Redis cache (optional; degrades gracefully if not configured) ────────────
function redisCreds() {
  return {
    url:   process.env.UPSTASH_REDIS_REST_URL   || process.env.STORAGE_UPSTASH_REDIS_REST_URL   || '',
    token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.STORAGE_UPSTASH_REDIS_REST_TOKEN || '',
  };
}
async function redis(...args) {
  const { url, token } = redisCreds();
  if (!url || !token) return null;
  const r = await fetch(`${url}/${args.map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000),
  }).catch(() => null);
  if (!r || !r.ok) return null;
  const d = await r.json().catch(() => ({}));
  return d.result ?? null;
}
async function cacheGet(k) { const v = await redis('GET', k); try { return v ? JSON.parse(v) : null; } catch { return null; } }
async function cacheSet(k, v, ttl = 900) { await redis('SET', k, JSON.stringify(v), 'EX', String(ttl)); }

// ── Price / market helper ────────────────────────────────────────────────────
async function dexData(token) {
  const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token}`, {
    headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000),
  }).catch(() => null);
  if (!r || !r.ok) return null;
  const d = await r.json().catch(() => ({}));
  const pairs = (d.pairs || []).filter(p => p.chainId === 'base' || p.chainId === 'robinhood');
  const pool = pairs.length ? pairs : (d.pairs || []);
  if (!pool.length) return null;
  return pool.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
}

function fmtUsd(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + n.toFixed(2);
}
function ageFrom(ts) {
  if (!ts) return '?';
  const s = Math.max(0, Date.now() / 1000 - Number(ts));
  const d = s / 86400;
  if (d >= 365) return (d / 365).toFixed(1) + 'y';
  if (d >= 1)   return Math.floor(d) + 'd';
  const h = s / 3600;
  if (h >= 1)   return Math.floor(h) + 'h';
  return Math.max(1, Math.floor(s / 60)) + 'm';
}

// ── 1. FUNDING TRACE — follow the money up the chain ─────────────────────────
// Finds the first inbound ETH transfer to a wallet → that's its funder → recurse.
// Returns the chain of hops with amounts, timestamps, and known-entity labels.
const KNOWN = {
  '0x6b75d8af000000e20b7a7ddf000ba900b4009a80': 'Bybit',
  '0x28c6c06298d514db089934071355e5743bf21d60': 'Binance',
  '0x503828976d22510aad0201ac7ec88293211d23da': 'Coinbase',
  '0x71660c4005ba85c37ccec55d0c4493e66fe775d3': 'Coinbase',
  '0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43': 'Coinbase',
  '0x3304e22ddaa22bcdc5fca2269b418046ae7b566a': 'Coinbase',
  '0xdfd5293d8e347dfe59e90efd55b2956a1343963d': 'Binance',
  '0x46340b20830761efd32832a74d7169b29feb9758': 'Crypto.com',
  '0x0d0707963952f2fba59dd06f2b425ace40b492fe': 'Gate.io',
  '0xf89d7b9c864f589bbf53a82105107622b35eaa40': 'Bybit',
  '0x00000000219ab540356cbb839cbe05303d7705fa': 'ETH2 Deposit',
  '0x1111111254eeb25477b68fb85ed929f73a960582': '1inch',
  '0x2626664c2603336e57b271c5c0b26f421741e481': 'Uniswap Router',
  '0x6ff5693b99212da76ad316178a184ab56d299b43': 'Uniswap Router',
  '0x827922686190790b37229fd06084350e74485b72': 'Bridge',
  '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad': 'Uniswap Router',
};
function label(addr) { return KNOWN[addr?.toLowerCase()] || null; }

async function firstFunder(wallet) {
  // Basescan: earliest normal txs, look for first inbound with value > 0
  const j = await bscan({ module: 'account', action: 'txlist', address: wallet,
    startblock: '0', endblock: '99999999', page: '1', offset: '50', sort: 'asc' });
  const txs = Array.isArray(j.result) ? j.result : [];
  for (const t of txs) {
    if (t.to?.toLowerCase() === wallet.toLowerCase() && BigInt(t.value || '0') > 0n && t.isError === '0') {
      return { from: t.from.toLowerCase(), value: Number(t.value) / 1e18, ts: Number(t.timeStamp), hash: t.hash };
    }
  }
  // Fallback: internal txs (funded by a contract / bridge)
  const ij = await bscan({ module: 'account', action: 'txlistinternal', address: wallet,
    startblock: '0', endblock: '99999999', page: '1', offset: '50', sort: 'asc' });
  const itxs = Array.isArray(ij.result) ? ij.result : [];
  for (const t of itxs) {
    if (t.to?.toLowerCase() === wallet.toLowerCase() && BigInt(t.value || '0') > 0n) {
      return { from: t.from.toLowerCase(), value: Number(t.value) / 1e18, ts: Number(t.timeStamp), hash: t.hash, internal: true };
    }
  }
  return null;
}

async function traceFunding(wallet, maxHops = 6) {
  wallet = wallet.toLowerCase();
  const ck = `inv:trace:${wallet}:${maxHops}`;
  const cached = await cacheGet(ck);
  if (cached) return cached;

  const hops = [];
  const seen = new Set([wallet]);
  let cur = wallet;
  for (let i = 0; i < maxHops; i++) {
    const f = await firstFunder(cur);
    if (!f) { hops.push({ end: true, reason: 'no-inbound', addr: cur }); break; }
    const lbl = label(f.from);
    hops.push({ from: f.from, value: f.value, ts: f.ts, hash: f.hash, label: lbl, internal: !!f.internal });
    if (lbl) { hops[hops.length - 1].terminal = true; break; }     // hit a CEX / bridge → source found
    if (seen.has(f.from)) { hops[hops.length - 1].loop = true; break; }
    seen.add(f.from);
    cur = f.from;
  }
  const out = { wallet, hops };
  await cacheSet(ck, out, 1800);
  return out;
}

// ── 2. WALLET CLUSTER — side wallets sharing a funder ────────────────────────
// Given a wallet, find its funder, then list OTHER wallets that same funder
// seeded around the same time. Classic sybil / side-wallet fingerprint.
async function walletCluster(wallet) {
  wallet = wallet.toLowerCase();
  const ck = `inv:cluster:${wallet}`;
  const cached = await cacheGet(ck);
  if (cached) return cached;

  const f = await firstFunder(wallet);
  if (!f) { const out = { wallet, funder: null, siblings: [] }; await cacheSet(ck, out, 900); return out; }

  // All outbound value txs from the funder → the wallets it seeded
  const j = await bscan({ module: 'account', action: 'txlist', address: f.from,
    startblock: '0', endblock: '99999999', page: '1', offset: '200', sort: 'asc' });
  const txs = Array.isArray(j.result) ? j.result : [];
  const sib = new Map();
  for (const t of txs) {
    if (t.from?.toLowerCase() === f.from && BigInt(t.value || '0') > 0n && t.to && t.to.toLowerCase() !== wallet) {
      const to = t.to.toLowerCase();
      if (label(to)) continue;                          // skip sends back to exchanges
      if (!sib.has(to)) sib.set(to, { addr: to, value: Number(t.value) / 1e18, ts: Number(t.timeStamp), count: 0 });
      sib.get(to).count++;
    }
  }
  const siblings = [...sib.values()].sort((a, b) => a.ts - b.ts).slice(0, 12);
  const out = { wallet, funder: { addr: f.from, label: label(f.from), value: f.value, ts: f.ts }, siblings };
  await cacheSet(ck, out, 900);
  return out;
}

// ── 3. DEPLOYER RAP SHEET — every token a creator has launched ───────────────
async function contractCreator(token) {
  const j = await bscan({ module: 'contract', action: 'getcontractcreation', contractaddresses: token });
  const row = Array.isArray(j.result) ? j.result[0] : null;
  if (!row) return null;
  return { creator: row.contractCreator?.toLowerCase(), hash: row.txHash };
}

async function deployerRapSheet(token) {
  token = token.toLowerCase();
  const ck = `inv:deployer:${token}`;
  const cached = await cacheGet(ck);
  if (cached) return cached;

  const cc = await contractCreator(token);
  if (!cc?.creator) { const out = { token, creator: null, deploys: [] }; await cacheSet(ck, out, 900); return out; }

  // Scan the creator's outbound txs for contract-creation (to == null → contractAddress)
  const j = await bscan({ module: 'account', action: 'txlist', address: cc.creator,
    startblock: '0', endblock: '99999999', page: '1', offset: '2000', sort: 'asc' });
  const txs = Array.isArray(j.result) ? j.result : [];
  const created = [];
  for (const t of txs) {
    if ((!t.to || t.to === '') && t.contractAddress) {
      created.push({ addr: t.contractAddress.toLowerCase(), ts: Number(t.timeStamp) });
    }
  }
  // Enrich up to ~10 most recent deploys with market data (parallel, capped)
  const recent = created.slice(-12).reverse();
  const enriched = [];
  await Promise.all(recent.map(async c => {
    const dx = await dexData(c.addr).catch(() => null);
    enriched.push({
      addr: c.addr, ts: c.ts,
      symbol: dx?.baseToken?.symbol || null,
      mcap: dx?.marketCap || dx?.fdv || 0,
      liq: dx?.liquidity?.usd || 0,
      ch24: dx?.priceChange?.h24 ?? null,
      dead: dx ? (dx.liquidity?.usd || 0) < 1000 : null,
      url: dx?.url || null,
    });
  }));
  enriched.sort((a, b) => b.ts - a.ts);
  const out = {
    token, creator: cc.creator, totalDeploys: created.length,
    firstDeploy: created[0]?.ts || null, deploys: enriched,
  };
  await cacheSet(ck, out, 900);
  return out;
}

// ── 4. EARLY BUYERS — first wallets to receive the token, and who held ───────
async function earlyBuyers(token, n = 12) {
  token = token.toLowerCase();
  const ck = `inv:early:${token}`;
  const cached = await cacheGet(ck);
  if (cached) return cached;

  const j = await bscan({ module: 'account', action: 'tokentx', contractaddress: token,
    page: '1', offset: '400', sort: 'asc' });
  const txs = Array.isArray(j.result) ? j.result : [];
  const dec = txs[0]?.tokenDecimal ? Number(txs[0].tokenDecimal) : 18;
  const firstBuyers = [];
  const seen = new Set();
  for (const t of txs) {
    const to = t.to?.toLowerCase();
    if (!to || seen.has(to)) continue;
    if (to === '0x0000000000000000000000000000000000000000') continue;
    if (label(to)) continue;
    // skip the LP pair / router (they receive tokens as liquidity)
    seen.add(to);
    firstBuyers.push({ addr: to, ts: Number(t.timeStamp), got: Number(t.value) / 10 ** dec });
    if (firstBuyers.length >= n) break;
  }
  // Current balance → still holding?
  await Promise.all(firstBuyers.map(async b => {
    const bal = await rpc('eth_call', [{ to: token,
      data: '0x70a08231' + b.addr.slice(2).padStart(64, '0') }, 'latest']).catch(() => null);
    const cur = bal && bal !== '0x' ? Number(BigInt(bal)) / 10 ** dec : 0;
    b.holding = cur;
    b.pctLeft = b.got > 0 ? Math.min(100, (cur / b.got) * 100) : 0;
    b.status = b.pctLeft >= 90 ? 'diamond' : b.pctLeft <= 5 ? 'sold' : 'trimmed';
  }));
  const out = { token, buyers: firstBuyers };
  await cacheSet(ck, out, 900);
  return out;
}

// ── 5. RUG DOSSIER — one-shot risk report on a token ─────────────────────────
async function rugDossier(token) {
  token = token.toLowerCase();
  const ck = `inv:dossier:${token}`;
  const cached = await cacheGet(ck);
  if (cached) return cached;

  const [dx, cc, holdersRes] = await Promise.all([
    dexData(token).catch(() => null),
    contractCreator(token).catch(() => null),
    fetch(`${BLOCKSCOUT}/tokens/${token}/holders?limit=15`, { signal: AbortSignal.timeout(8000) })
      .then(r => r.ok ? r.json() : null).catch(() => null),
  ]);

  // Holder concentration
  let topConc = null, holderList = [];
  if (holdersRes?.items?.length) {
    const supply = dx?.baseToken ? null : null;
    holderList = holdersRes.items.slice(0, 10).map(h => ({
      addr: (h.address?.hash || '').toLowerCase(),
      pct: h.value && dx?.fdv ? null : null,
      val: h.value,
    }));
  }

  // Dev wallet profile
  let dev = null;
  if (cc?.creator) {
    const trace = await traceFunding(cc.creator, 3).catch(() => null);
    const rap = await deployerRapSheet(token).catch(() => null);
    // dev's first activity = wallet age
    const fj = await bscan({ module: 'account', action: 'txlist', address: cc.creator,
      startblock: '0', endblock: '99999999', page: '1', offset: '1', sort: 'asc' });
    const firstTs = Array.isArray(fj.result) && fj.result[0] ? Number(fj.result[0].timeStamp) : null;
    dev = {
      addr: cc.creator,
      age: firstTs ? ageFrom(firstTs) : '?',
      fundedBy: trace?.hops?.find(h => h.label)?.label || (trace?.hops?.[0]?.from ? short(trace.hops[0].from) : '?'),
      deploys: rap?.totalDeploys ?? null,
      priorRugs: rap?.deploys?.filter(d => d.dead).length ?? null,
    };
  }

  // Risk scoring
  const flags = [];
  const liq = dx?.liquidity?.usd || 0;
  const mcap = dx?.marketCap || dx?.fdv || 0;
  if (liq < 5000) flags.push('Very low liquidity (<$5K)');
  if (mcap > 0 && liq > 0 && liq / mcap < 0.02) flags.push('Liquidity <2% of mcap');
  if (dev?.priorRugs > 0) flags.push(`Dev has ${dev.priorRugs} prior dead token(s)`);
  if (dev?.deploys > 5) flags.push(`Dev is a serial deployer (${dev.deploys} tokens)`);
  if (dx?.pairCreatedAt && Date.now() - dx.pairCreatedAt < 3600_000) flags.push('Pair <1h old');
  if ((dx?.txns?.h24?.sells || 0) === 0 && (dx?.txns?.h24?.buys || 0) > 20) flags.push('Buys but zero sells (honeypot?)');

  const score = Math.max(0, 100 - flags.length * 18 - (liq < 1000 ? 25 : 0));
  const out = {
    token, symbol: dx?.baseToken?.symbol || '?', name: dx?.baseToken?.name || 'Unknown',
    price: dx?.priceUsd || null, mcap, liq, ch24: dx?.priceChange?.h24 ?? null,
    ageStr: dx?.pairCreatedAt ? ageFrom(dx.pairCreatedAt / 1000) : '?',
    dev, flags, score,
    verdict: score >= 70 ? 'LOW RISK' : score >= 45 ? 'CAUTION' : 'HIGH RISK',
    url: dx?.url || null,
  };
  await cacheSet(ck, out, 600);
  return out;
}

module.exports = {
  short, fmtUsd, ageFrom, label,
  traceFunding, walletCluster, deployerRapSheet, earlyBuyers, rugDossier,
  contractCreator, firstFunder, dexData, rpc, bscan, redis,
};
