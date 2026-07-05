// Orlix AI — Onchain Investigation Engine
// Shared detective toolkit for the Telegram bot (and anywhere else).
//
// Give it one clue — a wallet, a token, a deployer — and it unrolls the rest
// of the network: money trails, side-wallet clusters, deployer rap sheets,
// early buyers, and full rug dossiers. Everything is request-driven and built
// on public data (Basescan + Blockscout + DexScreener), cached in Upstash so a
// repeated trace comes back instantly.

const BASE_RPC = 'https://mainnet.base.org';
// Blockscout exposes an Etherscan-compatible API at /api with NO key required,
// and it actually returns data for Base (the legacy api.basescan.org V1 endpoint
// now returns empty, and Etherscan V2 gates Base behind a paid plan). So we use
// Blockscout as the primary source — the response shape ({result:[...]}) matches
// what the Etherscan-style callers below already expect.
const BSCAN      = 'https://base.blockscout.com/api';
const BLOCKSCOUT = 'https://base.blockscout.com/api/v2';
const WETH      = '0x4200000000000000000000000000000000000006';

const short = a => a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '?';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Onchain data helper (Blockscout etherscan-compatible endpoint) ───────────
// Self-throttled to be a good citizen. Returns { result: [...] } on success.
let _lastCall = 0;
async function bscan(params, { timeout = 9000 } = {}) {
  const wait = 160 - (Date.now() - _lastCall);
  if (wait > 0) await sleep(wait);
  _lastCall = Date.now();
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`${BSCAN}?${qs}`, { signal: AbortSignal.timeout(timeout) }).catch(() => null);
  if (!r || !r.ok) return { status: '0', result: [] };
  const j = await r.json().catch(() => ({ status: '0', result: [] }));
  // Blockscout returns message:"OK" (not status:"1"); normalise result to array
  if (!Array.isArray(j.result)) j.result = [];
  return j;
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

// Burn / mint / system contracts that should never count as a "buyer" or "sibling"
const SYSTEM = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
  '0x0000000071727de22e5e9d8baf0edac6f37da032', // ERC-4337 EntryPoint v0.7
  '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789', // ERC-4337 EntryPoint v0.6
  '0x4200000000000000000000000000000000000006', // WETH
]);
function isSystem(addr) {
  const a = addr?.toLowerCase();
  return !a || SYSTEM.has(a) || /^0x0+$/.test(a) || a.endsWith('dead');
}

// Launchpad factories / deployers + AMM infra. Tokens minted through these keep
// the real human creator OFF the contract (owner()==factory), so we resolve the
// creator from who receives the initial creator allocation instead.
const FACTORY = {
  '0x660eaaedebc968f8f3694354fa8ec0b4c5ba8d12': 'Bankr/Clanker',
};
const INFRA = new Set([
  '0x498581ff718922c3f8e6a244956af099b2652b2b', // Uniswap v4 PoolManager (Base)
  '0x827922686190790b37229fd06084350e74485b72', // Uniswap v3 pos manager-ish
  '0x2626664c2603336e57b271c5c0b26f421741e481', // Uniswap universal router
  '0x6ff5693b99212da76ad316178a184ab56d299b43', // router
]);
function factoryName(addr) { return FACTORY[addr?.toLowerCase()] || null; }
function isInfra(addr) {
  const a = addr?.toLowerCase();
  return isSystem(a) || !!FACTORY[a] || INFRA.has(a);
}

