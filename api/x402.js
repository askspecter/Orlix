// x402 unified router — all paid endpoints in one serverless function
// Route: GET|POST /api/x402?service=chat|market
// Builder Code: bc_cxvityc7

const { withX402 }           = require('./_x402guard');
const { getOrlixTier, withTier } = require('./_orlix-tier');

// ── Existing core handlers ───────────────────────────────────────────────────
const chatHandler    = require('./chat');

// ── Market handler ───────────────────────────────────────────────────────────
const EXCLUDE = new Set(['USDT','USDC','DAI','WETH','WBTC','CBETH','USDBC','USDB','EURC','RETH','STETH','WSTETH','ETH','FRAX']);
const BASE_SEARCHES = [
  'BRETT','VIRTUAL','AERO','DEGEN','TOSHI','HIGHER','MOG','WELL','NORMIE','BASED',
  'MOCHI','TURBO','ODOS','ZORA','ENJOY','MFER','PRIME','MIGGLES','KEYCAT','BALD',
  'TYBG','HAM','ANDY','ANON','MOON','WEN','SEAM','FRENPET','MOXIE','BUILD',
  'CLANKER','TALENT','SMOL','PEPE','BONK','FLOKI','APE','WAIFU','BLUR','ENS',
  'AIXBT','VADER','LUNA','AGNT','BILLY','PURR','DOOMER','BASENJI','CHOMP','GIGA',
  'COPE','WOJAK','PONKE','POPCAT','WIF','BOME','BNKR','BANKR','ORLIX',
];

function validPair(p) {
  return (p.chainId === 'robinhood') && !!p.baseToken?.address
    && !EXCLUDE.has((p.baseToken.symbol || '').toUpperCase())
    && (p.liquidity?.usd || 0) >= 5000;
}

async function fetchTop(limit) {
  const results = await Promise.all(
    BASE_SEARCHES.slice(0, 30).map(q =>
      fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(8000) })
        .then(r => r.ok ? r.json() : null).catch(() => null)
    )
  );
  const seen = {};
  for (const r of results) {
    for (const p of (r?.pairs || [])) {
      if (!validPair(p)) continue;
      const key = p.baseToken.address.toLowerCase();
      if (!seen[key] || (p.liquidity?.usd || 0) > (seen[key].liquidity?.usd || 0)) seen[key] = p;
    }
  }
  return Object.values(seen)
    .sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0))
    .slice(0, limit)
    .map((p, i) => ({
      rank: i + 1,
      address:        p.baseToken.address.toLowerCase(),
      symbol:         p.baseToken.symbol,
      name:           p.baseToken.name,
      priceUsd:       p.priceUsd || null,
      priceChange1h:  p.priceChange?.h1  ?? null,
      priceChange24h: p.priceChange?.h24 ?? null,
      volume1h:       p.volume?.h1  || 0,
      volume24h:      p.volume?.h24 || 0,
      liquidity:      p.liquidity?.usd || 0,
      marketCap:      p.marketCap || p.fdv || 0,
      buys24h:        p.txns?.h24?.buys  || 0,
      sells24h:       p.txns?.h24?.sells || 0,
      dexId:          p.dexId || 'unknown',
      pairUrl:        p.url || `https://dexscreener.com/base/${p.baseToken.address}`,
    }));
}

const marketHandler = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  const tier   = await getOrlixTier((req.query?.wallet || '') || null);
  const tokens = await fetchTop(Math.min(tier.results, 100));
  let commentary = '';
  if (tier.tier !== 'NONE') {
    const key = process.env.BANKR_LLM_KEY || '';
    if (key && tokens.length) {
      try {
        const top3 = tokens.slice(0, 3);
        const totalVol = tokens.reduce((s, t) => s + t.volume24h, 0);
        const prompt = `${tokens.length} active tokens on Robinhood Chain. Total 24h volume: $${(totalVol / 1e6).toFixed(1)}M. Top: ${top3.map(t => `$${t.symbol} (${t.priceChange24h != null ? (t.priceChange24h >= 0 ? '+' : '') + t.priceChange24h.toFixed(1) + '%' : '?'} 24h)`).join(', ')}. Write 2-3 sentences of live market commentary. Be specific. No emojis.`;
        const r = await fetch('https://llm.bankr.bot/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': key, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 200, system: 'You are a live crypto market analyst.', messages: [{ role: 'user', content: prompt }] }),
          signal: AbortSignal.timeout(12000),
        });
        const d = await r.json();
        commentary = d.content?.[0]?.text || '';
      } catch { /* best effort */ }
    }
  }
  return res.json(withTier({
    tokens,
    stats: {
      total:       tokens.length,
      totalVol24h: tokens.reduce((s, t) => s + t.volume24h, 0),
      gainers:     tokens.filter(t => (t.priceChange24h ?? 0) > 0).length,
      losers:      tokens.filter(t => (t.priceChange24h ?? 0) < 0).length,
    },
    commentary: commentary || (tier.tier === 'NONE' ? 'Hold $ORLIX to unlock live AI market commentary' : ''),
    timestamp: new Date().toISOString(),
    poweredBy: 'Orlix AI — orlixai.xyz',
  }, tier));
};

