// Orlix AI — Telegram Bot Webhook
// Setup: set TELEGRAM_BOT_TOKEN env var, then:
// GET https://api.telegram.org/bot{TOKEN}/setWebhook?url=https://orlixai.xyz/api/telegram

const { ethers } = require('ethers');
const INV = require('./_investigate.js');
const REP = require('./_reputation.js');
const { stalkScanThrottled } = require('./_stalk-cron.js');

const ANTHROPIC_KEY = () => process.env.BANKR_LLM_KEY || process.env.ANTHROPIC_API_KEY || '';
const TG_TOKEN      = () => process.env.TELEGRAM_BOT_TOKEN || '';

const ORLIX_CA   = '0x799c28BAC95B3E0B26534D1e9A586511895EcBA3';
const BASE_RPC   = 'https://mainnet.base.org';
const GATE_MIN   = BigInt('10000000') * (10n ** 18n);

// In-memory session cache (survives warm invocations, resets on cold start)
const sessions = new Map(); // chatId -> { wallet, verified, balance }

// ── Agent wallet ───────────────────────────────────────────────────────────────
// Each Telegram user gets a UNIQUE Base wallet, derived deterministically from a
// server-side master secret + their user id — so we never store private keys and
// can always regenerate the same address on demand.
//
// Requires env AGENT_WALLET_SEED (a long random secret — keep it out of git!).
// This is CUSTODIAL: whoever holds AGENT_WALLET_SEED controls every user's agent
// wallet. Spending is intentionally NOT implemented — outgoing transfers stay
// disabled until an explicit approval flow is built. Treat these as receive-only
// deposit addresses for now; don't tell users to park large funds.
function agentWallet(userId) {
  const seed = process.env.AGENT_WALLET_SEED || '';
  if (!seed || userId == null) return null;
  // private key = keccak256("orlix-agent:v1:<seed>:<userId>") — 32 bytes, stable
  const pk = ethers.keccak256(ethers.toUtf8Bytes(`orlix-agent:v1:${seed}:${userId}`));
  return new ethers.Wallet(pk);
}

// ── AI access gate via the agent wallet ──────────────────────────────────────
// No /connect needed: a user unlocks AI simply by holding ≥10M $ORLIX in THEIR
// own agent wallet (from /wallet). We read that balance on demand and cache a
// positive result briefly to avoid an RPC on every message.
const gateCache = new Map(); // userId -> { ok, t }
async function aiAllowed(chatId, userId) {
  if (isVerified(chatId)) return { ok: true };            // legacy /connect session still works
  const w = agentWallet(userId);
  if (!w) return { ok: false, address: null, bal: 0n };
  const cached = gateCache.get(userId);
  if (cached && cached.ok && Date.now() - cached.t < 180000) return { ok: true, address: w.address };
  const bal = await getOrlixBalance(w.address);
  const ok  = bal >= GATE_MIN;
  gateCache.set(userId, { ok, t: Date.now() });
  return { ok, address: w.address, bal };
}
async function denyAiGate(chatId, lang, gate) {
  const isID = lang === 'id';
  if (!gate.address) {
    return send(chatId, isID ? 'Agent wallet belum dikonfigurasi.' : 'Agent wallet is not configured yet.');
  }
  const held = Number(gate.bal / 10n ** 15n) / 1000;
  const heldFmt = held.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return send(chatId, isID
    ? `*Akses AI Terkunci*\n\nFitur AI perlu *10,000,000 $ORLIX* di agent wallet kamu.\n\nSetor ke:\n\`${gate.address}\`\n\nSaldo kamu: *${heldFmt} ORLIX*\n\n_Cek: /balance · Beli: [orlixai.xyz/token](https://orlixai.xyz/token)_`
    : `*AI Access Locked*\n\nAI features need *10,000,000 $ORLIX* in your agent wallet.\n\nDeposit to:\n\`${gate.address}\`\n\nYour balance: *${heldFmt} ORLIX*\n\n_Check: /balance · Buy: [orlixai.xyz/token](https://orlixai.xyz/token)_`);
}

function aiEndpoint(key) {
  const isAnthropicKey = key.startsWith('sk-ant-');
  return {
    url:     isAnthropicKey ? 'https://api.anthropic.com/v1/messages' : 'https://llm.bankr.bot/v1/messages',
    headers: { 'Content-Type': 'application/json', ...(isAnthropicKey ? { 'x-api-key': key } : { 'X-API-Key': key }), 'anthropic-version': '2023-06-01' },
  };
}

// ── Telegram helpers ──────────────────────────────────────────────────────────

