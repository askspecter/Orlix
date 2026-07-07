// api/_b20-core.js — shared B20 (Beryl) deploy builders
// Extracted so the agent signing endpoint (b20-agent.js) reuses the exact
// same calldata/gas encoding as the non-custodial studio flow (b20-skill.js).
'use strict';

const { ethers } = require('ethers');

// ── Addresses ─────────────────────────────────────────────────────────────────
const B20_FACTORY = '0xB20f000000000000000000000000000000000000';

// ── Network (B20 is Base-only) ─────────────────────────────────────────────────
const RPC_URL  = { mainnet: 'https://mainnet.base.org', sepolia: 'https://sepolia.base.org', vibenet: 'https://rpc.vibes.base.org' };
const CHAIN_ID = { mainnet: 8453, sepolia: 84532, vibenet: 84538453 };
const EXPLORER = { mainnet: 'https://basescan.org', sepolia: 'https://sepolia.basescan.org', vibenet: 'https://explorer.vibes.base.org' };

// ── Role constants — keccak256 of role name strings ───────────────────────────
const ROLES = {
  MINT_ROLE:         '0x154c00819833dac601ee5ddded6fda79d9d8b506b911b3dbd54cdb95fe6c3686',
  BURN_ROLE:         '0xe97b137254058bd94f28d2f3eb79e2d34074ffb488d042e3bc958e0a57d2fa22',
  PAUSE_ROLE:        '0x139c2898040ef16910dc9f44dc697df79363da767d8bc92f2e310312b816e46d',
  UNPAUSE_ROLE:      '0x265b220c5a8891efdd9e1b1b7fa72f257bd5169f8d87e319cf3dad6ff52b94ae',
  METADATA_ROLE:     '0x6bd6b5318a46e5fff572d5e4258a20774aab40cc35ac7680654b9081fcc82f80',
};

const FACTORY_IFACE = new ethers.Interface([
  'function createB20(uint8 variant, bytes32 salt, bytes params, bytes[] initCalls) payable returns (address token)',
  'function getB20Address(uint8 variant, address sender, bytes32 salt) view returns (address)',
]);

const B20_IFACE = new ethers.Interface([
  'function grantRole(bytes32 role, address account)',
  'function updateSupplyCap(uint256 newSupplyCap)',
]);

const ABI_CODER = ethers.AbiCoder.defaultAbiCoder();

// ── JSON-RPC helpers ──────────────────────────────────────────────────────────
async function rpc(net, method, params = []) {
  const url = RPC_URL[net] ?? RPC_URL.mainnet;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await resp.json();
  if (json.error) throw new Error(`RPC ${method}: ${json.error.message}`);
  return json.result;
}

async function batchRpc(net, calls) {
  const url = RPC_URL[net] ?? RPC_URL.mainnet;
  const batch = calls.map((c, id) => ({ jsonrpc: '2.0', id, method: c.method, params: c.params ?? [] }));
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(batch),
  });
  return (await resp.json()).sort((a, b) => a.id - b.id);
}

async function ethCall(net, to, data) {
  return rpc(net, 'eth_call', [{ to, data }, 'latest']);
}

// ── Calldata builders (tuple encoding — must match factory abi.decode) ─────────
function encodeCreateParams(config) {
  const admin = config.admin ? ethers.getAddress(config.admin) : ethers.ZeroAddress;
  if (config.variant === 'stablecoin') {
    const currency = (config.currency ?? 'USD').trim().toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) || 'USD';
    return ABI_CODER.encode(
      ['tuple(uint8 version, string name, string symbol, address initialAdmin, string currency)'],
      [{ version: 1, name: config.name, symbol: config.symbol, initialAdmin: admin, currency }]
    );
  }
  return ABI_CODER.encode(
    ['tuple(uint8 version, string name, string symbol, address initialAdmin, uint8 decimals)'],
    [{ version: 1, name: config.name, symbol: config.symbol, initialAdmin: admin, decimals: config.decimals }]
  );
}

