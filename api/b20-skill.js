// /api/b20-skill — Orlix B20 Skill v3
// Agent-callable API with real Base chain interactions + correct Beryl ABI
//
// GET  ?action=manifest   → Claude + OpenAI tool schema
// GET  ?action=info       → live chain status, activation check, gas prices
// GET  ?action=gas        → current EIP-1559 gas prices
// POST action=balance     → ETH + optional ERC-20 balance
// POST action=token_info  → read any ERC-20 on Base
// POST action=validate    → deep validation + live admin balance check
// POST action=prepare     → full EIP-1559 deployment bundle (real gas + nonce)
// POST action=receipt     → tx hash status + deployed token address

'use strict';

const { ethers } = require('ethers');
const turnkey = require('./_turnkey');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Orlix-Key',
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json',
};

// ── Addresses ─────────────────────────────────────────────────────────────────
const B20_FACTORY         = '0xB20f000000000000000000000000000000000000';
const ACTIVATION_REGISTRY = '0x8453000000000000000000000000000000000001';
const POLICY_REGISTRY     = '0x8453000000000000000000000000000000000002';

// ── Network ───────────────────────────────────────────────────────────────────
// B20 is Base mainnet only.
const RPC_URL  = { mainnet: 'https://mainnet.base.org' };
const CHAIN_ID = { mainnet: 8453 };
const EXPLORER = { mainnet: 'https://basescan.org' };

// ── Role constants — keccak256 of role name strings ───────────────────────────
const ROLES = {
  DEFAULT_ADMIN: '0x0000000000000000000000000000000000000000000000000000000000000000',
  MINT_ROLE:         '0x154c00819833dac601ee5ddded6fda79d9d8b506b911b3dbd54cdb95fe6c3686',
  BURN_ROLE:         '0xe97b137254058bd94f28d2f3eb79e2d34074ffb488d042e3bc958e0a57d2fa22',
  BURN_BLOCKED_ROLE: '0x7408fdc0d31c7bcb349eab611f5d1168acd4303574993f8cdc98b1cd18c41cae',
  PAUSE_ROLE:        '0x139c2898040ef16910dc9f44dc697df79363da767d8bc92f2e310312b816e46d',
  UNPAUSE_ROLE:      '0x265b220c5a8891efdd9e1b1b7fa72f257bd5169f8d87e319cf3dad6ff52b94ae',
  METADATA_ROLE:     '0x6bd6b5318a46e5fff572d5e4258a20774aab40cc35ac7680654b9081fcc82f80',
  // Asset-variant only — gates updateMultiplier and announce()
  OPERATOR_ROLE:     ethers.id('OPERATOR_ROLE'),
};

// ── Activation Registry feature IDs — keccak256("base.b20_*") ────────────────
const FEATURE_B20_ASSET      = '0xcdcc772fe4cbdb1029f822861176d09e646db96723d4c1e82ddfdeb8163ef54c';
const FEATURE_B20_STABLECOIN = '0xecfa0def2c10020caaf65e6155aa69c84b24892aaef76eeac52e0e2b3a0b8601';

// ── ABI interfaces ────────────────────────────────────────────────────────────
const FACTORY_IFACE = new ethers.Interface([
  'function createB20(uint8 variant, bytes32 salt, bytes params, bytes[] initCalls) payable returns (address token)',
  'function getB20Address(uint8 variant, address sender, bytes32 salt) view returns (address)',
  'function isB20(address token) view returns (bool)',
]);

const B20_IFACE = new ethers.Interface([
  'function grantRole(bytes32 role, address account)',
  'function revokeRole(bytes32 role, address account)',
  'function mint(address to, uint256 amount)',
  'function updateSupplyCap(uint256 newSupplyCap)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
]);

const REGISTRY_IFACE = new ethers.Interface([
  'function isActivated(bytes32 featureId) view returns (bool)',
]);

const ABI_CODER = ethers.AbiCoder.defaultAbiCoder();

// Standard ERC-20 selectors for direct eth_call reads
const SEL = {
  name:        '06fdde03',
  symbol:      '95d89b41',
  decimals:    '313ce567',
  totalSupply: '18160ddd',
  balanceOf:   '70a08231',
};

// Known factory custom-error 4-byte selectors → human messages
const FACTORY_ERR = {
  [ethers.id('NonPayable()').slice(0,10)]:                    'NonPayable — tx must not send ETH',
  [ethers.id('TokenAlreadyExists(address)').slice(0,10)]:     'TokenAlreadyExists — try a different salt',
  [ethers.id('InvalidVariant()').slice(0,10)]:                'InvalidVariant — variant must be 0 (asset) or 1 (stablecoin)',
  [ethers.id('UnsupportedVersion(uint8,uint8)').slice(0,10)]: 'UnsupportedVersion — params.version must be 1',
  [ethers.id('MissingRequiredField(string)').slice(0,10)]:    'MissingRequiredField — name, symbol, or admin missing',
  [ethers.id('InvalidCurrency(string)').slice(0,10)]:         'InvalidCurrency — must be a valid 3-letter ISO code (e.g. USD)',
  [ethers.id('InvalidDecimals(uint8)').slice(0,10)]:          'InvalidDecimals — asset decimals must be 6–18',
  [ethers.id('InitCallFailed(uint256)').slice(0,10)]:         'InitCallFailed — one of the initCalls reverted',
};

// createB20 function selector — if this appears as revert data the RPC is echoing our calldata
const CREATE_B20_SEL = '0x62975e6a';

function decodeFactoryRevert(data) {
  if (!data || data === '0x') return 'Factory reverted (no revert data)';
  const sel = data.slice(0, 10);
  if (FACTORY_ERR[sel]) return FACTORY_ERR[sel];
  if (sel === '0x08c379a0') {
    try { return ABI_CODER.decode(['string'], '0x' + data.slice(10))[0]; } catch {}
    return 'Error(string) revert — decode failed';
  }
  if (sel === '0x4e487b71') return 'Panic — arithmetic error or array bounds';
  if (sel === CREATE_B20_SEL) return '__ECHO__'; // RPC echoed our own calldata — not a real error
  return `Factory custom error (selector ${sel})`;
}

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
  const results = await resp.json();
  return results.sort((a, b) => a.id - b.id);
}

async function ethCall(net, to, data) {
  return rpc(net, 'eth_call', [{ to, data }, 'latest']);
}

// eth_call that returns revert data instead of throwing, for factory simulation
async function ethCallSim(net, txParams) {
  const url = RPC_URL[net] ?? RPC_URL.mainnet;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [txParams, 'latest'] }),
  });
  const json = await resp.json();
  if (json.error) {
    return { reverted: true, data: json.error.data ?? null, message: json.error.message };
  }
  return { reverted: false, data: json.result };
}

// ── Activation Registry ───────────────────────────────────────────────────────

async function checkActivated(net, variant) {
  const featureId = variant === 'stablecoin' ? FEATURE_B20_STABLECOIN : FEATURE_B20_ASSET;
  const data = REGISTRY_IFACE.encodeFunctionData('isActivated', [featureId]);
  try {
    const result = await ethCall(net, ACTIVATION_REGISTRY, data);
    if (!result || result === '0x') return false;
    return ABI_CODER.decode(['bool'], result)[0];
  } catch {
    return false;
  }
}

// ── B20 calldata builders ─────────────────────────────────────────────────────

function encodeCreateParams(config) {
  // Factory decodes params with abi.decode(params, (B20AssetCreateParams)) or (B20StablecoinCreateParams).
  // A Solidity struct decoded this way expects abi.encode(structValue) which is tuple encoding —
  // the outer bytes start with a 32-byte offset pointer, not the first field directly.
  // Encoding as flat ['uint8','string',...] produces the wrong 288-byte layout; tuple encoding is 320 bytes.
  const admin = config.admin ? ethers.getAddress(config.admin) : ethers.ZeroAddress;
  if (config.variant === 'stablecoin') {
    const currency = (config.currency ?? 'USD').trim().toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) || 'USD';
    return ABI_CODER.encode(
      ['tuple(uint8 version, string name, string symbol, address initialAdmin, string currency)'],
      [{version: 1, name: config.name, symbol: config.symbol, initialAdmin: admin, currency}]
    );
  }
  return ABI_CODER.encode(
    ['tuple(uint8 version, string name, string symbol, address initialAdmin, uint8 decimals)'],
    [{version: 1, name: config.name, symbol: config.symbol, initialAdmin: admin, decimals: config.decimals}]
  );
}

