// /api/bankr-tokens.js — Bankr new tokens via GMGN API
const { checkLimits, allowedOrigin } = require('./_guard');
const CORS = {
  'Access-Control-Allow-Origin': 'https://orlixai.xyz',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Vary': 'Origin',
  'Content-Type': 'application/json',
};

module.exports = async (req, res) => {
  CORS['Access-Control-Allow-Origin'] = allowedOrigin(req);
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

  const _lim = await checkLimits(req, { bucket: 'bankrtokens', perMin: 40, perDay: 800, globalDay: 20000 });
  if (_lim.blocked) { res.writeHead(_lim.status, CORS); return res.end(JSON.stringify({ error: _lim.reason })); }

  const apiKey = process.env.GMGN_API_KEY;
  if (!apiKey) {
    res.writeHead(503, CORS);
    return res.end(JSON.stringify({ error: 'GMGN_API_KEY not configured' }));
  }

  const limit = 50;
  const filters = ['offchain', 'onchain'];
  const platform = ['bankr'];
  const quoteType = [11, 3, 12, 13, 0];

  const section = { filters, launchpad_platform: platform, quote_address_type: quoteType, launchpad_platform_v2: true, limit };
  const body = { version: 'v2', new_creation: section, pump: section, completed: section };

  const ts = Math.floor(Date.now() / 1000);
  const cid = 'orlix-' + Math.random().toString(36).slice(2, 10);

  try {
    const r = await fetch(
      `https://openapi.gmgn.ai/v1/trenches?chain=base&timestamp=${ts}&client_id=${cid}`,
      {
        method: 'POST',
        headers: { 'X-APIKEY': apiKey, 'Content-Type': 'application/json', 'User-Agent': 'orlix/1.0' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      }
    );

    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`GMGN ${r.status}: ${txt.slice(0, 120)}`);
    }

    const data = await r.json();
    res.writeHead(200, { ...CORS, 'Cache-Control': 'public,max-age=15' });
    res.end(JSON.stringify(data));
  } catch (e) {
    res.writeHead(502, CORS);
    res.end(JSON.stringify({ error: e.message }));
  }
};
