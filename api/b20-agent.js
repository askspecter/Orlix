// /api/b20-agent — Agentic launch planner (the "brain" of the Orlix agent economy).
// An allow-listed AI agent posts a natural-language BRIEF; this compiles it into a
// validated B20 token + policy config (via the Policy Compiler) and returns a
// ready-to-execute agent_deploy payload. Execution stays on the existing, tested,
// spend-capped custodial path (/api/b20-skill action=agent_deploy) — this endpoint
// never moves funds itself, so the money path keeps its single audited guardrail.
const crypto = require('crypto');
const { checkLimits, allowedOrigin } = require('./_guard');
const { compilePolicy } = require('./b20-policy');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Orlix-Key',
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json',
};

// Fail-closed allow-list check (mirrors b20-skill agent_deploy).
function agentAllowed(agentKey) {
  const raw = (process.env.B20_AGENT_ALLOWLIST || '').trim();
  if (!raw || !agentKey) return false;
  return raw.split(',').map(s => s.trim()).filter(Boolean).some(k => {
    if (k.length !== agentKey.length) return false;
    try { return crypto.timingSafeEqual(Buffer.from(k), Buffer.from(agentKey)); } catch { return false; }
  });
}

module.exports = async (req, res) => {
  CORS['Access-Control-Allow-Origin'] = allowedOrigin(req);
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (req.method !== 'POST') { res.writeHead(405, CORS); return res.end(JSON.stringify({ ok: false, error: 'POST only' })); }

  // Guardrail first — header-only key, fail closed.
  const agentKey = req.headers['x-orlix-key'] || '';
  if (!agentAllowed(agentKey)) {
    res.writeHead(403, CORS);
    return res.end(JSON.stringify({ ok: false, error: 'Forbidden: agent not on allowlist' }));
  }

  const _lim = await checkLimits(req, { bucket: 'b20agent', perMin: 6, perDay: 60, globalDay: 800 });
  if (_lim.blocked) { res.writeHead(_lim.status, CORS); return res.end(JSON.stringify({ ok: false, error: _lim.reason })); }

  let body = '';
  req.on('data', c => { body += c; if (body.length > 12000) { body = ''; req.destroy(); } });
  await new Promise(r => req.on('end', r));

  let parsed;
  try { parsed = JSON.parse(body); } catch { res.writeHead(400, CORS); return res.end(JSON.stringify({ ok: false, error: 'Invalid JSON body' })); }
  const brief = parsed.brief || parsed.rules;
  if (!brief?.trim()) { res.writeHead(400, CORS); return res.end(JSON.stringify({ ok: false, error: 'brief required' })); }

  // Optional overrides the agent may pass.
  const creator = /^0x[0-9a-fA-F]{40}$/.test(parsed.creator || '') ? parsed.creator : undefined;

  try {
    const plan = await compilePolicy(brief);

    // Assemble the exact payload the agent should POST to agent_deploy. We do NOT
    // execute it here — the custodial signer + daily spend cap live on that endpoint.
    const deploy = { action: 'agent_deploy', ...plan.deployConfig, network: 'mainnet' };
    if (creator) { deploy.creator = creator; if (!deploy.adminless) deploy.admin = creator; }

    res.writeHead(200, CORS);
    res.end(JSON.stringify({
      ok: true,
      brief: String(brief).slice(0, 400),
      plan,                     // token, onchain policies, advisory, trust score, warnings
      execute: {
        endpoint: '/api/b20-skill',
        method: 'POST',
        header: 'X-Orlix-Key: <your agent key>',
        body: deploy,
        note: 'Deploys custodially via Turnkey, subject to the daily spend cap. Review plan.warnings and plan.trust first.',
      },
    }));
  } catch (e) {
    res.writeHead(502, CORS);
    res.end(JSON.stringify({ ok: false, error: e.message || 'Agent planning failed' }));
  }
};
