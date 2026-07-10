// /api/b20-ai — Orlix B20 AI endpoint (multi-mode, single serverless function).
//   • default            : natural-language description → B20 form fields (autofill)
//   • { mode:"policy" }  : AI Policy Compiler — rules → validated B20 config + trust score
//   • { mode:"agent" }   : Agentic launch planner (allow-listed) → ready agent_deploy plan
// Kept as one function to stay under the Vercel plan's serverless-function cap.
const crypto = require('crypto');
const { checkLimits, allowedOrigin } = require('./_guard');

const CORS = {
  'Access-Control-Allow-Origin': 'https://orlixai.xyz',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Orlix-Key',
  'Vary': 'Origin',
  'Content-Type': 'application/json',
};

// ── Prompts ───────────────────────────────────────────────────────────────────
const SYSTEM_EXTRACT = `You are a B20 token parameter extractor for the Base blockchain.
Given a natural language description, extract token parameters and return ONLY valid JSON.
No markdown, no code fences, no explanation — pure JSON only.

Return exactly this JSON structure:
{ "name": string, "symbol": string, "variant": "asset"|"stablecoin", "decimals": 18|6,
  "allowlist": boolean, "blocklist": boolean, "freeze": boolean }

Rules:
- name: Title Case, clean. symbol: UPPERCASE, no spaces, max 11 chars.
- variant: "stablecoin" ONLY if explicitly stable/pegged/USD-backed; otherwise "asset".
- decimals: 18 for asset; 6 for stablecoins. Supply cap fixed at 1B — omit supply fields.
- allowlist: true if whitelist/allowlist/KYC/approved-only. blocklist: true if blacklist/ban.
- freeze: true if freeze/seize/compliance/regulatory. When in doubt about policies: false`;

const SYSTEM_POLICY = `You are the Orlix B20 Policy Compiler for the Base blockchain.
The user describes token rules in plain language. Turn them into a B20 config.
Return ONLY valid JSON (no markdown, no prose):
{
  "token": { "name": string, "symbol": string, "variant": "asset"|"stablecoin", "decimals": 18|6 },
  "onchain": {
    "immutable": boolean, "supplyCap": number|null, "allowlist": boolean, "blocklist": boolean,
    "freezeSeize": boolean, "pausable": boolean, "metadataEditable": boolean, "keepMintRole": boolean
  },
  "advisory": [ { "rule": string, "why": string } ],
  "warnings": [ string ],
  "summary": string
}
CRITICAL — B20 precompile ONLY natively enforces: immutability, supply cap, allowlist,
blocklist, freeze & seize, pausable transfers, editable metadata, and role delegation.
Anything TIME-BASED or TRADE-BASED — anti-snipe, "no sells for N minutes", "max wallet %
in first hour", cooldowns, sniper-fee decay, wash-trade detection, auto-buyback — is NOT a
B20 native policy. Put every such rule in "advisory" with a clear "why" (needs a Uniswap V4
hook), and NEVER set an onchain flag for it.
Rules: name Title Case; symbol UPPERCASE max 11. variant "stablecoin" only if pegged; decimals
6 for stablecoin else 18. If immutable is true, keepMintRole/pausable/freezeSeize/metadataEditable
must be false. allowlist+blocklist together: keep both, warn allowlist wins. Default everything
false / immutable=true (trustless) unless asked. warnings: flag centralization in plain language.
summary: one or two sentences a non-technical creator understands.`;

// ── Helpers (Policy Compiler) ─────────────────────────────────────────────────
function toNum(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : null; }