async function firstFunder(wallet) {
  wallet = wallet.toLowerCase();
  // 1) earliest normal tx that actually sent ETH in (real funding)
  const j = await bscan({ module: 'account', action: 'txlist', address: wallet,
    startblock: '0', endblock: '99999999', page: '1', offset: '80', sort: 'asc' });
  const txs = Array.isArray(j.result) ? j.result : [];
  for (const t of txs) {
    if (t.to?.toLowerCase() === wallet && BigInt(t.value || '0') > 0n && t.isError === '0' && !isSystem(t.from)) {
      return { from: t.from.toLowerCase(), value: Number(t.value) / 1e18, ts: Number(t.timeStamp), hash: t.hash };
    }
  }
  // 2) internal value transfer (funded by a contract / bridge / disperser)
  const ij = await bscan({ module: 'account', action: 'txlistinternal', address: wallet,
    startblock: '0', endblock: '99999999', page: '1', offset: '80', sort: 'asc' });
  const itxs = Array.isArray(ij.result) ? ij.result : [];
  for (const t of itxs) {
    if (t.to?.toLowerCase() === wallet && BigInt(t.value || '0') > 0n && !isSystem(t.from)) {
      return { from: t.from.toLowerCase(), value: Number(t.value) / 1e18, ts: Number(t.timeStamp), hash: t.hash, internal: true };
    }
  }
  // 3) gasless / smart-wallet: no ETH ever came in → whoever FIRST interacted with
  //    (created / relayed for) this address is its controller. value=0 but it's the link.
  for (const t of txs) {
    if (t.to?.toLowerCase() === wallet && !isSystem(t.from) && t.from.toLowerCase() !== wallet) {
      return { from: t.from.toLowerCase(), value: 0, ts: Number(t.timeStamp), hash: t.hash, gasless: true };
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
      if (label(to) || isSystem(to)) continue;          // skip exchanges + system addrs
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
  token = token.toLowerCase();
  let onchainCreator = null, creationHash = null;

  // Blockscout V2 address endpoint carries the on-chain creator + creation tx.
  const r = await fetch(`${BLOCKSCOUT}/addresses/${token}`, { signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (r && r.ok) {
    const d = await r.json().catch(() => ({}));
    const c = d.creator_address_hash?.toLowerCase();
    if (c && !isSystem(c)) { onchainCreator = c; creationHash = d.creation_transaction_hash || null; }
  }
  if (!onchainCreator) {
    const j = await bscan({ module: 'contract', action: 'getcontractcreation', contractaddresses: token });
    const row = Array.isArray(j.result) && j.result.length ? j.result[0] : null;
    if (row?.contractCreator && !isSystem(row.contractCreator)) { onchainCreator = row.contractCreator.toLowerCase(); creationHash = row.txHash; }
  }

  // If the on-chain creator is a real EOA (not a launchpad factory), use it.
  if (onchainCreator && !factoryName(onchainCreator)) {
    return { creator: onchainCreator, hash: creationHash, via: 'onchain' };
  }

  // Factory/launchpad token (Bankr/Clanker etc): the human creator is whoever
  // receives the initial creator allocation from the deploy/LP cluster. Scan the
  // first transfers, mark the mint→LP forwarding chain as infra, and take the
  // first sizeable transfer to a real EOA — that's the dev's allocation.
  const factory = onchainCreator && factoryName(onchainCreator) ? factoryName(onchainCreator) : 'factory';
  const supply = await tokenSupply(token);
  const tj = await bscan({ module: 'account', action: 'tokentx', contractaddress: token, page: '1', offset: '60', sort: 'asc' });
  const txs = Array.isArray(tj.result) ? tj.result : [];
  const dec = txs[0]?.tokenDecimal ? Number(txs[0].tokenDecimal) : 18;
  // Distribution sources = the mint recipient + big pass-through holders (factory,
  // LP locker, treasury) — but NOT the AMM pool/router (those are trading venues,
  // and receiving FROM the pool means a *buy*, not a creator allocation).
  const distSrc = new Set();
  for (const t of txs) {
    const to = t.to?.toLowerCase();
    if (INFRA.has(to)) continue;   // never treat the pool/router as a distribution source
    if (t.from?.toLowerCase() === '0x0000000000000000000000000000000000000000') distSrc.add(to);
    if (supply && Number(t.value) / 10 ** dec >= supply * 0.40) distSrc.add(to);
  }
  const minAlloc = supply ? supply * 0.003 : 0;   // ≥0.3% of supply
  const maxAlloc = supply ? supply * 0.40 : Infinity;
  for (const t of txs) {
    const to = t.to?.toLowerCase(), from = t.from?.toLowerCase();
    if (!to || isInfra(to) || distSrc.has(to) || to === token) continue;
    const amt = Number(t.value) / 10 ** dec;
    if (minAlloc && (amt < minAlloc || amt > maxAlloc)) continue;
    if (!from || !distSrc.has(from)) continue;   // must come from the deploy cluster
    return { creator: to, hash: t.hash, via: 'factory-alloc', factory, onchain: onchainCreator };
  }

  // Fee-recipient signal (Clanker-style): the creator earns LP fees, paid out from
  // the locker over time. Scan RECENT transfers and find the EOA that keeps
  // receiving from the distribution cluster (not the pool). That's the dev.
  if (distSrc.size) {
    const rj = await bscan({ module: 'account', action: 'tokentx', contractaddress: token, page: '1', offset: '1000', sort: 'desc' });
    const rtxs = Array.isArray(rj.result) ? rj.result : [];
    const tally = new Map();  // addr → { amt, count }
    for (const t of rtxs) {
      const from = t.from?.toLowerCase(), to = t.to?.toLowerCase();
      if (!distSrc.has(from)) continue;
      if (!to || isInfra(to) || distSrc.has(to) || to === token) continue;
      const e = tally.get(to) || { amt: 0, count: 0 };
      e.amt += Number(t.value) / 10 ** dec; e.count++;
      tally.set(to, e);
    }
    // rank by payout count first (recurring = fee recipient), then amount
    const best = [...tally.entries()].sort((a, b) => (b[1].count - a[1].count) || (b[1].amt - a[1].amt))[0];
    if (best) return { creator: best[0], hash: null, via: 'fee-recipient', factory, onchain: onchainCreator };
  }

  // Last resort: first mint recipient (may be the factory — better than nothing)
  for (const t of txs) {
    if (t.from?.toLowerCase() === '0x0000000000000000000000000000000000000000') {
      const to = t.to?.toLowerCase();
      if (to && !isSystem(to)) return { creator: to, hash: t.hash, via: 'first-mint', factory, onchain: onchainCreator };
    }
  }
  return onchainCreator ? { creator: onchainCreator, hash: creationHash, via: 'factory', factory } : null;
}

// total supply (human units) via RPC totalSupply()
async function tokenSupply(token) {
  const hex = await rpc('eth_call', [{ to: token, data: '0x18160ddd' }, 'latest']).catch(() => null);
  if (!hex || hex === '0x') return null;
  const decHex = await rpc('eth_call', [{ to: token, data: '0x313ce567' }, 'latest']).catch(() => null);
  const dec = decHex && decHex !== '0x' ? parseInt(decHex, 16) : 18;
  try { return Number(BigInt(hex)) / 10 ** dec; } catch { return null; }
}

async function deployerRapSheet(token) {
  token = token.toLowerCase();
  const ck = `inv:deployer:${token}`;
  const cached = await cacheGet(ck);
  if (cached) return cached;

  const cc = await contractCreator(token);
  if (!cc?.creator) { const out = { token, creator: null, deploys: [] }; await cacheSet(ck, out, 900); return out; }

  const createdMap = new Map();   // tokenAddr → earliest ts
  const add = (addr, ts) => {
    addr = addr.toLowerCase();
    if (isSystem(addr)) return;
    if (!createdMap.has(addr) || ts < createdMap.get(addr)) createdMap.set(addr, ts);
  };

  // Source 1 — traditional deploys: creator's txs with (to empty → contractAddress)
  const j = await bscan({ module: 'account', action: 'txlist', address: cc.creator,
    startblock: '0', endblock: '99999999', page: '1', offset: '2000', sort: 'asc' });
  for (const t of (Array.isArray(j.result) ? j.result : [])) {
    if ((!t.to || t.to === '') && t.contractAddress) add(t.contractAddress, Number(t.timeStamp));
  }

  // Source 2 — factory / ERC-4337 deploys: tokens where THIS wallet received the
  // very first mint (from 0x0). Catches memecoins launched via handleOps/factories.
  const tj = await bscan({ module: 'account', action: 'tokentx', address: cc.creator,
    page: '1', offset: '2000', sort: 'asc' });
  for (const t of (Array.isArray(tj.result) ? tj.result : [])) {
    if (t.from?.toLowerCase() === '0x0000000000000000000000000000000000000000' && t.contractAddress) {
      add(t.contractAddress, Number(t.timeStamp));
    }
  }
  // always include the token we were asked about
  add(token, cc.ts || Math.floor(Date.now() / 1000));

  const created = [...createdMap.entries()].map(([addr, ts]) => ({ addr, ts })).sort((a, b) => a.ts - b.ts);
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
      dead: (dx?.liquidity?.usd || 0) < 1000,   // unlisted or drained = dead
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
  const ck = `inv:early2:${token}`;
  const cached = await cacheGet(ck);
  if (cached) return cached;

  // Identify the DEX pool + price so we can tell a real BUY (token leaves the
  // pool to a wallet) from mint / LP-setup / dev distribution transfers.
  const dx = await dexData(token).catch(() => null);
  const pool = dx?.pairAddress ? dx.pairAddress.toLowerCase() : null;
  const price = dx?.priceUsd ? Number(dx.priceUsd) : 0;

  // Scan the token's earliest transfers.
  const txs = [];
  for (let page = 1; page <= 3; page++) {
    const j = await bscan({ module: 'account', action: 'tokentx', contractaddress: token, page: String(page), offset: '1000', sort: 'asc' });
    const r = Array.isArray(j.result) ? j.result : [];
    txs.push(...r);
    if (r.length < 1000) break;
    if (pool && r.some(t => t.from?.toLowerCase() === pool)) break;  // reached pool trading
  }
  const dec = txs[0]?.tokenDecimal ? Number(txs[0].tokenDecimal) : 18;
  const supply = await tokenSupply(token).catch(() => null);
  const creator = (await contractCreator(token).catch(() => null))?.creator;

  // Build the "distribution / infrastructure" exclusion set: the mint recipient,
  // any ≥40% holder (deployer/locker/treasury), the resolved creator, and any
  // address that fans tokens out to many wallets (an airdrop/distribution hub).
  const distSrc = new Set(), fanout = {};
  for (const t of txs) {
    const to = t.to?.toLowerCase(), from = t.from?.toLowerCase();
    if (from === '0x0000000000000000000000000000000000000000') distSrc.add(to);
    if (supply && Number(t.value) / 10 ** dec >= supply * 0.40) distSrc.add(to);
    (fanout[from] = fanout[from] || new Set()).add(to);
  }
  const hubs = new Set(Object.entries(fanout).filter(([, s]) => s.size >= 15).map(([a]) => a));
  if (creator) distSrc.add(creator);
  const excluded = a => isSystem(a) || isInfra(a) || distSrc.has(a) || hubs.has(a) || a === token || a === pool || !!label(a);

  // Preferred: real BUYS = token leaves the pool (or an AMM router) to a fresh EOA.
  const buyFrom = pool ? new Set([pool, ...INFRA]) : new Set(INFRA);
  const collect = (validFrom) => {
    const out = [], seen = new Set();
    for (const t of txs) {
      const to = t.to?.toLowerCase(), from = t.from?.toLowerCase();
      if (!to || !validFrom(from) || excluded(to)) continue;
      const amt = Number(t.value) / 10 ** dec;
      if (seen.has(to)) { const b = out.find(x => x.addr === to); if (b) b.got += amt; continue; }
      seen.add(to); out.push({ addr: to, ts: Number(t.timeStamp), got: amt });
    }
    return out;
  };
  let buyers = collect(f => buyFrom.has(f));
  let mode = 'pool-buys';
  if (buyers.length < 4) {                       // pool buys not visible (exotic DEX / airdrop token)
    buyers = collect(() => true);                // fall back to earliest real holders
    mode = 'earliest-holders';
  }
  const firstBuyers = buyers.slice(0, n);

  // Current balance → still holding? + USD value of what's left
  await Promise.all(firstBuyers.map(async b => {
    const bal = await rpc('eth_call', [{ to: token,
      data: '0x70a08231' + b.addr.slice(2).padStart(64, '0') }, 'latest']).catch(() => null);
    const cur = bal && bal !== '0x' ? Number(BigInt(bal)) / 10 ** dec : 0;
    b.holding = cur;
    b.pctLeft = b.got > 0 ? Math.min(100, (cur / b.got) * 100) : 0;
    b.valueUsd = price ? cur * price : 0;
    b.status = b.pctLeft >= 90 ? 'diamond' : b.pctLeft <= 5 ? 'sold' : 'trimmed';
  }));

  const ageStr = dx?.pairCreatedAt ? ageFrom(dx.pairCreatedAt / 1000)
    : (txs[0]?.timeStamp ? ageFrom(Number(txs[0].timeStamp)) : null);
  const out = {
    token, symbol: dx?.baseToken?.symbol || null, ageStr,
    poolFound: !!pool, mode, buyers: firstBuyers,
  };
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
    fetch(`${BLOCKSCOUT}/tokens/${token}/holders`, { signal: AbortSignal.timeout(8000) })
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

// ── 6. NET WORTH — full portfolio valuation of a wallet ──────────────────────
// ETH + every ERC-20 the wallet holds, each priced via DexScreener, summed.
async function netWorth(wallet) {
  wallet = wallet.toLowerCase();
  const ck = `inv:networth:${wallet}`;
  const cached = await cacheGet(ck);
  if (cached) return cached;

  const [ethHex, tokRes, ethPx] = await Promise.all([
    rpc('eth_getBalance', [wallet, 'latest']).catch(() => null),
    fetch(`${BLOCKSCOUT}/addresses/${wallet}/token-balances`, { signal: AbortSignal.timeout(9000) })
      .then(r => r.ok ? r.json() : null).catch(() => null),
    dexData(WETH).then(d => d?.priceUsd ? Number(d.priceUsd) : 0).catch(() => 0),
  ]);

  const ethBal = ethHex ? Number(BigInt(ethHex)) / 1e18 : 0;
  const ethUsd = ethBal * (ethPx || 0);
  const holdings = [];
  const list = Array.isArray(tokRes) ? tokRes : [];
  // Value the top token positions (cap DexScreener calls)
  const candidates = list
    .filter(t => t.token?.type === 'ERC-20' && t.value && Number(t.value) > 0)
    .map(t => ({
      addr: (t.token.address || '').toLowerCase(),
      symbol: t.token.symbol || '?',
      amount: Number(t.value) / 10 ** (Number(t.token.decimals) || 18),
    }))
    .slice(0, 40);

  await Promise.all(candidates.map(async c => {
    const dx = await dexData(c.addr).catch(() => null);
    const px = dx?.priceUsd ? Number(dx.priceUsd) : 0;
    c.usd = c.amount * px;
    c.px = px;
    if (c.usd >= 1) holdings.push(c);   // ignore dust / unpriced
  }));
  holdings.sort((a, b) => b.usd - a.usd);
  const tokenUsd = holdings.reduce((s, h) => s + h.usd, 0);
  const out = {
    wallet, ethBal, ethUsd, tokenUsd, total: ethUsd + tokenUsd,
    holdings: holdings.slice(0, 15), tokenCount: holdings.length,
  };
  await cacheSet(ck, out, 300);
  return out;
}

// ── 7. LINK — how are two wallets connected? ─────────────────────────────────
// Direct transfers between them + shared counterparties/funders. Answers
// "are these the same person / working together?"
async function linkWallets(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase();
  const pull = w => bscan({ module: 'account', action: 'txlist', address: w,
    startblock: '0', endblock: '99999999', page: '1', offset: '400', sort: 'desc' })
    .then(j => Array.isArray(j.result) ? j.result : []);
  const [ta, tb] = await Promise.all([pull(a), pull(b)]);

  // Direct transfers between a and b
  const direct = [];
  for (const t of ta) {
    const f = t.from?.toLowerCase(), to = t.to?.toLowerCase();
    if ((f === a && to === b) || (f === b && to === a)) {
      direct.push({ from: f, to, value: Number(t.value) / 1e18, ts: Number(t.timeStamp), hash: t.hash });
    }
  }
  // Shared counterparties (excluding each other + system)
  const peers = w => txs => {
    const s = new Set();
    for (const t of txs) {
      for (const p of [t.from?.toLowerCase(), t.to?.toLowerCase()]) {
        if (p && p !== w && p !== a && p !== b && !isSystem(p) && !label(p)) s.add(p);
      }
    }
    return s;
  };
  const pa = peers(a)(ta), pb = peers(b)(tb);
  const shared = [...pa].filter(p => pb.has(p)).slice(0, 10);
  // Shared funders specifically
  const [fa, fb] = await Promise.all([firstFunder(a).catch(() => null), firstFunder(b).catch(() => null)]);
  const sameFunder = fa && fb && fa.from === fb.from ? fa.from : null;

  return {
    a, b, direct: direct.slice(0, 5),
    shared, sameFunder,
    funderA: fa ? { addr: fa.from, label: label(fa.from) } : null,
    funderB: fb ? { addr: fb.from, label: label(fb.from) } : null,
    connected: direct.length > 0 || shared.length > 0 || !!sameFunder,
  };
}

module.exports = {
  short, fmtUsd, ageFrom, label, isSystem,
  traceFunding, walletCluster, deployerRapSheet, earlyBuyers, rugDossier,
  netWorth, linkWallets,
  contractCreator, firstFunder, dexData, rpc, bscan, redis,
};
