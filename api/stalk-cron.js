// Orlix AI — Stalk Mode cron
// Scans every wallet registered via /stalk and DMs the owner the moment it
// moves. Registered as a Vercel cron (see vercel.json). Also invocable
// manually: GET /api/stalk-cron?key=<TELEGRAM_WEBHOOK_SECRET>

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

async function scan() {
  // 'stalk:all' is a set of "chatId:wallet" pairs
  const all = await INV.redis('SMEMBERS', 'stalk:all').catch(() => null);
  if (!Array.isArray(all) || !all.length) return { scanned: 0, alerts: 0 };

  let alerts = 0;
  for (const pair of all.slice(0, 60)) {          // cap per run to stay under the timeout
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
    if (!lastSeen) continue;                          // first observation → set baseline, don't alert

    // Build a short alert for the newest tx(s)
    const fresh = [];
    for (const t of txs) { if (t.hash === lastSeen) break; fresh.push(t); }
    const t = newest;
    const isOut = t.from?.toLowerCase() === wallet.toLowerCase();
    const val = t.value ? (Number(t.value) / 1e18).toFixed(4) : '0';
    const dir = isOut ? '📤 SENT' : '📥 RECEIVED';
    const peer = isOut ? t.to : t.from;
    let msg = `🚨 *STALK ALERT*\n\`${short(wallet)}\` ${INV.label(wallet) ? '('+INV.label(wallet)+')' : ''}just moved\n\n`;
    msg += `${dir} *${val} ETH* ${isOut ? '→' : '←'} \`${short(peer)}\`${INV.label(peer) ? ' 🏦 ' + INV.label(peer) : ''}\n`;
    if (fresh.length > 1) msg += `_+${fresh.length - 1} more new tx_\n`;
    msg += `\n[🔍 Tx](https://basescan.org/tx/${t.hash}) · [Wallet](https://basescan.org/address/${wallet})`;
    await tg('sendMessage', { chat_id: chatId, text: msg, parse_mode: 'Markdown', disable_web_page_preview: true });
    alerts++;
  }
  return { scanned: all.length, alerts };
}

module.exports = async function handler(req, res) {
  // Vercel cron sends a GET; allow a manual key too. Cron requests carry a
  // special header, but we also accept the webhook secret for manual runs.
  const key = process.env.TELEGRAM_WEBHOOK_SECRET || '';
  const isCron = !!req.headers['x-vercel-cron'];
  const manualOk = key && req.query && req.query.key === key;
  if (!isCron && !manualOk) return res.status(403).json({ ok: false, error: 'forbidden' });
  try {
    const out = await scan();
    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message });
  }
};