async function tg(method, body) {
  const token = TG_TOKEN();
  if (!token) return;
  return fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function send(chatId, text, extra = {}) {
  const r = await tg('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown', ...extra });
  if (r && !r.ok) {
    const j = await r.json().catch(() => ({}));
    if (j.description?.includes('parse')) {
      await tg('sendMessage', { chat_id: chatId, text: text.replace(/[*_`\[\]]/g, ''), ...extra });
    }
  }
}

// Strip em/en dashes from AI-generated text — the model likes them, we don't.
// " — " between clauses becomes a clean comma; a bare dash becomes a colon/hyphen.
function deDash(s) {
  if (!s) return s;
  return s
    .replace(/ [—–] /g, ', ')
    .replace(/[—–]/g, '-');
}

async function sendLong(chatId, text) {
  text = deDash(text);
  const MAX = 3900;
  if (text.length <= MAX) return send(chatId, text);
  const chunks = [];
  let buf = '';
  for (const line of text.split('\n')) {
    if (buf.length + line.length + 1 > MAX) { chunks.push(buf); buf = ''; }
    buf += (buf ? '\n' : '') + line;
  }
  if (buf) chunks.push(buf);
  for (const chunk of chunks) await send(chatId, chunk);
}

function typing(chatId) {
  return tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
}

// ── Language detection ────────────────────────────────────────────────────────
function detectLang(text) {
  const idWords = /\b(apa|ini|itu|dan|yang|di|ke|dari|untuk|dengan|tidak|bisa|mau|tolong|gimana|kenapa|berapa|siapa|kapan|dimana|bagaimana|adalah|saya|aku|kamu|kita|mereka|harga|token|analisa|dompet|kripto)\b/i;
  return idWords.test(text) ? 'id' : 'en';
}

// ── ORLIX balance check ───────────────────────────────────────────────────────
async function getOrlixBalance(wallet) {
  try {
    const data = '0x70a08231' + wallet.replace('0x', '').toLowerCase().padStart(64, '0');
    const r = await fetch(BASE_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: ORLIX_CA, data }, 'latest'] }),
      signal: AbortSignal.timeout(6000),
    });
    const d   = await r.json();
    const hex = d.result || '0x0';
    return hex === '0x' ? 0n : BigInt(hex);
  } catch { return 0n; }
}

// ERC-20 balanceOf(holder) -> raw bigint
async function erc20BalanceOf(token, holder) {
  const data = '0x70a08231' + holder.replace('0x', '').toLowerCase().padStart(64, '0');
  const hex = await baseRpc('eth_call', [{ to: token, data }, 'latest']);
  return (!hex || hex === '0x') ? 0n : BigInt(hex);
}

// pretty-print a decimal-string amount
function fmtAmt(str) {
  const n = Number(str);
  if (!isFinite(n)) return str;
  if (n === 0) return '0';
  return n.toLocaleString('en-US', { maximumFractionDigits: n >= 1 ? 4 : 8 });
}

// ── Gate check ────────────────────────────────────────────────────────────────
function isVerified(chatId) {
  return sessions.get(chatId)?.verified === true;
}

// ── On-chain helpers ──────────────────────────────────────────────────────────

async function baseRpc(method, params = []) {
  const r = await fetch(BASE_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
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

async function getTokenInfo(address) {
  const [name, symbol, supply, dec] = await Promise.allSettled([
    baseRpc('eth_call', [{ to: address, data: '0x06fdde03' }, 'latest']),
    baseRpc('eth_call', [{ to: address, data: '0x95d89b41' }, 'latest']),
    baseRpc('eth_call', [{ to: address, data: '0x18160ddd' }, 'latest']),
    baseRpc('eth_call', [{ to: address, data: '0x313ce567' }, 'latest']),
  ]);
  const decimals = dec.status === 'fulfilled' && dec.value !== '0x'
    ? parseInt(dec.value, 16) : 18;
  const rawSupply = supply.status === 'fulfilled' && supply.value !== '0x'
    ? BigInt(supply.value).toString() : '0';
  const totalSupply = rawSupply !== '0'
    ? (Number(BigInt(rawSupply)) / Math.pow(10, decimals)).toLocaleString()
    : 'Unknown';
  return {
    name:        name.status   === 'fulfilled' ? decodeStr(name.value)   : 'Unknown',
    symbol:      symbol.status === 'fulfilled' ? decodeStr(symbol.value) : '?',
    decimals,
    totalSupply,
  };
}

async function getDex(address) {
  const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, {
    headers: { Accept: 'application/json' },
  });
  if (!r.ok) return null;
  const data = await r.json();
  const supported = (data.pairs || []).filter(p => p.chainId === 'base' || p.chainId === 'robinhood');
  const pool = supported.length ? supported : (data.pairs || []);
  if (!pool.length) return null;
  const best = pool.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
  const liq  = best.liquidity?.usd || 0;
  const mcap = best.marketCap || best.fdv || 0;
  const liqMcapRatio = mcap > 0 ? ((liq / mcap) * 100).toFixed(1) : null;
  const buys  = best.txns?.h24?.buys  || 0;
  const sells = best.txns?.h24?.sells || 0;
  return {
    priceUsd:       best.priceUsd ? Number(best.priceUsd) : null,
    priceChange1h:  best.priceChange?.h1  ?? null,
    priceChange6h:  best.priceChange?.h6  ?? null,
    priceChange24h: best.priceChange?.h24 ?? 0,
    liquidityUsd:   liq,
    volume1h:       best.volume?.h1  || 0,
    volume6h:       best.volume?.h6  || 0,
    volume24h:      best.volume?.h24 || 0,
    buys24h:        buys,
    sells24h:       sells,
    buySellRatio:   sells > 0 ? (buys / sells).toFixed(2) : buys > 0 ? '∞' : '0',
    dexId:          best.dexId            || 'unknown',
    pairName:       (best.baseToken?.symbol || '?') + '/' + (best.quoteToken?.symbol || '?'),
    fdv:            best.fdv              || 0,
    marketCap:      best.marketCap        || 0,
    liqMcapRatio,
    pairsCount:     pool.length,
    url:            best.url              || '',
    pairCreatedAt:  best.pairCreatedAt    || null,
    chainId:        best.chainId          || 'base',
  };
}

// ── Token Analyzer ────────────────────────────────────────────────────────────

async function cmdAnalyze(chatId, address, lang = 'en') {
  typing(chatId);

  const [tokR, dexR] = await Promise.allSettled([getTokenInfo(address), getDex(address)]);
  const token = tokR.status === 'fulfilled' ? tokR.value : null;
  const dex   = dexR.status === 'fulfilled' ? dexR.value : null;

  const shortAddr = `${address.slice(0, 6)}...${address.slice(-4)}`;
  const fmt = (n, d = 2) => Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtUsd = (n) => `$${fmt(n, 0)}`;
  const priceStr = dex?.priceUsd
    ? `$${dex.priceUsd < 0.0001 ? dex.priceUsd.toFixed(10) : dex.priceUsd < 0.01 ? dex.priceUsd.toFixed(8) : dex.priceUsd.toFixed(6)}`
    : '-';
  const fmtChange = (v) => v == null ? '-' : (v >= 0 ? `+${v}%` : `${v}%`);
  const ageStr = dex?.pairCreatedAt
    ? `${Math.floor((Date.now() - dex.pairCreatedAt) / 86400000)}d`
    : '?';

  let card = `*TOKEN ANALYSIS*\n`;
  card    += `\`${shortAddr}\` · Base Network\n`;
  card    += `\n`;

  if (token?.name && token.name !== 'Unknown') {
    card += `*${token.name}* (${token.symbol})\n`;
    card += `Supply: ${token.totalSupply} · Decimals: ${token.decimals}\n`;
  }

  if (dex) {
    card += `\n* Price:* ${priceStr}\n`;
    card += `* Change:* 1h ${fmtChange(dex.priceChange1h)} | 6h ${fmtChange(dex.priceChange6h)} | 24h ${fmtChange(dex.priceChange24h)}\n`;
    card += `* Liquidity:* ${fmtUsd(dex.liquidityUsd)}\n`;
    card += `* Volume:* 1h ${fmtUsd(dex.volume1h)} | 24h ${fmtUsd(dex.volume24h)}\n`;
    card += `* Buys/Sells 24h:* ${dex.buys24h} / ${dex.sells24h} (ratio ${dex.buySellRatio})\n`;
    card += `* FDV:* ${fmtUsd(dex.fdv)}`;
    if (dex.marketCap > 0) card += ` | *MCap:* ${fmtUsd(dex.marketCap)}`;
    card += '\n';
    if (dex.liqMcapRatio) {
      const rugRisk = Number(dex.liqMcapRatio) < 3 ? 'HIGH RUG RISK' : Number(dex.liqMcapRatio) < 8 ? 'MODERATE' : 'HEALTHY';
      card += `* Liq/MCap:* ${dex.liqMcapRatio}% ${rugRisk}\n`;
    }
    card += `* DEX:* ${dex.dexId} · ${dex.pairName} · Age: ${ageStr}\n`;
    if (dex.url) card += `[ View Chart](${dex.url})\n`;
  } else {
    card += `\n_ Not listed on any DEX · token may be very new or unlisted_\n`;
  }

  const key = ANTHROPIC_KEY();
  if (key) {
    typing(chatId);
    const langInstruction = lang === 'id' ? 'IMPORTANT: Reply entirely in Bahasa Indonesia.' : 'Reply in English.';
    const ctx = [
      token ? `Token: ${token.name} (${token.symbol}), Supply: ${token.totalSupply}` : 'Token info unavailable',
      dex ? [
        `Price: ${priceStr} | Change: 1h ${fmtChange(dex.priceChange1h)} / 6h ${fmtChange(dex.priceChange6h)} / 24h ${fmtChange(dex.priceChange24h)}`,
        `Liquidity: ${fmtUsd(dex.liquidityUsd)} | Volume 24h: ${fmtUsd(dex.volume24h)}`,
        `Buys/Sells 24h: ${dex.buys24h}/${dex.sells24h} (ratio: ${dex.buySellRatio})`,
        `FDV: ${fmtUsd(dex.fdv)} | MCap: ${fmtUsd(dex.marketCap)}`,
        dex.liqMcapRatio ? `Liq/MCap Ratio: ${dex.liqMcapRatio}%` : '',
        `Pair age: ${ageStr} | DEX: ${dex.dexId}`,
      ].filter(Boolean).join('\n') : 'No DEX listing.',
    ].join('\n');

    try {
      const { url: aiUrl, headers: aiHdr } = aiEndpoint(key);
      const r = await fetch(aiUrl, {
        method: 'POST',
        headers: aiHdr,
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 700,
          system: `You are an expert crypto security analyst for Base and Robinhood Chain tokens. ${langInstruction} ONLY use Telegram markdown: *bold* and _italic_. NEVER use # or ## headers or --- rules. Use *bold text* for section titles. You CAN use > for important warnings. Be concise but specific and cite actual numbers from the data. NEVER use the em-dash or en-dash character ("—" / "–"); use a period, comma, colon, or the word "and" instead. Keep a clean plain terminal style.`,
          messages: [{
            role: 'user',
            content: `Analyze this Base token. Format:\n\n*Red Flags*\n- [specific flags or: None detected]\n\n*Green Flags*\n- [specific positives or: None detected]\n\n*Risk Assessment*\n[liquidity risk, price manipulation, rug pull probability, citing Liq/MCap ratio and buy/sell data]\n\n*Verdict: SAFE / CAUTION / HIGH RISK / SCAM LIKELY*\n[One sentence with key reason]\n\nData:\n${ctx}`,
          }],
        }),
      });
      const d = await r.json();
      const verdict = d.content?.[0]?.text;
      if (verdict) card += '\n' + verdict;
    } catch { card += `\n_AI analysis unavailable_`; }
  }

  await sendLong(chatId, card);
}

// ── Wallet Watcher ────────────────────────────────────────────────────────────

async function cmdWatch(chatId, address, lang = 'en') {
  typing(chatId);

  const [balR, txR, tokenTxR] = await Promise.allSettled([
    baseRpc('eth_getBalance', [address, 'latest']),
    fetch(`https://base.blockscout.com/api/v2/addresses/${address}/transactions?limit=5`, {
      headers: { Accept: 'application/json' },
    }).then(r => r.json()),
    fetch(`https://base.blockscout.com/api/v2/addresses/${address}/token-transfers?limit=5`, {
      headers: { Accept: 'application/json' },
    }).then(r => r.json()),
  ]);

  const ethBal = balR.status === 'fulfilled'
    ? (Number(BigInt(balR.value)) / 1e18).toFixed(4) : '?';
  const txns = txR.status === 'fulfilled' ? (txR.value?.items || []) : [];
  const tokenTxns = tokenTxR.status === 'fulfilled' ? (tokenTxR.value?.items || []) : [];
  const shortAddr = `${address.slice(0, 6)}...${address.slice(-4)}`;
  const isID = lang === 'id';

  let msg = `*${isID ? 'PELACAK DOMPET' : 'WALLET WATCHER'}*\n`;
  msg    += `\`${shortAddr}\` · Base Network\n`;
  msg    += `\n`;
  msg    += `*${isID ? 'Saldo ETH' : 'ETH Balance'}:* ${ethBal} ETH\n`;

  if (txns.length) {
    msg += `\n*${isID ? 'Transaksi Terakhir' : 'Recent Transactions'}:*\n`;
    for (const tx of txns) {
      const isIn   = tx.to?.hash?.toLowerCase() === address.toLowerCase();
      const dir    = isIn ? '' : '';
      const status = tx.status === 'ok' ? '' : '';
      const val    = tx.value ? (Number(BigInt(tx.value)) / 1e18).toFixed(4) : '0.0000';
      const peer   = isIn ? tx.from?.hash : tx.to?.hash;
      const peerS  = peer ? `${peer.slice(0, 6)}...${peer.slice(-4)}` : '?';
      msg += `${dir} ${status} *${val} ETH* ${isIn ? (isID ? 'dari' : 'from') : (isID ? 'ke' : 'to')} \`${peerS}\`\n`;
    }
  }

  if (tokenTxns.length) {
    msg += `\n*${isID ? 'Transfer Token Terakhir' : 'Recent Token Transfers'}:*\n`;
    for (const tx of tokenTxns.slice(0, 4)) {
      const isIn  = tx.to?.hash?.toLowerCase() === address.toLowerCase();
      const sym   = tx.token?.symbol || '?';
      const val   = tx.total?.value && tx.token?.decimals
        ? (Number(tx.total.value) / Math.pow(10, tx.token.decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 })
        : '?';
      msg += `${isIn ? '' : ''} *${val} ${sym}* ${isIn ? (isID ? 'masuk' : 'in') : (isID ? 'keluar' : 'out')}\n`;
    }
  }

  if (!txns.length && !tokenTxns.length) {
    msg += `\n_${isID ? 'Tidak ada transaksi ditemukan.' : 'No recent transactions found.'}_`;
  }

  msg += `\n[${isID ? 'Lihat di Basescan' : 'View on Basescan'}](https://basescan.org/address/${address})`;
  await sendLong(chatId, msg);
}

// ── Quick Price ───────────────────────────────────────────────────────────────

async function cmdPrice(chatId, address) {
  typing(chatId);
  const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, {
    headers: { Accept: 'application/json' },
  }).catch(() => null);
  if (!r?.ok) return send(chatId, 'Could not fetch price. Check the address and try again.');
  const data = await r.json();
  const pairs = (data.pairs || []).filter(p => p.chainId === 'base' || p.chainId === 'robinhood');
  const best  = (pairs.length ? pairs : (data.pairs || [])).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
  if (!best) return send(chatId, 'Token not listed on any DEX.');

  const price = best.priceUsd ? `$${Number(best.priceUsd).toFixed(8)}` : '-';
  const ch24  = best.priceChange?.h24;
  const chStr = ch24 == null ? '-' : (ch24 >= 0 ? `+${ch24}%` : `${ch24}%`);
  const sym   = best.baseToken?.symbol || '?';

  let msg = `*${sym} PRICE*\n`;
  msg    += `*Price:* ${price}\n`;
  msg    += `*24h Change:* ${chStr}\n`;
  msg    += `*Liquidity:* $${Number(best.liquidity?.usd || 0).toLocaleString()}\n`;
  msg    += `*Volume 24h:* $${Number(best.volume?.h24 || 0).toLocaleString()}\n`;
  if (best.url) msg += `[ Chart](${best.url})`;
  await send(chatId, msg);
}

// ── AI Chat ───────────────────────────────────────────────────────────────────

async function cmdChat(chatId, text, lang) {
  const key = ANTHROPIC_KEY();
  if (!key) return send(chatId, 'Bot not fully configured.');

  const isID = lang === 'id';
  const { url: aiUrl, headers: aiHdr } = aiEndpoint(key);
  const r = await fetch(aiUrl, {
    method: 'POST',
    headers: aiHdr,
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: `You are Orlix AI, a highly intelligent, versatile AI assistant running inside Telegram.

${isID ? 'PENTING: Pengguna menulis dalam Bahasa Indonesia. Balas SELALU dalam Bahasa Indonesia yang baik dan natural.' : 'Reply in English.'}

Your capabilities:
- Answer ANY question on ANY topic: science, coding, math, history, writing, business, health, law, philosophy, creative writing, and more
- Analyze crypto tokens, wallets, DeFi protocols, and onchain data
- Write code in any programming language
- Help with research, analysis, calculations, and problem-solving
- Translate between languages

FORMATTING RULES (STRICT):
- ONLY use Telegram-compatible markdown: *bold*, _italic_, \`code\`, \`\`\`code blocks\`\`\`
- NEVER use # headers, ## headers, ### headers, or --- horizontal rules; Telegram does NOT render them
- NEVER use the em-dash or en-dash character ("—" / "–"). Use a period, comma, colon, or the word "and". This is a hard rule.
- For section titles, use *bold text* on its own line instead of # or ## headers
- For separators, use a blank line instead of ---
- You CAN use > for important notes or warnings; it looks good as an agent-style callout
- Write clean, professional responses without raw # symbols showing
- When relevant, mention /analyze, /swap, /top, /watch, $TICKER
- Keep replies under 3000 characters when possible`,
      messages: [{ role: 'user', content: text }],
    }),
  });

  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${r.status}`);
  }
  const data = await r.json();
  await sendLong(chatId, data.content?.[0]?.text || (isID ? 'Tidak dapat menghasilkan respons.' : 'Could not generate a response.'));
}

// ── Ticker Search (prefer paid/verified DexScreener profiles) ────────────────

const VERIFIED_TOKENS = {
  'ORLIX': ORLIX_CA,
};

async function searchTicker(ticker) {
  const upper = ticker.toUpperCase();

  // Known verified tokens -> direct contract lookup (bypass search)
  if (VERIFIED_TOKENS[upper]) {
    try {
      const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${VERIFIED_TOKENS[upper]}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (r.ok) {
        const data = await r.json();
        const pairs = (data.pairs || []).filter(p => p.chainId === 'base' || p.chainId === 'robinhood');
        if (pairs.length) return pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
      }
    } catch {}
  }

  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(ticker)}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const data = await r.json();
    const supported = (data.pairs || []).filter(p => p.chainId === 'base' || p.chainId === 'robinhood');
    if (!supported.length) return null;
    const exact = supported.filter(p => (p.baseToken?.symbol || '').toUpperCase() === upper);
    const pool = exact.length ? exact : supported;

    // Prefer tokens with paid DexScreener profile (info with image/website/socials)
    const paid = pool.filter(p => p.info?.imageUrl || p.info?.websites?.length || p.info?.socials?.length);
    const candidates = paid.length ? paid : pool;

    // Minimum $10K liquidity to filter scam copies
    const liquid = candidates.filter(p => (p.liquidity?.usd || 0) >= 10000);
    const final = liquid.length ? liquid : candidates;

    return final.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0] || null;
  } catch { return null; }
}

async function cmdTickerPrice(chatId, ticker, lang) {
  typing(chatId);
  const isID = lang === 'id';
  const pair = await searchTicker(ticker);
  if (!pair) {
    return send(chatId, `*$${ticker.toUpperCase()}* ${isID ? 'tidak ditemukan di Base / Robinhood Chain.' : 'not found on Base / Robinhood Chain.'}`);
  }

  const sym   = pair.baseToken?.symbol || ticker.toUpperCase();
  const name  = pair.baseToken?.name || '';
  const addr  = pair.baseToken?.address || '';
  const price = pair.priceUsd ? `$${Number(pair.priceUsd) < 0.0001 ? Number(pair.priceUsd).toFixed(10) : Number(pair.priceUsd) < 0.01 ? Number(pair.priceUsd).toFixed(8) : Number(pair.priceUsd).toFixed(6)}` : '-';
  const ch1h  = pair.priceChange?.h1;
  const ch24h = pair.priceChange?.h24;
  const liq   = pair.liquidity?.usd || 0;
  const vol   = pair.volume?.h24 || 0;
  const mcap  = pair.marketCap || pair.fdv || 0;
  const chain = pair.chainId === 'robinhood' ? 'Robinhood' : 'Base';
  const arrow = (v) => v == null ? '-' : v >= 0 ? `+${v}%` : `${v}%`;

  let msg = `*$${sym}*`;
  if (name) msg += ` - ${name}`;
  msg += `\n${chain}\n\n`;
  msg += `*${isID ? 'Harga' : 'Price'}:* ${price}\n`;
  msg += `*1h:* ${arrow(ch1h)}  *24h:* ${arrow(ch24h)}\n`;
  msg += `*Liq:* $${liq.toLocaleString()}\n`;
  msg += `*Vol 24h:* $${vol.toLocaleString()}\n`;
  if (mcap > 0) msg += `*MCap:* $${mcap.toLocaleString()}\n`;

  const buttons = [];
  if (addr) {
    buttons.push([{ text: `${isID ? 'Analisa Lengkap' : 'Full Analysis'}`, callback_data: `analyze:${addr}` }]);
  }
  if (pair.url) buttons.push([{ text: 'Chart', url: pair.url }]);
  if (sym.toUpperCase() === 'ORLIX') {
    buttons.push([
      { text: 'Swap ORLIX <-> ETH', callback_data: 'swap_menu' },
    ]);
  }

  await tg('sendMessage', {
    chat_id: chatId, text: msg, parse_mode: 'Markdown',
    disable_web_page_preview: true,
    reply_markup: buttons.length ? { inline_keyboard: buttons } : undefined,
  });
}

// ── On-chain Swap Engine ─────────────────────────────────────────────────────
const WETH_BASE      = '0x4200000000000000000000000000000000000006';
const UNISWAP_ROUTER = '0x2626664c2603336E57B271c5C0b26F421741e481';
const SWAP_SLIPPAGE  = 5;
const pendingSwaps   = new Map();

const ROUTER_IFACE = new ethers.Interface([
  'function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
]);
const ERC20_IFACE = new ethers.Interface([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

function genNonce() { return Math.random().toString(36).slice(2, 10); }

async function getEthPrice() {
  try {
    const p = await searchTicker('WETH');
    if (p?.priceUsd) return Number(p.priceUsd);
  } catch {}
  return 3500;
}

async function resolveToken(sym) {
  const upper = sym.toUpperCase().replace('$', '');
  if (upper === 'ETH' || upper === 'WETH') return { address: WETH_BASE, symbol: 'ETH', decimals: 18 };
  if (VERIFIED_TOKENS[upper]) {
    const info = await getTokenInfo(VERIFIED_TOKENS[upper]);
    return { address: VERIFIED_TOKENS[upper], symbol: upper, decimals: info?.decimals || 18 };
  }
  const pair = await searchTicker(upper);
  if (!pair?.baseToken?.address) return null;
  const info = await getTokenInfo(pair.baseToken.address);
  return { address: pair.baseToken.address, symbol: pair.baseToken.symbol || upper, decimals: info?.decimals || 18 };
}

async function execSwap(userId, tokenAddr, amount, isEthToToken, decimals = 18) {
  const w = agentWallet(userId);
  if (!w) throw new Error('Agent wallet not configured');
  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const signer = w.connect(provider);
  const dex = await getDex(tokenAddr);
  if (!dex?.priceUsd) throw new Error('No price data for this token');
  const ethP = await getEthPrice();
  const slip = (100 - SWAP_SLIPPAGE) / 100;
  const fees = [10000, 3000, 500];
  let lastErr;

  if (isEthToToken) {
    const inWei = ethers.parseEther(amount.toString());
    const expOut = (amount * ethP) / dex.priceUsd;
    const minOut = ethers.parseUnits((expOut * slip).toFixed(Math.min(decimals, 8)), decimals);
    for (const fee of fees) {
      try {
        const data = ROUTER_IFACE.encodeFunctionData('exactInputSingle', [{
          tokenIn: WETH_BASE, tokenOut: tokenAddr, fee,
          recipient: w.address, amountIn: inWei,
          amountOutMinimum: minOut, sqrtPriceLimitX96: 0n,
        }]);
        const tx = await signer.sendTransaction({ to: UNISWAP_ROUTER, data, value: inWei, gasLimit: 350000n });
        return { hash: tx.hash, expected: expOut };
      } catch (e) { lastErr = e; }
    }
  } else {
    const inUnits = ethers.parseUnits(Math.floor(amount).toString(), decimals);
    const expOut = (amount * dex.priceUsd) / ethP;
    const minOut = ethers.parseEther((expOut * slip).toFixed(18));
    const aData = ERC20_IFACE.encodeFunctionData('allowance', [w.address, UNISWAP_ROUTER]);
    const aRes = await baseRpc('eth_call', [{ from: w.address, to: tokenAddr, data: aData }, 'latest']);
    if (BigInt(aRes || '0') < inUnits) {
      const apData = ERC20_IFACE.encodeFunctionData('approve', [UNISWAP_ROUTER, ethers.MaxUint256]);
      const apTx = await signer.sendTransaction({ to: tokenAddr, data: apData, gasLimit: 100000n });
      await apTx.wait();
    }
    for (const fee of fees) {
      try {
        const data = ROUTER_IFACE.encodeFunctionData('exactInputSingle', [{
          tokenIn: tokenAddr, tokenOut: WETH_BASE, fee,
          recipient: w.address, amountIn: inUnits,
          amountOutMinimum: minOut, sqrtPriceLimitX96: 0n,
        }]);
        const tx = await signer.sendTransaction({ to: UNISWAP_ROUTER, data, gasLimit: 350000n });
        return { hash: tx.hash, expected: expOut };
      } catch (e) { lastErr = e; }
    }
  }
  throw lastErr || new Error('Swap failed - no pool found');
}

// ── Swap Command ─────────────────────────────────────────────────────────────

async function cmdSwap(chatId, userId, args, lang) {
  typing(chatId);
  const isID = lang === 'id';
  const cleaned = args.replace(/\bto\b/gi, '').replace(/\$/g, '').trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);

  let amount = null, fromSym, toSym;
  if (parts.length >= 3 && !isNaN(parts[0])) {
    amount = parseFloat(parts[0]);
    fromSym = parts[1].toUpperCase();
    toSym = parts[2].toUpperCase();
  } else if (parts.length >= 2) {
    fromSym = parts[0].toUpperCase();
    toSym = parts[1].toUpperCase();
  } else {
    return tg('sendMessage', {
      chat_id: chatId, parse_mode: 'Markdown', disable_web_page_preview: true,
      text: isID
        ? `*Swap Token*\n\n*Format:*\n\`/swap 0.001 ETH ORLIX\` · Swap langsung\n\`/swap 1000000 ORLIX ETH\`\n\`/swap ETH BRETT\` · Lihat harga\n\n_Swap apapun di Base via Uniswap V3_`
        : `*Swap Token*\n\n*Usage:*\n\`/swap 0.001 ETH ORLIX\` · Execute swap\n\`/swap 1000000 ORLIX ETH\`\n\`/swap ETH BRETT\` · View price\n\n_Swap any token on Base via Uniswap V3_`,
      reply_markup: { inline_keyboard: [
        [{ text: 'Swap ETH -> ORLIX', url: `https://app.uniswap.org/swap?chain=base&inputCurrency=ETH&outputCurrency=${ORLIX_CA}` }],
        [{ text: 'ORLIX Chart', url: `https://dexscreener.com/base/${ORLIX_CA}` }],
      ] },
    });
  }

  const fromIsEth = fromSym === 'ETH' || fromSym === 'WETH';
  const toIsEth = toSym === 'ETH' || toSym === 'WETH';
  if (!fromIsEth && !toIsEth) {
    return send(chatId, isID
      ? `Swap harus melibatkan ETH.\n\nContoh: \`/swap 0.001 ETH ${fromSym}\`atau \`/swap 1000 ${fromSym} ETH\``
      : `One side must be ETH.\n\nExample: \`/swap 0.001 ETH ${fromSym}\`or \`/swap 1000 ${fromSym} ETH\``);
  }
  if (fromIsEth && toIsEth) {
    return send(chatId, `${isID ? 'Tidak bisa swap ETH ke ETH.' : 'Cannot swap ETH to ETH.'}`);
  }

  const tokenSym = fromIsEth ? toSym : fromSym;
  const isEthToToken = fromIsEth;
  const token = await resolveToken(tokenSym);
  if (!token) {
    return send(chatId, `*$${tokenSym}* ${isID ? 'tidak ditemukan di Base.' : 'not found on Base.'}`);
  }

  const dex = await getDex(token.address);
  if (!dex?.priceUsd) {
    return send(chatId, `${isID ? 'Tidak ada data harga untuk' : 'No price data for'} $${token.symbol}`);
  }

  const ethPrice = await getEthPrice();
  const tokenPrice = dex.priceUsd;
  const fmtP = (p) => p < 0.0001 ? p.toFixed(10) : p < 0.01 ? p.toFixed(8) : p.toFixed(4);

  if (!amount) {
    const inputC = isEthToToken ? 'ETH' : token.address;
    const outputC = isEthToToken ? token.address : 'ETH';
    let msg = `*${isEthToToken ? 'ETH -> ' + token.symbol : token.symbol + ' -> ETH'}*\n\n`;
    msg += `*${token.symbol}:* $${fmtP(tokenPrice)}\n`;
    msg += `*ETH:* $${ethPrice.toFixed(2)}\n\n`;
    msg += isID ? `_Tambahkan jumlah untuk swap:_\n` : `_Add amount to swap:_\n`;
    msg += `\`/swap ${isEthToToken ? '0.001 ETH ' + token.symbol : '1000 ' + token.symbol + ' ETH'}\``;
    return tg('sendMessage', {
      chat_id: chatId, text: msg, parse_mode: 'Markdown', disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [
        [{ text: `Swap on Uniswap`, url: `https://app.uniswap.org/swap?chain=base&inputCurrency=${inputC}&outputCurrency=${outputC}` }],
        [{ text: `Chart`, url: dex.url || `https://dexscreener.com/base/${token.address}` }],
      ] },
    });
  }

  let expOut;
  if (isEthToToken) {
    expOut = (amount * ethPrice) / tokenPrice;
  } else {
    expOut = (amount * tokenPrice) / ethPrice;
  }
  const usdValue = isEthToToken ? amount * ethPrice : amount * tokenPrice;
  const direction = isEthToToken ? `ETH -> ${token.symbol}` : `${token.symbol} -> ETH`;
  const outFmt = isEthToToken
    ? expOut.toLocaleString(undefined, { maximumFractionDigits: 0 })
    : expOut.toFixed(6);
  const outSym = isEthToToken ? token.symbol : 'ETH';

  const nonce = genNonce();
  pendingSwaps.set(nonce, {
    userId, chatId, tokenAddr: token.address, amount, isEthToToken,
    decimals: token.decimals, symbol: token.symbol,
    expiry: Date.now() + 120000,
  });

  let msg = `*Swap Preview*\n\n`;
  msg += `*Send:* ${isEthToToken ? amount + ' ETH' : amount.toLocaleString() + ' ' + token.symbol} (~$${usdValue.toFixed(2)})\n`;
  msg += `*Receive:* ~${outFmt} ${outSym}\n`;
  msg += `*Rate:* 1 ${token.symbol} = $${fmtP(tokenPrice)}\n`;
  msg += `*Slippage:* ${SWAP_SLIPPAGE}% max\n\n`;
  msg += `> ${isID ? 'Swap dari agent wallet kamu via Uniswap V3' : 'Swap from your agent wallet via Uniswap V3'}`;

  await tg('sendMessage', {
    chat_id: chatId, text: msg, parse_mode: 'Markdown', disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [
      [{ text: `${isID ? 'Konfirmasi Swap' : 'Confirm Swap'}`, callback_data: `csw:${nonce}` },
       { text: `${isID ? 'Batal' : 'Cancel'}`, callback_data: `cswno:${nonce}` }],
    ] },
  });
}

