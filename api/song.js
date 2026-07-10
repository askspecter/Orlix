// /api/song.js — generate song lyrics for a Base token using real DexScreener data
const { checkLimits, allowedOrigin } = require('./_guard');
const CORS = {
  'Access-Control-Allow-Origin': 'https://orlixai.xyz',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Vary': 'Origin',
  'Content-Type': 'application/json',
};

async function fetchTokenData(query) {
  // Try as address first, then as symbol search
  const isAddress = /^0x[0-9a-fA-F]{40}$/.test(query.trim());

  let pairs = [];

  if (isAddress) {
    const r = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${query.trim()}`,
      { headers: { Accept: 'application/json', 'User-Agent': 'Orlix/1.0' }, signal: AbortSignal.timeout(8000) }
    );
    if (r.ok) {
      const d = await r.json();
      pairs = (d.pairs || []).filter(p => p.chainId === 'base');
    }
  } else {
    const r = await fetch(
      `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`,
      { headers: { Accept: 'application/json', 'User-Agent': 'Orlix/1.0' }, signal: AbortSignal.timeout(8000) }
    );
    if (r.ok) {
      const d = await r.json();
      pairs = (d.pairs || []).filter(p => p.chainId === 'base');
    }
  }

  if (!pairs.length) return null;

  // Pick highest liquidity pair
  pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  const p = pairs[0];

  return {
    symbol: p.baseToken?.symbol || query,
    name: p.baseToken?.name || query,
    address: p.baseToken?.address || '',
    priceUsd: p.priceUsd ? parseFloat(p.priceUsd) : null,
    priceChange1h: p.priceChange?.h1 ?? null,
    priceChange24h: p.priceChange?.h24 ?? null,
    volume24h: p.volume?.h24 || 0,
    liquidity: p.liquidity?.usd || 0,
    marketCap: p.marketCap || p.fdv || 0,
    buys24h: p.txns?.h24?.buys || 0,
    sells24h: p.txns?.h24?.sells || 0,
    dexId: p.dexId || 'unknown',
    pairUrl: p.url || `https://dexscreener.com/base/${p.baseToken?.address}`,
  };
}

function formatNumber(n) {
  if (!n) return '0';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
  return n.toFixed(0);
}

const GENRE_STYLES = {
  trap: {
    vibe: 'aggressive trap/hip-hop',
    ref: 'Travis Scott, Future, Gunna energy on Base chain',
    guide: 'Hard punchy bars, internal rhyme schemes, triplet flow. Use crypto slang organically: ape in, cook, bag, gm, on chain, liquidity, rug. Reference Base network, Coinbase L2. Brag about gains, threaten competitors.',
  },
  phonk: {
    vibe: 'dark hypnotic phonk / Memphis drift rap',
    ref: 'underground phonk, Russian drift culture energy',
    guide: 'Short punchy lines, slow-burn menace, dark imagery, repetitive hypnotic hook. Reference the drift: price drifting, chart drifting. Unsettling and cool.',
  },
  pop: {
    vibe: 'massive feel-good pop anthem',
    ref: 'The Chainsmokers meets crypto Twitter optimism',
    guide: 'Big singalong chorus that sticks in your head. Diamond hands narrative, community love, builders on Base. Uplifting even when charts are down. Makes people want to buy.',
  },
  drill: {
    vibe: 'cold UK/Chicago drill',
    ref: 'Central Cee, Fivio Foreign — dark and unflinching',
    guide: 'Cold delivery, no emotion, gritty market survival. Never sold, still holding, watching competitors get rugged. Street mentality in DeFi. Minimal words, maximum threat.',
  },
  hype: {
    vibe: 'stadium hype anthem / battle cry',
    ref: 'Eminem Lose Yourself meets FIFA crowd chant',
    guide: 'Explosive energy. Short lines that hit like punches. ALL CAPS on key moments. Crowd chant breaks. Makes you want to run through a wall.',
  },
  ballad: {
    vibe: 'emotional slow ballad',
    ref: 'Sam Smith meets a degenerate checking charts at 3am',
    guide: 'Raw emotion: longing for ATH, pain of watching a bag bleed, hope that never dies. Bittersweet love letter to a volatile token. Melancholic but beautiful.',
  },
};

