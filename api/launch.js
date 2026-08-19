// Vercel Serverless Function — /api/launch
// Backs the Agent Launcher (/launcher): AI launch-package generation, and
// image upload/serve (so token logos are hosted, not pasted URLs).
//   ?action=generate  POST {idea}         -> { name, ticker, description }
//   ?action=upload    POST {data:dataURL} -> { url }
//   ?action=img&id=…  GET                 -> raw image bytes
//
// Uses the Bankr LLM gateway (BANKR_LLM_KEY) for generation and Upstash Redis
// for image storage — the same infra the rest of the site already uses.

const IMG_PREFIX = 'limg:';
const BASE_URL = 'https://orlixai.xyz';

function creds() {
  const c = [
    { url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN },
    { url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN },
    { url: process.env.STORAGE_UPSTASH_REDIS_REST_URL, token: process.env.STORAGE_UPSTASH_REDIS_REST_TOKEN },
  ];
  return c.find((x) => x.url && x.token) || null;
}
async function redis(url, token, ...args) {
  // Upstash single-command REST: POST base URL with a JSON array body ["SET","key","val"].
  // (The /pipeline endpoint rejects our body with "failed to parse pipeline request".)
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const j = await r.json();
  if (j && j.error) throw new Error(j.error);
  return j ? (j.result ?? null) : null;
}
function rid() {
  return Array.from({ length: 20 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[(Math.random() * 36) | 0]).join('');
}
function readBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
  });
}

// deterministic fallback if the LLM is unavailable
function fallbackPackage(idea) {
  const words = String(idea).replace(/[^a-zA-Z0-9 ]/g, '').split(/\s+/).filter(Boolean);
  const name = (words.slice(0, 2).join(' ') || 'Agent Token').replace(/\b\w/g, (m) => m.toUpperCase());
  const ticker = (words.find((w) => w.length >= 3) || 'ORLX').slice(0, 5).toUpperCase();
  return { name, ticker, description: String(idea).slice(0, 180) };
}

async function generate(idea) {
  const key = process.env.BANKR_LLM_KEY || '';
  if (!key) return fallbackPackage(idea);
  const sys =
    'You are ORLIX\'s token launch engine on Robinhood Chain. Given a one-sentence idea, invent a launch package. ' +
    'Return ONLY compact JSON: {"name": string (catchy, <=32 chars), "ticker": string (3-6 UPPERCASE letters/numbers), ' +
    '"description": string (1-2 punchy sentences, <=200 chars)}. No markdown, no extra text.';
  try {
    const r = await fetch('https://llm.bankr.bot/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'system', content: sys }, { role: 'user', content: String(idea).slice(0, 400) }],
        max_tokens: 400,
        temperature: 0.9,
      }),
    });
    const j = await r.json();
    let txt = j?.choices?.[0]?.message?.content || '';
    const m = txt.match(/\{[\s\S]*\}/);
    if (m) {
      const o = JSON.parse(m[0]);
      const ticker = String(o.ticker || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
      if (o.name && ticker) return { name: String(o.name).slice(0, 42), ticker, description: String(o.description || '').slice(0, 220) };
    }
  } catch (_) {}
  return fallbackPackage(idea);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = (req.query.action || '').toString();

  // ── serve an uploaded image ──
  if (action === 'img') {
    const id = (req.query.id || '').toString().replace(/[^a-z0-9]/gi, '');
    const c = creds();
    if (!id || !c) return res.status(404).end();
    try {
      const data = await redis(c.url, c.token, 'GET', IMG_PREFIX + id);
      if (!data) return res.status(404).end();
      const m = /^data:([^;]+);base64,(.*)$/s.exec(data);
      if (!m) return res.status(404).end();
      const buf = Buffer.from(m[2], 'base64');
      res.setHeader('Content-Type', m[1]);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return res.status(200).send(buf);
    } catch { return res.status(404).end(); }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const body = await readBody(req);

  // ── AI generate ──
  if (action === 'generate') {
    const idea = (body.idea || '').toString().trim();
    if (idea.length < 3) return res.status(400).json({ error: 'Describe your idea in a sentence.' });
    const pkg = await generate(idea);
    return res.status(200).json(pkg);
  }

  // ── upload an image ──
  if (action === 'upload') {
    const data = (body.data || '').toString();
    const m = /^data:(image\/(png|jpeg|jpg|gif|webp|svg\+xml));base64,/.exec(data);
    if (!m) return res.status(400).json({ error: 'Send a base64 image data URL.' });
    if (data.length > 1_600_000) return res.status(413).json({ error: 'Image too large (max ~1MB).' });
    const c = creds();
    if (!c) return res.status(500).json({ error: 'Storage not configured.' });
    const id = rid();
    try {
      await redis(c.url, c.token, 'SET', IMG_PREFIX + id, data);
      return res.status(200).json({ url: `${BASE_URL}/api/launch?action=img&id=${id}` });
    } catch (e) {
      return res.status(500).json({ error: 'Upload failed.' });
    }
  }

  return res.status(400).json({ error: 'Unknown action.' });
}