function scoreOf(o) {
  let s = 55; const f = [];
  if (o.immutable) { s += 30; f.push('+ Immutable — no admin after launch'); }
  else {
    f.push('− Keeps an admin wallet');
    if (o.keepMintRole) { s -= 16; f.push('− Mintable — supply can grow'); }
    if (o.freezeSeize)  { s -= 12; f.push('− Freeze & seize enabled'); }
    if (o.pausable)     { s -= 8;  f.push('− Transfers can be paused'); }
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
  immutable: { label: 'Immutability', enforcement: 'native' },
  supplyCap: { label: 'Supply cap', enforcement: 'native' },
  allowlist: { label: 'Allowlist', enforcement: 'native' },
  blocklist: { label: 'Blocklist', enforcement: 'native' },
  freezeSeize: { label: 'Freeze & seize', enforcement: 'role' },
  pausable: { label: 'Pausable', enforcement: 'role' },
  metadataEditable: { label: 'Editable metadata', enforcement: 'role' },
  keepMintRole: { label: 'Mintable', enforcement: 'role' },
};

function agentAllowed(agentKey) {
  const raw = (process.env.B20_AGENT_ALLOWLIST || '').trim();
  if (!raw || !agentKey) return false;
  return raw.split(',').map(s => s.trim()).filter(Boolean).some(k => {
    if (k.length !== agentKey.length) return false;
    try { return crypto.timingSafeEqual(Buffer.from(k), Buffer.from(agentKey)); } catch { return false; }
  });
}

async function askClaude(system, user, maxTokens) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('AI unavailable');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: maxTokens, system, messages: [{ role: 'user', content: String(user).slice(0, 1500) }] }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}`);
  const data = await r.json();
  const txt = (data.content?.[0]?.text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  return JSON.parse(txt);
}

async function compilePolicy(rules) {
  const m = await askClaude(SYSTEM_POLICY, rules, 900);
  const t = m.token || {};
  const variant = t.variant === 'stablecoin' ? 'stablecoin' : 'asset';
  const token = {
    name: String(t.name || 'My Token').slice(0, 40),
    symbol: String(t.symbol || 'TOKEN').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 11) || 'TOKEN',
    variant, decimals: variant === 'stablecoin' ? 6 : (Number(t.decimals) || 18),
  };
  const oc = m.onchain || {};
  const immutable = oc.immutable !== false;
  const onchain = {
    immutable,
    supplyCap: toNum(oc.supplyCap),
    allowlist: !!oc.allowlist,
    blocklist: !!oc.blocklist,
    freezeSeize: immutable ? false : !!oc.freezeSeize,
    pausable: immutable ? false : !!oc.pausable,
    metadataEditable: immutable ? false : !!oc.metadataEditable,
    keepMintRole: immutable ? false : !!oc.keepMintRole,
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
  const compiled = [];
  for (const [k, meta] of Object.entries(ENF)) {
    const val = onchain[k];
    if (k === 'supplyCap' ? val != null : !!val) compiled.push({ key: k, label: meta.label, enforcement: meta.enforcement, value: k === 'supplyCap' ? val : true });
  }
  compiled.unshift({ key: 'variant', label: token.variant === 'stablecoin' ? 'Stablecoin' : 'Asset token', enforcement: 'native', value: true });
  const trust = scoreOf(onchain);
  const deployConfig = {
    name: token.name, symbol: token.symbol, variant: token.variant, decimals: token.decimals,
    adminless: onchain.immutable,
    policies: { allowlist: onchain.allowlist, blocklist: onchain.blocklist, freeze: onchain.freezeSeize },
    supply_cap: onchain.supplyCap ? String(onchain.supplyCap) : undefined,
    keep_mint_role: onchain.keepMintRole, metadata_editable: onchain.metadataEditable, pausable: onchain.pausable,
  };
  return { ok: true, token, onchain, compiled, advisory, warnings, trust, summary: String(m.summary || '').slice(0, 400), deployConfig };
}

// ── Handler ───────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  CORS['Access-Control-Allow-Origin'] = allowedOrigin(req);
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (req.method !== 'POST') { res.writeHead(405, CORS); return res.end(JSON.stringify({ error: 'POST only' })); }

  let body = '';
  req.on('data', c => { body += c; if (body.length > 12000) { body = ''; req.destroy(); } });
  await new Promise(r => req.on('end', r));

  let parsed;
  try { parsed = JSON.parse(body); } catch { res.writeHead(400, CORS); return res.end(JSON.stringify({ error: 'Invalid JSON body' })); }

  const agentKey = req.headers['x-orlix-key'] || '';
  const mode = parsed.mode || (agentKey ? 'agent' : (parsed.rules ? 'policy' : 'extract'));

  try {
    // ── Agentic launch planner ──
    if (mode === 'agent') {
      if (!agentAllowed(agentKey)) { res.writeHead(403, CORS); return res.end(JSON.stringify({ ok: false, error: 'Forbidden: agent not on allowlist' })); }
      const _lim = await checkLimits(req, { bucket: 'b20agent', perMin: 6, perDay: 60, globalDay: 800 });
      if (_lim.blocked) { res.writeHead(_lim.status, CORS); return res.end(JSON.stringify({ ok: false, error: _lim.reason })); }
      const brief = parsed.brief || parsed.rules;
      if (!brief?.trim()) { res.writeHead(400, CORS); return res.end(JSON.stringify({ ok: false, error: 'brief required' })); }
      const plan = await compilePolicy(brief);
      const deploy = { action: 'agent_deploy', ...plan.deployConfig, network: 'mainnet' };
      const creator = /^0x[0-9a-fA-F]{40}$/.test(parsed.creator || '') ? parsed.creator : undefined;
      if (creator) { deploy.creator = creator; if (!deploy.adminless) deploy.admin = creator; }
      res.writeHead(200, CORS);
      return res.end(JSON.stringify({ ok: true, brief: String(brief).slice(0, 400), plan,
        execute: { endpoint: '/api/b20-skill', method: 'POST', header: 'X-Orlix-Key: <your agent key>', body: deploy,
          note: 'Deploys custodially via Turnkey under the daily spend cap. Review plan.warnings and plan.trust first.' } }));
    }

    // ── Policy Compiler ──
    if (mode === 'policy') {
      const _lim = await checkLimits(req, { bucket: 'b20policy', perMin: 8, perDay: 100, globalDay: 2000 });
      if (_lim.blocked) { res.writeHead(_lim.status, CORS); return res.end(JSON.stringify({ ok: false, error: _lim.reason })); }
      const rules = parsed.rules;
      if (!rules?.trim()) { res.writeHead(400, CORS); return res.end(JSON.stringify({ ok: false, error: 'rules required' })); }
      const out = await compilePolicy(rules);
      res.writeHead(200, CORS);
      return res.end(JSON.stringify(out));
    }

    // ── Default: description → form fields ──
    const _lim = await checkLimits(req, { bucket: 'b20ai', perMin: 8, perDay: 80, globalDay: 1500 });
    if (_lim.blocked) { res.writeHead(_lim.status, CORS); return res.end(JSON.stringify({ error: _lim.reason })); }
    const description = parsed.description;
    if (!description?.trim()) { res.writeHead(400, CORS); return res.end(JSON.stringify({ error: 'description required' })); }
    const params = await askClaude(SYSTEM_EXTRACT, description, 300);
    params.symbol = (params.symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 11);
    params.decimals = params.variant === 'stablecoin' ? 6 : (Number(params.decimals) || 18);
    delete params.uncapped; delete params.supply;
    res.writeHead(200, CORS);
    res.end(JSON.stringify(params));
  } catch (e) {
    res.writeHead(502, CORS);
    res.end(JSON.stringify({ ok: false, error: e.message || 'AI request failed' }));
  }
};
