// /api/b20-tokens — Recently deployed B20 tokens on Base mainnet
const { checkLimits, allowedOrigin } = require('./_guard');
const CORS = {
  'Access-Control-Allow-Origin': 'https://orlixai.xyz',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Vary': 'Origin',
  'Content-Type': 'application/json',
};

// B20 Factory — tokens are created via createB20() on this address
const B20_FACTORY = '0xB20f000000000000000000000000000000000000';
const NETWORKS = {
  mainnet: { rpc: 'https://mainnet.base.org', basescan: 'https://api.basescan.org/api' },
};

let _currentNet = 'mainnet';

// Read the shared "recently launched on Orlix" feed (Redis list b20:launched).
// This is the primary source — tokens deployed through Orlix register themselves,
// which is far more reliable than scanning the B20 precompile factory for logs.
async function fetchOrlixLaunched(limit) {
  const url   = process.env.UPSTASH_REDIS_REST_URL   || process.env.STORAGE_UPSTASH_REDIS_REST_URL   || '';
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.STORAGE_UPSTASH_REDIS_REST_TOKEN || '';
  if (!url || !token) return [];
  try {
    const r = await fetch(`${url}/LRANGE/b20:launched/0/${Math.max(limit * 2, 40) - 1}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return [];
    const data = await r.json();
    const arr = Array.isArray(data.result) ? data.result : [];
    const seen = new Set();
    const out = [];
    for (const s of arr) {
      let t; try { t = JSON.parse(s); } catch { continue; }
      if (!t || !t.address) continue;
      const norm = t.address.toLowerCase();
      if (seen.has(norm)) continue;   // de-dupe re-registers
      seen.add(norm);
      out.push(t);
      if (out.length >= limit) break;
    }
    return out;
  } catch { return []; }
}

async function rpcCall(method, params) {
  const rpcUrl = NETWORKS[_currentNet]?.rpc ?? NETWORKS.mainnet.rpc;
  const r = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`RPC ${r.status}`);
  const data = await r.json();
  if (data.error) throw new Error(data.error.message);
  return data.result;
}

function hexToNum(hex) {
  return parseInt(hex, 16);
}

function strip0x(hex) {
  return hex.startsWith('0x') ? hex.slice(2) : hex;
}

// Decode a padded EVM address (32 bytes → 20-byte address)
function decodeAddress(word) {
  return '0x' + strip0x(word).slice(24);
}

// Decode uint256 from 32-byte word
function decodeUint(word) {
  return BigInt('0x' + strip0x(word));
}

// Minimal ABI encode: call(bytes4 selector + args)
function encodeCall(selector, ...uint256s) {
  const sel = strip0x(selector);
  const args = uint256s.map(n => n.toString(16).padStart(64, '0')).join('');
  return '0x' + sel + args;
}

// eth_call shortcut
async function call(to, data) {
  return rpcCall('eth_call', [{ to, data }, 'latest']);
}

// Read token metadata via BaseScan token transfers or logs
// Fallback: use eth_call on ERC-20 name/symbol/decimals
async function getTokenMeta(tokenAddr) {
  try {
    // name()
    const nameRaw = await call(tokenAddr, '0x06fdde03');
    const symRaw  = await call(tokenAddr, '0x95d89b41');
    const decRaw  = await call(tokenAddr, '0x313ce567');
    const supRaw  = await call(tokenAddr, '0x18160ddd');

    const name    = decodeString(nameRaw);
    const symbol  = decodeString(symRaw);
    const decimals = hexToNum(strip0x(decRaw).slice(56));
    const supply  = decodeUint(supRaw);

    return { name, symbol, decimals, supply: supply.toString() };
  } catch {
    return null;
  }
}

// Decode ABI-encoded string
function decodeString(hex) {
  const raw = strip0x(hex);
  if (raw.length < 128) return '';
  // offset at 0x00 (32 bytes), length at 0x20 (32 bytes), data starts at 0x40
  const len = hexToNum(raw.slice(64, 128));
  const chars = raw.slice(128, 128 + len * 2);
  let s = '';
  for (let i = 0; i < chars.length; i += 2) {
    const code = parseInt(chars.slice(i, i + 2), 16);
    if (code) s += String.fromCharCode(code);
  }
  return s;
}

// Get recent B20 token deployments from the B20 Factory.
// Primary: eth_getLogs on the Factory (catches all creation events).
// Fallback: BaseScan txlist to the Factory address.
async function fetchRecentTokens(limit = 20) {
  // Primary: scan Factory logs (last ~50k blocks ≈ 1 day)
  try {
    const latestHex = await rpcCall('eth_blockNumber', []);
    const latest = hexToNum(latestHex);
    const fromBlock = '0x' + Math.max(latest - 50000, 0).toString(16);

    const logs = await rpcCall('eth_getLogs', [{
      address: B20_FACTORY,
      fromBlock,
      toBlock: 'latest',
    }]);

    if (Array.isArray(logs) && logs.length > 0) {
      const tokens = [];
      const seen = new Set();
      for (const log of logs.slice(-limit * 3).reverse()) {
        // Factory events typically have token address in topics[1] and deployer in topics[2]
        const tokenAddr = log.topics?.[1] ? decodeAddress(log.topics[1]) : null;
        if (!tokenAddr || tokenAddr === '0x0000000000000000000000000000000000000000') continue;
        const norm = tokenAddr.toLowerCase();
        if (seen.has(norm)) continue;
        seen.add(norm);
        tokens.push({
          address: tokenAddr,
          deployer: log.topics?.[2] ? decodeAddress(log.topics[2]) : null,
          txHash: log.transactionHash,
          blockNumber: hexToNum(log.blockNumber),
          timestamp: null,
        });
        if (tokens.length >= limit) break;
      }
      if (tokens.length > 0) return tokens;
    }
  } catch {}

  // Fallback: BaseScan — get transactions TO the Factory (createB20 calls)
  const key = process.env.BASESCAN_API_KEY || '';
  const basescanUrl = NETWORKS[_currentNet]?.basescan;
  if (key && basescanUrl) {
    try {
      const url = `${basescanUrl}?module=account&action=txlist&address=${B20_FACTORY}&sort=desc&page=1&offset=${limit * 2}&apikey=${key}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const data = await r.json();
        if (data.status === '1' && Array.isArray(data.result)) {
          const tokens = [];
          const seen = new Set();
          for (const tx of data.result) {
            if (tx.isError === '1') continue;
            // contractAddress from receipt, or extract from logs
            const addr = tx.contractAddress;
            if (!addr || addr === '' || addr.toLowerCase() === B20_FACTORY.toLowerCase()) continue;
            const norm = addr.toLowerCase();
            if (seen.has(norm)) continue;
            seen.add(norm);
            tokens.push({
              address: addr,
              deployer: tx.from,
              txHash: tx.hash,
              blockNumber: parseInt(tx.blockNumber, 10),
              timestamp: parseInt(tx.timeStamp, 10),
            });
            if (tokens.length >= limit) break;
          }
          if (tokens.length > 0) return tokens;
        }
      }
    } catch {}

    // Fallback 2: internal transactions from Factory (token creation traces)
    try {
      const url = `${basescanUrl}?module=account&action=txlistinternal&address=${B20_FACTORY}&sort=desc&page=1&offset=${limit * 2}&apikey=${key}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const data = await r.json();
        if (data.status === '1' && Array.isArray(data.result)) {
          const tokens = [];
          const seen = new Set();
          for (const tx of data.result) {
            const addr = tx.contractAddress || tx.to;
            if (!addr || addr.toLowerCase() === B20_FACTORY.toLowerCase()) continue;
            const norm = addr.toLowerCase();
            if (seen.has(norm)) continue;
            seen.add(norm);
            tokens.push({
              address: addr,
              deployer: tx.from,
              txHash: tx.hash || tx.transactionHash,
              blockNumber: parseInt(tx.blockNumber, 10),
              timestamp: parseInt(tx.timeStamp, 10),
            });
            if (tokens.length >= limit) break;
          }
          return tokens;
        }
      }
    } catch {}
  }

  return [];
}

// Fetch block timestamp for tokens where we don't have it
async function enrichTimestamps(tokens) {
  const blocks = [...new Set(tokens.filter(t => !t.timestamp && t.blockNumber).map(t => t.blockNumber))];
  const blockMap = {};
  await Promise.all(
    blocks.slice(0, 10).map(async bn => {
      try {
        const b = await rpcCall('eth_getBlockByNumber', ['0x' + bn.toString(16), false]);
        if (b?.timestamp) blockMap[bn] = hexToNum(b.timestamp);
      } catch {}
    })
  );
  return tokens.map(t => ({
    ...t,
    timestamp: t.timestamp || blockMap[t.blockNumber] || null,
  }));
}

module.exports = async (req, res) => {
  CORS['Access-Control-Allow-Origin'] = allowedOrigin(req);
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (req.method !== 'GET') {
    res.writeHead(405, CORS);
    return res.end(JSON.stringify({ error: 'GET only' }));
  }

  const _lim = await checkLimits(req, { bucket: 'b20tokens', perMin: 40, perDay: 800, globalDay: 20000 });
  if (_lim.blocked) { res.writeHead(_lim.status, CORS); return res.end(JSON.stringify({ error: _lim.reason })); }

  try {
    const limit = Math.min(parseInt(req.query?.limit || '20', 10), 50);
    _currentNet = 'mainnet';

    // Primary: tokens launched through Orlix (self-registered feed).
    const launched = await fetchOrlixLaunched(limit);
    if (launched.length > 0) {
      // Enrich the newest few with live supply/decimals from chain (best-effort).
      const enriched = await Promise.all(
        launched.map(async (t, i) => {
          if (i >= 12) return t;
          const meta = await getTokenMeta(t.address).catch(() => null);
          return {
            ...t,
            name:     t.name   || meta?.name   || 'Unknown Token',
            symbol:   t.symbol || meta?.symbol || '???',
            decimals: t.decimals ?? meta?.decimals ?? 18,
            supply:   meta?.supply ?? t.supply ?? null,
          };
        })
      );
      const tokens = enriched.map(t => ({
        address: t.address,
        name:     t.name     || 'Unknown Token',
        symbol:   t.symbol   || '???',
        decimals: t.decimals ?? 18,
        supply:   t.supply   || null,
        deployer: t.deployer || null,
        txHash:   t.txHash   || null,
        timestamp: t.ts ? Math.floor(t.ts / 1000) : (t.timestamp || null),
        variant:  t.variant || ((t.decimals === 6) ? 'stablecoin' : 'asset'),
        source:   'orlix',
      }));
      res.writeHead(200, CORS);
      return res.end(JSON.stringify({ tokens, network: _currentNet, source: 'orlix' }));
    }

    // Fallback: on-chain discovery via the B20 factory.
    const raw = await fetchRecentTokens(limit);

    if (raw.length === 0) {
      res.writeHead(200, CORS);
      return res.end(JSON.stringify({ tokens: [] }));
    }

    // Enrich with block timestamps
    const withTs = await enrichTimestamps(raw);

    // Enrich with token metadata (parallel, max 10)
    const enriched = await Promise.all(
      withTs.slice(0, 10).map(async t => {
        const meta = await getTokenMeta(t.address);
        return { ...t, ...(meta || {}) };
      })
    );

    const tokens = enriched.map(t => ({
      address: t.address,
      name:     t.name     || 'Unknown Token',
      symbol:   t.symbol   || '???',
      decimals: t.decimals ?? 18,
      supply:   t.supply   || null,
      deployer: t.deployer || null,
      txHash:   t.txHash   || null,
      timestamp: t.timestamp || null,
      variant:  (t.decimals === 6) ? 'stablecoin' : 'asset',
    }));

    res.writeHead(200, CORS);
    res.end(JSON.stringify({ tokens, network: _currentNet }));
  } catch (e) {
    res.writeHead(502, CORS);
    res.end(JSON.stringify({ error: e.message || 'Failed to fetch tokens' }));
  }
};
