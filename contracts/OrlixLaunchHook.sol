// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// ─────────────────────────────────────────────────────────────────────────────
//  OrlixLaunchHook — Uniswap V4 hook for fair B20 launches on Base.
//
//  This is what makes the "advisory" rules from the Orlix AI Policy Compiler
//  actually enforceable on-chain — the ones B20's native precompile CANNOT do:
//
//    • Anti-snipe sniper fee: a dynamic LP fee that starts high (e.g. 80%) at
//      launch and decays linearly to the normal fee over a short window, so
//      bots that snipe block 0 pay a punishing fee that funds real LPs.
//    • Launch sell-lock: optionally block sells (token → ETH) for the first
//      N seconds so the price can find its footing.
//
//  Per-pool config is set once by the launch orchestrator (the Orlix deployer),
//  keyed by PoolId, at pool creation time.
//
//  ⚠️  REFERENCE IMPLEMENTATION — NOT DEPLOYED, NOT AUDITED.
//      Before any mainnet use you MUST:
//        1. Pin exact v4-core / v4-periphery versions and compile with Foundry.
//        2. Deploy at an address whose low bits match the permission flags below
//           (mine a CREATE2 salt — see contracts/README.md).
//        3. Write invariant/fork tests and get an independent audit.
//      Hooks sit in the swap path of real user funds; a bug can brick trading.
// ─────────────────────────────────────────────────────────────────────────────

import {BaseHook} from "v4-periphery/src/utils/BaseHook.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";

contract OrlixLaunchHook is BaseHook {
    using PoolIdLibrary for PoolKey;
    using LPFeeLibrary for uint24;

    // Per-launch protection config.
    struct LaunchConfig {
        uint64  startTime;      // pool launch timestamp
        uint32  decaySeconds;   // sniper-fee decay window (e.g. 15)
        uint24  startFeePips;   // fee at t=0 in pips (1e6 = 100%), e.g. 800000 = 80%
        uint24  baseFeePips;    // steady-state fee, e.g. 10000 = 1%
        uint32  sellLockSeconds;// block sells for this many seconds (0 = disabled)
        bool    set;
    }

    // currency0 is always the paired asset (WETH); currency1 is the launched token.
    // A "sell" is token → WETH, i.e. zeroForOne == false (spending currency1).
    mapping(PoolId => LaunchConfig) public configOf;

    address public immutable orchestrator; // the Orlix deployer allowed to configure

    error NotOrchestrator();
    error AlreadyConfigured();
    error SellLocked();

    event LaunchConfigured(PoolId indexed poolId, uint24 startFeePips, uint24 baseFeePips, uint32 decaySeconds, uint32 sellLockSeconds);

    constructor(IPoolManager _pm, address _orchestrator) BaseHook(_pm) {
        orchestrator = _orchestrator;
    }

    // Only beforeSwap is needed; it overrides the LP fee per-swap and can revert.
    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: false,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    /// @notice One-time per-pool config, called by the launch orchestrator right after pool init.
    function configureLaunch(
        PoolKey calldata key,
        uint24 startFeePips,
        uint24 baseFeePips,
        uint32 decaySeconds,
        uint32 sellLockSeconds
    ) external {
        if (msg.sender != orchestrator) revert NotOrchestrator();
        PoolId id = key.toId();
        if (configOf[id].set) revert AlreadyConfigured();
        require(startFeePips <= LPFeeLibrary.MAX_LP_FEE && baseFeePips <= startFeePips, "bad fee");
        configOf[id] = LaunchConfig({
            startTime: uint64(block.timestamp),
            decaySeconds: decaySeconds,
            startFeePips: startFeePips,
            baseFeePips: baseFeePips,
            sellLockSeconds: sellLockSeconds,
            set: true
        });
        emit LaunchConfigured(id, startFeePips, baseFeePips, decaySeconds, sellLockSeconds);
    }

    /// @dev Current sniper fee (linear decay start → base over decaySeconds).
    function currentFee(PoolId id) public view returns (uint24) {
        LaunchConfig memory c = configOf[id];
        if (!c.set) return 0; // 0 => don't override; pool's own fee applies
        uint256 elapsed = block.timestamp - c.startTime;
        if (elapsed >= c.decaySeconds) return c.baseFeePips;
        uint256 span = uint256(c.startFeePips) - c.baseFeePips;
        uint256 shaved = (span * elapsed) / c.decaySeconds;
        return uint24(c.startFeePips - shaved);
    }

    function _beforeSwap(
        address,
        PoolKey calldata key,
        IPoolManager.SwapParams calldata params,
        bytes calldata
    ) internal view override returns (bytes4, BeforeSwapDelta, uint24) {
        PoolId id = key.toId();
        LaunchConfig memory c = configOf[id];
        if (!c.set) {
            return (BaseHook.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }

        // Sell-lock: token → WETH is zeroForOne == false (currency1 in, currency0 out).
        if (c.sellLockSeconds > 0 && !params.zeroForOne && block.timestamp < c.startTime + c.sellLockSeconds) {
            revert SellLocked();
        }

        // Dynamic sniper fee — returned as an LP-fee override (pool must be a
        // dynamic-fee pool: initialized with LPFeeLibrary.DYNAMIC_FEE_FLAG).
        uint24 fee = currentFee(id);
        return (BaseHook.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, fee | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }
}
