// /api/b20-policy — AI Policy Compiler.
// Turns natural-language token rules into a real, validated B20 config, honestly
// split into what the B20 precompile enforces on-chain vs. what would need a
// Uniswap V4 hook (advisory). Also returns a deterministic trust score, warnings,
// and a ready-to-deploy config for /api/b20-skill.
const { checkLimits, allowedOrigin } = require('./_guard');

const CORS = {
  'Access-Control-Allow-Origin': 'https://orlixai.xyz',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Vary': 'Origin',
  'Content-Type': 'application/json',
};

// What the B20 precompile can actually enforce, described for the model so it
// never promises features B20 doesn't have.
const SYSTEM = `You are the Orlix B20 Policy Compiler for the Base blockchain.
The user describes token rules in plain language. Turn them into a B20 config.

Return ONLY valid JSON (no markdown, no prose):
{
  "token": { "name": string, "symbol": string, "variant": "asset"|"stablecoin", "decimals": 18|6 },
  "onchain": {
    "immutable": boolean,          // true = no admin after launch (renounce). Safer, but no future changes.
    "supplyCap": number|null,      // hard max supply, or null for the fixed launch supply
    "allowlist": boolean,          // only approved wallets can receive (KYC / permissioned)
    "blocklist": boolean,          // named wallets are banned from transferring
    "freezeSeize": boolean,        // admin can freeze accounts and seize balances (compliance)
    "pausable": boolean,           // admin can pause all transfers
    "metadataEditable": boolean,   // keep METADATA role so name/links can be edited later
    "keepMintRole": boolean        // creator can mint more supply later (inflationary)
  },
  "advisory": [ { "rule": string, "why": string } ],
  "warnings": [ string ],
  "summary": string
}

CRITICAL — B20 precompile ONLY natively enforces: immutability, supply cap, allowlist,
blocklist, freeze & seize, pausable transfers, editable metadata, and role delegation
(mint/burn/pause). Anything TIME-BASED or TRADE-BASED — anti-snipe, "no sells for N minutes",
"max wallet % in first hour", cooldowns, sniper-fee decay, wash-trade detection, auto-buyback —
is NOT a B20 native policy. Put every such rule in "advisory" with a clear "why" (needs a
Uniswap V4 hook), and NEVER set an onchain flag for it.

Rules:
- name Title Case; symbol UPPERCASE max 11 chars.
- variant "stablecoin" only if pegged/USD-backed; else "asset". decimals 6 for stablecoin else 18.
- If immutable is true, keepMintRole/pausable/freezeSeize/metadataEditable must be false (an
  immutable token keeps no admin roles). Add a warning if the user asked for both.
- allowlist + blocklist together: keep both but warn allowlist takes precedence.
- Default everything to false / immutable=true (trustless) unless the text asks otherwise.
- warnings: flag any centralization powers in plain language so buyers understand the tradeoff.
- summary: one or two sentences a non-technical creator understands.`;

function toNum(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : null; }

// Deterministic, buyer-facing trust score (0-100) computed server-side — never
// trust the model for the number. Higher = less centralized control.
function scoreOf(o) {
  let s = 55;
  const f = [];
  if (o.immutable) { s += 30; f.push('+ Immutable — no admin after launch'); }
  else {
    f.push('− Keeps an admin wallet');
    if (o.keepMintRole)  { s -= 16; f.push('− Mintable — supply can grow'); }
    if (o.freezeSeize)   { s -= 12; f.push('− Freeze & seize enabled'); }
    if (o.pausable)      { s -= 8;  f.push('− Transfers can be paused'); }
    if (o.metadataEditable) { s -= 3; f.push('· Metadata editable'); }
  }
  if (o.blocklist) { s -= 6; f.push('− Blocklist (wallets can be banned)'); }
  if (o.allowlist) { s -= 6; f.push('− Allowlist (permissioned transfers)'); }
  if (o.supplyCap) { s += 10; f.push('+ Hard supply cap'); }
  s = Math.max(0, Math.min(100, s));
  const tier = s >= 82 ? 'Trustless' : s >= 62 ? 'Solid' : s >= 42 ? 'Caution' : 'High control';
  return { score: s, tier, factors: f };
}

const ENF = {
  immutable:        { label: 'Immutability',      enforcement: 'native' },
  supplyCap:        { label: 'Supply cap',        enforcement: 'native' },
  allowlist:        { label: 'Allowlist',         enforcement: 'native' },
  blocklist:        { label: 'Blocklist',         enforcement: 'native' },
  freezeSeize:      { label: 'Freeze & seize',    enforcement: 'role'   },
  pausable:         { label: 'Pausable',          enforcement: 'role'   },
  metadataEditable: { label: 'Editable metadata', enforcement: 'role'   },
  keepMintRole:     { label: 'Mintable',          enforcement: 'role'   },
};

