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

const GEN_SYS =
  'You are ORLIX\'s degen token-launch engine on Robinhood Chain. From a one-sentence idea, invent a WILD, memeable launch package that would pop off on crypto Twitter. ' +
  'Rules: name = punchy, funny or epic, <=28 chars, no generic words like "Token"/"Coin". ticker = 3-6 UPPERCASE letters, clever, easy to shill. ' +
  'description = 1-2 electric sentences with attitude, <=180 chars. ' +
  'image_prompt = a vivid degen-meme art-direction prompt for a square token mascot: describe the SUBJECT and its unhinged crypto-meme action/expression (think pepe/wojak/chad/doge energy, moon, laser eyes, tendies, pump) and the MOOD/background only — do NOT specify a render style (pixel/3D/neon is chosen separately). No text/words in the image. ' +
  'Return ONLY compact JSON: {"name":string,"ticker":string,"description":string,"image_prompt":string}. No markdown.';

// Art-direction presets appended to every image prompt. Default is a pixel-art degen meme.
const STYLE_PRESETS = {
  pixel: 'as a 16-bit pixel-art degen crypto meme, retro arcade sprite, crisp pixelated shading, limited neon palette, dithering, punchy meme energy, flat solid background',
  degen: 'as an unhinged degen crypto meme sticker, bold outlines, exaggerated meme expression, vaporwave neon accents, glossy sticker finish, high contrast, flat background',
  neon: 'as a neon-glow synthwave degen meme, glowing outlines, dark background, electric cyan and lime rim light, retro-futuristic, high contrast',
  '3d': 'as a glossy 3D-rendered degen meme mascot, soft studio lighting, vibrant plastic material, playful, clean gradient background',
};
function stylePreset(s) {
  return STYLE_PRESETS[String(s || '').toLowerCase()] || STYLE_PRESETS.pixel;
}

function parsePkg(txt) {
  const m = String(txt || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    const ticker = String(o.ticker || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    if (o.name && ticker) return {
      name: String(o.name).slice(0, 42), ticker,
      description: String(o.description || '').slice(0, 220),
      image_prompt: String(o.image_prompt || '').slice(0, 500),
    };
  } catch (_) {}
  return null;
}

async function generate(idea) {
  // Try Venice (same key as image gen, reliable) then Bankr; deterministic fallback last.
  const attempts = [];
  const vkey = process.env.VENICE_API_KEY || '';
  if (vkey) attempts.push({ url: 'https://api.venice.ai/api/v1/chat/completions', key: vkey, model: 'venice-uncensored' });
  const bkey = process.env.BANKR_LLM_KEY || '';
  if (bkey) attempts.push({ url: 'https://llm.bankr.bot/v1/chat/completions', key: bkey, model: 'gpt-4o-mini' });
  const user = String(idea).slice(0, 400);
  for (const a of attempts) {
    try {
      const r = await fetch(a.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + a.key },
        body: JSON.stringify({ model: a.model, messages: [{ role: 'system', content: GEN_SYS }, { role: 'user', content: user }], max_tokens: 500, temperature: 1.0 }),
      });
      if (!r.ok) continue;
      const j = await r.json();
      const pkg = parsePkg(j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content);
      if (pkg) return pkg;
    } catch (_) {}
  }
  return fallbackPackage(idea);
}

// AI image via Venice (uncensored, fast). Returns a base64 data URL, or null.
// `style` selects an art-direction preset (default: pixel-art degen meme).
async function generateImage(prompt, style) {
  const key = process.env.VENICE_API_KEY || '';
  if (!key || !prompt) return null;
  const preset = stylePreset(style);
  const models = ['flux-dev', 'venice-sd35', 'stable-diffusion-3.5'];
  for (const model of models) {
    try {
      const r = await fetch('https://api.venice.ai/api/v1/image/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({
          model,
          prompt: String(prompt).slice(0, 1200) + ', ' + preset + ', centered square meme icon, no text, no watermark',
          width: 640, height: 640, format: 'webp', steps: 12,
          safe_mode: false, hide_watermark: true,
        }),
      });
      if (!r.ok) continue;
      const j = await r.json();
      const b64 = j && j.images && j.images[0];
      if (b64) return 'data:image/webp;base64,' + b64;
    } catch (_) {}
  }
  return null;
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

  // ── AI image generation (Venice) → hosted URL ──
  if (action === 'image') {
    const prompt = (body.prompt || '').toString().trim();
    if (prompt.length < 3) return res.status(400).json({ error: 'Provide an image prompt.' });
    const style = (body.style || 'pixel').toString();
    const dataUrl = await generateImage(prompt, style);
    if (!dataUrl) return res.status(502).json({ error: 'Image generation unavailable.' });
    const c = creds();
    if (!c) return res.status(200).json({ dataUrl }); // no store — return inline (caller may still use it as preview)
    const id = rid();
    try {
      await redis(c.url, c.token, 'SET', IMG_PREFIX + id, dataUrl);
      return res.status(200).json({ url: `${BASE_URL}/api/launch?action=img&id=${id}` });
    } catch (e) {
      return res.status(200).json({ dataUrl });
    }
  }

  return res.status(400).json({ error: 'Unknown action.' });
}