// ── Bridge ───────────────────────────────────────────────────────────────────

async function cmdBridge(chatId, lang) {
  const isID = lang === 'id';
  await tg('sendMessage', {
    chat_id: chatId, parse_mode: 'Markdown', disable_web_page_preview: true,
    text: isID
      ? `*Bridge Base <-> Robinhood Chain*\n\nPilih bridge untuk transfer aset antar chain:\n\n*Base -> Robinhood Chain:*\nBridge ETH dari Base ke Robinhood Chain\n\n*Robinhood Chain -> Base:*\nBridge ETH dari Robinhood ke Base\n\n> Kedua chain adalah Arbitrum L2 dengan ETH sebagai native currency`
      : `*Bridge Base <-> Robinhood Chain*\n\nSelect a bridge to transfer assets:\n\n*Base -> Robinhood Chain:*\nBridge ETH from Base to Robinhood Chain\n\n*Robinhood Chain -> Base:*\nBridge ETH from Robinhood to Base\n\n> Both chains are Arbitrum L2s with ETH as native currency`,
    reply_markup: { inline_keyboard: [
      [{ text: 'Across Protocol', url: 'https://app.across.to/bridge' }],
      [{ text: 'Stargate', url: 'https://stargate.finance/bridge' }],
      [{ text: 'Base Bridge', url: 'https://bridge.base.org' }],
      [{ text: 'Robinhood Explorer', url: 'https://robinhoodchain.blockscout.com' }],
    ] },
  });
}