function buildInitCalls(config) {
  const calls = [];
  if (config.supply_cap && config.supply_cap !== '0') {
    calls.push(B20_IFACE.encodeFunctionData('updateSupplyCap', [BigInt(config.supply_cap)]));
  }
  if (config.admin) {
    const adminAddr = ethers.getAddress(config.admin);
    calls.push(B20_IFACE.encodeFunctionData('grantRole', [ROLES.MINT_ROLE, adminAddr]));
  }
  return calls;
}

function buildCreateCalldata(config, salt) {
  const variant   = config.variant === 'stablecoin' ? 1 : 0;
  const params    = encodeCreateParams(config);
  const initCalls = buildInitCalls(config);
  return FACTORY_IFACE.encodeFunctionData('createB20', [variant, salt, params, initCalls]);
}

// ── Gas (EIP-1559) ─────────────────────────────────────────────────────────────
async function fetchGas(net) {
  const results = await batchRpc(net, [
    { method: 'eth_gasPrice' },
    { method: 'eth_feeHistory', params: [1, 'latest', [50]] },
  ]);
  const gasPriceWei = BigInt(results[0].result ?? '0x0');
  const feeHist     = results[1].result ?? {};
  const baseFee     = BigInt(feeHist.baseFeePerGas?.[0] ?? '0x0');
  const tip50       = BigInt(feeHist.reward?.[0]?.[0] ?? '0x0');

  const minGasPrice   = gasPriceWei > 0n ? gasPriceWei : 1000000000n; // 1 gwei floor (devnet)
  const effectiveBase = baseFee > 0n ? baseFee : minGasPrice;
  const priorityFee   = tip50 > 0n ? tip50 : 1000000n;                // 0.001 gwei min tip
  const maxFeePerGas  = effectiveBase * 2n + priorityFee;
  return { maxFeePerGas, maxPriorityFeePerGas: priorityFee, baseFee: effectiveBase };
}

// ── Predicted (CREATE2) token address ──────────────────────────────────────────
async function predictAddress(net, config, salt) {
  try {
    const data = FACTORY_IFACE.encodeFunctionData('getB20Address', [
      config.variant === 'stablecoin' ? 1 : 0,
      ethers.getAddress(config.admin),
      salt,
    ]);
    const result = await ethCall(net, B20_FACTORY, data);
    if (result && result !== '0x') return ABI_CODER.decode(['address'], result)[0];
  } catch {}
  return null;
}

// ── Intent validation (returns { errors, config }) ─────────────────────────────
function parseIntent(input, signerAddress) {
  const errors = [];

  const name = (input.name ?? '').trim();
  if (!name) errors.push('name is required');
  else if (name.length > 64) errors.push('name must be <= 64 characters');

  const symbol = (input.symbol ?? '').trim().toUpperCase();
  if (!symbol) errors.push('symbol is required');
  else if (symbol.length > 11) errors.push('symbol must be <= 11 characters');
  else if (!/^[A-Z0-9]+$/.test(symbol)) errors.push('symbol must be letters and numbers only');

  const variant = (input.variant ?? 'asset').toLowerCase();
  if (!['asset', 'stablecoin'].includes(variant)) errors.push('variant must be "asset" or "stablecoin"');

  let decimals = parseInt(input.decimals ?? 18, 10);
  if (variant === 'stablecoin') decimals = 6;
  else if (isNaN(decimals) || decimals < 6 || decimals > 18) { errors.push('decimals must be 6-18 for asset variant'); decimals = 18; }

  // Admin defaults to the server signer wallet (the agent never holds a key)
  let admin = (input.admin ?? signerAddress ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(admin)) errors.push('admin must be a valid 0x address');

  const supplyCap = String(input.supply_cap ?? '1000000000');
  if (!/^\d+$/.test(supplyCap)) errors.push('supply_cap must be an integer string');

  return {
    errors,
    config: {
      name, symbol, variant, decimals, admin,
      supply_cap: supplyCap,
      currency: (input.currency ?? 'USD').trim().toUpperCase().slice(0, 3),
    },
  };
}

module.exports = {
  B20_FACTORY, RPC_URL, CHAIN_ID, EXPLORER,
  rpc, batchRpc, ethCall, fetchGas,
  buildCreateCalldata, predictAddress, parseIntent,
};
