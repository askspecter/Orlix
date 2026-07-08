// /api/b20-pool — Make a freshly deployed B20 token tradeable by seeding a
// Uniswap V4 liquidity pool (ETH ↔ token), single-sided token liquidity so
// buyers bring the ETH (a fair-launch curve). This is what turns a minted B20
// (1B supply, "not yet tradeable") into a token that shows on DexScreener/DEXs.
//
// Uniswap V4 flow (creator's wallet signs each tx in order):
//   1. token.approve(Permit2, max)                         — let Permit2 custody the token
//   2. Permit2.approve(token, PositionManager, amt, exp)   — allow posm to pull it
//   3. PositionManager.multicall([ initializePool, modifyLiquidities(MINT_POSITION) ])
//
// In V4, native ETH is currency0 (address(0) sorts below any token), so the
// token is always currency1. Single-sided token liquidity sits BELOW the current
// price; ETH buyers push price into the range and receive tokens.
//
// POST action=prepare_pool → { txs: [...], pool: {...} }
// POST action=pool_status  → { pools: {...}, hasPool }
//
'use strict';

const { ethers } = require('ethers');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json',
};

// ── Base mainnet — Uniswap V4 canonical deployment ────────────────────────────
const RPC_URL  = 'https://mainnet.base.org';
const CHAIN_ID = 8453;
// Pair with WETH (ERC-20), matching the ecosystem "TOKEN / WETH" convention.
// WETH (0x42..06) sorts below any B20 token (0xb2..), so WETH is currency0.
const WETH     = '0x4200000000000000000000000000000000000006';
const ZERO     = '0x0000000000000000000000000000000000000000'; // no hooks
const PERMIT2          = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const POOL_MANAGER     = '0x498581fF718922c3f8e6A244956aF099B2652b2b';
const POSITION_MANAGER = '0x7C5f5A4bBd8fD63184577525326123B519429bDc';
const STATE_VIEW       = '0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71';

// Uniswap V4 liquidity action opcodes (v4-periphery Actions.sol)
const ACTION_MINT_POSITION = 0x02;
const ACTION_SETTLE_PAIR   = 0x0d;

// Fee tier → tick spacing
const FEE_SPACING = { 500: 10, 3000: 60, 10000: 200 };
const MAX_TICK = 887272;
const Q96 = 2n ** 96n;
const MAX_UINT256 = (2n ** 256n) - 1n;

// ── ABIs ──────────────────────────────────────────────────────────────────────
const ERC20_IFACE = new ethers.Interface([
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

const ABI_CODER = ethers.AbiCoder.defaultAbiCoder();

// ── RPC (works in production; this dev sandbox blocks chain egress) ────────────
async function rpc(method, params = []) {
  const resp = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(8000),
  });
  const json = await resp.json();
  if (json.error) throw new Error(`RPC ${method}: ${json.error.message}`);
  return json.result;
}
async function ethCall(to, data) { return rpc('eth_call', [{ to, data }, 'latest']); }

// ── Math ────────────────────────────────────────────────────────────────────────
function bigintSqrt(value) {
  if (value < 0n) throw new Error('sqrt of negative');
  if (value < 2n) return value;
  let x = value, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + value / x) / 2n; }
  return x;
}
// sqrtPriceX96 = floor( sqrt( (num << 192) / den ) ), price P = num/den (currency1/currency0, raw)
function sqrtPriceX96From(num, den) {
  return bigintSqrt((num << 192n) / den);
}
function tickFromPrice(Pfloat) { return Math.floor(Math.log(Pfloat) / Math.log(1.0001)); }
function alignDown(t, s) { return Math.floor(t / s) * s; }
function maxUsableTick(s) { return alignDown(MAX_TICK, s); }