// ── Top Tokens ───────────────────────────────────────────────────────────────

async function cmdTop(chatId, lang) {
  typing(chatId);
  const isID = lang === 'id';
  const searches = ['BRETT','VIRTUAL','AERO','DEGEN','TOSHI','HIGHER','MOG','WELL','ORLIX','AIXBT','PEPE','BONK','WIF','POPCAT','CLANKER'];
  const STABLES = new Set(['USDT','USDC','DAI','WETH','WBTC','CBETH','USDBC','USDB','EURC','RETH','STETH','WSTETH','ETH','FRAX']);

  try {
    const results = await Promise.all(
      searches.map(q =>
        fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(8000) })
          .then(r => r.ok ? r.json() : null).catch(() => null)
      )
    );
    const seen = {};
    for (const r of results) {
      for (const p of (r?.pairs || [])) {
        if (p.chainId !== 'base' && p.chainId !== 'robinhood') continue;
        if (!p.baseToken?.address || STABLES.has((p.baseToken.symbol || '').toUpperCase())) continue;
        if ((p.liquidity?.usd || 0) < 5000) continue;
        const key = p.baseToken.address.toLowerCase();
        if (!seen[key] || (p.liquidity?.usd || 0) > (seen[key].liquidity?.usd || 0)) seen[key] = p;
      }
    }
    const top = Object.values(seen).sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0)).slice(0, 10);
    if (!top.length) return send(chatId, `${isID ? 'Gagal memuat data market.' : 'Failed to load market data.'}`);

    let msg = `*${isID ? 'Top Token · Base & Robinhood' : 'Top Tokens · Base & Robinhood'}*\n\n`;
    for (let i = 0; i < top.length; i++) {
      const p = top[i];
      const sym = p.baseToken?.symbol || '?';
      const pr  = p.priceUsd ? `$${Number(p.priceUsd) < 0.01 ? Number(p.priceUsd).toFixed(6) : Number(p.priceUsd).toFixed(4)}` : '-';
      const ch  = p.priceChange?.h24;
      const arr = ch == null ? '' : ch >= 0 ? `+${ch}%` : `${ch}%`;
      const vol = p.volume?.h24 || 0;
      const chain = p.chainId === 'robinhood' ? 'rhc' : 'base';
      msg += `*${i + 1}. $${sym}* ${pr} ${arr} [${chain}]\n`;
      msg += `   vol $${(vol / 1000).toFixed(0)}K · liq $${((p.liquidity?.usd || 0) / 1000).toFixed(0)}K\n`;
    }
    msg += `\n_${isID ? 'Ketik $TICKER untuk detail · /swap untuk trade' : 'Type $TICKER for details · /swap to trade'}_`;
    await send(chatId, msg);
  } catch (e) {
    await send(chatId, `${isID ? 'Gagal memuat data' : 'Failed to load data'}: ${e.message}`);
  }
}

// ── Smart Detect (auto-detect address / $TICKER) ─────────────────────────────

// ── ONCHAIN DETECTIVE ───────────────────────────────────────────────────────
// One clue in -> the rest of the network out. Money trails, side-wallet
// clusters, deployer rap sheets, early buyers, and full rug dossiers.

const bsLink = a => `https://basescan.org/address/${a}`;
const dxLink = a => `https://dexscreener.com/base/${a}`;

// Terminal-style helpers — clean, monospace, no emoji.
const term = (title, body) => '```\n' + `orlix:~$ ${title}\n` + '─'.repeat(Math.min(34, Math.max(18, title.length + 8))) + '\n' + body.replace(/\s+$/, '') + '\n```';
const pad = (s, n) => (String(s) + ' '.repeat(n)).slice(0, n);
const running = (chatId, line) => send(chatId, '`orlix:~$ ' + line + '`');

// /trace <wallet> — follow the money up to its source
async function cmdTrace(chatId, wallet, lang = 'en') {
  const isID = lang === 'id';
  typing(chatId);
  await running(chatId, `trace ${INV.short(wallet)} --follow-funding`);
  const res = await INV.traceFunding(wallet, 6);
  REP.recordTrace(res).catch(() => {});
  if (!res.hops.length || (res.hops.length === 1 && res.hops[0].end)) {
    return send(chatId, '```\nno inbound funding found for ' + INV.short(wallet) + '\n```');
  }
  let body = `target  ${INV.short(wallet)}\n\nmoney trail (source is up):\n`;
  res.hops.forEach((h, i) => {
    const branch = i === 0 ? '└─' : '  '.repeat(i) + '└─';
    if (h.end) { body += `${branch} [trail ends · no inbound funding]\n`; return; }
    const who = h.label ? h.label.toUpperCase() : INV.short(h.from);
    const amt = h.gasless ? 'controlled-by' : (h.value ? `${h.value.toFixed(4)} ETH` : '-');
    const when = h.ts ? `${INV.ageFrom(h.ts)} ago` : '';
    const tag = h.gasless ? '  [smart-wallet]' : h.internal ? '  [internal]' : '';
    body += `${branch} ${pad(amt, 14)} <- ${pad(who, 16)} ${when}${tag}\n`;
    if (h.terminal) body += `${'  '.repeat(i + 1)}   >> SOURCE: exchange/bridge above\n`;
    if (h.loop) body += `${'  '.repeat(i + 1)}   >> loop detected\n`;
  });
  const last = res.hops[res.hops.length - 1];
  const kb = [];
  if (last && last.from && !last.label) kb.push([{ text: 'trace funder', callback_data: `trace:${last.from}` }, { text: 'side wallets', callback_data: `cluster:${last.from}` }]);
  kb.push([{ text: 'basescan', url: bsLink(wallet) }]);
  await tg('sendMessage', { chat_id: chatId, text: term(`trace ${INV.short(wallet)}`, body), parse_mode: 'Markdown', disable_web_page_preview: true, reply_markup: { inline_keyboard: kb } });
}

// /cluster <wallet> — the side wallets seeded by the same funder
async function cmdCluster(chatId, wallet, lang = 'en') {
  typing(chatId);
  await running(chatId, `cluster ${INV.short(wallet)} --side-wallets`);
  const res = await INV.walletCluster(wallet);
  REP.recordCluster(res).catch(() => {});
  if (!res.funder) return send(chatId, '```\nno funder found for ' + INV.short(wallet) + '\n```');
  const f = res.funder;
  let body = `target  ${INV.short(wallet)}\nfunder  ${f.label ? f.label.toUpperCase() : INV.short(f.addr)}\n\n`;
  if (!res.siblings.length) {
    body += 'no side wallets · funder seeded nobody else\n(clean, or a public exchange)\n';
  } else {
    body += `side wallets from same funder (${res.siblings.length}):\n`;
    res.siblings.forEach(s => { body += `${pad(INV.short(s.addr), 16)} ${pad(s.value.toFixed(3) + ' ETH', 12)} ${INV.ageFrom(s.ts)} ago\n`; });
    body += `\n>> likely one operator / one operation\n`;
  }
  const kb = res.siblings.slice(0, 3).map(s => ([{ text: INV.short(s.addr), callback_data: `watch:${s.addr}` }]));
  kb.push([{ text: 'basescan', url: bsLink(f.addr) }]);
  await tg('sendMessage', { chat_id: chatId, text: term(`cluster ${INV.short(wallet)}`, body), parse_mode: 'Markdown', disable_web_page_preview: true, reply_markup: { inline_keyboard: kb } });
}

// /deployer <token> — the creator's full launch history
async function cmdDeployer(chatId, token, lang = 'en') {
  typing(chatId);
  await running(chatId, `deployer ${INV.short(token)} --rap-sheet`);
  const res = await INV.deployerRapSheet(token);
  REP.recordDeployer(res).catch(() => {});
  if (!res.creator) return send(chatId, '```\ncould not resolve deployer for ' + INV.short(token) + '\n```');
  let body = `deployer  ${INV.short(res.creator)}\n`;
  if (res.via) body += `resolved  ${res.via}${res.factory && res.factory !== 'factory' ? 'via ' + res.factory : ''}\n`;
  body += `launches  ${res.totalDeploys}\n`;
  if (res.firstDeploy) body += `first     ${INV.ageFrom(res.firstDeploy)} ago\n`;
  body += `\nrecent launches:\n`;
  let dead = 0;
  res.deploys.forEach(d => {
    const sym = d.symbol ? `$${d.symbol}` : INV.short(d.addr);
    const tag = d.dead === true ? 'DEAD' : d.dead === false ? 'LIVE' : ' ?  ';
    if (d.dead) dead++;
    body += ` [${tag}] ${pad(sym, 12)} mc ${pad(d.mcap ? INV.fmtUsd(d.mcap) : '-', 8)} liq ${INV.fmtUsd(d.liq)}\n`;
  });
  if (res.deploys.length > 2) {
    const rate = res.deploys.length ? Math.round((dead / res.deploys.length) * 100) : 0;
    body += `\n${dead}/${res.deploys.length} recent tokens dead (${rate}%)\n`;
    if (rate >= 50) body += `>> SERIAL RUGGER PATTERN\n`;
  }
  await tg('sendMessage', { chat_id: chatId, text: term(`deployer ${INV.short(token)}`, body), parse_mode: 'Markdown', disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [
      [{ text: 'trace deployer', callback_data: `trace:${res.creator}` }, { text: 'net worth', callback_data: `networth:${res.creator}` }],
      [{ text: 'basescan', url: bsLink(res.creator) }],
    ] } });
}