function buildInitCalls(config) {
  const calls = [];

  // Decimals used for scaling human amounts → raw on-chain units
  const decimals = config.variant === 'stablecoin' ? 6 : (Number(config.decimals) || 18);

  // Supply cap — MUST be scaled by decimals to match the minted (scaled) amount.
  // Passing the raw human value (e.g. 1e9) sets a cap of 1e9 wei ≈ 1e-9 tokens,
  // which the initial mint of 1e9 * 10^decimals instantly exceeds → InitCallFailed → tx reverts.
  if (config.supply_cap && config.supply_cap !== '0') {
    const capRaw = BigInt(config.supply_cap) * (10n ** BigInt(decimals));
    calls.push(B20_IFACE.encodeFunctionData('updateSupplyCap', [capRaw]));
  }

  // Mint the initial supply to the admin during the bootstrap window.
  // Per the B20 spec, factory-originated initCalls BYPASS the token's role gates,
  // so `mint` succeeds without first granting MINT_ROLE. Only MINT_RECEIVER_POLICY
  // is enforced during initCalls, and it defaults to ALWAYS_ALLOW.
  if (config.admin && !config.adminless) {
    const adminAddr = ethers.getAddress(config.admin);
    // 1. Mint initial supply to admin (scaled by decimals, so mint == cap, never exceeding it)
    if (config.initial_supply && config.initial_supply !== '0') {
      const raw = BigInt(config.initial_supply) * (10n ** BigInt(decimals));
      calls.push(B20_IFACE.encodeFunctionData('mint', [adminAddr, raw]));
    }
    // 2. Grant MINT_ROLE to admin so they can mint more later (admin holds
    //    DEFAULT_ADMIN_ROLE from initialAdmin, but not MINT_ROLE by default).
    calls.push(B20_IFACE.encodeFunctionData('grantRole', [ROLES.MINT_ROLE, adminAddr]));
  }

  // Explicit role grants from config (user-specified via roles section)
  const roleMap = {
    minter:       ROLES.MINT_ROLE,
    burner:       ROLES.BURN_ROLE,
    burn_blocked: ROLES.BURN_BLOCKED_ROLE,
    pauser:       ROLES.PAUSE_ROLE,
    unpauser:     ROLES.UNPAUSE_ROLE,
    meta_admin:   ROLES.METADATA_ROLE,
    operator:     ROLES.OPERATOR_ROLE,
  };
  for (const [key, roleHash] of Object.entries(roleMap)) {
    const addr = (config.roles ?? {})[key];
    if (addr && /^0x[0-9a-fA-F]{40}$/i.test(addr)) {
      const grantee = ethers.getAddress(addr);
      // Skip if already granted to admin above (avoid duplicate grantRole for MINT_ROLE)
      if (roleHash === ROLES.MINT_ROLE && config.admin && grantee.toLowerCase() === config.admin.toLowerCase()) continue;
      calls.push(B20_IFACE.encodeFunctionData('grantRole', [roleHash, grantee]));
    }
  }

  return calls;
}

function buildCreateCalldata(config, salt) {
  const variant    = config.variant === 'stablecoin' ? 1 : 0;
  const params     = encodeCreateParams(config);
  const initCalls  = buildInitCalls(config);
  return FACTORY_IFACE.encodeFunctionData('createB20', [variant, salt, params, initCalls]);
}

// ── Gas helper ────────────────────────────────────────────────────────────────

async function fetchGas(net) {
  const results = await batchRpc(net, [
    { method: 'eth_gasPrice' },
    { method: 'eth_feeHistory', params: [1, 'latest', [25, 50, 75]] },
    { method: 'eth_blockNumber' },
  ]);

  const gasPriceWei = BigInt(results[0].result ?? '0x0');
  const feeHist     = results[1].result ?? {};
  const blockNumber = parseInt(results[2].result ?? '0x0', 16);

  const baseFee  = BigInt(feeHist.baseFeePerGas?.[0] ?? '0x0');
  const rewards  = feeHist.reward?.[0] ?? [];
  const tip50    = BigInt(rewards[1] ?? '0x0');
  const tip25    = BigInt(rewards[0] ?? '0x0');
  const tip75    = BigInt(rewards[2] ?? '0x0');

  // If baseFee reports 0, fall back to gasPrice or a 1 gwei minimum floor
  const minGasPrice = gasPriceWei > 0n ? gasPriceWei : 1000000000n; // 1 gwei floor
  const effectiveBase = baseFee > 0n ? baseFee : minGasPrice;
  const priorityFee  = tip50 > 0n ? tip50 : 1000000n; // 0.001 gwei min tip
  const maxFeePerGas = effectiveBase * 2n + priorityFee;

  const gwei = (n) => (Number(n) / 1e9).toFixed(4);
  const hex  = (n) => '0x' + n.toString(16);

  return {
    blockNumber,
    baseFeeGwei:         gwei(effectiveBase),
    gasPriceGwei:        gwei(gasPriceWei),
    maxFeePerGas:        hex(maxFeePerGas),
    maxPriorityFeePerGas:hex(priorityFee),
    tips: { slow: gwei(tip25), normal: gwei(tip50), fast: gwei(tip75) },
    raw: { baseFee: hex(effectiveBase), maxFeePerGas: hex(maxFeePerGas), maxPriorityFeePerGas: hex(priorityFee) },
  };
}

// ── Validation ────────────────────────────────────────────────────────────────

function parseConfig(input) {
  const errors   = [];
  const warnings = [];

  const name = (input.name ?? '').trim();
  if (!name) errors.push('name is required');
  else if (name.length > 64) errors.push('name must be ≤ 64 characters');

  const symbol = (input.symbol ?? '').trim().toUpperCase();
  if (!symbol) errors.push('symbol is required');
  else if (symbol.length > 11) errors.push('symbol must be ≤ 11 characters');
  else if (!/^[A-Z0-9]+$/.test(symbol)) warnings.push('symbol should only contain letters and numbers');

  const variant = (input.variant ?? 'asset').toLowerCase();
  if (!['asset', 'stablecoin'].includes(variant))
    errors.push('variant must be "asset" or "stablecoin"');

  let decimals = parseInt(input.decimals ?? 18, 10);
  if (variant === 'stablecoin') {
    if (input.decimals !== undefined && parseInt(input.decimals, 10) !== 6)
      warnings.push('Stablecoin variant fixes decimals at 6');
    decimals = 6;
  } else if (isNaN(decimals) || decimals < 6 || decimals > 18) {
    errors.push('decimals must be 6–18 for Asset variant');
    decimals = 18;
  }

  const adminless = !!(input.adminless);
  const admin     = (input.admin ?? '').trim().toLowerCase();
  if (!adminless) {
    if (!admin) errors.push('admin is required (or set adminless: true)');
    else if (!/^0x[0-9a-f]{40}$/.test(admin)) errors.push('admin must be a valid 0x Ethereum address');
  }
  if (adminless) warnings.push('Admin-less deploy is irreversible — no minting, pausing, or policy changes ever');

  // Supply cap — configurable (default 100B). Full supply is minted then seeded
  // into the pool. Clamp so cap * 10^decimals stays well under type(uint128).max.
  let supplyCap = String(input.supply_cap ?? '').replace(/[^0-9]/g, '');
  try {
    let n = supplyCap ? BigInt(supplyCap) : 100000000000n;
    if (n <= 0n) n = 100000000000n;
    if (n > 1000000000000000000000n) { n = 1000000000000000000000n; warnings.push('Supply cap clamped to 1e21 max'); }
    supplyCap = n.toString();
  } catch { supplyCap = '100000000000'; }
  const initialSupply = supplyCap;

  const pol      = input.policies ?? {};
  const policies = { allowlist: !!pol.allowlist, blocklist: !!pol.blocklist, freeze: !!pol.freeze };
  if (policies.allowlist && policies.blocklist) warnings.push('Both allowlist and blocklist enabled — allowlist takes precedence');
  if (policies.freeze) warnings.push('Freeze & Seize grants admin power to freeze accounts and seize their balances');
  if (adminless && Object.values(policies).some(Boolean)) warnings.push('Compliance policies have no effect when adminless is true');

  // Roles
  const roles = {};
  for (const key of ['minter','burner','burn_blocked','pauser','unpauser','meta_admin','operator']) {
    const addr = (input.roles ?? {})[key];
    if (addr && addr.trim()) {
      if (!/^0x[0-9a-fA-F]{40}$/i.test(addr.trim()))
        warnings.push(`roles.${key} is not a valid address — ignored`);
      else
        roles[key] = addr.trim().toLowerCase();
    }
  }

  return {
    errors, warnings,
    config: {
      name, symbol, variant, decimals,
      supply_cap:     supplyCap,
      initial_supply: initialSupply,
      admin:          adminless ? null : admin,
      adminless,
      policies,
      roles,
      currency:       (input.currency ?? 'USD').trim().toUpperCase().slice(0, 3),
      contract_uri:   input.contract_uri ?? input.contractUri ?? null,
    },
  };
}