// Uniswap TickMath.getSqrtRatioAtTick — exact Q64.96 sqrt price for a tick.
function getSqrtRatioAtTick(tick) {
  const absTick = BigInt(tick < 0 ? -tick : tick);
  if (absTick > BigInt(MAX_TICK)) throw new Error('tick out of range');
  let ratio = (absTick & 0x1n) !== 0n
    ? 0xfffcb933bd6fad37aa2d162d1a594001n
    : 0x100000000000000000000000000000000n;
  const M = [
    [0x2n, 0xfff97272373d413259a46990580e213an],
    [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn],
    [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
    [0x10n, 0xffcb9843d60f6159c9db58835c926644n],
    [0x20n, 0xff973b41fa98c081472e6896dfb254c0n],
    [0x40n, 0xff2ea16466c96a3843ec78b326b52861n],
    [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n],
    [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
    [0x200n, 0xf987a7253ac413176f2b074cf7815e54n],
    [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n],
    [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n],
    [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
    [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n],
    [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n],
    [0x8000n, 0x31be135f97d08fd981231505542fcfa6n],
    [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
    [0x20000n, 0x5d6af8dedb81196699c329225ee604n],
    [0x40000n, 0x2216e584f5fa1ea926041bedfe98n],
    [0x80000n, 0x48a170391f7dc42444e8fa2n],
  ];
  for (const [bit, mul] of M) {
    if ((absTick & bit) !== 0n) ratio = (ratio * mul) >> 128n;
  }
  if (tick > 0) ratio = MAX_UINT256 / ratio;
  // Q128.128 → Q64.96, rounding up
  return (ratio >> 32n) + ((ratio % (1n << 32n)) === 0n ? 0n : 1n);
}

// Liquidity from a single-sided currency1 (token) amount in a range entirely
// below the current price:  amount1 = L * (sqrtB - sqrtA) / Q96
function liquidityForAmount1(sqrtA, sqrtB, amount1) {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return (amount1 * Q96) / (sqrtB - sqrtA);
}

// Parse a decimal string into an 18-decimal (wei) BigInt.
function toWei18(str) {
  const s = String(str).trim();
  if (!/^\d*\.?\d+$/.test(s)) throw new Error('invalid number');
  const [i, f = ''] = s.split('.');
  const frac = (f + '0'.repeat(18)).slice(0, 18);
  return BigInt(i || '0') * (10n ** 18n) + BigInt(frac || '0');
}

function poolIdOf(key) {
  const encoded = ABI_CODER.encode(
    ['tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)'],
    [key],
  );
  return ethers.keccak256(encoded);
}

// ── prepare_pool ─────────────────────────────────────────────────────────────────
async function handlePreparePool(body, res) {
  const token   = (body.token || '').trim();
  const creator = (body.creator || body.admin || '').trim();
  const fee     = parseInt(body.fee || '10000', 10);           // 1% default
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

  // Read decimals + creator balance → LP amount
  let decimals = 18, lpRaw;
  try {
    const [decHex, balHex] = await Promise.all([
      ethCall(tokenAddr, ERC20_IFACE.encodeFunctionData('decimals', [])),
      ethCall(tokenAddr, ERC20_IFACE.encodeFunctionData('balanceOf', [creatorAddr])),
    ]);
    decimals = decHex && decHex !== '0x' ? Number(ABI_CODER.decode(['uint8'], decHex)[0]) : 18;
    const bal = balHex && balHex !== '0x' ? BigInt(balHex) : 0n;
    if (body.lp_tokens && String(body.lp_tokens) !== '0') {
      lpRaw = BigInt(String(body.lp_tokens).replace(/[^0-9]/g, '')) * (10n ** BigInt(decimals));
      if (lpRaw > bal) lpRaw = bal;
    } else {
      lpRaw = bal; // default: seed the entire minted supply
    }
  } catch (e) {
    return res.end(JSON.stringify({ ok: false, error: `Token read failed: ${e.message}` }));
  }
  if (lpRaw <= 0n)
    return res.end(JSON.stringify({ ok: false, error: 'Creator holds 0 tokens — deploy/mint supply before seeding a pool' }));

  // Price: user gives ETH per whole token. currency1/currency0 = tokenRaw/ethWei = 10^dec / weiPerToken.
  const weiPerToken = toWei18(priceStr);
  if (weiPerToken <= 0n)
    return res.end(JSON.stringify({ ok: false, error: 'price must be > 0' }));
  const tokenUnit = 10n ** BigInt(decimals);

  const sqrtPriceX96 = sqrtPriceX96From(tokenUnit, weiPerToken);
  if (sqrtPriceX96 <= 0n)
    return res.end(JSON.stringify({ ok: false, error: 'price out of range — adjust initial price' }));
  const Pfloat = Number(tokenUnit) / Number(weiPerToken);
  const currentTick = tickFromPrice(Pfloat);

  // Single-sided token (currency1) → range entirely BELOW current price.
  const maxTick = maxUsableTick(spacing);
  let tickUpper = alignDown(currentTick, spacing);
  if (tickUpper >= currentTick) tickUpper -= spacing;  // strictly below → pure currency1
  const tickLower = -maxTick;
  if (tickLower >= tickUpper)
    return res.end(JSON.stringify({ ok: false, error: 'Invalid tick range — raise the initial price or lower the fee tier' }));

  // Liquidity from the token amount over [tickLower, tickUpper]
  const sqrtA = getSqrtRatioAtTick(tickLower);
  const sqrtB = getSqrtRatioAtTick(tickUpper);
  const liquidity = liquidityForAmount1(sqrtA, sqrtB, lpRaw);
  if (liquidity <= 0n)
    return res.end(JSON.stringify({ ok: false, error: 'Computed liquidity is zero — increase LP token amount or adjust price' }));

  const poolKey = {
    currency0: WETH,
    currency1: tokenAddr,
    fee,
    tickSpacing: spacing,
    hooks: ZERO,
  };
  const deadline   = Math.floor(Date.now() / 1000) + 1200;        // 20 min
  const expiration = Math.floor(Date.now() / 1000) + 30 * 86400;  // Permit2: 30 days

  // ── Build unlockData for modifyLiquidities: MINT_POSITION + SETTLE_PAIR ────────
  const actions = '0x' + [ACTION_MINT_POSITION, ACTION_SETTLE_PAIR]
    .map(a => a.toString(16).padStart(2, '0')).join('');
  const mintParam = ABI_CODER.encode(
    ['tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)',
     'int24', 'int24', 'uint256', 'uint128', 'uint128', 'address', 'bytes'],
    [poolKey, tickLower, tickUpper, liquidity, 0n, lpRaw, creatorAddr, '0x'],
  );
  const settleParam = ABI_CODER.encode(['address', 'address'], [WETH, tokenAddr]);
  const unlockData = ABI_CODER.encode(['bytes', 'bytes[]'], [actions, [mintParam, settleParam]]);

  const initData   = POSM_IFACE.encodeFunctionData('initializePool', [poolKey, sqrtPriceX96]);
  const modifyData = POSM_IFACE.encodeFunctionData('modifyLiquidities', [unlockData, deadline]);
  const multicallData = POSM_IFACE.encodeFunctionData('multicall', [[initData, modifyData]]);

  // ── Tx bundle ──────────────────────────────────────────────────────────────
  const txs = [
    {
      label: 'approve_permit2',
      title: 'Approve token (Permit2)',
      to: tokenAddr,
      data: ERC20_IFACE.encodeFunctionData('approve', [PERMIT2, MAX_UINT256]),
      value: '0x0',
      gas: '0xea60', // 60k
    },
    {
      label: 'permit2_approve',
      title: 'Authorize position manager',
      to: PERMIT2,
      data: PERMIT2_IFACE.encodeFunctionData('approve', [tokenAddr, POSITION_MANAGER, lpRaw, expiration]),
      value: '0x0',
      gas: '0x186a0', // 100k
    },
    {
      label: 'create_pool',
      title: 'Create V4 pool + seed liquidity',
      to: POSITION_MANAGER,
      data: multicallData,
      value: '0x0', // single-sided token → no ETH owed
      gas: '0x7a120', // 500k
    },
  ];

  return res.end(JSON.stringify({
    ok: true,
    chainId: CHAIN_ID,
    dex: 'uniswap-v4',
    pool: {
      poolId: poolIdOf(poolKey),
      currency0: WETH,
      currency1: tokenAddr,
      fee, tickSpacing: spacing, hooks: ZERO,
      sqrtPriceX96: sqrtPriceX96.toString(),
      tickLower, tickUpper,
      liquidity: liquidity.toString(),
      lpTokensRaw: lpRaw.toString(),
      priceEthPerToken: priceStr,
      decimals,
      positionManager: POSITION_MANAGER,
    },
    txs,
    note: 'Sign all 3 txs in order. Single-sided token liquidity; ETH buyers move price into range.',
  }));
}

// ── pool_status — is a V4 pool already initialized for this token? ────────────────
async function handlePoolStatus(body, res) {
  const token = (body.token || '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(token))
    return res.end(JSON.stringify({ ok: false, error: 'token must be a valid 0x address' }));
  const tokenAddr = ethers.getAddress(token);
  try {
    const pools = {};
    await Promise.all(Object.keys(FEE_SPACING).map(async feeStr => {
      const fee = parseInt(feeStr, 10);
      const key = { currency0: WETH, currency1: tokenAddr, fee, tickSpacing: FEE_SPACING[fee], hooks: ZERO };
      const id  = poolIdOf(key);
      try {
        const r = await ethCall(STATE_VIEW, STATEVIEW_IFACE.encodeFunctionData('getSlot0', [id]));
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

module.exports = async (req, res) => {
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'POST only' })); }

  try {
    const body   = req.body ?? {};
    const action = body.action ?? 'prepare_pool';
    if (action === 'prepare_pool') return handlePreparePool(body, res);
    if (action === 'pool_status')  return handlePoolStatus(body, res);
    return res.end(JSON.stringify({ ok: false, error: `Unknown action: "${action}"` }));
  } catch (e) {
    return res.end(JSON.stringify({ ok: false, error: e.message }));
  }
};