// ── Wallet handler ───────────────────────────────────────────────────────────
const ROBINHOOD_RPC       = 'https://rpc.mainnet.chain.robinhood.com/';
const ORLIX_CONTRACT = '0x1eFdD871f052900D88E4DC2D49BcD32Bf77e333c';

async function rpc(method, params = []) {
  const r = await fetch(ROBINHOOD_RPC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(8000),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d.result;
}

const walletHandler = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  const target = ((req.query?.address || req.query?.wallet || '') + '').trim().toLowerCase();
  const caller = ((req.query?.caller || target) + '').trim().toLowerCase();
  if (!target || !/^0x[0-9a-f]{40}$/i.test(target)) {
    return res.status(400).json({ error: 'address required', usage: 'GET /api/x402?service=wallet&address=0x...' });
  }
  const tier = await getOrlixTier(caller || null);
  try {
    const data = '0x70a08231' + target.replace('0x', '').padStart(64, '0');
    const [ethHex, orlixHex, chainIdHex, blockHex, gasPriceHex] = await Promise.all([
      rpc('eth_getBalance',  [target, 'latest']),
      rpc('eth_call', [{ to: ORLIX_CONTRACT, data }, 'latest']),
      rpc('eth_chainId', []),
      rpc('eth_blockNumber', []),
      rpc('eth_gasPrice', []),
    ]);
    const ethWei       = BigInt(ethHex || '0x0');
    const orlixWei     = BigInt(orlixHex && orlixHex !== '0x' ? orlixHex : '0');
    const orlixBalance = (Number(orlixWei) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 0 });
    const walletTier   = await getOrlixTier(target);
    let aiSummary = '';
    const llmKey = process.env.BANKR_LLM_KEY || '';
    if (tier.tier !== 'NONE' && llmKey) {
      try {
        const prompt = `Wallet ${target} on Robinhood Chain: ${(Number(ethWei) / 1e18).toFixed(6)} ETH, ${orlixBalance} ORLIX (${walletTier.label}). Write a 2-sentence wallet profile. No emojis.`;
        const r = await fetch('https://llm.bankr.bot/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': llmKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 200, system: 'You are a blockchain analyst.', messages: [{ role: 'user', content: prompt }] }),
          signal: AbortSignal.timeout(10000),
        });
        const d = await r.json();
        aiSummary = d.content?.[0]?.text || '';
      } catch { /* best effort */ }
    }
    return res.json(withTier({
      address:  target,
      network:  { chainId: parseInt(chainIdHex, 16), latestBlock: parseInt(blockHex, 16), gasPriceGwei: (parseInt(gasPriceHex, 16) / 1e9).toFixed(4) },
      balances: {
        eth:   { formatted: (Number(ethWei) / 1e18).toFixed(6) + ' ETH' },
        orlix: { formatted: orlixBalance + ' ORLIX', tier: walletTier.label },
      },
      aiSummary:   aiSummary || (tier.tier === 'NONE' ? 'Hold $ORLIX to unlock AI wallet analysis' : ''),
      blockscout:   `https://robinhoodchain.blockscout.com/address/`,
      timestamp:   new Date().toISOString(),
      poweredBy:   'Orlix AI — orlixai.xyz',
    }, tier));
  } catch (e) {
    return res.status(502).json({ error: 'Service temporarily unavailable.' });
  }
};

// ── Service registry ─────────────────────────────────────────────────────────
const SERVICES = {
  chat:    { amountUsdc: 0.002, description: 'Orlix AI chat — 19 frontier models',                 handler: chatHandler   },
  market:  { amountUsdc: 0.01,  description: 'Live Robinhood Chain market data — top tokens by volume', handler: marketHandler },
};

// Pre-wrap each service with its x402 guard
const guarded = {};
for (const [name, cfg] of Object.entries(SERVICES)) {
  guarded[name] = withX402(cfg.handler, {
    path:       `/api/x402?service=${name}`,
    amountUsdc: cfg.amountUsdc,
    description:cfg.description,
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Payment');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const service = ((req.query?.service || '') + '').trim().toLowerCase();

  if (!service || !guarded[service]) {
    return res.status(400).json({
      error:     service ? `Unknown service: ${service}` : 'service query param required',
      available: Object.keys(SERVICES),
      usage:     'GET /api/x402?service=analyze&address=0x...',
      prices:    Object.fromEntries(Object.entries(SERVICES).map(([k, v]) => [k, `$${v.amountUsdc} USDC`])),
      builderCode: 'bc_cxvityc7',
    });
  }

  return guarded[service](req, res);
};