// ── ERC-20 decoders ───────────────────────────────────────────────────────────

function decodeString(hex) {
  if (!hex || hex === '0x') return '';
  try {
    const raw    = hex.replace('0x', '');
    const offset = parseInt(raw.slice(0, 64), 16) * 2;
    const len    = parseInt(raw.slice(offset, offset + 64), 16);
    const data   = raw.slice(offset + 64, offset + 64 + len * 2);
    return Buffer.from(data, 'hex').toString('utf8');
  } catch { return ''; }
}
function decodeUint(hex)  { try { return BigInt(hex ?? '0x0').toString(); } catch { return '0'; } }
function decodeUint8(hex) { try { return parseInt(hex ?? '0x0', 16); } catch { return 0; } }

// ── Handlers ──────────────────────────────────────────────────────────────────

async function handleInfo(net, res) {
  try {
    const [gas, assetActive, stableActive] = await Promise.all([
      fetchGas(net),
      checkActivated(net, 'asset'),
      checkActivated(net, 'stablecoin'),
    ]);

    return res.end(JSON.stringify({
      ok:       true,
      standard: 'B20',
      network:  'Base',
      chainId:  CHAIN_ID[net],
      upgrade:  'Base Beryl',
      activation: {
        asset:      assetActive,
        stablecoin: stableActive,
        registryAddress: ACTIVATION_REGISTRY,
        note: assetActive ? 'B20 is live on Base mainnet — ready to deploy' : 'Activation Registry check failed — verify your RPC connection',
      },
      chain: {
        blockNumber: gas.blockNumber,
        baseFeeGwei: gas.baseFeeGwei,
        gasTip:      `${gas.tips.normal} gwei (normal)`,
      },
      factory: {
        address: B20_FACTORY,
        note:    'B20 Factory precompile on Base',
      },
      policyRegistry: {
        address: POLICY_REGISTRY,
        note:    'Create allowlist/blocklist policies, then link to token via updatePolicy(scope, policyId)',
      },
      variants: [
        { name: 'asset',      description: 'General-purpose. Configurable decimals (6–18), rebasing, issuer metadata.' },
        { name: 'stablecoin', description: 'Fiat-focused. Fixed 6 decimals, immutable currency code (e.g. "USD").' },
      ],
      features: [
        'ERC-20 compatible — works with any wallet, DEX, or indexer',
        'ERC-2612 permits — gasless approvals (no separate tx)',
        'Role-based access — mint, burn, pause, metadata roles',
        'Supply cap — fixed at 1 billion (1B) per token',
        'Transfer policies — sender/receiver/executor control',
        'Freeze & Seize — freeze accounts and recover balances',
        'Transfer memos — payment IDs and compliance tags',
      ],
      roles: ROLES,
      links: {
        studio:   'https://orlixai.xyz/b20-studio.html',
        manifest: 'https://orlixai.xyz/api/b20-skill?action=manifest',
        baseDocs: 'https://docs.base.org/base-chain/specs/upgrades/beryl/b20',
      },
    }));
  } catch (e) {
    return res.end(JSON.stringify({
      ok: false, error: `Chain query failed: ${e.message}`,
      standard: 'B20', network: net, chainId: CHAIN_ID[net],
    }));
  }
}

async function handleGas(net, res) {
  try {
    const gas = await fetchGas(net);
    const DEPLOY_GAS = 600000n;
    const maxFee     = BigInt(gas.raw.maxFeePerGas);
    const costWei    = DEPLOY_GAS * maxFee;
    const costEth    = Number(costWei) / 1e18;

    return res.end(JSON.stringify({
      ok: true, network: net, chainId: CHAIN_ID[net], blockNumber: gas.blockNumber,
      eip1559: {
        baseFeeGwei:              gas.baseFeeGwei,
        maxFeePerGas:             gas.maxFeePerGas,
        maxPriorityFeePerGas:     gas.maxPriorityFeePerGas,
        maxPriorityFeePerGas_gwei:(Number(BigInt(gas.raw.maxPriorityFeePerGas)) / 1e9).toFixed(6) + ' gwei',
        tips: gas.tips,
      },
      deployEstimate: {
        gasUnits:   600000,
        note:       'Approximate — actual gas depends on calldata size',
        maxCostEth: costEth.toFixed(8),
        maxCostWei: costWei.toString(),
        summary:    costEth.toFixed(8) + ' ETH at ' + gas.baseFeeGwei + ' gwei base fee',
      },
    }));
  } catch (e) {
    return res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}

async function handleBalance(body, res) {
  const { address, token, network = 'mainnet' } = body;
  const net = 'mainnet';

  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address))
    return res.end(JSON.stringify({ ok: false, error: 'address must be a valid 0x Ethereum address' }));

  try {
    const calls = [{ method: 'eth_getBalance', params: [address, 'latest'] }];
    if (token && /^0x[0-9a-fA-F]{40}$/.test(token)) {
      calls.push({
        method: 'eth_call',
        params: [{ to: token, data: '0x' + SEL.balanceOf + '000000000000000000000000' + address.replace('0x', '').toLowerCase() }, 'latest'],
      });
    }
    const results = await batchRpc(net, calls);
    const ethWei  = BigInt(results[0].result ?? '0x0');
    const ethBal  = Number(ethWei) / 1e18;

    const out = {
      ok: true, network: net, chainId: CHAIN_ID[net], address,
      eth: {
        wei:                   ethWei.toString(),
        ether:                 ethBal.toFixed(6),
        sufficient_for_deploy: ethBal >= 0.001,
      },
    };
    if (token && results[1] && !results[1].error) {
      out.token = { address: token, balanceWei: BigInt(results[1].result ?? '0x0').toString() };
    }
    return res.end(JSON.stringify(out));
  } catch (e) {
    return res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}

async function handleTokenInfo(body, res) {
  const { address, holder, network = 'mainnet' } = body;
  const net = 'mainnet';

  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address))
    return res.end(JSON.stringify({ ok: false, error: 'address must be a valid token contract address' }));

  try {
    const calls = [
      { method: 'eth_call', params: [{ to: address, data: '0x' + SEL.name        }, 'latest'] },
      { method: 'eth_call', params: [{ to: address, data: '0x' + SEL.symbol      }, 'latest'] },
      { method: 'eth_call', params: [{ to: address, data: '0x' + SEL.decimals    }, 'latest'] },
      { method: 'eth_call', params: [{ to: address, data: '0x' + SEL.totalSupply }, 'latest'] },
    ];
    if (holder && /^0x[0-9a-fA-F]{40}$/.test(holder)) {
      calls.push({
        method: 'eth_call',
        params: [{ to: address, data: '0x' + SEL.balanceOf + '000000000000000000000000' + holder.replace('0x', '').toLowerCase() }, 'latest'],
      });
    }

    const results  = await batchRpc(net, calls);
    if (results[0].error)
      return res.end(JSON.stringify({ ok: false, error: 'Not a valid ERC-20 token or call failed', address }));

    const name      = decodeString(results[0].result);
    const symbol    = decodeString(results[1].result);
    const decimals  = decodeUint8(results[2].result);
    const supplyRaw = BigInt(results[3].result ?? '0x0');
    const supply    = Number(supplyRaw) / Math.pow(10, decimals);

    const out = {
      ok: true, network: net, chainId: CHAIN_ID[net], address,
      name, symbol, decimals,
      totalSupply:    supply.toLocaleString(),
      totalSupplyRaw: supplyRaw.toString(),
    };
    if (holder && results[4] && !results[4].error) {
      const balRaw = BigInt(results[4].result ?? '0x0');
      out.holder = {
        address: holder,
        balanceRaw: balRaw.toString(),
        balance:    (Number(balRaw) / Math.pow(10, decimals)).toLocaleString(),
      };
    }
    return res.end(JSON.stringify(out));
  } catch (e) {
    return res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}

