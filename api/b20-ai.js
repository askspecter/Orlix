// /api/b20-ai — Parse natural language token description → B20 form fields (Claude Haiku)
const { checkLimits, allowedOrigin } = require('./_guard');

const CORS = {
  'Access-Control-Allow-Origin': 'https://orlixai.xyz',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Vary': 'Origin',
  'Content-Type': 'application/json',
};

const SYSTEM = `You are a B20 token parameter extractor for the Base blockchain.
Given a natural language description, extract token parameters and return ONLY valid JSON.
No markdown, no code fences, no explanation — pure JSON only.

Return exactly this JSON structure:
{
  "name": string,
  "symbol": string,
  "variant": "asset" | "stablecoin",
  "decimals": 18 | 6,
  "allowlist": boolean,
  "blocklist": boolean,
  "freeze": boolean
}

Rules:
- name: Title Case, clean (e.g. "GameFi Token", "Bankr Protocol")
- symbol: UPPERCASE, no spaces, max 11 chars (e.g. "GAMEFI", "BNKR")
- variant: "stablecoin" ONLY if explicitly described as stable/pegged/USD-backed; otherwise "asset"
- decimals: 18 for asset tokens; 6 for stablecoins
- Supply cap is always fixed at 1 billion (1,000,000,000). Do not include supply fields.
- allowlist: true if "whitelist", "allowlist", "KYC", "approved-only" mentioned
- blocklist: true if "blacklist", "blocklist", "ban" mentioned
- freeze: true if "freeze", "seize", "compliance", "regulatory" mentioned
- When in doubt about policies: false`;

module.exports = async (req, res) => {
  CORS['Access-Control-Allow-Origin'] = allowedOrigin(req);
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (req.method !== 'POST') {
    res.writeHead(405, CORS);
    return res.end(JSON.stringify({ error: 'POST only' }));
  }

  // Shared Redis-backed guard (replaces the old bypassable in-memory limiter)
  const _lim = await checkLimits(req, { bucket: 'b20ai', perMin: 8, perDay: 80, globalDay: 1500 });
  if (_lim.blocked) { res.writeHead(_lim.status, CORS); return res.end(JSON.stringify({ error: _lim.reason })); }

  let body = '';
  req.on('data', c => {
    body += c;
    if (body.length > 8000) { body = ''; req.destroy(); }
  });
  await new Promise(r => req.on('end', r));

  let description;
  try { description = JSON.parse(body).description; } catch {
    res.writeHead(400, CORS); return res.end(JSON.stringify({ error: 'Invalid JSON body' }));
  }
  if (!description?.trim()) {
    res.writeHead(400, CORS); return res.end(JSON.stringify({ error: 'description required' }));
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    res.writeHead(500, CORS); return res.end(JSON.stringify({ error: 'Service temporarily unavailable' }));
  }

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        system: SYSTEM,
        messages: [{ role: 'user', content: String(description).slice(0, 500) }],
      }),
      signal: AbortSignal.timeout(12000),
    });

    if (!r.ok) throw new Error(`Anthropic ${r.status}`);
    const data = await r.json();
    const raw = (data.content?.[0]?.text || '').trim();
    // Strip markdown code fences if model wraps response
    const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const params = JSON.parse(text);

    // Sanitize output
    params.symbol = (params.symbol || '').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0, 11);
    params.decimals = params.variant === 'stablecoin' ? 6 : (Number(params.decimals) || 18);
    // Supply is always fixed at 1B
    delete params.uncapped;
    delete params.supply;

    res.writeHead(200, CORS);
    res.end(JSON.stringify(params));
  } catch (e) {
    res.writeHead(502, CORS);
    res.end(JSON.stringify({ error: e.message || 'AI generation failed' }));
  }
};