// /early <token> — first real buyers (or earliest holders) and who's still holding
async function cmdEarly(chatId, token, lang = 'en') {
  typing(chatId);
  await running(chatId, `early ${INV.short(token)} --first-buyers`);
  const res = await INV.earlyBuyers(token, 12);
  if (!res.buyers.length) return send(chatId, '```\nno early buyer data for ' + INV.short(token) + '\n```');
  const label = res.mode === 'pool-buys' ? 'first buyers (from pool)' : 'earliest holders';
  let body = `${res.symbol ? '$' + res.symbol : INV.short(token)}${res.ageStr ? ' · age ' + res.ageStr : ''}\n`;
  body += `${label} · deployer/LP excluded\n\n#   wallet             held   status\n`;
  let diamonds = 0, sold = 0;
  res.buyers.forEach((b, i) => {
    if (b.status === 'diamond') diamonds++; if (b.status === 'sold') sold++;
    const st = b.status === 'diamond' ? 'DIAMOND' : b.status === 'sold' ? 'SOLD' : 'TRIM';
    const val = b.valueUsd > 1 ? ' ' + INV.fmtUsd(b.valueUsd) : '';
    body += `${pad(i + 1, 3)} ${pad(INV.short(b.addr), 16)} ${pad(b.pctLeft.toFixed(0) + '%', 5)} ${pad(st, 7)}${val}\n`;
  });
  body += `\n${diamonds} diamond · ${sold} fully sold · ${res.buyers.length} total\n`;
  if (res.mode === 'earliest-holders')
    body += `note: pool trades not readable on this DEX;\nshowing earliest real holders instead.\n`;
  await tg('sendMessage', { chat_id: chatId, text: term(`early ${INV.short(token)}`, body), parse_mode: 'Markdown', disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [[{ text: 'chart', url: dxLink(token) }]] } });
}

// /dossier <token> (alias /rugcheck) — full risk report
async function cmdDossier(chatId, token, lang = 'en') {
  typing(chatId);
  await running(chatId, `dossier ${INV.short(token)} --risk-scan`);
  const d = await INV.rugDossier(token);
  REP.recordDossier(d).catch(() => {});
  const bar = n => { const f = Math.round(n / 10); return '['.padEnd(1) + '#'.repeat(f) + '.'.repeat(10 - f) + ']'; };
  let body = `${d.name} ($${d.symbol})\n${INV.short(d.token)}\n\n`;
  body += `risk   ${bar(d.score)} ${d.score}/100  ${d.verdict}\n\n`;
  body += `price  ${d.price ? '$' + Number(d.price).toPrecision(4) : '-'}${d.ch24 != null ? `(${d.ch24 >= 0 ? '+' : ''}${d.ch24}% 24h)` : ''}\n`;
  body += `mcap   ${INV.fmtUsd(d.mcap)}\nliq    ${INV.fmtUsd(d.liq)}\nage    ${d.ageStr}\n`;
  if (d.dev) {
    body += `\ndev wallet\n addr    ${INV.short(d.dev.addr)}\n age     ${d.dev.age}\n funded  ${d.dev.fundedBy}\n`;
    if (d.dev.deploys != null) body += `deploys ${d.dev.deploys}${d.dev.priorRugs ? `(${d.dev.priorRugs} dead)` : ''}\n`;
  }
  if (d.flags.length) { body += `\nred flags:\n`; d.flags.forEach(f => { body += ` ! ${f}\n`; }); }
  else body += `\nno major red flags\n`;
  body += `\nnot financial advice · dyor\n`;
  const kb = [];
  if (d.dev) kb.push([{ text: 'deployer', callback_data: `deployer:${d.token}` }, { text: 'early buyers', callback_data: `early:${d.token}` }]);
  kb.push([{ text: 'chart', url: d.url || dxLink(d.token) }]);
  await tg('sendMessage', { chat_id: chatId, text: term(`dossier ${INV.short(token)}`, body), parse_mode: 'Markdown', disable_web_page_preview: true, reply_markup: { inline_keyboard: kb } });
}

// /networth <wallet> — full portfolio valuation
async function cmdNetWorth(chatId, wallet, lang = 'en') {
  typing(chatId);
  await running(chatId, `networth ${INV.short(wallet)} --portfolio`);
  const n = await INV.netWorth(wallet);
  let body = `wallet  ${INV.short(wallet)}\n\ntotal   ${INV.fmtUsd(n.total)}\n`;
  body += `eth   ${n.ethBal.toFixed(4)}  (${INV.fmtUsd(n.ethUsd)})\n`;
  body += `tok   ${INV.fmtUsd(n.tokenUsd)}  (${n.tokenCount} positions)\n`;
  if (n.holdings.length) {
    body += `\ntop holdings:\n`;
    n.holdings.slice(0, 10).forEach(h => {
      const pct = n.total > 0 ? ((h.usd / n.total) * 100).toFixed(0) : 0;
      body += `${pad('$' + h.symbol, 12)} ${pad(INV.fmtUsd(h.usd), 9)} ${pct}%\n`;
    });
  } else body += `\nno significant token holdings\n`;
  await tg('sendMessage', { chat_id: chatId, text: term(`networth ${INV.short(wallet)}`, body), parse_mode: 'Markdown', disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [[{ text: 'trace funds', callback_data: `trace:${wallet}` }, { text: 'basescan', url: bsLink(wallet) }]] } });
}

// /link <walletA> <walletB> — how are two wallets connected?
async function cmdLink(chatId, a, b, lang = 'en') {
  typing(chatId);
  await running(chatId, `link ${INV.short(a)} ${INV.short(b)}`);
  const r = await INV.linkWallets(a, b);
  let body = `A  ${INV.short(a)}\nB  ${INV.short(b)}\n\n`;
  if (!r.connected) {
    body += `result NO LINK\nno transfers, no shared funder,\nno common counterparties\n`;
    return send(chatId, term(`link`, body));
  }
  body += `result CONNECTED\n`;
  if (r.sameFunder) body += `\nsame funder: ${INV.short(r.sameFunder)}\n`;
  if (r.direct.length) {
    body += `\ndirect transfers:\n`;
    r.direct.forEach(d => { body += `${d.from === a.toLowerCase() ? 'A->B' : 'B->A'} ${pad(d.value.toFixed(4) + ' ETH', 14)} ${INV.ageFrom(d.ts)} ago\n`; });
  }
  if (r.shared.length) {
    body += `\nshared counterparties (${r.shared.length}):\n`;
    r.shared.slice(0, 6).forEach(s => { body += `${INV.short(s)}\n`; });
  }
  body += `\n>> likely connected / same operator\n`;
  await tg('sendMessage', { chat_id: chatId, text: term(`link`, body), parse_mode: 'Markdown', disable_web_page_preview: true });
}

// /rep <wallet> — everything Orlix's reputation graph knows about a target
async function cmdRep(chatId, addr, lang = 'en') {
  typing(chatId);
  await running(chatId, `rep ${INV.short(addr)} --reputation`);
  const r = await REP.getReputation(addr);
  if (!r.known) {
    return send(chatId, term(`rep ${INV.short(addr)}`,
      `reputation  UNRATED\n\nno facts on this address yet.\nrun /dossier /deployer /trace /cluster\nto build its onchain reputation.`));
  }
  const lvl = { entity: 'KNOWN ENTITY', trusted: 'TRUSTED', neutral: 'NEUTRAL', caution: 'CAUTION', 'high-risk': 'HIGH RISK' }[r.level] || r.level.toUpperCase();
  const bar = n => { const f = Math.round((n || 0) / 10); return '[' + '#'.repeat(f) + '.'.repeat(10 - f) + ']'; };
  let body = `address  ${INV.short(addr)}\n`;
  if (r.label) body += `entity   ${r.label}\n`;
  body += `score    ${bar(r.score)} ${r.score}/100  ${lvl}\n`;
  const w = r.w || {};
  if (w.deploys != null) body += `\ndeployer · ${w.deploys} launches${w.dead ? ` · ${w.dead} dead` : ''}\n`;
  if (w.fundedBy) body += `funded by  ${typeof w.fundedBy === 'string' && w.fundedBy.startsWith('0x') ? INV.short(w.fundedBy) : w.fundedBy}\n`;
  if (w.clusters?.length) body += `cluster    ${w.clusters.length} side wallet(s)\n`;
  if (r.flaggedConns > 0) body += `\n! ${r.flaggedConns} connection(s) are flagged\n`;
  if (r.flags?.length) { body += `\nflags:\n`; r.flags.forEach(f => { body += `  ! ${f.note || f.type}\n`; }); }
  await tg('sendMessage', { chat_id: chatId, text: term(`rep ${INV.short(addr)}`, body), parse_mode: 'Markdown', disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [[{ text: 'dossier', callback_data: `dossier:${addr}` }, { text: 'trace', callback_data: `trace:${addr}` }]] } });
}

// ── Group Guardian — auto-scan CAs posted in group chats, warn on risky ones ──
async function guardianScan(chatId, text) {
  const m = text.match(/0x[0-9a-fA-F]{40}/);
  if (!m) return;
  const ca = m[0].toLowerCase();
  // throttle: one scan per CA per group per 30 min
  const seen = await INV.redis('GET', `guard:${chatId}:${ca}`).catch(() => null);
  if (seen) return;
  await INV.redis('SET', `guard:${chatId}:${ca}`, '1', 'EX', '1800').catch(() => {});
  // is it even a contract/token?
  const dx = await INV.dexData(ca).catch(() => null);
  if (!dx) return;                                  // not a listed token → stay silent
  const d = await INV.rugDossier(ca).catch(() => null);
  if (!d) return;
  REP.recordDossier(d).catch(() => {});
  if (d.verdict === 'LOW RISK') return;             // don't spam groups on safe tokens
  const ico = d.verdict === 'HIGH RISK' ? '🔴' : '🟠';
  let msg = `${ico} *Orlix Guardian* — heads up on *$${d.symbol}*\n`;
  msg += `risk *${d.score}/100 · ${d.verdict}*\n`;
  if (d.dev) {
    const rep = await REP.getReputation(d.dev.addr).catch(() => null);
    if (rep?.flags?.length) msg += `dev \`${INV.short(d.dev.addr)}\`: ${rep.flags[0].note}\n`;
    else if (d.dev.priorRugs) msg += `dev has ${d.dev.priorRugs} prior dead token(s)\n`;
  }
  if (d.flags?.length) msg += `• ${d.flags.slice(0, 2).join('\n• ')}\n`;
  msg += `\n_not financial advice · /dossier ${INV.short(ca)} for full report_`;
  await tg('sendMessage', { chat_id: chatId, text: msg, parse_mode: 'Markdown', disable_web_page_preview: true });
}

// Stalk mode — register a wallet for movement alerts
async function cmdStalk(chatId, userId, wallet, lang = 'en') {
  if (!/^0x[0-9a-f]{40}$/i.test(wallet || '')) {
    const cur = await INV.redis('SMEMBERS', `stalk:list:${chatId}`).catch(() => null);
    if (Array.isArray(cur) && cur.length) {
      let body = `watching ${cur.length} wallet(s):\n`;
      cur.forEach(w => { body += `${INV.short(w)}\n`; });
      body += `\nstop: /unstalk <addr>\n`;
      return send(chatId, term('stalk --list', body));
    }
    return send(chatId, term('stalk', 'usage: /stalk 0x...\n\nalerts you the moment that wallet\nmoves · sells, buys, transfers.'));
  }
  wallet = wallet.toLowerCase();
  const latest = await INV.bscan({ module: 'account', action: 'txlist', address: wallet, page: '1', offset: '1', sort: 'desc' });
  const lastHash = Array.isArray(latest.result) && latest.result[0] ? latest.result[0].hash : '';
  await INV.redis('SADD', `stalk:list:${chatId}`, wallet);
  await INV.redis('SADD', 'stalk:all', `${chatId}:${wallet}`);
  await INV.redis('SET', `stalk:seen:${chatId}:${wallet}`, lastHash);
  await send(chatId, term(`stalk ${INV.short(wallet)}`, `status WATCHING\n\nyou'll be pinged on every new move.\nstop: /unstalk`));
}
async function cmdUnstalk(chatId, wallet, lang = 'en') {
  if (!/^0x[0-9a-f]{40}$/i.test(wallet || '')) {
    await INV.redis('DEL', `stalk:list:${chatId}`);
    return send(chatId, term('unstalk --all', 'stopped watching all wallets'));
  }
  wallet = wallet.toLowerCase();
  await INV.redis('SREM', `stalk:list:${chatId}`, wallet);
  await INV.redis('SREM', 'stalk:all', `${chatId}:${wallet}`);
  await send(chatId, term(`unstalk ${INV.short(wallet)}`, 'stopped watching ' + INV.short(wallet)));
}