async function handleValidate(body, res) {
  const { errors, warnings, config } = parseConfig(body);
  const net = 'mainnet';

  if (errors.length)
    return res.end(JSON.stringify({ ok: false, valid: false, errors, warnings }));

  let chainCheck = null;
  let activated  = false;
  try {
    const [balResult, gas, isActive] = await Promise.all([
      config.admin ? rpc(net, 'eth_getBalance', [config.admin, 'latest']) : Promise.resolve('0x0'),
      fetchGas(net),
      checkActivated(net, config.variant),
    ]);
    activated = isActive;

    if (config.admin) {
      const balWei  = BigInt(balResult ?? '0x0');
      const balEth  = Number(balWei) / 1e18;
      const maxFee  = BigInt(gas.raw.maxFeePerGas);
      const costWei = 600000n * maxFee;
      const costEth = Number(costWei) / 1e18;
      const funded  = balWei > costWei;
      if (!funded) warnings.push(`Admin wallet has ${balEth.toFixed(6)} ETH — estimated deploy cost ~${costEth.toFixed(6)} ETH`);

      chainCheck = {
        network: net, chainId: CHAIN_ID[net], blockNumber: gas.blockNumber,
        admin: {
          address: config.admin, ethBalance: balEth.toFixed(6),
          deployCostEstimate: costEth.toFixed(6), sufficientBalance: funded,
        },
        gas: { baseFeeGwei: gas.baseFeeGwei, maxFeePerGas: gas.maxFeePerGas },
      };
    }
  } catch (e) {
    warnings.push(`Live chain check skipped: ${e.message}`);
  }

  return res.end(JSON.stringify({ ok: true, valid: true, errors: [], warnings, config, chainCheck, activated }));
}

async function handlePrepare(body, res) {
  const { errors, warnings, config } = parseConfig(body);
  const net = 'mainnet';

  if (errors.length)
    return res.end(JSON.stringify({ ok: false, valid: false, errors, warnings }));

  // Activation check — try Activation Registry first, but don't trust it alone
  let activated = false;
  try { activated = await checkActivated(net, config.variant); } catch {}

  // Salt — use provided or generate random
  const saltHex = body.salt ?? ethers.hexlify(ethers.randomBytes(32));

  // Build calldata
  const calldata = buildCreateCalldata(config, saltHex);

  // Simulate via eth_call — factory is ground truth.
  // Success: returns ABI-encoded address (66 hex chars, non-zero) → activated = true.
  // Revert:  returns error with revert data → decode and report reason → activated = false.
  let simRevertReason = null;
  try {
    const simFrom = config.admin ?? ethers.ZeroAddress;
    const sim = await ethCallSim(net, { from: simFrom, to: B20_FACTORY, data: calldata, value: '0x0' });

    if (sim.reverted) {
      const decoded = decodeFactoryRevert(sim.data);
      if (decoded === '__ECHO__' || (sim.data && sim.data.startsWith(CREATE_B20_SEL))) {
        // RPC echoed our calldata back — precompile may not support eth_call simulation.
        // Trust the Activation Registry result instead of treating this as a hard block.
        warnings.push('Factory simulation inconclusive (RPC returned calldata echo) — relying on Activation Registry');
      } else {
        activated = false;
        simRevertReason = decoded;
        warnings.push(`Factory simulation reverted: ${simRevertReason}`);
      }
    } else {
      const simResult = sim.data;
      const isValidAddress = simResult && simResult.length === 66
        && simResult !== '0x' + '0'.repeat(64);
      if (isValidAddress) {
        activated = true;
      } else if (!simResult || simResult === '0x' || simResult === '0x' + '0'.repeat(64)) {
        // Empty result — precompile not deployed or not active
        warnings.push('B20 factory returned empty — precompile not active on this network yet');
        // Keep activated from registry check (don't override to false here)
      } else if (simResult.startsWith(CREATE_B20_SEL)) {
        warnings.push('Factory simulation inconclusive (calldata echo in result)');
      } else {
        simRevertReason = decodeFactoryRevert(simResult);
        warnings.push(`Factory simulation failed: ${simRevertReason}`);
        activated = false;
      }
    }
  } catch (simErr) {
    warnings.push(`Factory simulation error: ${simErr.message ?? 'unknown'}`);
    // Keep activated from registry check
  }

  // Fetch live gas + nonce
  let gas = null, nonce = null, ethBalance = null, predictedAddress = null;
  try {
    const adminAddr = config.admin ?? ethers.ZeroAddress;
    const [gasResult, nonceResult, balResult] = await Promise.all([
      fetchGas(net),
      rpc(net, 'eth_getTransactionCount', [adminAddr, 'pending']),
      config.admin ? rpc(net, 'eth_getBalance', [config.admin, 'latest']) : Promise.resolve('0x0'),
    ]);
    gas   = gasResult;
    nonce = parseInt(nonceResult ?? '0x0', 16);

    const balWei  = BigInt(balResult ?? '0x0');
    const balEth  = Number(balWei) / 1e18;
    const maxFee  = BigInt(gas.raw.maxFeePerGas);
    const costWei = 600000n * maxFee;
    const costEth = Number(costWei) / 1e18;
    ethBalance = { wei: balWei.toString(), ether: balEth.toFixed(6) };
    if (balWei < costWei) warnings.push(`Admin wallet has ${balEth.toFixed(6)} ETH — estimated deploy cost ~${costEth.toFixed(6)} ETH`);

    // Predict token address
    if (config.admin) {
      try {
        const data   = FACTORY_IFACE.encodeFunctionData('getB20Address', [
          config.variant === 'stablecoin' ? 1 : 0,
          config.admin,
          saltHex,
        ]);
        const result = await ethCall(net, B20_FACTORY, data);
        if (result && result !== '0x') {
          predictedAddress = ABI_CODER.decode(['address'], result)[0];
        }
      } catch {}
    }
  } catch (e) {
    warnings.push(`Live chain data fetch failed: ${e.message}`);
  }

  // Gas: base 500k + 50k per initCall, minimum 600k
  // initCalls always includes at least grantRole(MINT_ROLE, admin) = 1 call → ~550k
  const initCallsCount = buildInitCalls(config).length;
  const DEPLOY_GAS_UNITS = Math.max(600000, 500000 + initCallsCount * 50000);
  const maxFeeHex = gas?.maxFeePerGas ?? null;
  const tipHex    = gas?.maxPriorityFeePerGas ?? null;

  const tx = {
    type:                 '0x02',
    chainId:              '0x' + CHAIN_ID[net].toString(16),
    to:                   B20_FACTORY,
    value:                '0x0',
    data:                 calldata,
    gas:                  '0x' + DEPLOY_GAS_UNITS.toString(16),
    maxFeePerGas:         maxFeeHex,
    maxPriorityFeePerGas: tipHex,
    nonce:                nonce !== null ? '0x' + nonce.toString(16) : null,
  };

  const deployCostEth = maxFeeHex
    ? (Number(BigInt(maxFeeHex) * BigInt(DEPLOY_GAS_UNITS)) / 1e18).toFixed(8)
    : null;

  return res.end(JSON.stringify({
    ok:        true,
    status:    activated ? 'ready' : 'prepared',
    activated,
    revertReason: simRevertReason,
    message:   activated
      ? 'Config valid — sign and broadcast to deploy'
      : simRevertReason
        ? `Factory reverted: ${simRevertReason}`
        : 'B20 activation check failed — verify RPC connection and try again.',

    config,
    salt: saltHex,
    predictedAddress,

    deployment: {
      factory:      B20_FACTORY,
      network:      net,
      chainId:      CHAIN_ID[net],
      calldata,
      gasEstimate:  '0x' + DEPLOY_GAS_UNITS.toString(16),
      initCallCount: initCallsCount,
      tx,
      txNote: 'EIP-1559 unsigned tx. factory=createB20(variant,salt,params,initCalls)',
    },

    chain: {
      network: net, chainId: CHAIN_ID[net],
      blockNumber:  gas?.blockNumber ?? null,
      adminBalance: ethBalance,
      estimatedCost: deployCostEth ? `~${deployCostEth} ETH` : null,
      gas: gas ? { baseFeeGwei: gas.baseFeeGwei, maxFeePerGas: gas.maxFeePerGas } : null,
    },

    warnings,
    links: { studio: 'https://orlixai.xyz/b20-studio.html', baseDocs: 'https://docs.base.org/base-chain/specs/upgrades/beryl/b20' },
  }));
}

