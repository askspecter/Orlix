// /api/token-search — live DexScreener token search, Base + Robinhood Chain
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const EXCLUDE = new Set([
  'USDT','USDC','DAI','WETH','WBTC','CBETH','USDBC','USDB',
  'EURC','CRVUSD','LUSD','FRAX','SUSD','BUSD','GUSD','TUSD',
  'RETH','STETH','WSTETH','ETH',
]);

function mapPair(p) {
  return {
    address: p.baseToken?.address || '',
    name: p.baseToken?.name || 'Unknown',
    symbol: p.baseToken?.symbol || '???',
    priceUsd: p.priceUsd || null,
    priceChange1h: p.priceChange?.h1 ?? null,
    priceChange6h: p.priceChange?.h6 ?? null,
    priceChange24h: p.priceChange?.h24 ?? null,
    volume1h: p.volume?.h1 || 0,
    volume6h: p.volume?.h6 || 0,
    volume24h: p.volume?.h24 || 0,
    liquidity: p.liquidity?.usd || 0,
    marketCap: p.marketCap || p.fdv || 0,
    fdv: p.fdv || 0,
    buys1h: p.txns?.h1?.buys || 0,
    sells1h: p.txns?.h1?.sells || 0,
    buys24h: p.txns?.h24?.buys || 0,
    sells24h: p.txns?.h24?.sells || 0,
    pairCreatedAt: p.pairCreatedAt || null,
    pairUrl: p.url || `https://dexscreener.com/${p.chainId || 'base'}/${p.baseToken?.address}`,
    dexId: p.dexId || 'unknown',
    pairName: `${p.baseToken?.symbol}/${p.quoteToken?.symbol || '?'}`,
  };
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (req.method !== 'GET') { res.writeHead(405, CORS); return res.end(JSON.stringify({ error: 'Method not allowed' })); }

  const q = (req.query.q || '').trim();
  if (!q || q.length < 1) {
    res.writeHead(400, CORS);
    return res.end(JSON.stringify({ error: 'Missing query' }));
  }

  try {
    const r = await fetch(
      `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`,
      {
        headers: { Accept: 'application/json', 'User-Agent': 'Orlix/1.0' },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!r.ok) throw new Error(`DexScreener HTTP ${r.status}`);
    const data = await r.json();

    const pairs = (data.pairs || []);

    const chain = req.query.chain === 'robinhood' ? 'robinhood' : 'base';
    // Deduplicate by token address on selected chain, keep highest liquidity pair
    const tokenMap = {};
    for (const p of pairs) {
      if (p.chainId !== chain) continue;
      if (!p.baseToken?.address) continue;
      const sym = (p.baseToken.symbol || '').toUpperCase();
      if (EXCLUDE.has(sym)) continue;
      const key = p.baseToken.address.toLowerCase();
      const liq = p.liquidity?.usd || 0;
      if (!tokenMap[key] || liq > (tokenMap[key].liquidity?.usd || 0)) {
        tokenMap[key] = p;
      }
    }

    const tokens = Object.values(tokenMap).map(mapPair)
      .sort((a, b) => (b.volume24h || 0) - (a.volume24h || 0));

    res.writeHead(200, CORS);
    res.end(JSON.stringify({ tokens, total: tokens.length, query: q }));
  } catch (e) {
    res.writeHead(502, CORS);
    res.end(JSON.stringify({ error: e.message }));
  }
};
