// Token Analyzer — Multi-chain RPC + DexScreener + AI verdict (upgraded)
const { checkLimits, allowedOrigin } = require('./_guard');

const CHAINS = {
  base:      { rpc: 'https://mainnet.base.org',               name: 'Base',            explorer: 'https://basescan.org' },
  robinhood: { rpc: 'https://rpc.mainnet.chain.robinhood.com/', name: 'Robinhood Chain', explorer: 'https://robinhoodchain.blockscout.com' },
};

async function rpc(method, params = [], chain = 'base') {
  const rpcUrl = CHAINS[chain]?.rpc || CHAINS.base.rpc;
  // Timeout so a slow/rate-limited RPC (e.g. Robinhood's public endpoint) can't
  // hang the whole request until the Vercel function timeout.
  const r = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(8000),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d.result;
}

function decodeStr(hex) {
  try {
    if (!hex || hex === '0x') return '';
    const raw = hex.slice(2);
    if (raw.length < 128) return '';
    const len = parseInt(raw.slice(64, 128), 16);
    return Buffer.from(raw.slice(128, 128 + len * 2), 'hex').toString('utf8').replace(/\0/g, '');
  } catch { return ''; }
}
function decodeUint(hex) {
  try { return hex && hex !== '0x' ? BigInt(hex).toString() : '0'; } catch { return '0'; }
}
function decodeU8(hex) {
  try { return hex && hex !== '0x' ? parseInt(hex, 16) : 18; } catch { return 18; }
}

async function getTokenInfo(address, chain = 'base') {
  const [name, symbol, supply, dec] = await Promise.allSettled([
    rpc('eth_call', [{ to: address, data: '0x06fdde03' }, 'latest'], chain),
    rpc('eth_call', [{ to: address, data: '0x95d89b41' }, 'latest'], chain),
    rpc('eth_call', [{ to: address, data: '0x18160ddd' }, 'latest'], chain),
    rpc('eth_call', [{ to: address, data: '0x313ce567' }, 'latest'], chain),
  ]);
  const decimals = dec.status === 'fulfilled' ? decodeU8(dec.value) : 18;
  const raw = supply.status === 'fulfilled' ? decodeUint(supply.value) : '0';
  const totalSupply = raw !== '0'
    ? (Number(BigInt(raw)) / Math.pow(10, decimals)).toLocaleString()
    : 'Unknown';
  return {
    name:        name.status   === 'fulfilled' ? decodeStr(name.value)   : 'Unknown',
    symbol:      symbol.status === 'fulfilled' ? decodeStr(symbol.value) : '?',
    decimals,
    totalSupply,
  };
}

async function getDex(address, chain = 'base') {
  const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) return null;
  const data = await r.json();
  const chainPairs = (data.pairs || []).filter(p => p.chainId === chain);
  const allPairs   = data.pairs || [];
  const pool       = chainPairs.length ? chainPairs : allPairs;
  if (!pool.length) return null;
  const best = pool.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
  const priceRaw = best.priceUsd ? Number(best.priceUsd) : 0;

  // Liquidity / MCap ratio (rug pull signal — low ratio = risky)
  const liq = best.liquidity?.usd || 0;
  const mcap = best.marketCap || best.fdv || 0;
  const liqMcapRatio = mcap > 0 ? ((liq / mcap) * 100).toFixed(1) : null;

  // Buy/sell ratio
  const buys  = best.txns?.h24?.buys  || 0;
  const sells = best.txns?.h24?.sells || 0;
  const bsRatio = sells > 0 ? (buys / sells).toFixed(2) : buys > 0 ? '∞' : '0';

  return {
    priceUsd:        priceRaw > 0 ? best.priceUsd : null,
    priceChange1h:   best.priceChange?.h1  ?? null,
    priceChange6h:   best.priceChange?.h6  ?? null,
    priceChange24h:  best.priceChange?.h24 ?? 0,
    liquidityUsd:    liq,
    volume1h:        best.volume?.h1  || 0,
    volume6h:        best.volume?.h6  || 0,
    volume24h:       best.volume?.h24 || 0,
    buys24h:         buys,
    sells24h:        sells,
    buySellRatio:    bsRatio,
    dexId:           best.dexId             || 'unknown',
    pairName:        (best.baseToken?.symbol || '?') + '/' + (best.quoteToken?.symbol || '?'),
    fdv:             best.fdv               || 0,
    marketCap:       best.marketCap         || 0,
    liqMcapRatio,
    pairsCount:      pool.length,
    chainId:         best.chainId           || 'base',
    url:             best.url               || '',
    pairCreatedAt:   best.pairCreatedAt     || null,
  };
}

