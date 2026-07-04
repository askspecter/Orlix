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
const RPC_URL  = { mainnet: 'https://mainnet.base.org', sepolia: 'https://sepolia.base.org', vibenet: 'https://rpc.vibes.base.org' };
const CHAIN_ID = { mainnet: 8453, sepolia: 84532, vibenet: 84538453 };
const EXPLORER = { mainnet: 'https://basescan.org', sepolia: 'https://sepolia.basescan.org', vibenet: 'https://explorer.vibes.base.org' };

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

  // Supply cap
  if (config.supply_cap && config.supply_cap !== '0') {
    calls.push(B20_IFACE.encodeFunctionData('updateSupplyCap', [BigInt(config.supply_cap)]));
  }

  // Grant MINT_ROLE to admin during token creation.
  // initCalls msg.sender = factory which holds DEFAULT_ADMIN_ROLE temporarily,
  // so this grantRole succeeds. Minting happens in a separate tx from the frontend
  // where the user's wallet (= admin, now has MINT_ROLE) is msg.sender.
  if (config.admin && !config.adminless) {
    const adminAddr = ethers.getAddress(config.admin);
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

  // Devnets (Vibenet) may report 0 baseFee — fallback to gasPrice or minimum 1 gwei
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

  // Supply fixed at 1 billion — not configurable
  const supplyCap = '1000000000';
  const initialSupply = '1000000000';

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
      network:  net === 'mainnet' ? 'Base' : net === 'vibenet' ? 'Base Vibenet' : 'Base Sepolia',
      chainId:  CHAIN_ID[net],
      upgrade:  'Base Beryl',
      activation: {
        asset:      assetActive,
        stablecoin: stableActive,
        registryAddress: ACTIVATION_REGISTRY,
        note: assetActive ? 'B20 is live — ready to deploy' : 'Activation Registry not yet enabled — wait ~1 hour after Beryl hardfork',
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
  const net = ['mainnet', 'sepolia', 'vibenet'].includes(network) ? network : 'mainnet';

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
  const net = ['mainnet', 'sepolia', 'vibenet'].includes(network) ? network : 'mainnet';

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
  const net = ['mainnet', 'sepolia', 'vibenet'].includes(body.network) ? body.network : 'mainnet';

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
  const net = ['mainnet', 'sepolia', 'vibenet'].includes(body.network) ? body.network : 'mainnet';

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
        : 'B20 not yet active on this network — Beryl hardfork activation pending.',

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
  const net = ['mainnet', 'sepolia', 'vibenet'].includes(network) ? network : 'mainnet';

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

function handleManifest(res) {
  return res.end(JSON.stringify({
    schema:      'orlix-skill/3.0',
    id:          'orlix.b20',
    name:        'Orlix B20 Token Skill',
    version:     '3.0.0',
    description: 'Full B20 token lifecycle on Base (Beryl): activation check, live chain data, balance checks, config validation, deployment bundles via createB20 precompile, ERC-20 reads, tx receipts.',
    endpoint:    'https://orlixai.xyz/api/b20-skill',
    factory:     B20_FACTORY,
    activation:  ACTIVATION_REGISTRY,
    networks:    { mainnet: { chainId: 8453, rpc: 'https://mainnet.base.org' }, sepolia: { chainId: 84532, rpc: 'https://sepolia.base.org' }, vibenet: { chainId: 84538453, rpc: 'https://rpc.vibes.base.org', explorer: 'https://explorer.vibes.base.org' } },
    actions:     { GET: ['manifest','info','gas'], POST: ['validate','prepare','balance','token_info','receipt'] },
    links: {
      studio:   'https://orlixai.xyz/b20-studio.html',
      baseDocs: 'https://docs.base.org/base-chain/specs/upgrades/beryl/b20',
    },
  }));
}

// ── Router ────────────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  res.writeHead(200, CORS);
  if (req.method === 'OPTIONS') return res.end();

  try {
    const body   = req.method === 'POST' ? (req.body ?? {}) : (req.query ?? {});
    const action = body.action ?? (req.method === 'GET' ? 'manifest' : 'prepare');
    const net    = ['mainnet', 'sepolia', 'vibenet'].includes(body.network ?? req.query?.network)
      ? (body.network ?? req.query?.network)
      : 'mainnet';

    if (action === 'manifest')                         return handleManifest(res);
    if (action === 'info')                             return handleInfo(net, res);
    if (action === 'gas')                              return handleGas(net, res);
    if (action === 'balance')                          return handleBalance(body, res);
    if (action === 'token_info' || action === 'token') return handleTokenInfo(body, res);
    if (action === 'validate')                         return handleValidate(body, res);
    if (action === 'prepare' || action === 'deploy')   return handlePrepare(body, res);
    if (action === 'receipt')                          return handleReceipt(body, res);

    return res.end(JSON.stringify({
      ok: false, error: `Unknown action: "${action}"`,
      valid_actions: { GET: ['manifest','info','gas'], POST: ['validate','prepare','balance','token_info','receipt'] },
    }));
  } catch (e) {
    return res.end(JSON.stringify({ ok: false, error: e.message }));
  }
};