function buildPrompt(token, genre) {
  const s = GENRE_STYLES[genre] || GENRE_STYLES.trap;
  const price = token.priceUsd ? `$${token.priceUsd < 0.001 ? token.priceUsd.toExponential(2) : token.priceUsd.toFixed(token.priceUsd < 1 ? 4 : 2)}` : null;
  const chg24 = token.priceChange24h != null ? `${token.priceChange24h >= 0 ? '+' : ''}${token.priceChange24h.toFixed(1)}%` : null;
  const vol = token.volume24h ? formatNumber(token.volume24h) : null;
  const mc = token.marketCap ? formatNumber(token.marketCap) : null;
  const buySide = token.buys24h + token.sells24h > 0
    ? Math.round(token.buys24h / (token.buys24h + token.sells24h) * 100)
    : null;

  const stats = [
    price && `Current price: ${price}${chg24 ? ` — moved ${chg24} today` : ''}`,
    token.priceChange1h != null && `Last hour: ${token.priceChange1h >= 0 ? '+' : ''}${token.priceChange1h.toFixed(1)}%`,
    vol && `24h trading volume: $${vol}`,
    mc && `Market cap: $${mc}`,
    buySide && `${buySide}% of trades are buys right now`,
  ].filter(Boolean).join('\n');

  return `Write ${s.vibe} song lyrics for $${token.symbol} (${token.name}), a token on Base network.

${stats ? `Live market data — use this as RAW MATERIAL for storytelling, not a report to recite:\n${stats}` : ''}

Energy: ${s.ref}
Direction: ${s.guide}

Deliver: [Verse 1] → [Chorus] → [Verse 2] → [Chorus] → [Outro]

Non-negotiable:
- English only
- This must sound like a REAL song from a real artist, not an AI summary
- $${token.symbol} appears naturally multiple times
- At least one reference to Base network
- Stats show up as IMAGERY and METAPHOR, not bullet points
- Every line must earn its place — cut anything generic
- Output the lyrics only, no commentary`;
}

module.exports = async (req, res) => {
  // Merged endpoint: /api/music rewrites here with __svc=music
  if (req.query?.__svc === 'music') return require('./_music')(req, res);
  CORS['Access-Control-Allow-Origin'] = allowedOrigin(req);
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (req.method !== 'POST') { res.writeHead(405, CORS); return res.end(JSON.stringify({ error: 'Method not allowed' })); }

  // Reject oversized bodies, then guard against abuse (expensive: Sonnet @1500 tok, 30s)
  if (parseInt(req.headers['content-length'] || '0', 10) > 64 * 1024) {
    res.writeHead(413, CORS); return res.end(JSON.stringify({ error: 'Request too large' }));
  }
  const _lim = await checkLimits(req, { bucket: 'song', perMin: 4, perDay: 25, globalDay: 400 });
  if (_lim.blocked) { res.writeHead(_lim.status, CORS); return res.end(JSON.stringify({ error: _lim.reason })); }

  // Vercel pre-parses JSON bodies into req.body; fall back to raw stream for other envs
  let query, genre;
  if (req.body && typeof req.body === 'object') {
    ({ query, genre } = req.body);
  } else {
    let raw = '';
    await new Promise((resolve, reject) => {
      req.on('data', d => { raw += d; });
      req.on('end', resolve);
      req.on('error', reject);
    });
    try { ({ query, genre } = JSON.parse(raw)); } catch { res.writeHead(400, CORS); return res.end(JSON.stringify({ error: 'Invalid JSON body' })); }
  }

  if (!query?.trim()) { res.writeHead(400, CORS); return res.end(JSON.stringify({ error: 'Missing token query' })); }
  genre = genre || 'trap';

  const bankrKey     = process.env.BANKR_LLM_KEY || '';
  const anthropicKey = process.env.ANTHROPIC_API_KEY || '';
  if (!bankrKey && !anthropicKey) { res.writeHead(503, CORS); return res.end(JSON.stringify({ error: 'Service temporarily unavailable' })); }

  // Fetch token data
  let token = null;
  try { token = await fetchTokenData(query); } catch {}
  if (!token) {
    token = { symbol: query.toUpperCase().replace('$', ''), name: query, priceUsd: null, priceChange24h: null, volume24h: 0, liquidity: 0, marketCap: 0, buys24h: 0, sells24h: 0 };
  }

  const prompt = buildPrompt(token, genre);
  const aiBody = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    system: 'You are a world-class songwriter fluent in trap, phonk, pop, drill, hype, and ballad. You write in English only. Your lyrics feel authentic — real artists, real flow, real emotion. You treat token data as creative inspiration, not content to recite. You never pad with generic filler.',
    messages: [{ role: 'user', content: prompt }],
  });

  const callAI = async (key) => {
    const isAnthropic = key.startsWith('sk-ant-');
    const url     = isAnthropic ? 'https://api.anthropic.com/v1/messages' : 'https://llm.bankr.bot/v1/messages';
    const authHdr = isAnthropic ? { 'x-api-key': key } : { 'X-API-Key': key };
    const r = await fetch(url, {
      method: 'POST',
      headers: { ...authHdr, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: aiBody,
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) throw new Error(`AI API ${r.status}`);
    return r.json();
  };

  try {
    let data;
    if (bankrKey) {
      try { data = await callAI(bankrKey); }
      catch (e) { if (anthropicKey) data = await callAI(anthropicKey); else throw e; }
    } else {
      data = await callAI(anthropicKey);
    }
    const lyrics = data.content?.[0]?.text || '';
    res.writeHead(200, CORS);
    res.end(JSON.stringify({ lyrics, token, genre }));
  } catch (e) {
    res.writeHead(502, CORS);
    res.end(JSON.stringify({ error: e.message }));
  }
};