async function aiVerdict(address, token, dex, chain = 'base') {
  const chainName = CHAINS[chain]?.name || 'Base';
  const key = process.env.BANKR_LLM_KEY || process.env.ANTHROPIC_API_KEY || '';
  if (!key) return '**AI analysis temporarily unavailable.**';

  const priceStr = dex?.priceUsd
    ? `$${Number(dex.priceUsd).toFixed(Number(dex.priceUsd) < 0.0001 ? 10 : Number(dex.priceUsd) < 0.01 ? 8 : 6)}`
    : 'Not listed / no price data';

  const ageStr = dex?.pairCreatedAt
    ? `${Math.floor((Date.now() - dex.pairCreatedAt) / 86400000)} days old`
    : 'Unknown';

  const ctx = [
    `Contract: ${address} (${chainName})`,
    `Token: ${token?.name} (${token?.symbol}) | Decimals: ${token?.decimals} | Supply: ${token?.totalSupply}`,
    dex ? [
      `Price: ${priceStr}`,
      `Price Change: 1h ${dex.priceChange1h ?? 'N/A'}% | 6h ${dex.priceChange6h ?? 'N/A'}% | 24h ${dex.priceChange24h}%`,
      `Liquidity: $${Number(dex.liquidityUsd).toLocaleString()}`,
      `Volume: 1h $${Number(dex.volume1h).toLocaleString()} | 6h $${Number(dex.volume6h).toLocaleString()} | 24h $${Number(dex.volume24h).toLocaleString()}`,
      `Transactions 24h: ${dex.buys24h} buys / ${dex.sells24h} sells (ratio: ${dex.buySellRatio})`,
      `FDV: $${Number(dex.fdv).toLocaleString()} | Market Cap: $${Number(dex.marketCap).toLocaleString()}`,
      dex.liqMcapRatio ? `Liquidity/MCap Ratio: ${dex.liqMcapRatio}% (below 5% = high rug risk)` : '',
      `DEX: ${dex.dexId} | Pair: ${dex.pairName} | Total pairs: ${dex.pairsCount}`,
      `Pair age: ${ageStr}`,
    ].filter(Boolean).join('\n') : 'No DEX listing found (token not traded or very new).',
  ].join('\n');

  const isAnthropicKey = key.startsWith('sk-ant-');
  const apiUrl = isAnthropicKey ? 'https://api.anthropic.com/v1/messages' : 'https://llm.bankr.bot/v1/messages';
  const authHeader = isAnthropicKey ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { 'X-API-Key': key, 'anthropic-version': '2023-06-01' };
  // Never let a slow/failing LLM turn the whole analysis into a 502 — degrade to
  // a data-only result instead so the token + market data still render.
  try {
    const r = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader },
      signal: AbortSignal.timeout(45000),
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1200,
        system: `You are an expert crypto security analyst specializing in ${chainName} tokens and DeFi.
You have deep knowledge of: rug pulls, honeypots, pump & dumps, wash trading, liquidity traps, whale manipulation, and token contract exploits.
Use **bold** for section headers. Do NOT use ## or ### markdown. Be direct, specific, and data-driven.
When data suggests risk, be explicit. When data looks healthy, say so with reasoning.`,
        messages: [{
          role: 'user',
          content: `Analyze this ${chainName} token thoroughly. Use exactly this format:\n\n**📊 Overview**\n[What this token is, key facts, age context — 2-3 sentences]\n\n**💧 Liquidity Analysis**\n[Depth adequacy, Liq/MCap ratio interpretation, concentration risk]\n\n**📈 Price & Volume Analysis**\n[Trend across 1h/6h/24h, volume consistency, wash trading signals]\n\n**🔄 Buy/Sell Pressure**\n[What the buy/sell ratio means, momentum interpretation]\n\n**🚩 Red Flags**\n• [Each flag on its own line — be specific with data. If none: "None detected"]\n\n**✅ Green Flags**\n• [Each positive signal with data. If none: "None detected"]\n\n**⚖️ Verdict: SAFE / CAUTION / HIGH RISK / SCAM LIKELY**\n[One clear sentence with the main reason]\n\nData:\n${ctx}`,
        }],
      }),
    });
    if (!r.ok) return `**AI analysis unavailable** (engine returned ${r.status}). Token and market data below are still accurate.`;
    const d = await r.json();
    return d.content?.[0]?.text || 'Analysis unavailable.';
  } catch (e) {
    return `**AI analysis unavailable** (${e.name === 'TimeoutError' ? 'timed out' : 'engine error'}). Token and market data below are still accurate.`;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin(req));
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  // Abuse guard — one call = one paid Sonnet completion
  const _lim = await checkLimits(req, { bucket: 'analyze', perMin: 25, perDay: 400, globalDay: 10000 });
  if (_lim.blocked) return res.status(_lim.status).json({ error: _lim.reason });

  const address = ((req.query.address || '') + '').trim().toLowerCase();
  if (!address || !/^0x[0-9a-f]{40}$/i.test(address)) {
    return res.status(400).json({ error: 'Invalid address — must be 0x + 40 hex chars.' });
  }
  const chain = CHAINS[req.query.chain] ? req.query.chain : 'base';

  try {
    const [tokR, dexR] = await Promise.allSettled([getTokenInfo(address, chain), getDex(address, chain)]);
    const token    = tokR.status === 'fulfilled' ? tokR.value : null;
    const dex      = dexR.status === 'fulfilled' ? dexR.value : null;
    const analysis = await aiVerdict(address, token, dex, chain);
    return res.json({ address, chain, tokenInfo: token, dexInfo: dex, analysis, timestamp: new Date().toISOString() });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
};