async function smartDetect(chatId, userId, text, lang) {
  const isID = lang === 'id';

  // 1. Bare 0x address -> detect contract vs wallet
  const addrMatch = text.match(/^(0x[0-9a-fA-F]{40})$/i);
  if (addrMatch) {
    const addr = addrMatch[1].toLowerCase();
    typing(chatId);
    try {
      const code = await baseRpc('eth_getCode', [addr, 'latest']);
      const isContract = code && code !== '0x' && code.length > 4;

      if (isContract) {
        await send(chatId, isID ? `*Kontrak terdeteksi* · menganalisa token...` : `*Contract detected* · analyzing token...`);
        const gate = await aiAllowed(chatId, userId);
        if (gate.ok) {
          await cmdAnalyze(chatId, addr, lang);
        } else {
          const [token, dex] = await Promise.allSettled([getTokenInfo(addr), getDex(addr)]);
          const tok = token.status === 'fulfilled' ? token.value : null;
          const dx  = dex.status === 'fulfilled' ? dex.value : null;
          const chain = dx?.chainId === 'robinhood' ? 'Robinhood' : 'Base';
          let msg = `*${tok?.name || 'Unknown'} (${tok?.symbol || '?'})*\n`;
          msg += `\`${addr.slice(0,6)}...${addr.slice(-4)}\` · ${chain}\n\n`;
          if (dx) {
            const price = dx.priceUsd ? `$${dx.priceUsd < 0.01 ? dx.priceUsd.toFixed(8) : dx.priceUsd.toFixed(6)}` : '-';
            const ch24 = dx.priceChange24h;
            msg += `*${isID ? 'Harga' : 'Price'}:* ${price}\n`;
            msg += `*24h:* ${ch24 >= 0 ? '' : ''} ${ch24}%\n`;
            msg += `*Liq:* $${dx.liquidityUsd.toLocaleString()} | *Vol 24h:* $${dx.volume24h.toLocaleString()}\n`;
            msg += `*B/S 24h:* ${dx.buys24h}/${dx.sells24h} (${dx.buySellRatio})\n`;
            if (dx.fdv > 0) msg += `*FDV:* $${dx.fdv.toLocaleString()}\n`;
          } else {
            msg += `_${isID ? 'Belum listing di DEX manapun' : 'Not listed on any DEX'}_\n`;
          }
          msg += `\n _${isID ? 'Hold 10M $ORLIX untuk analisa AI lengkap' : 'Hold 10M $ORLIX for full AI analysis'}_`;
          await tg('sendMessage', {
            chat_id: chatId, text: msg, parse_mode: 'Markdown', disable_web_page_preview: true,
            reply_markup: { inline_keyboard: [
              [{ text: `Chart`, url: dx?.url || `https://dexscreener.com/base/${addr}` }],
              [{ text: `${isID ? 'Analisa Lengkap' : 'Full Analysis'}`, callback_data: `analyze:${addr}` }],
            ] },
          });
        }
      } else {
        await send(chatId, isID ? `*Dompet terdeteksi* · memuat info...` : `*Wallet detected* · loading info...`);
        await cmdWatch(chatId, addr, lang);
      }
    } catch (e) {
      await send(chatId, `${e.message}`);
    }
    return true;
  }

  // 2. $TICKER (exact match, e.g. "$BRETT" or "$orlix")
  const tickerMatch = text.match(/^\$([A-Za-z]{2,12})$/);
  if (tickerMatch) {
    await cmdTickerPrice(chatId, tickerMatch[1], lang);
    return true;
  }

  return false;
}

// ── Main handler ──────────────────────────────────────────────────────────────