async function handleReceipt(body, res) {
  const { tx_hash, network = 'mainnet' } = body;
  const net = 'mainnet';

  if (!tx_hash || !/^0x[0-9a-fA-F]{64}$/.test(tx_hash))
    return res.end(JSON.stringify({ ok: false, error: 'tx_hash must be a 0x transaction hash (66 hex chars)' }));

  try {
    const receipt = await rpc(net, 'eth_getTransactionReceipt', [tx_hash]);
    if (!receipt) {
      return res.end(JSON.stringify({ ok: true, found: false, tx_hash, network: net, status: 'pending' }));
    }

    const success = receipt.status === '0x1';
    // Extract deployed token address from logs.
    // Strategy 1: find log from B20 factory with token address in topic[1]
    // Strategy 2: find any log whose emitting address starts with 0xb200 (B20 token address prefix)
    let deployedToken = null;
    if (success && receipt.logs?.length > 0) {
      const factoryLog = receipt.logs.find(l => l.address?.toLowerCase() === B20_FACTORY.toLowerCase());
      if (factoryLog?.topics?.[1]) {
        deployedToken = '0x' + factoryLog.topics[1].slice(26);
      }
      if (!deployedToken) {
        const b20Log = receipt.logs.find(l => l.address?.toLowerCase().startsWith('0xb200'));
        if (b20Log) deployedToken = b20Log.address;
      }
      if (!deployedToken && receipt.logs[0]?.address) {
        deployedToken = receipt.logs[0].address;
      }
    }

    return res.end(JSON.stringify({
      ok: true, found: true, tx_hash, network: net, chainId: CHAIN_ID[net],
      status:       success ? 'success' : 'failed',
      blockNumber:  parseInt(receipt.blockNumber ?? '0x0', 16),
      gasUsed:      parseInt(receipt.gasUsed ?? '0x0', 16),
      from:         receipt.from,
      to:           receipt.to,
      deployedToken,
      explorerUrl:  deployedToken
        ? `${EXPLORER[net] ?? EXPLORER.mainnet}/address/${deployedToken}`
        : null,
      logCount: receipt.logs?.length ?? 0,
    }));
  } catch (e) {
    return res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}

// ── Agent Deploy (custodial, Turnkey-signed, guardrailed) ──────────────────────
// 1Claw-style: agent submits a deploy intent; the signing key lives in Turnkey's
// secure enclave and never touches Orlix. Deploy allowlist is enforced HERE, in
// the proxy, before the signer is ever reached — prompt injection cannot bypass it.
const crypto = require('crypto');

function agentAllowed(agentKey) {
  const raw = (process.env.B20_AGENT_ALLOWLIST || '').trim();
  if (!raw || !agentKey) return false;                 // fail closed
  return raw.split(',').map(s => s.trim()).filter(Boolean).some(k => {
    if (k.length !== agentKey.length) return false;
    try { return crypto.timingSafeEqual(Buffer.from(k), Buffer.from(agentKey)); } catch { return false; }
  });
}

// ── Upstash Redis (spend cap + deploy serialization) ───────────────────────────
function _redisEnv() {
  return {
    url:   process.env.UPSTASH_REDIS_REST_URL   || process.env.STORAGE_UPSTASH_REDIS_REST_URL   || '',
    token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.STORAGE_UPSTASH_REDIS_REST_TOKEN || '',
  };
}
async function _redis(...args) {
  const { url, token } = _redisEnv();
  if (!url || !token) return undefined;                // not configured
  const r = await fetch(`${url}/${args.map(encodeURIComponent).join('/')}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error('redis ' + r.status);
  return (await r.json()).result;
}
// Serialize deploys so concurrent calls can't collide on the signer nonce.
async function _acquireLock() {
  const { url, token } = _redisEnv();
  if (!url || !token) return { locked: true, held: false };          // no redis → best-effort proceed
  try {
    const r = await _redis('SET', 'b20deploy:lock', '1', 'NX', 'PX', '28000');
    return { locked: r === 'OK', held: r === 'OK' };
  } catch { return { locked: true, held: false }; }                  // redis error → proceed
}
async function _releaseLock(held) { if (held) { try { await _redis('DEL', 'b20deploy:lock'); } catch {} } }

// Factory eth_call simulation — never sign+broadcast a tx that will revert (wastes gas).
async function _simulateDeploy(net, signer, calldata, variant) {
  const activationFallback = async () => {
    try { return (await checkActivated(net, variant)) ? { ok: true } : { ok: false, reason: 'B20 activation check failed — verify RPC connection' }; }
    catch { return { ok: false, reason: 'Could not verify B20 activation on-chain' }; }
  };
  try {
    const sim = await ethCallSim(net, { from: signer, to: B20_FACTORY, data: calldata, value: '0x0' });
    if (sim.reverted) {
      const decoded = decodeFactoryRevert(sim.data);
      return decoded === '__ECHO__' ? activationFallback() : { ok: false, reason: decoded };
    }
    const d = sim.data;
    if (d && d.length === 66 && d !== '0x' + '0'.repeat(64)) return { ok: true };
    if (!d || d === '0x' || d === '0x' + '0'.repeat(64) || d.startsWith(CREATE_B20_SEL)) return activationFallback();
    return { ok: false, reason: decodeFactoryRevert(d) };
  } catch { return activationFallback(); }
}

async function handleAgentDeploy(req, body, res) {
  // GUARDRAIL first — before any signer/provider access. Header-only key
  // (bodies are far more likely to end up in request logs than headers).
  const agentKey = req.headers['x-orlix-key'] || '';
  if (!agentAllowed(agentKey)) {
    res.statusCode = 403;
    return res.end(JSON.stringify({ ok: false, error: 'Forbidden: agent not on deploy allowlist' }));
  }
  if (!turnkey.isConfigured())
    return res.end(JSON.stringify({ ok: false, error: 'Signer not configured (Turnkey env missing)' }));

  const net    = 'mainnet'; // B20 agent deploys target Base mainnet
  const signer = turnkey.signerAddress();

  // Admin defaults to the server signer wallet (agent never holds a key)
  if (!body.admin && !body.adminless) body.admin = signer;

  const { errors, warnings, config } = parseConfig(body);
  if (errors.length) return res.end(JSON.stringify({ ok: false, error: 'Invalid intent', details: errors }));

  const salt     = body.salt ?? ethers.hexlify(ethers.randomBytes(32));
  const calldata = buildCreateCalldata(config, salt);

  // Serialize the whole reserve→sign→broadcast section (nonce safety + atomic spend cap)
  const lock = await _acquireLock();
  if (!lock.locked)
    return res.end(JSON.stringify({ ok: false, error: 'Another deploy is in progress — retry shortly' }));

  try {
    // Spend cap — rolling daily deploy limit (protects the signer wallet's gas)
    const dailyLimit = parseInt(process.env.B20_AGENT_DAILY_LIMIT || '25', 10);
    const dayKey     = `b20deploy:count:${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
    let usedToday;
    try { usedToday = parseInt((await _redis('GET', dayKey)) || '0', 10); } catch { usedToday = 0; }
    if (usedToday !== undefined && usedToday >= dailyLimit)
      return res.end(JSON.stringify({ ok: false, error: `Daily deploy limit reached (${dailyLimit})` }));

    // Never burn gas on a tx that will revert (not active yet, bad config, dup salt)
    const sim = await _simulateDeploy(net, signer, calldata, config.variant);
    if (!sim.ok) return res.end(JSON.stringify({ ok: false, error: `Deploy would revert: ${sim.reason}` }));

    // Live gas + nonce for the server signer, plus predicted (CREATE2) address
    let gas, nonce, predicted = null;
    try {
      [gas, nonce] = await Promise.all([
        fetchGas(net),
        rpc(net, 'eth_getTransactionCount', [signer, 'pending']).then(n => parseInt(n ?? '0x0', 16)),
      ]);
      try {
        const data = FACTORY_IFACE.encodeFunctionData('getB20Address', [config.variant === 'stablecoin' ? 1 : 0, signer, salt]);
        const r = await ethCall(net, B20_FACTORY, data);
        if (r && r !== '0x') predicted = ABI_CODER.decode(['address'], r)[0];
      } catch {}
    } catch (e) {
      return res.end(JSON.stringify({ ok: false, error: `Chain query failed: ${e.message}` }));
    }

    // Gas limit scales with initCalls (base 500k + 50k each). Floor 700k for
    // headroom; unused gas is refunded, so a higher limit only needs more ETH.
    const gasUnits = Math.max(700000, 500000 + buildInitCalls(config).length * 50000);

    const unsigned = ethers.Transaction.from({
      type: 2, chainId: CHAIN_ID[net], to: B20_FACTORY, value: 0, data: calldata,
      gasLimit: gasUnits,
      maxFeePerGas:         BigInt(gas.raw.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(gas.raw.maxPriorityFeePerGas),
      nonce,
    }).unsignedSerialized;

    let txHash;
    try {
      const signedRaw = await turnkey.signTransaction(unsigned);
      txHash = await rpc(net, 'eth_sendRawTransaction', [signedRaw]);
    } catch (e) {
      return res.end(JSON.stringify({ ok: false, error: `Sign/broadcast failed: ${e.message}` }));
    }

    // Count this deploy against the daily cap (only on successful broadcast)
    try {
      const n = await _redis('INCR', dayKey);
      if (n === 1) await _redis('EXPIRE', dayKey, '90000'); // ~25h
    } catch {}

    // Record to the shared "recently launched" feed (best-effort)
    if (predicted) {
      try {
        await _redis('LPUSH', 'b20:launched', JSON.stringify({
          address: predicted, name: config.name, symbol: config.symbol,
          deployer: config.admin || signer, variant: config.variant,
          decimals: config.decimals, txHash, ts: Date.now(),
        }));
        await _redis('LTRIM', 'b20:launched', '0', '199');
      } catch {}
    }

    return res.end(JSON.stringify({
      ok: true, status: 'broadcast', txHash, predictedAddress: predicted,
      explorerUrl: `${EXPLORER[net]}/tx/${txHash}`,
      token: { name: config.name, symbol: config.symbol, variant: config.variant, decimals: config.decimals, admin: config.admin },
      signer, network: net, chainId: CHAIN_ID[net], warnings,
    }));
  } finally {
    await _releaseLock(lock.held);
  }
}

function handleManifest(res) {
  return res.end(JSON.stringify({
    schema:      'orlix-skill/3.0',
    id:          'orlix.b20',
    name:        'Orlix B20 Token Skill',
    version:     '3.0.0',
    description: 'Full B20 token lifecycle on Base mainnet (Beryl, live): activation check, live chain data, balance checks, config validation, deployment bundles via createB20 precompile, ERC-20 reads, tx receipts.',
    endpoint:    'https://orlixai.xyz/api/b20-skill',
    factory:     B20_FACTORY,
    activation:  ACTIVATION_REGISTRY,
    networks:    { mainnet: { chainId: 8453, rpc: 'https://mainnet.base.org' } },
    actions:     { GET: ['manifest','info','gas'], POST: ['validate','prepare','balance','token_info','receipt'] },
    links: {
      studio:     'https://orlixai.xyz/b20-studio.html',
      baseDocs:   'https://docs.base.org/base-chain/specs/upgrades/beryl/b20',
      launchGuide:'https://docs.base.org/apps/guides/launch-a-b20-token',
    },
  }));
}

// ── Uniswap V4 pool seeding (make a deployed B20 tradeable) ─────────────────────
// Merged into this function to stay within the Vercel Hobby 12-function limit.
// Seeds a TOKEN/WETH V4 pool with single-sided token liquidity (concentrated) so
// buyers bring the ETH — the same shape RWAGMI uses. Creator signs each tx.
const WETH             = '0x4200000000000000000000000000000000000006'; // currency0 (sorts below B20 token)
const ZERO_ADDR        = '0x0000000000000000000000000000000000000000';
const PERMIT2          = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const POSITION_MANAGER = '0x7C5f5A4bBd8fD63184577525326123B519429bDc';
const STATE_VIEW       = '0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71';
const UNIVERSAL_ROUTER = '0x6fF5693b99212Da76ad316178A184AB56D299b43';

const CMD_WRAP_ETH = 0x0b, CMD_V4_SWAP = 0x10, CMD_SWEEP = 0x04;
const UR_MSG_SENDER = '0x0000000000000000000000000000000000000001';
const UR_ADDRESS_THIS = '0x0000000000000000000000000000000000000002';
const ACT_SWAP_EXACT_IN_SINGLE = 0x06, ACT_SETTLE = 0x0b, ACT_SETTLE_ALL = 0x0c, ACT_TAKE_ALL = 0x0f;
const ACT_MINT_POSITION = 0x02, ACT_SETTLE_PAIR = 0x0d;

const FEE_SPACING = { 500: 10, 3000: 60, 10000: 200 };
const MAX_TICK_V4 = 887272;
const Q96 = 2n ** 96n;
const MAX_UINT256 = (2n ** 256n) - 1n;

const POOL_ERC20_IFACE = new ethers.Interface([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address account) view returns (uint256)',
]);
const PERMIT2_IFACE = new ethers.Interface([
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
]);
const POSM_IFACE = new ethers.Interface([
  'function initializePool((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key, uint160 sqrtPriceX96) payable returns (int24)',
  'function modifyLiquidities(bytes unlockData, uint256 deadline) payable',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
]);
const STATEVIEW_IFACE = new ethers.Interface([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
]);
const UR_IFACE = new ethers.Interface([
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
]);

function bigintSqrt(value) {
  if (value < 0n) throw new Error('sqrt of negative');
  if (value < 2n) return value;
  let x = value, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + value / x) / 2n; }
  return x;
}
function sqrtPriceX96From(num, den) { return bigintSqrt((num << 192n) / den); }
function tickFromPrice(Pfloat) { return Math.floor(Math.log(Pfloat) / Math.log(1.0001)); }
function poolAlignDown(t, s) { return Math.floor(t / s) * s; }
function poolMaxUsableTick(s) { return poolAlignDown(MAX_TICK_V4, s); }

