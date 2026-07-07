// /api/b20-agent — Orlix B20 Agent Deploy (custodial, guardrailed)
//
// 1Claw-style flow: an agent submits a *deploy intent* (name, symbol, supply).
// The signing key lives in Turnkey's secure enclave and is NEVER exposed to the
// agent, to prompt-space, or to Orlix memory. Orlix constructs the tx, has it
// signed remotely, and broadcasts it.
//
// Guardrail (enforced BEFORE the signing key is ever reached):
//   deploy allowlist — only agents whose key is in B20_AGENT_ALLOWLIST may deploy.
// Because the check runs in this proxy (not in model/application prompt-space), a
// compromised or prompt-injected agent cannot bypass it.
//
// POST { action:"deploy", name, symbol, variant?, decimals?, supply_cap?, admin? }
//   header: X-Orlix-Key: <agent key>
// POST { action:"receipt", tx_hash }
'use strict';

const { ethers } = require('ethers');
const {
  B20_FACTORY, CHAIN_ID, EXPLORER,
  rpc, fetchGas, buildCreateCalldata, predictAddress, parseIntent,
} = require('./_b20-core');
const turnkey = require('./_turnkey');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Orlix-Key',
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json',
};

const NET = 'mainnet'; // B20 is Base-only; agent deploys target Base mainnet.

// ── Guardrail: deploy allowlist ────────────────────────────────────────────────
// Sourced from env B20_AGENT_ALLOWLIST (comma-separated agent keys). Evaluated
// before any signer/provider access. Empty/unset = deny all (fail closed).
function agentAllowed(agentKey) {
  const raw = (process.env.B20_AGENT_ALLOWLIST || '').trim();
  if (!raw || !agentKey) return false;
  const allow = raw.split(',').map(s => s.trim()).filter(Boolean);
  // constant-time-ish membership: compare against each entry
  return allow.some(k => k.length === agentKey.length
    && crypto_timingSafeEq(k, agentKey));
}

// timingSafeEqual wrapper that tolerates unequal lengths without throwing
function crypto_timingSafeEq(a, b) {
  const crypto = require('crypto');
  const ab = Buffer.from(a), bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ab, bb); } catch { return false; }
}

async function handleDeploy(body, res) {
  // 1) Signer must be configured (custodial key in Turnkey enclave)
  if (!turnkey.isConfigured()) {
    return res.end(JSON.stringify({ ok: false, error: 'Signer not configured (Turnkey env missing)' }));
  }

  // 2) Validate intent against the server signer as default admin
  const signer = turnkey.signerAddress();
  const { errors, config } = parseIntent(body, signer);
  if (errors.length) return res.end(JSON.stringify({ ok: false, error: 'Invalid intent', details: errors }));

  // 3) Build deterministic-salt calldata + predicted address
  const salt     = body.salt ?? ethers.hexlify(ethers.randomBytes(32));
  const calldata = buildCreateCalldata(config, salt);

  // 4) Live gas + nonce for the SERVER signer (server pays gas)
  let gas, nonce, predicted;
  try {
    [gas, nonce, predicted] = await Promise.all([
      fetchGas(NET),
      rpc(NET, 'eth_getTransactionCount', [signer, 'pending']).then(n => parseInt(n ?? '0x0', 16)),
      predictAddress(NET, config, salt),
    ]);
  } catch (e) {
    return res.end(JSON.stringify({ ok: false, error: `Chain query failed: ${e.message}` }));
  }

  // 5) Construct the unsigned EIP-1559 transaction
  const unsigned = ethers.Transaction.from({
    type:                 2,
    chainId:              CHAIN_ID[NET],
    to:                   B20_FACTORY,
    value:                0,
    data:                 calldata,
    gasLimit:             700000,
    maxFeePerGas:         gas.maxFeePerGas,
    maxPriorityFeePerGas: gas.maxPriorityFeePerGas,
    nonce,
  }).unsignedSerialized;

  // 6) Sign remotely (key never touches Orlix) + broadcast
  let txHash;
  try {
    const signedRaw = await turnkey.signTransaction(unsigned);
    txHash = await rpc(NET, 'eth_sendRawTransaction', [signedRaw]);
  } catch (e) {
    return res.end(JSON.stringify({ ok: false, error: `Sign/broadcast failed: ${e.message}` }));
  }

  return res.end(JSON.stringify({
    ok: true,
    status: 'broadcast',
    txHash,
    predictedAddress: predicted,
    explorerUrl: `${EXPLORER[NET]}/tx/${txHash}`,
    token: { name: config.name, symbol: config.symbol, variant: config.variant, decimals: config.decimals, admin: config.admin },
    signer,
    network: NET,
    chainId: CHAIN_ID[NET],
  }));
}

async function handleReceipt(body, res) {
  const { tx_hash } = body;
  if (!tx_hash || !/^0x[0-9a-fA-F]{64}$/.test(tx_hash))
    return res.end(JSON.stringify({ ok: false, error: 'tx_hash must be a 0x transaction hash' }));
  try {
    const receipt = await rpc(NET, 'eth_getTransactionReceipt', [tx_hash]);
    if (!receipt) return res.end(JSON.stringify({ ok: true, found: false, tx_hash, status: 'pending' }));
    const success = receipt.status === '0x1';
    let deployedToken = null;
    if (success && receipt.logs?.length) {
      const factoryLog = receipt.logs.find(l => l.address?.toLowerCase() === B20_FACTORY.toLowerCase());
      if (factoryLog?.topics?.[1]) deployedToken = '0x' + factoryLog.topics[1].slice(26);
      if (!deployedToken) deployedToken = receipt.logs.find(l => l.address?.toLowerCase().startsWith('0xb200'))?.address ?? null;
    }
    return res.end(JSON.stringify({
      ok: true, found: true, tx_hash, status: success ? 'success' : 'failed',
      deployedToken,
      explorerUrl: deployedToken ? `${EXPLORER[NET]}/address/${deployedToken}` : null,
    }));
  } catch (e) {
    return res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}

module.exports = async (req, res) => {
  res.writeHead(200, CORS);
  if (req.method === 'OPTIONS') return res.end();
  if (req.method !== 'POST') return res.end(JSON.stringify({ ok: false, error: 'POST only' }));

  try {
    const body = req.body && typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');

    // ── GUARDRAIL FIRST: deploy allowlist, before any signer/provider access ──
    const agentKey = req.headers['x-orlix-key'] || body.agent_key || '';
    if (!agentAllowed(agentKey)) {
      res.statusCode = 403;
      return res.end(JSON.stringify({ ok: false, error: 'Forbidden: agent not on deploy allowlist' }));
    }

    const action = body.action ?? 'deploy';
    if (action === 'deploy')  return handleDeploy(body, res);
    if (action === 'receipt') return handleReceipt(body, res);
    return res.end(JSON.stringify({ ok: false, error: `Unknown action: "${action}"`, valid: ['deploy', 'receipt'] }));
  } catch (e) {
    return res.end(JSON.stringify({ ok: false, error: e.message }));
  }
};
