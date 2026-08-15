// Vercel Serverless Function — /api/auth
// Privy SIWE proxy — wallet-only authentication
// Only allows Sign-In With Ethereum. Email, social, and embedded wallets are disabled.
// Env vars required: PRIVY_APP_SECRET

const APP_ID     = 'cmqh5fvyg00co0ci68birz0s2';
const CLIENT_ID  = 'client-WY6aRspZ68mzwa8hexMRYu9xiCKWRkscPMKYYu3oayZ99';
const APP_ORIGIN = 'https://orlixai.xyz';
const BASE       = 'https://auth.privy.io/api/v1';

function adminHeaders(secret) {
  const creds = Buffer.from(`${APP_ID}:${secret}`).toString('base64');
  return {
    'Content-Type':    'application/json',
    'Authorization':   `Basic ${creds}`,
    'privy-app-id':    APP_ID,
    'privy-client-id': CLIENT_ID,
  };
}

function clientHeaders() {
  return {
    'Content-Type':    'application/json',
    'privy-app-id':    APP_ID,
    'privy-client-id': CLIENT_ID,
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('x-orlix-proxy', '1');
  res.setHeader('Access-Control-Allow-Origin', APP_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SECRET = process.env.PRIVY_APP_SECRET || '';
  if (!SECRET) {
    return res.status(503).json({ error: 'Authentication service temporarily unavailable.' });
  }

  const action = (req.query && req.query.action) || (req.body && req.body.action) || '';

  // ── Verify token ──────────────────────────────────────────────────────────────
  if (action === 'verify') {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'No token provided' });
    try {
      const r    = await fetch(`${BASE}/users/me`, {
        headers: { ...adminHeaders(SECRET), Authorization: `Bearer ${token}` },
      });
      const data = await r.json();
      return res.status(r.status).json(data);
    } catch (e) {
      return res.status(502).json({ error: e.message });
    }
  }

  // ── SIWE init ─────────────────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'siwe-init') {
    const { address } = req.body || {};
    if (!address) return res.status(400).json({ error: 'Missing: address' });
    try {
      const r    = await fetch(`${BASE}/siwe/init`, {
        method:  'POST',
        headers: clientHeaders(),
        body:    JSON.stringify({ address }),
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data.error || 'siwe-init failed', raw: data });
      return res.status(200).json(data);
    } catch (e) {
      return res.status(502).json({ error: e.message });
    }
  }

  // ── SIWE authenticate ─────────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'siwe-authenticate') {
    const { message, signature, chainId } = req.body || {};
    if (!message || !signature) return res.status(400).json({ error: 'Missing: message, signature' });
    try {
      const r    = await fetch(`${BASE}/siwe/authenticate`, {
        method:  'POST',
        headers: clientHeaders(),
        body:    JSON.stringify({ message, signature, chainId: chainId || 4663 }),
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data.error || 'siwe-authenticate failed', raw: data });
      return res.status(200).json(data);
    } catch (e) {
      return res.status(502).json({ error: e.message });
    }
  }

  return res.status(400).json({
    error:   'Unknown action',
    allowed: ['verify', 'siwe-init', 'siwe-authenticate'],
  });
};
