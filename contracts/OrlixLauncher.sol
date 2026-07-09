// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title OrlixLauncher
 * @notice One-transaction B20 launcher for Base: creates a B20 token, seeds a
 *         Uniswap V4 TOKEN/WETH pool with single-sided token liquidity, and does
 *         an optional creator "dev buy" — all in a single call, so the user signs
 *         ONE wallet confirmation and the supply is minted straight into the pool
 *         (it never lands in the creator's wallet).
 *
 * @dev    This mirrors the RWAGMI launch flow. It is UNAUDITED and UNTESTED in
 *         this repo — you MUST test it on a fork / testnet before mainnet use
 *         (see contracts/README-launcher.md). Deploy it once, then point the
 *         Orlix frontend at its address.
 *
 *  Flow inside launch():
 *   1. FACTORY.createB20(variant, salt, params, initCalls) where initCalls:
 *        a. updateSupplyCap(supplyRaw)         (bypasses role gates during init)
 *        b. mint(address(this), supplyRaw)     (supply minted to THIS contract)
 *   2. Approve token -> Permit2 -> PositionManager.
 *   3. PositionManager.multicall([initializePool, modifyLiquidities(MINT_POSITION)])
 *        -> pool created + single-sided token liquidity seeded; the position NFT
 *           (and its LP fees) is owned by `creator`.
 *   4. Optional dev buy: if msg.value > 0, swap ETH->token via the Universal
 *        Router and send the token to `creator`.
 *
 *  WETH (0x42..06) sorts below any B20 token (0xb2..), so WETH is currency0 and
 *  the token is currency1. The seeded range sits entirely below the current tick,
 *  so only the token is required (buyers bring the ETH).
 */

interface IB20Factory {
    function createB20(uint8 variant, bytes32 salt, bytes calldata params, bytes[] calldata initCalls)
        external payable returns (address token);
    function getB20Address(uint8 variant, address sender, bytes32 salt) external view returns (address);
}

interface IB20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IPositionManager {
    function initializePool(PoolKey calldata key, uint160 sqrtPriceX96) external payable returns (int24);
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
    function multicall(bytes[] calldata data) external payable returns (bytes[] memory);
}

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

// PoolKey uses address for currency/hooks — ABI-encodes identically to the
// Uniswap types (Currency is `type ... is address`, IHooks is an address).
struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

contract OrlixLauncher {
    // ── Base mainnet addresses (Uniswap V4 canonical + B20 precompile) ──────────
    address public constant FACTORY          = 0xB20f000000000000000000000000000000000000;
    address public constant WETH             = 0x4200000000000000000000000000000000000006;
    address public constant PERMIT2          = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address public constant POSITION_MANAGER = 0x7C5f5A4bBd8fD63184577525326123B519429bDc;
    address public constant UNIVERSAL_ROUTER = 0x6fF5693b99212Da76ad316178A184AB56D299b43;

    // V4 liquidity action opcodes (v4-periphery Actions.sol)
    uint8 constant ACT_MINT_POSITION = 0x02;
    uint8 constant ACT_SETTLE_PAIR   = 0x0d;
    // Universal Router commands + V4 swap actions (dev buy)
    bytes1 constant CMD_WRAP_ETH = 0x0b;
    bytes1 constant CMD_V4_SWAP  = 0x10;
    bytes1 constant CMD_SWEEP    = 0x04;
    uint8  constant ACT_SWAP_EXACT_IN_SINGLE = 0x06;
    uint8  constant ACT_SETTLE               = 0x0b;
    uint8  constant ACT_TAKE_ALL             = 0x0f;
    address constant UR_MSG_SENDER   = 0x0000000000000000000000000000000000000001;
    address constant UR_ADDRESS_THIS = 0x0000000000000000000000000000000000000002;

    // B20 function selectors
    bytes4 constant SEL_UPDATE_SUPPLY_CAP = bytes4(keccak256("updateSupplyCap(uint256)"));
    bytes4 constant SEL_MINT              = bytes4(keccak256("mint(address,uint256)"));

    event Launched(address indexed token, address indexed creator, uint24 fee, uint128 liquidity, uint256 supply);

    struct LaunchParams {
        uint8   variant;       // 0 = asset, 1 = stablecoin
        bytes32 salt;          // address-derivation entropy
        bytes   b20Params;     // ABI-encoded B20 create params (initialAdmin = 0 for immutable)
        uint256 supplyRaw;     // raw supply to mint == supply cap (decimals applied off-chain)
        uint24  fee;           // LP fee tier (e.g. 10000 = 1%)
        int24   tickSpacing;   // matching tick spacing (e.g. 200)
        uint160 sqrtPriceX96;  // initial price (computed off-chain)
        int24   tickLower;     // range lower (computed off-chain, aligned)
        int24   tickUpper;     // range upper (computed off-chain, aligned, below current tick)
        uint128 liquidity;     // liquidity for the single-sided position (computed off-chain)
        address creator;       // LP position owner + dev-buy recipient
    }

    /// @notice Deterministic token address for a given salt, as deployed by THIS launcher.
    function predict(uint8 variant, bytes32 salt) external view returns (address) {
        return IB20Factory(FACTORY).getB20Address(variant, address(this), salt);
    }

    /// @notice Create the token, seed the V4 pool, and optionally dev-buy — in one tx.
    function launch(LaunchParams calldata p) external payable returns (address token) {
        require(p.creator != address(0), "creator=0");
        require(p.supplyRaw > 0, "supply=0");

        // 1. Create the B20 with initCalls that mint the whole supply to THIS contract.
        //    Factory-originated initCalls bypass role gates, so updateSupplyCap + mint
        //    work even for an immutable (initialAdmin == 0) token.
        bytes[] memory initCalls = new bytes[](2);
        initCalls[0] = abi.encodeWithSelector(SEL_UPDATE_SUPPLY_CAP, p.supplyRaw);
        initCalls[1] = abi.encodeWithSelector(SEL_MINT, address(this), p.supplyRaw);
        token = IB20Factory(FACTORY).createB20(p.variant, p.salt, p.b20Params, initCalls);

        // 2. Approvals: token -> Permit2 -> PositionManager.
        IB20(token).approve(PERMIT2, type(uint256).max);
        IPermit2(PERMIT2).approve(token, POSITION_MANAGER, uint160(p.supplyRaw), uint48(block.timestamp + 3650 days));

        // 3. Create pool + seed single-sided token liquidity (position owned by creator).
        PoolKey memory key = PoolKey({
            currency0: WETH,        // WETH < token, so WETH is currency0
            currency1: token,
            fee: p.fee,
            tickSpacing: p.tickSpacing,
            hooks: address(0)
        });

        bytes memory actions = abi.encodePacked(ACT_MINT_POSITION, ACT_SETTLE_PAIR);
        bytes[] memory mParams = new bytes[](2);
        mParams[0] = abi.encode(
            key, p.tickLower, p.tickUpper, uint256(p.liquidity),
            uint128(0),           // amount0Max (WETH) — none
            uint128(p.supplyRaw), // amount1Max (token)
            p.creator,            // position owner
            bytes("")             // hookData
        );
        mParams[1] = abi.encode(WETH, token); // SETTLE_PAIR(currency0, currency1)
        bytes memory unlockData = abi.encode(actions, mParams);

        bytes[] memory mc = new bytes[](2);
        mc[0] = abi.encodeWithSelector(IPositionManager.initializePool.selector, key, p.sqrtPriceX96);
        mc[1] = abi.encodeWithSelector(IPositionManager.modifyLiquidities.selector, unlockData, block.timestamp + 1200);
        IPositionManager(POSITION_MANAGER).multicall(mc);

        // 4. Optional dev buy: ETH -> token via Universal Router, sent to creator.
        if (msg.value > 0) {
            _devBuy(token, key, msg.value, p.creator);
        }

        emit Launched(token, p.creator, p.fee, p.liquidity, p.supplyRaw);
    }

    function _devBuy(address token, PoolKey memory key, uint256 ethIn, address creator) internal {
        bytes memory swapParam = abi.encode(key, true, uint128(ethIn), uint128(0), bytes("")); // zeroForOne WETH->token
        bytes memory settle    = abi.encode(WETH, ethIn, false);   // pay WETH from the router (wrapped below)
        bytes memory takeAll   = abi.encode(token, uint256(0));
        bytes memory v4Actions = abi.encodePacked(ACT_SWAP_EXACT_IN_SINGLE, ACT_SETTLE, ACT_TAKE_ALL);
        bytes[] memory v4Params = new bytes[](3);
        v4Params[0] = swapParam; v4Params[1] = settle; v4Params[2] = takeAll;
        bytes memory v4Input = abi.encode(v4Actions, v4Params);

        bytes memory wrapInput  = abi.encode(UR_ADDRESS_THIS, ethIn);
        bytes memory sweepInput = abi.encode(token, creator, uint256(0)); // token -> creator
        bytes memory commands   = abi.encodePacked(CMD_WRAP_ETH, CMD_V4_SWAP, CMD_SWEEP);
        bytes[] memory inputs = new bytes[](3);
        inputs[0] = wrapInput; inputs[1] = v4Input; inputs[2] = sweepInput;

        IUniversalRouter(UNIVERSAL_ROUTER).execute{value: ethIn}(commands, inputs, block.timestamp + 1200);
    }

    // Allow receiving ETH refunds (e.g. from the router).
    receive() external payable {}
}