// Uniswap TickMath.getSqrtRatioAtTick — exact Q64.96 sqrt price for a tick.
function getSqrtRatioAtTick(tick) {
  const absTick = BigInt(tick < 0 ? -tick : tick);
  if (absTick > BigInt(MAX_TICK_V4)) throw new Error('tick out of range');
  let ratio = (absTick & 0x1n) !== 0n
    ? 0xfffcb933bd6fad37aa2d162d1a594001n
    : 0x100000000000000000000000000000000n;
  const M = [
    [0x2n, 0xfff97272373d413259a46990580e213an], [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn],
    [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n], [0x10n, 0xffcb9843d60f6159c9db58835c926644n],
    [0x20n, 0xff973b41fa98c081472e6896dfb254c0n], [0x40n, 0xff2ea16466c96a3843ec78b326b52861n],
    [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n], [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
    [0x200n, 0xf987a7253ac413176f2b074cf7815e54n], [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n],
    [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n], [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
    [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n], [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n],
    [0x8000n, 0x31be135f97d08fd981231505542fcfa6n], [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
    [0x20000n, 0x5d6af8dedb81196699c329225ee604n], [0x40000n, 0x2216e584f5fa1ea926041bedfe98n],
    [0x80000n, 0x48a170391f7dc42444e8fa2n],
  ];
  for (const [bit, mul] of M) if ((absTick & bit) !== 0n) ratio = (ratio * mul) >> 128n;
  if (tick > 0) ratio = MAX_UINT256 / ratio;
  return (ratio >> 32n) + ((ratio % (1n << 32n)) === 0n ? 0n : 1n);
}
// Single-sided currency1 (token) amount below current price: amount1 = L*(sqrtB-sqrtA)/Q96
function liquidityForAmount1(sqrtA, sqrtB, amount1) {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return (amount1 * Q96) / (sqrtB - sqrtA);
}
function toWei18(str) {
  const s = String(str).trim();
  if (!/^\d*\.?\d+$/.test(s)) throw new Error('invalid number');
  const [i, f = ''] = s.split('.');
  const frac = (f + '0'.repeat(18)).slice(0, 18);
  return BigInt(i || '0') * (10n ** 18n) + BigInt(frac || '0');
}
function poolIdOf(key) {
  return ethers.keccak256(ABI_CODER.encode(
    ['tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)'], [key],
  ));
}

async function handlePreparePool(body, res) {
  const token   = (body.token || '').trim();
  const creator = (body.creator || body.admin || '').trim();
  const fee     = parseInt(body.fee || '10000', 10);
  const priceStr = String(body.price ?? body.initial_price ?? '');

  if (!/^0x[0-9a-fA-F]{40}$/.test(token))
    return res.end(JSON.stringify({ ok: false, error: 'token must be a valid 0x address' }));
  if (!/^0x[0-9a-fA-F]{40}$/.test(creator))
    return res.end(JSON.stringify({ ok: false, error: 'creator must be a valid 0x address' }));
  if (!FEE_SPACING[fee])
    return res.end(JSON.stringify({ ok: false, error: 'fee must be 500, 3000, or 10000' }));
  if (!priceStr)
    return res.end(JSON.stringify({ ok: false, error: 'price (ETH per token) is required' }));

  const spacing   = FEE_SPACING[fee];
  const tokenAddr = ethers.getAddress(token);
  const creatorAddr = ethers.getAddress(creator);

  let decimals = 18, lpRaw;
  if (body.predeploy) {
    // One-tx launch: the token doesn't exist yet (its deploy is batched in the same
    // wallet_sendCalls). Use the known supply/decimals instead of reading the chain.
    decimals = Number(body.decimals) || 18;
    const lpTokens = BigInt(String(body.lp_tokens || '1000000000').replace(/[^0-9]/g, '') || '1000000000');
    lpRaw = lpTokens * (10n ** BigInt(decimals));
  } else {
    try {
      const [decHex, balHex] = await Promise.all([
        ethCall('mainnet', tokenAddr, POOL_ERC20_IFACE.encodeFunctionData('decimals', [])),
        ethCall('mainnet', tokenAddr, POOL_ERC20_IFACE.encodeFunctionData('balanceOf', [creatorAddr])),
      ]);
      decimals = decHex && decHex !== '0x' ? Number(ABI_CODER.decode(['uint8'], decHex)[0]) : 18;
      const bal = balHex && balHex !== '0x' ? BigInt(balHex) : 0n;
      if (body.lp_tokens && String(body.lp_tokens) !== '0') {
        lpRaw = BigInt(String(body.lp_tokens).replace(/[^0-9]/g, '')) * (10n ** BigInt(decimals));
        if (lpRaw > bal) lpRaw = bal;
      } else { lpRaw = bal; }
    } catch (e) {
      return res.end(JSON.stringify({ ok: false, error: `Token read failed: ${e.message}` }));
    }
  }
  if (lpRaw <= 0n)
    return res.end(JSON.stringify({ ok: false, error: 'Creator holds 0 tokens — deploy/mint supply before seeding a pool' }));

  const weiPerToken = toWei18(priceStr);
  if (weiPerToken <= 0n) return res.end(JSON.stringify({ ok: false, error: 'price must be > 0' }));
  const tokenUnit = 10n ** BigInt(decimals);

  const sqrtPriceX96 = sqrtPriceX96From(tokenUnit, weiPerToken);
  if (sqrtPriceX96 <= 0n) return res.end(JSON.stringify({ ok: false, error: 'price out of range — adjust initial price' }));
  const currentTick = tickFromPrice(Number(tokenUnit) / Number(weiPerToken));

  const maxTick = poolMaxUsableTick(spacing);
  let tickUpper = poolAlignDown(currentTick, spacing);
  if (tickUpper >= currentTick) tickUpper -= spacing;
  const tickLower = -maxTick;
  if (tickLower >= tickUpper)
    return res.end(JSON.stringify({ ok: false, error: 'Invalid tick range — raise the initial price or lower the fee tier' }));

  const sqrtA = getSqrtRatioAtTick(tickLower);
  const sqrtB = getSqrtRatioAtTick(tickUpper);
  const liquidity = liquidityForAmount1(sqrtA, sqrtB, lpRaw);
  if (liquidity <= 0n)
    return res.end(JSON.stringify({ ok: false, error: 'Computed liquidity is zero — increase LP token amount or adjust price' }));

  const poolKey = { currency0: WETH, currency1: tokenAddr, fee, tickSpacing: spacing, hooks: ZERO_ADDR };
  const deadline   = Math.floor(Date.now() / 1000) + 1200;
  const expiration = Math.floor(Date.now() / 1000) + 30 * 86400;

  const actions = '0x' + [ACT_MINT_POSITION, ACT_SETTLE_PAIR].map(a => a.toString(16).padStart(2, '0')).join('');
  const mintParam = ABI_CODER.encode(
    ['tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)',
     'int24', 'int24', 'uint256', 'uint128', 'uint128', 'address', 'bytes'],
    [poolKey, tickLower, tickUpper, liquidity, 0n, lpRaw, creatorAddr, '0x'],
  );
  const settleParam = ABI_CODER.encode(['address', 'address'], [WETH, tokenAddr]);
  const unlockData = ABI_CODER.encode(['bytes', 'bytes[]'], [actions, [mintParam, settleParam]]);

  // If the pool is already initialized (e.g. a previous attempt), don't re-init —
  // initializePool would revert. Just add liquidity in that case.
  let poolInitialized = false;
  if (!body.predeploy) {
    try {
      const r = await ethCall('mainnet', STATE_VIEW, STATEVIEW_IFACE.encodeFunctionData('getSlot0', [poolIdOf(poolKey)]));
      if (r && r !== '0x') {
        const [sp] = STATEVIEW_IFACE.decodeFunctionResult('getSlot0', r);
        poolInitialized = BigInt(sp) > 0n;
      }
    } catch {}
  }

  const initData   = POSM_IFACE.encodeFunctionData('initializePool', [poolKey, sqrtPriceX96]);
  const modifyData = POSM_IFACE.encodeFunctionData('modifyLiquidities', [unlockData, deadline]);
  const multicallData = poolInitialized
    ? POSM_IFACE.encodeFunctionData('multicall', [[modifyData]])
    : POSM_IFACE.encodeFunctionData('multicall', [[initData, modifyData]]);

  const txs = [
    { label: 'approve_permit2', title: 'Approve token (Permit2)', to: tokenAddr,
      data: POOL_ERC20_IFACE.encodeFunctionData('approve', [PERMIT2, MAX_UINT256]), value: '0x0', gas: '0xea60' },
    { label: 'permit2_approve', title: 'Authorize position manager', to: PERMIT2,
      data: PERMIT2_IFACE.encodeFunctionData('approve', [tokenAddr, POSITION_MANAGER, lpRaw, expiration]), value: '0x0', gas: '0x186a0' },
    { label: 'create_pool', title: 'Create V4 pool + seed liquidity', to: POSITION_MANAGER,
      data: multicallData, value: '0x0', gas: '0x1e8480' }, // 2,000,000 — init + mint headroom
  ];

  // Optional dev buy — isolated final tx (a revert here leaves the pool live)
  let devBuy = null;
  const devEthStr = String(body.dev_buy_eth ?? body.devBuy ?? '0').trim();
  if (devEthStr && devEthStr !== '0') {
    let devWei = 0n;
    try { devWei = toWei18(devEthStr); } catch { devWei = 0n; }
    if (devWei > 0n) {
      const urDeadline = Math.floor(Date.now() / 1000) + 1200;
      const swapParam = ABI_CODER.encode(
        ['tuple(tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)'],
        [{ poolKey, zeroForOne: true, amountIn: devWei, amountOutMinimum: 0n, hookData: '0x' }],
      );
      // SETTLE (not SETTLE_ALL) with payerIsUser=false: pay the WETH we just wrapped
      // FROM THE ROUTER's balance. SETTLE_ALL settles from the user via Permit2, which
      // reverts here because the user holds no WETH (it's wrapped into the router).
      const settle  = ABI_CODER.encode(['address', 'uint256', 'bool'], [WETH, devWei, false]);
      const takeAll = ABI_CODER.encode(['address', 'uint256'], [tokenAddr, 0n]);
      const v4Actions = '0x' + [ACT_SWAP_EXACT_IN_SINGLE, ACT_SETTLE, ACT_TAKE_ALL].map(a => a.toString(16).padStart(2, '0')).join('');
      const v4Input = ABI_CODER.encode(['bytes', 'bytes[]'], [v4Actions, [swapParam, settle, takeAll]]);
      const wrapInput  = ABI_CODER.encode(['address', 'uint256'], [UR_ADDRESS_THIS, devWei]);
      const sweepInput = ABI_CODER.encode(['address', 'address', 'uint256'], [tokenAddr, UR_MSG_SENDER, 0n]);
      const commands = '0x' + [CMD_WRAP_ETH, CMD_V4_SWAP, CMD_SWEEP].map(c => c.toString(16).padStart(2, '0')).join('');
      const execData = UR_IFACE.encodeFunctionData('execute', [commands, [wrapInput, v4Input, sweepInput], urDeadline]);
      txs.push({ label: 'dev_buy', title: 'Dev buy (ETH → token)', to: UNIVERSAL_ROUTER,
        data: execData, value: '0x' + devWei.toString(16), gas: '0x4c4b40', note: 'Optional — test with a small amount first' });
      devBuy = { eth: devEthStr, wei: devWei.toString() };
    }
  }

  return res.end(JSON.stringify({
    ok: true, chainId: CHAIN_ID.mainnet, dex: 'uniswap-v4', devBuy,
    pool: {
      poolId: poolIdOf(poolKey), currency0: WETH, currency1: tokenAddr,
      fee, tickSpacing: spacing, hooks: ZERO_ADDR,
      sqrtPriceX96: sqrtPriceX96.toString(), tickLower, tickUpper,
      liquidity: liquidity.toString(), lpTokensRaw: lpRaw.toString(),
      priceEthPerToken: priceStr, decimals, positionManager: POSITION_MANAGER,
    },
    txs,
    note: 'Sign txs in order. Single-sided token liquidity; ETH buyers move price into range.',
  }));
}

async function handlePoolStatus(body, res) {
  const token = (body.token || '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(token))
    return res.end(JSON.stringify({ ok: false, error: 'token must be a valid 0x address' }));
  const tokenAddr = ethers.getAddress(token);
  try {
    const pools = {};
    await Promise.all(Object.keys(FEE_SPACING).map(async feeStr => {
      const fee = parseInt(feeStr, 10);
      const key = { currency0: WETH, currency1: tokenAddr, fee, tickSpacing: FEE_SPACING[fee], hooks: ZERO_ADDR };
      const id  = poolIdOf(key);
      try {
        const r = await ethCall('mainnet', STATE_VIEW, STATEVIEW_IFACE.encodeFunctionData('getSlot0', [id]));
        if (r && r !== '0x') {
          const [sqrtPriceX96] = STATEVIEW_IFACE.decodeFunctionResult('getSlot0', r);
          if (BigInt(sqrtPriceX96) > 0n) pools[fee] = { poolId: id, sqrtPriceX96: sqrtPriceX96.toString() };
        }
      } catch {}
    }));
    return res.end(JSON.stringify({ ok: true, token: tokenAddr, pools, hasPool: Object.keys(pools).length > 0 }));
  } catch (e) {
    return res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}

// Build a BUY swap (ETH → token) through the Uniswap V4 Universal Router — the
// same proven encoding as the launch dev buy. Used by the on-site Trade widget.
async function handlePrepareSwap(body, res) {
  const token = (body.token || '').trim();
  const side  = (body.side || 'buy').toLowerCase();
  const fee   = parseInt(body.fee || '10000', 10);
  const amountStr = String(body.amount || '0');
  if (!/^0x[0-9a-fA-F]{40}$/.test(token))
    return res.end(JSON.stringify({ ok: false, error: 'valid token address required' }));
  if (!FEE_SPACING[fee])
    return res.end(JSON.stringify({ ok: false, error: 'fee must be 500, 3000, or 10000' }));
  if (side !== 'buy')
    return res.end(JSON.stringify({ ok: false, error: 'only buy (ETH → token) is supported on-site; use the Uniswap link to sell' }));

  const tokenAddr = ethers.getAddress(token);
  const poolKey = { currency0: WETH, currency1: tokenAddr, fee, tickSpacing: FEE_SPACING[fee], hooks: ZERO_ADDR };
  let wei = 0n; try { wei = toWei18(amountStr); } catch {}
  if (wei <= 0n) return res.end(JSON.stringify({ ok: false, error: 'amount must be > 0' }));

  const deadline = Math.floor(Date.now() / 1000) + 1200;
  const swapParam = ABI_CODER.encode(
    ['tuple(tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)'],
    [{ poolKey, zeroForOne: true, amountIn: wei, amountOutMinimum: 0n, hookData: '0x' }],
  );
  const settle  = ABI_CODER.encode(['address', 'uint256', 'bool'], [WETH, wei, false]);
  const takeAll = ABI_CODER.encode(['address', 'uint256'], [tokenAddr, 0n]);
  const v4Actions = '0x' + [ACT_SWAP_EXACT_IN_SINGLE, ACT_SETTLE, ACT_TAKE_ALL].map(a => a.toString(16).padStart(2, '0')).join('');
  const v4Input = ABI_CODER.encode(['bytes', 'bytes[]'], [v4Actions, [swapParam, settle, takeAll]]);
  const wrapInput  = ABI_CODER.encode(['address', 'uint256'], [UR_ADDRESS_THIS, wei]);
  const sweepInput = ABI_CODER.encode(['address', 'address', 'uint256'], [tokenAddr, UR_MSG_SENDER, 0n]);
  const commands = '0x' + [CMD_WRAP_ETH, CMD_V4_SWAP, CMD_SWEEP].map(c => c.toString(16).padStart(2, '0')).join('');
  const execData = UR_IFACE.encodeFunctionData('execute', [commands, [wrapInput, v4Input, sweepInput], deadline]);

  return res.end(JSON.stringify({
    ok: true, side: 'buy', chainId: CHAIN_ID.mainnet,
    tx: { to: UNIVERSAL_ROUTER, data: execData, value: '0x' + wei.toString(16), gas: '0x4c4b40' },
  }));
}

// Record an Orlix-deployed token to the shared "recently launched" feed (Redis),
// so the New Launched tab shows tokens deployed through Orlix (not a chain scan).
async function handleRegisterLaunch(body, res) {
  const token = (body.token || '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(token) || !token.toLowerCase().startsWith('0xb2'))
    return res.end(JSON.stringify({ ok: false, error: 'valid B20 token address required' }));
  // Accept a small compressed data-URL logo (cap size to keep the feed lean).
  let image = null;
  if (typeof body.image === 'string' && /^data:image\//.test(body.image) && body.image.length <= 50000) {
    image = body.image;
  }
  const entry = JSON.stringify({
    address:  ethers.getAddress(token),
    name:     String(body.name || '').slice(0, 64),
    symbol:   String(body.symbol || '').slice(0, 16),
    deployer: /^0x[0-9a-fA-F]{40}$/.test(body.deployer || '') ? String(body.deployer).toLowerCase() : null,
    variant:  body.variant === 'stablecoin' ? 'stablecoin' : 'asset',
    decimals: Number(body.decimals) || 18,
    txHash:   /^0x[0-9a-fA-F]{64}$/.test(body.txHash || '') ? body.txHash : null,
    image,
    ts:       Date.now(),
  });
  try {
    await _redis('LPUSH', 'b20:launched', entry);
    await _redis('LTRIM', 'b20:launched', '0', '199');
  } catch {}
  return res.end(JSON.stringify({ ok: true }));
}

// ── Router ────────────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  // Set CORS via setHeader (not writeHead) so handlers can still choose a status
  // code — writeHead commits the status line immediately (403 would be ignored).
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

  try {
    const body   = req.method === 'POST' ? (req.body ?? {}) : (req.query ?? {});
    const action = body.action ?? (req.method === 'GET' ? 'manifest' : 'prepare');
    const net    = 'mainnet';

    if (action === 'manifest')                         return handleManifest(res);
    if (action === 'info')                             return handleInfo(net, res);
    if (action === 'gas')                              return handleGas(net, res);
    if (action === 'balance')                          return handleBalance(body, res);
    if (action === 'token_info' || action === 'token') return handleTokenInfo(body, res);
    if (action === 'validate')                         return handleValidate(body, res);
    if (action === 'prepare' || action === 'deploy')   return handlePrepare(body, res);
    if (action === 'agent_deploy')                     return handleAgentDeploy(req, body, res);
    if (action === 'receipt')                          return handleReceipt(body, res);
    if (action === 'prepare_pool')                     return handlePreparePool(body, res);
    if (action === 'pool_status')                      return handlePoolStatus(body, res);
    if (action === 'prepare_swap')                     return handlePrepareSwap(body, res);
    if (action === 'register_launch')                  return handleRegisterLaunch(body, res);

    return res.end(JSON.stringify({
      ok: false, error: `Unknown action: "${action}"`,
      valid_actions: { GET: ['manifest','info','gas'], POST: ['validate','prepare','balance','token_info','receipt'] },
    }));
  } catch (e) {
    return res.end(JSON.stringify({ ok: false, error: e.message }));
  }
};