// Core: natural-language rules -> compiled B20 policy result. Reused by the
// Policy Compiler page and by the agentic launch endpoint (/api/b20-agent).
async function compilePolicy(rules) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('AI unavailable');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 900,
      system: SYSTEM,
      messages: [{ role: 'user', content: String(rules).slice(0, 1500) }],
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}`);
  const data = await r.json();
  const txt = (data.content?.[0]?.text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const m = JSON.parse(txt);

  // ── Sanitize / normalize ──
  {
    const t = m.token || {};
    const variant = t.variant === 'stablecoin' ? 'stablecoin' : 'asset';
    const token = {
      name: String(t.name || 'My Token').slice(0, 40),
      symbol: String(t.symbol || 'TOKEN').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 11) || 'TOKEN',
      variant,
      decimals: variant === 'stablecoin' ? 6 : (Number(t.decimals) || 18),
    };
    const oc = m.onchain || {};
    const immutable = oc.immutable !== false;   // default trustless
    const onchain = {
      immutable,
      supplyCap: toNum(oc.supplyCap),
      allowlist: !!oc.allowlist,
      blocklist: !!oc.blocklist,
      freezeSeize: immutable ? false : !!oc.freezeSeize,
      pausable:    immutable ? false : !!oc.pausable,
      metadataEditable: immutable ? false : !!oc.metadataEditable,
      keepMintRole:     immutable ? false : !!oc.keepMintRole,
    };

    const warnings = Array.isArray(m.warnings) ? m.warnings.slice(0, 8).map(String) : [];
    if (immutable && (oc.keepMintRole || oc.pausable || oc.freezeSeize || oc.metadataEditable))
      warnings.unshift('You asked for an admin power AND immutability — immutable wins, so those powers were dropped.');
    if (onchain.allowlist && onchain.blocklist)
      warnings.push('Allowlist and blocklist both on — allowlist takes precedence.');

    const advisory = Array.isArray(m.advisory) ? m.advisory.slice(0, 8).map(a => ({
      rule: String(a.rule || '').slice(0, 120),
      why: String(a.why || 'Not a B20 native policy — needs a Uniswap V4 hook.').slice(0, 200),
      status: 'needs-hook',
    })) : [];

    // Enforcement view (what's on-chain vs role-gated)
    const compiled = [];
    for (const [k, meta] of Object.entries(ENF)) {
      const val = onchain[k];
      if (k === 'supplyCap' ? val != null : !!val) compiled.push({ key: k, label: meta.label, enforcement: meta.enforcement, value: k === 'supplyCap' ? val : true });
    }
    compiled.unshift({ key: 'variant', label: token.variant === 'stablecoin' ? 'Stablecoin' : 'Asset token', enforcement: 'native', value: true });

    const trust = scoreOf(onchain);

    // Ready-to-deploy config for /api/b20-skill (action=prepare)
    const deployConfig = {
      name: token.name, symbol: token.symbol, variant: token.variant, decimals: token.decimals,
      adminless: onchain.immutable,
      policies: { allowlist: onchain.allowlist, blocklist: onchain.blocklist, freeze: onchain.freezeSeize },
      supply_cap: onchain.supplyCap ? String(onchain.supplyCap) : undefined,
      keep_mint_role: onchain.keepMintRole,
      metadata_editable: onchain.metadataEditable,
      pausable: onchain.pausable,
    };

    return {
      ok: true, token, onchain, compiled, advisory, warnings, trust,
      summary: String(m.summary || '').slice(0, 400),
      deployConfig,
    };
  }
}

module.exports = async (req, res) => {
  CORS['Access-Control-Allow-Origin'] = allowedOrigin(req);
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (req.method !== 'POST') { res.writeHead(405, CORS); return res.end(JSON.stringify({ ok: false, error: 'POST only' })); }

  const _lim = await checkLimits(req, { bucket: 'b20policy', perMin: 8, perDay: 100, globalDay: 2000 });
  if (_lim.blocked) { res.writeHead(_lim.status, CORS); return res.end(JSON.stringify({ ok: false, error: _lim.reason })); }

  let body = '';
  req.on('data', c => { body += c; if (body.length > 12000) { body = ''; req.destroy(); } });
  await new Promise(r => req.on('end', r));

  let rules;
  try { rules = JSON.parse(body).rules; } catch { res.writeHead(400, CORS); return res.end(JSON.stringify({ ok: false, error: 'Invalid JSON body' })); }
  if (!rules?.trim()) { res.writeHead(400, CORS); return res.end(JSON.stringify({ ok: false, error: 'rules required' })); }

  try {
    const out = await compilePolicy(rules);
    res.writeHead(200, CORS);
    res.end(JSON.stringify(out));
  } catch (e) {
    res.writeHead(502, CORS);
    res.end(JSON.stringify({ ok: false, error: e.message || 'Policy compile failed' }));
  }
};
module.exports.compilePolicy = compilePolicy;
