// Orlix AI — Stalk Mode scanner
// Scans every wallet registered via /stalk and DMs the owner the moment it
// moves. Two ways to trigger it:
//   1) Opportunistically from the Telegram webhook (throttled ~5 min) — works
//      on Vercel Hobby with no cron needed. See stalkScan() import in telegram.js.
//   2) Manually / external cron: GET /api/stalk-cron?key=<TELEGRAM_WEBHOOK_SECRET>

const INV = require('./_investigate.js');

const TG_TOKEN = () => process.env.TELEGRAM_BOT_TOKEN || '';

async function tg(method, body) {
  const token = TG_TOKEN();
  if (!token) return null;
  return fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => null);
}
const short = a => a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '?';

// Core scan. `limit` caps how many wallets we touch per run so we stay well
// under the function timeout even when called inline from the webhook.
async function stalkScan(limit = 40) {
  const all = await INV.redis('SMEMBERS', 'stalk:all').catch(() => null);
  if (!Array.isArray(all) || !all.length) return { scanned: 0, alerts: 0 };

  let alerts = 0;
  for (const pair of all.slice(0, limit)) {
    const sep = pair.lastIndexOf(':');
    const chatId = pair.slice(0, sep);
    const wallet = pair.slice(sep + 1);
    if (!/^0x[0-9a-f]{40}$/i.test(wallet)) continue;

    const j = await INV.bscan({ module: 'account', action: 'txlist', address: wallet, page: '1', offset: '3', sort: 'desc' });
    const txs = Array.isArray(j.result) ? j.result : [];
    if (!txs.length) continue;
    const newest = txs[0];
    const seenKey = `stalk:seen:${chatId}:${wallet}`;
    const lastSeen = await INV.redis('GET', seenKey).catch(() => null);
    if (newest.hash === lastSeen) continue;         // nothing new

    await INV.redis('SET', seenKey, newest.hash);
    if (!lastSeen) continue;                          // first observation → baseline only

    const fresh = [];
    for (const t of txs) { if (t.hash === lastSeen) break; fresh.push(t); }
    const t = newest;
    const isOut = t.from?.toLowerCase() === wallet.toLowerCase();
    const val = t.value ? (Number(t.value) / 1e18).toFixed(4) : '0';
    const dir = isOut ? 'SENT' : 'RECEIVED';
    const peer = isOut ? t.to : t.from;
    let msg = '```\n';
    msg += `stalk alert :: ${short(wallet)}${INV.label(wallet) ? ' (' + INV.label(wallet) + ')' : ''}\n`;
    msg += '─'.repeat(30) + '\n';
    msg += `${dir}  ${val} ETH  ${isOut ? '->' : '<-'}  ${short(peer)}${INV.label(peer) ? ' (' + INV.label(peer) + ')' : ''}\n`;
    if (fresh.length > 1) msg += `+${fresh.length - 1} more new tx\n`;
    msg += '```\n';
    msg += `[tx](https://basescan.org/tx/${t.hash}) · [wallet](https://basescan.org/address/${wallet})`;
    await tg('sendMessage', { chat_id: chatId, text: msg, parse_mode: 'Markdown', disable_web_page_preview: true });
    alerts++;
  }
  return { scanned: all.length, alerts };
}

// Throttled wrapper — only actually scans if >minGapSec has passed since the
// last run (tracked in Redis). Safe to call on every webhook hit.
async function stalkScanThrottled(minGapSec = 300, limit = 40) {
  const last = await INV.redis('GET', 'stalk:lastscan').catch(() => null);
  const now = Math.floor(Date.now() / 1000);
  if (last && now - Number(last) < minGapSec) return { skipped: true };
  // claim the slot first so concurrent invocations don't double-scan
  await INV.redis('SET', 'stalk:lastscan', String(now));
  return stalkScan(limit);
}

module.exports = async function handler(req, res) {
  const key = process.env.TELEGRAM_WEBHOOK_SECRET || '';
  const isCron = !!req.headers['x-vercel-cron'];
  const manualOk = key && req.query && req.query.key === key;
  if (!isCron && !manualOk) return res.status(403).json({ ok: false, error: 'forbidden' });
  try {
    const out = await stalkScan(60);
    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message });
  }
};

module.exports.stalkScan = stalkScan;
module.exports.stalkScanThrottled = stalkScanThrottled;