// ── One-time setup: register the command list + the blue "Menu" button ──────────
// The native Telegram Menu button appears automatically once commands are set.
// Trigger once after deploy:  GET /api/telegram?setup=<TELEGRAM_WEBHOOK_SECRET>
async function setupBot() {
  const post = async (method, body) => {
    const r = await tg(method, body);
    return r ? await r.json().catch(() => ({ ok: false })) : { ok: false, error: 'no token' };
  };
  // Single English command set for everyone (matches the English website/brand).
  const en = [
    { command: 'start',   description: 'About Orlix + get started' },
    { command: 'menu',    description: 'Quick actions' },
    { command: 'swap',    description: 'Swap ORLIX <-> ETH' },
    { command: 'bridge',  description: 'Bridge Base <-> Robinhood' },
    { command: 'top',     description: 'Top trending tokens' },
    { command: 'analyze', description: 'Deep token analysis' },
    { command: 'dossier', description: 'Full rug dossier + risk score' },
    { command: 'trace',   description: 'Follow a wallet\'s money trail' },
    { command: 'cluster', description: 'Find a wallet\'s side wallets' },
    { command: 'deployer',description: 'Every token a deployer launched' },
    { command: 'early',   description: 'First buyers · who still holds' },
    { command: 'networth',description: 'Full portfolio value of a wallet' },
    { command: 'link',    description: 'How two wallets are connected' },
    { command: 'rep',     description: 'Reputation score Orlix knows on a wallet' },
    { command: 'stalk',   description: 'Alert me when a wallet moves' },
    { command: 'price',   description: 'Quick token price' },
    { command: 'watch',   description: 'Wallet activity tracker' },
    { command: 'wallet',  description: 'Your Base agent wallet' },
    { command: 'balance', description: 'Check agent wallet balance' },
    { command: 'help',    description: 'Full command list' },
  ];
  return {
    commands:   (await post('setMyCommands', { commands: en })).ok,
    // remove any old Indonesian override so ID-language users also see English
    clearedID:  (await post('deleteMyCommands', { language_code: 'id' })).ok,
    menuButton: (await post('setChatMenuButton', { menu_button: { type: 'commands' } })).ok,
  };
}

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    const token = TG_TOKEN();
    const llmKey = ANTHROPIC_KEY();
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET || '';
    // one-time: register commands + Menu button
    if (req.query && req.query.setup !== undefined) {
      if (secret && req.query.setup !== secret) {
        return res.status(403).json({ ok: false, error: 'bad setup key' });
      }
      const setup = await setupBot();
      return res.status(200).json({ ok: true, setup });
    }
    return res.status(200).json({
      ok: true,
      configured: !!token,
      status: {
        TELEGRAM_BOT_TOKEN: token ? `set (${token.slice(0,8)}...)` : 'MISSING',
        BANKR_LLM_KEY: llmKey ? `set (${llmKey.slice(0,8)}...)` : 'MISSING',
        TELEGRAM_WEBHOOK_SECRET: secret ? 'set' : 'not set',
      }
    });
  }
  if (req.method !== 'POST') return res.status(405).end();

  const token = TG_TOKEN();
  if (!token) return res.status(200).json({ ok: true });

  // Fail CLOSED: the webhook secret MUST be configured and match. Without this,
  // anyone could forge Telegram updates and drain LLM credits.
  // Set TELEGRAM_WEBHOOK_SECRET in Vercel env AND on the Telegram webhook.
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET || '';
  const incoming = req.headers['x-telegram-bot-api-secret-token'] || '';
  if (!webhookSecret || incoming !== webhookSecret) return res.status(200).json({ ok: true });

  // Stalk mode without a paid cron: piggyback a throttled scan on live webhook
  // traffic. It self-limits to once every ~5 min via Redis and runs concurrently
  // with message handling (which is I/O-bound), so it never delays a reply.
  const stalkJob = stalkScanThrottled(300, 40).catch(() => {});

  const update = req.body || {};

  // ── Callback queries (inline button presses) ──────────────────────────────
  const callback = update.callback_query;
  if (callback) {
    const cbChat = callback.message?.chat?.id;
    const cbUser = callback.from?.id ?? cbChat;
    const cbData = callback.data || '';
    const cbLang = detectLang(callback.message?.text || '');
    if (cbChat) {
      tg('answerCallbackQuery', { callback_query_id: callback.id }).catch(() => {});
      try {
        if (cbData.startsWith('analyze:')) {
          const addr = cbData.slice(8).toLowerCase();
          const gate = await aiAllowed(cbChat, cbUser);
          if (!gate.ok) { await denyAiGate(cbChat, cbLang, gate); }
          else { await send(cbChat, 'Analyzing...'); await cmdAnalyze(cbChat, addr, cbLang); }
        } else if (cbData.startsWith('watch:')) {
          await cmdWatch(cbChat, cbData.slice(6).toLowerCase(), cbLang);
        } else if (cbData.startsWith('trace:')) {
          const g = await aiAllowed(cbChat, cbUser);
          if (!g.ok) { await denyAiGate(cbChat, cbLang, g); } else { await cmdTrace(cbChat, cbData.slice(6).toLowerCase(), cbLang); }
        } else if (cbData.startsWith('cluster:')) {
          const g = await aiAllowed(cbChat, cbUser);
          if (!g.ok) { await denyAiGate(cbChat, cbLang, g); } else { await cmdCluster(cbChat, cbData.slice(8).toLowerCase(), cbLang); }
        } else if (cbData.startsWith('deployer:')) {
          const g = await aiAllowed(cbChat, cbUser);
          if (!g.ok) { await denyAiGate(cbChat, cbLang, g); } else { await cmdDeployer(cbChat, cbData.slice(9).toLowerCase(), cbLang); }
        } else if (cbData.startsWith('early:')) {
          const g = await aiAllowed(cbChat, cbUser);
          if (!g.ok) { await denyAiGate(cbChat, cbLang, g); } else { await cmdEarly(cbChat, cbData.slice(6).toLowerCase(), cbLang); }
        } else if (cbData.startsWith('networth:')) {
          const g = await aiAllowed(cbChat, cbUser);
          if (!g.ok) { await denyAiGate(cbChat, cbLang, g); } else { await cmdNetWorth(cbChat, cbData.slice(9).toLowerCase(), cbLang); }
        } else if (cbData.startsWith('dossier:')) {
          const g = await aiAllowed(cbChat, cbUser);
          if (!g.ok) { await denyAiGate(cbChat, cbLang, g); } else { await cmdDossier(cbChat, cbData.slice(8).toLowerCase(), cbLang); }
        } else if (cbData.startsWith('price:')) {
          await cmdPrice(cbChat, cbData.slice(6).toLowerCase());
        } else if (cbData.startsWith('ticker:')) {
          await cmdTickerPrice(cbChat, cbData.slice(7), cbLang);
        } else if (cbData.startsWith('csw:')) {
          const nonce = cbData.slice(4);
          const pending = pendingSwaps.get(nonce);
          if (!pending) {
            await send(cbChat, cbLang === 'id' ? 'Swap sudah kedaluwarsa. Coba lagi dengan /swap' : 'Swap expired. Try again with /swap');
          } else if (Date.now() > pending.expiry) {
            pendingSwaps.delete(nonce);
            await send(cbChat, cbLang === 'id' ? '⏰ Swap kedaluwarsa. Buat ulang dengan /swap' : '⏰ Swap expired. Create a new one with /swap');
          } else {
            pendingSwaps.delete(nonce);
            await send(cbChat, cbLang === 'id' ? '⏳ Menjalankan swap...' : '⏳ Executing swap...');
            try {
              const result = await execSwap(pending.userId, pending.tokenAddr, pending.amount, pending.isEthToToken, pending.decimals);
              const outFmt = pending.isEthToToken
                ? result.expected.toLocaleString(undefined, { maximumFractionDigits: 0 })
                : result.expected.toFixed(6);
              const outSym = pending.isEthToToken ? pending.symbol : 'ETH';
              let msg = cbLang === 'id' ? `*Swap Berhasil!*\n\n` : `*Swap Successful!*\n\n`;
              msg += `${pending.isEthToToken ? pending.amount + ' ETH' : pending.amount.toLocaleString() + ' ' + pending.symbol}\n`;
              msg += ` ~${outFmt} ${outSym}\n\n`;
              msg += ` [Tx on BaseScan](https://basescan.org/tx/${result.hash})`;
              await tg('sendMessage', {
                chat_id: cbChat, text: msg, parse_mode: 'Markdown', disable_web_page_preview: true,
                reply_markup: { inline_keyboard: [
                  [{ text: 'View Transaction', url: `https://basescan.org/tx/${result.hash}` }],
                ] },
              });
            } catch (e) {
              await send(cbChat, `Swap failed: ${e.message}`);
            }
          }
        } else if (cbData.startsWith('cswno:')) {
          const nonce = cbData.slice(6);
          pendingSwaps.delete(nonce);
          await send(cbChat, cbLang === 'id' ? 'Swap dibatalkan.' : 'Swap cancelled.');
        } else if (cbData === 'swap_menu') {
          await cmdSwap(cbChat, cbUser, '', cbLang);
        } else if (cbData === 'top') {
          await cmdTop(cbChat, cbLang);
        }
      } catch (e) { await send(cbChat, `${e.message}`); }
    }
    return res.status(200).json({ ok: true });
  }

  const message = update.message || update.edited_message;
  if (!message) return res.status(200).json({ ok: true });

  const chatId    = message.chat?.id;
  const userId    = message.from?.id ?? chatId;
  const firstName = message.from?.first_name || 'friend';
  let text        = (message.text || '').trim();
  if (!chatId) return res.status(200).json({ ok: true });

  // ── Group Guardian ─────────────────────────────────────────────────────────
  // In group chats, auto-scan any contract address posted and warn if it's risky
  // (free, non-spammy). Only respond to explicit commands otherwise — no AI chat.
  const isGroup = message.chat?.type === 'group' || message.chat?.type === 'supergroup';
  if (isGroup) {
    text = text.replace(/^(\/[a-z_]+)@\w+/i, '$1');   // /dossier@OrlixBot -> /dossier
    const isCmd = /^\/[a-z]/i.test(text);
    if (!isCmd) { if (text) await guardianScan(chatId, text).catch(() => {}); return res.status(200).json({ ok: true }); }
    guardianScan(chatId, text).catch(() => {});       // also scan CAs in command messages
  }

  typing(chatId);
  const lang = detectLang(text);
  const isID = lang === 'id';

  // ── /start ────────────────────────────────────────────────────────────────
  if (text === '/start' || text.startsWith('/start ')) {
    const session = sessions.get(chatId);
    const accessLine = session?.verified
      ? (isID ? `\n _Wallet terverifikasi · ${session.balance} ORLIX_` : `\n _Wallet verified · ${session.balance} ORLIX_`)
      : (isID ? `\n _Fitur AI: hold 10M $ORLIX di agent wallet kamu · /wallet lalu setor, cek /balance_` : `\n _AI features: hold 10M $ORLIX in your agent wallet · /wallet, deposit, then /balance_`);

    await tg('sendMessage', {
      chat_id: chatId, parse_mode: 'Markdown', disable_web_page_preview: true,
      text: '```\norlix ai · base chain intelligence\n```\n' +
      (isID
        ? `hi ${firstName}. agen onchain untuk *Base & Robinhood*.\nkasih satu petunjuk. wallet, token, atau screenshot. saya bongkar sisanya.\n\n`
        : `hi ${firstName}. onchain agent for *Base & Robinhood*.\ngive me one clue. a wallet, a token, a screenshot. i'll find the rest.\n\n`) +
      '```\n' +
      'detective\n' +
      '  trace     money trail to its source\n' +
      '  cluster   side wallets of one operator\n' +
      '  deployer  every token a dev launched\n' +
      '  early     first buyers, who still holds\n' +
      '  dossier   risk report + rug score\n' +
      '  networth  full portfolio value\n' +
      '  link      how two wallets connect\n' +
      '  stalk     alert when a wallet moves\n\n' +
      'trading\n' +
      '  swap · bridge · top · price · analyze\n\n' +
      'wallet\n' +
      '  wallet · balance · export\n' +
      '```\n' +
      (isID
        ? `_tempel 0x · ketik $TICKER · kirim screenshot · tanya apa saja_`
        : `_paste 0x · type $TICKER · send a screenshot · ask anything_`) +
      accessLine + `\n\n_orlixai.xyz_`,
      reply_markup: { inline_keyboard: [
        [{ text: 'swap', callback_data: 'swap_menu' }, { text: 'top', callback_data: 'top' }],
        [{ text: 'dashboard', url: 'https://orlixai.xyz/app' }],
      ] },
    });
    return res.status(200).json({ ok: true });
  }

  // ── /menu ─────────────────────────────────────────────────────────────────
  if (text === '/menu') {
    await tg('sendMessage', {
      chat_id: chatId,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      text: '```\norlix:~$ menu\n```\n' + (isID
        ? `*trading*\nswap · bridge · top · price · analyze\n\n*detective* _(10M $ORLIX)_\ndossier · trace · cluster · deployer\nearly · networth · link · rep · stalk\n\n*wallet*\nwallet · balance · export\n\n_tempel 0x · ketik $TICKER · kirim screenshot_`
        : `*trading*\nswap · bridge · top · price · analyze\n\n*detective* _(10M $ORLIX)_\ndossier · trace · cluster · deployer\nearly · networth · link · rep · stalk\n\n*wallet*\nwallet · balance · export\n\n_paste 0x · type $TICKER · send a screenshot_`),
      reply_markup: { inline_keyboard: [
        [{ text: 'swap', callback_data: 'swap_menu' }, { text: 'top', callback_data: 'top' }],
        [{ text: 'dashboard', url: 'https://orlixai.xyz/app' },
         { text: 'buy $ORLIX', url: 'https://orlixai.xyz/token' }],
        [{ text: 'base city', url: 'https://orlixai.xyz/base-city' }],
      ] },
    });
    return res.status(200).json({ ok: true });
  }

  // ── /wallet ─────────────────────────────────────────────────────────────────
  if (text === '/wallet' || text.startsWith('/wallet ')) {
    const w = agentWallet(userId);
    if (!w) {
      await send(chatId, isID
        ? `Fitur agent wallet belum dikonfigurasi.`
        : `Agent wallet is not configured yet.`);
      return res.status(200).json({ ok: true });
    }
    await send(chatId, isID
      ? `*Agent Wallet Base kamu:*\n\`${w.address}\`\n\n Setor *10,000,000 $ORLIX* ke sini untuk buka fitur AI.\n\n_Cek saldo: /balance · Ambil kendali penuh / tarik dana: /export (private key)._`
      : `*Your Base agent wallet:*\n\`${w.address}\`\n\n Deposit *10,000,000 $ORLIX* here to unlock AI.\n\n_Check balance: /balance · Take full control / withdraw: /export (private key)._`);
    return res.status(200).json({ ok: true });
  }

  // ── /balance ────────────────────────────────────────────────────────────────
  if (text === '/balance' || text.startsWith('/balance ')) {
    const w = agentWallet(userId);
    if (!w) {
      await send(chatId, isID ? `Agent wallet belum dikonfigurasi.` : `Agent wallet is not configured yet.`);
      return res.status(200).json({ ok: true });
    }
    const addr = w.address;
    const tokenArg = (text.split(/\s+/)[1] || '').toLowerCase();
    try {
      const [ethHex, orlixRaw] = await Promise.all([
        baseRpc('eth_getBalance', [addr, 'latest']),
        getOrlixBalance(addr),
      ]);
      const lines = [
        `*ETH:* ${fmtAmt(ethers.formatEther(BigInt(ethHex || '0x0')))}`,
        `*ORLIX:* ${fmtAmt(ethers.formatUnits(orlixRaw, 18))}`,
      ];
      if (tokenArg && /^0x[0-9a-f]{40}$/i.test(tokenArg)) {
        const [info, raw] = await Promise.all([getTokenInfo(tokenArg), erc20BalanceOf(tokenArg, addr)]);
        lines.push(`*${info.symbol}:* ${fmtAmt(ethers.formatUnits(raw, info.decimals))}`);
      }
      await send(chatId,
        `*${isID ? 'Saldo Agent Wallet' : 'Agent Wallet Balance'}*\n\`${addr}\`\n\n` +
        lines.join('\n') +
        `\n\n_${isID ? 'Read-only · spending dinonaktifkan. Cek token lain: /balance <alamat token>' : 'Read-only · spending disabled. Check another token: /balance <token address>'}_`);
    } catch (e) {
      await send(chatId, `${isID ? 'Gagal cek saldo' : 'Balance check failed'}: ${e.message}`);
    }
    return res.status(200).json({ ok: true });
  }

  // ── /export ── reveal the agent wallet private key (self-custody / withdraw)
  if (text === '/export') {
    const w = agentWallet(userId);
    if (!w) {
      await send(chatId, isID ? 'Agent wallet belum dikonfigurasi.' : 'Agent wallet is not configured yet.');
      return res.status(200).json({ ok: true });
    }
    await send(chatId, isID
      ? `*Private key agent wallet kamu*\n\`${w.privateKey}\`\n\nAlamat: \`${w.address}\`\n\n_Import ke wallet apa pun (MetaMask, dll) untuk kontrol penuh & tarik dana._`
      : `*Your agent wallet private key*\n\`${w.privateKey}\`\n\nAddress: \`${w.address}\`\n\n_Import into any wallet (MetaMask, etc.) for full control & withdrawals._`);
    return res.status(200).json({ ok: true });
  }

  // ── /help ─────────────────────────────────────────────────────────────────
  if (text === '/help') {
    const verified = isVerified(chatId);
    await send(chatId,
      '```\norlix:~$ help --all\n```\n' +
      `access: ${isID ? 'hold 10M $ORLIX di agent wallet' : 'hold 10M $ORLIX in your agent wallet'} · /wallet ${verified ? '[ok]' : '[locked]'}\n\n` +
      '```\n' +
      'detective  (needs 10M $ORLIX)\n' +
      '  dossier <token>    risk report + rug score\n' +
      '  trace <wallet>     money trail to source\n' +
      '  cluster <wallet>   side wallets, one operator\n' +
      '  deployer <token>   dev\'s full launch history\n' +
      '  early <token>      first buyers, who holds\n' +
      '  networth <wallet>  full portfolio value\n' +
      '  link <a> <b>       how two wallets connect\n' +
      '  rep <wallet>       reputation Orlix has learned\n' +
      '  stalk <wallet>     alert when it moves\n\n' +
      'trading\n' +
      '  swap · bridge · top · price · analyze\n\n' +
      'onchain (free)\n' +
      '  price <token> · watch <wallet>\n\n' +
      'wallet\n' +
      '  wallet · balance · export\n\n' +
      'smart detection\n' +
      '  paste 0x address    -> contract or wallet\n' +
      '  type $TICKER        -> instant price\n' +
      '  send a screenshot   -> auto-investigation\n' +
      '  ask anything        -> ai chat\n\n' +
      'group guardian\n' +
      '  add me to a group and I auto-scan every\n' +
      '  contract posted, warning on risky ones.\n' +
      '```\n' +
      `[orlixai.xyz](https://orlixai.xyz)`
    );
    return res.status(200).json({ ok: true });
  }

  // ── /web ──────────────────────────────────────────────────────────────────
  if (text === '/web') {
    await tg('sendMessage', {
      chat_id: chatId,
      text: isID ? 'Buka dashboard Orlix AI:' : 'Open the Orlix AI dashboard:',
      reply_markup: { inline_keyboard: [[{ text: 'Launch Orlix AI', url: 'https://orlixai.xyz/app' }]] },
    });
    return res.status(200).json({ ok: true });
  }

  // ── /price (free) ─────────────────────────────────────────────────────────
  if (text.startsWith('/price')) {
    const addr = (text.split(/\s+/)[1] || '').toLowerCase();
    if (!addr || !/^0x[0-9a-f]{40}$/i.test(addr)) {
      await send(chatId, isID ? `Contoh: /price <alamat token>` : `Usage: /price <token address>`);
      return res.status(200).json({ ok: true });
    }
    try { await cmdPrice(chatId, addr); }
    catch (e) { await send(chatId, `${e.message}`); }
    return res.status(200).json({ ok: true });
  }

  // ── /watch (free) ─────────────────────────────────────────────────────────
  if (text.startsWith('/watch')) {
    const addr = (text.split(/\s+/)[1] || '').toLowerCase();
    if (!addr || !/^0x[0-9a-f]{40}$/i.test(addr)) {
      await send(chatId, isID ? `Contoh: /watch <alamat dompet>` : `Usage: /watch <wallet address>`);
      return res.status(200).json({ ok: true });
    }
    await send(chatId, isID ? `Memeriksa dompet...` : `Looking up wallet...`);
    try { await cmdWatch(chatId, addr, lang); }
    catch (e) { await send(chatId, `${isID ? 'Gagal' : 'Failed'}: ${e.message}`); }
    return res.status(200).json({ ok: true });
  }

  // ── /analyze (gated) ──────────────────────────────────────────────────────
  if (text.startsWith('/analyze')) {
    { const g = await aiAllowed(chatId, userId); if (!g.ok) { await denyAiGate(chatId, lang, g); return res.status(200).json({ ok: true }); } }
    const addr = (text.split(/\s+/)[1] || '').toLowerCase();
    if (!addr || !/^0x[0-9a-f]{40}$/i.test(addr)) {
      await send(chatId, isID ? `Contoh: /analyze <alamat token>` : `Usage: /analyze <token address>`);
      return res.status(200).json({ ok: true });
    }
    await send(chatId, isID ? `Menganalisa token...` : `Analyzing token...`);
    try { await cmdAnalyze(chatId, addr, lang); }
    catch (e) { await send(chatId, `${isID ? 'Analisa gagal' : 'Analysis failed'}: ${e.message}`); }
    return res.status(200).json({ ok: true });
  }

  // ── ONCHAIN DETECTIVE (gated) ─────────────────────────────────────────────
  const invRoute = [
    { re: /^\/trace\b/,    fn: (a) => cmdTrace(chatId, a, lang),           need: 'wallet' },
    { re: /^\/cluster\b/,  fn: (a) => cmdCluster(chatId, a, lang),         need: 'wallet' },
    { re: /^\/deployer\b/, fn: (a) => cmdDeployer(chatId, a, lang),        need: 'token'  },
    { re: /^\/early\b/,    fn: (a) => cmdEarly(chatId, a, lang),           need: 'token'  },
    { re: /^\/(dossier|rugcheck|rug)\b/, fn: (a) => cmdDossier(chatId, a, lang), need: 'token' },
    { re: /^\/(networth|worth|portfolio)\b/, fn: (a) => cmdNetWorth(chatId, a, lang), need: 'wallet' },
    { re: /^\/(rep|reputation)\b/, fn: (a) => cmdRep(chatId, a, lang), need: 'wallet' },
  ];
  for (const route of invRoute) {
    if (route.re.test(text)) {
      { const g = await aiAllowed(chatId, userId); if (!g.ok) { await denyAiGate(chatId, lang, g); return res.status(200).json({ ok: true }); } }
      const addr = (text.split(/\s+/)[1] || '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$/i.test(addr)) {
        await send(chatId, isID ? `Contoh: \`${text.split(/\s+/)[0]} 0x...\` (alamat ${route.need === 'token' ? 'token' : 'wallet'})` : `Usage: \`${text.split(/\s+/)[0]} 0x...\` (${route.need} address)`);
        return res.status(200).json({ ok: true });
      }
      try { await route.fn(addr); }
      catch (e) { await send(chatId, `${e.message}`); }
      return res.status(200).json({ ok: true });
    }
  }

  // ── /link <A> <B> (gated) — connection between two wallets ────────────────
  if (text.startsWith('/link')) {
    { const g = await aiAllowed(chatId, userId); if (!g.ok) { await denyAiGate(chatId, lang, g); return res.status(200).json({ ok: true }); } }
    const parts = text.split(/\s+/).filter(p => /^0x[0-9a-f]{40}$/i.test(p));
    if (parts.length < 2) {
      await send(chatId, isID ? `Contoh: \`/link 0x... 0x...\` (dua alamat wallet)` : `Usage: \`/link 0x... 0x...\` (two wallet addresses)`);
      return res.status(200).json({ ok: true });
    }
    try { await cmdLink(chatId, parts[0].toLowerCase(), parts[1].toLowerCase(), lang); }
    catch (e) { await send(chatId, `${e.message}`); }
    return res.status(200).json({ ok: true });
  }

  // ── /stalk · /unstalk (gated) ─────────────────────────────────────────────
  if (text.startsWith('/stalk')) {
    { const g = await aiAllowed(chatId, userId); if (!g.ok) { await denyAiGate(chatId, lang, g); return res.status(200).json({ ok: true }); } }
    try { await cmdStalk(chatId, userId, text.split(/\s+/)[1], lang); }
    catch (e) { await send(chatId, `${e.message}`); }
    return res.status(200).json({ ok: true });
  }
  if (text.startsWith('/unstalk')) {
    try { await cmdUnstalk(chatId, text.split(/\s+/)[1], lang); }
    catch (e) { await send(chatId, `${e.message}`); }
    return res.status(200).json({ ok: true });
  }

  // ── /swap (free) ───────────────────────────────────────────────────────────
  if (text.startsWith('/swap')) {
    const args = text.slice(5).trim();
    try { await cmdSwap(chatId, userId, args, lang); }
    catch (e) { await send(chatId, `${e.message}`); }
    return res.status(200).json({ ok: true });
  }

  // ── /bridge (free) ────────────────────────────────────────────────────────
  if (text === '/bridge' || text.startsWith('/bridge ')) {
    try { await cmdBridge(chatId, lang); }
    catch (e) { await send(chatId, `${e.message}`); }
    return res.status(200).json({ ok: true });
  }

  // ── /top (free) ───────────────────────────────────────────────────────────
  if (text === '/top') {
    try { await cmdTop(chatId, lang); }
    catch (e) { await send(chatId, `${e.message}`); }
    return res.status(200).json({ ok: true });
  }

  // ── Photo / vision (gated) ────────────────────────────────────────────────
  if (message.photo) {
    { const g = await aiAllowed(chatId, userId); if (!g.ok) { await denyAiGate(chatId, lang, g); return res.status(200).json({ ok: true }); } }
    const caption = message.caption || (isID ? 'Jelaskan gambar ini' : 'Describe this image');
    const photo   = message.photo[message.photo.length - 1];
    const fileRes = await tg('getFile', { file_id: photo.file_id }).then(r => r?.json()).catch(() => null);
    if (!fileRes?.result?.file_path) {
      await send(chatId, isID ? 'Gagal mengambil file gambar.' : 'Could not retrieve image file.');
      return res.status(200).json({ ok: true });
    }
    const fileUrl = `https://api.telegram.org/file/bot${token}/${fileRes.result.file_path}`;
    const imgBuf  = await fetch(fileUrl).then(r => r.arrayBuffer()).catch(() => null);
    if (!imgBuf) {
      await send(chatId, '' + (isID ? 'Gagal mengunduh gambar.' : 'Could not download image.'));
      return res.status(200).json({ ok: true });
    }
    const b64  = Buffer.from(imgBuf).toString('base64');
    const ext  = fileRes.result.file_path.split('.').pop() || 'jpeg';
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    try {
      const { url: aiUrl, headers: aiHdr } = aiEndpoint(ANTHROPIC_KEY());
      // Vision pass 1: read the screenshot AND extract any onchain clue as JSON,
      // so a chart / DM / wallet screenshot can auto-launch an investigation.
      const r = await fetch(aiUrl, {
        method: 'POST', headers: aiHdr,
        body: JSON.stringify({
          model: 'claude-sonnet-4-6', max_tokens: 1500,
          system: `You are Orlix AI, an onchain detective reading a screenshot. ${isID ? 'Balas dalam Bahasa Indonesia.' : 'Reply in English.'}

First, describe what the image shows (a chart, a DM, a group chat, a wallet, a tweet, a contract, etc) and pull out anything an investigator would care about: ticker, token name, price, a contract address, a wallet address, a tx hash, timestamps, usernames, claims.

Telegram markdown ONLY: *bold*, _italic_, \`code\`. NEVER use # headers or --- rules. NEVER use the em-dash or en-dash ("—" / "–"); use a period, comma, or colon. Use *bold* on its own line for section titles. Keep it tight and plain-terminal.

Then, on the VERY LAST line, output a machine-readable clue block EXACTLY in this format (no other text after it):
CLUE|type=<token|wallet|none>|address=<0x... or NONE>|ticker=<SYMBOL or NONE>
Rules: 'token' if you see a contract address or a coin/ticker being discussed; 'wallet' if the main subject is a wallet/holder address; a 40-hex 0x address is required to set address=, otherwise NONE.`,
          messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } },
            { type: 'text', text: caption },
          ]}],
        }),
      });
      const data = await r.json();
      let out = data.content?.[0]?.text || (isID ? 'Tidak dapat menganalisa gambar.' : 'Could not analyze image.');

      // Parse + strip the clue line
      let clue = null;
      const cm = out.match(/CLUE\|type=(\w+)\|address=(0x[0-9a-fA-F]{40}|NONE)\|ticker=([A-Za-z0-9]+|NONE)/);
      if (cm) { clue = { type: cm[1], address: cm[2], ticker: cm[3] }; out = out.replace(/\n?CLUE\|.*$/s, '').trim(); }
      await sendLong(chatId, out);

      // Auto-launch the matching investigation from the extracted clue
      if (clue) {
        let addr = clue.address !== 'NONE' ? clue.address.toLowerCase() : null;
        if (!addr && clue.ticker !== 'NONE') {
          const found = await searchTicker(clue.ticker).catch(() => null);
          if (found?.baseToken?.address) addr = found.baseToken.address.toLowerCase();
        }
        if (addr && /^0x[0-9a-f]{40}$/i.test(addr)) {
          await send(chatId, isID
            ? `_Menemukan petunjuk di gambar · memulai investigasi otomatis pada_ \`${INV.short(addr)}\`...`
            : ` _Found a clue in the image · auto-investigating_ \`${INV.short(addr)}\`...`);
          try {
            if (clue.type === 'wallet') await cmdTrace(chatId, addr, lang);
            else await cmdDossier(chatId, addr, lang);
          } catch (e) { await send(chatId, `${e.message}`); }
        }
      }
    } catch (e) { await send(chatId, `Vision error: ${e.message}`); }
    return res.status(200).json({ ok: true });
  }

  // ── Smart detection: bare address or $TICKER ──────────────────────────────
  if (!text) return res.status(200).json({ ok: true });

  try {
    const handled = await smartDetect(chatId, userId, text, lang);
    if (handled) return res.status(200).json({ ok: true });
  } catch { /* fall through to AI chat */ }

  // ── Free text -> AI chat (gated) ───────────────────────────────────────────
  { const g = await aiAllowed(chatId, userId); if (!g.ok) { await denyAiGate(chatId, lang, g); return res.status(200).json({ ok: true }); } }

  try { await cmdChat(chatId, text, lang); }
  catch (e) { await send(chatId, `Error: ${e.message}`); }

  await stalkJob;   // let the piggybacked stalk scan finish on this common path
  return res.status(200).json({ ok: true });
};
