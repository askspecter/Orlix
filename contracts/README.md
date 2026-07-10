# Orlix on-chain enforcement — hook + B20 policy wiring

Two pieces make the **AI Policy Compiler** rules fully enforced on-chain.

---

## 1. `OrlixLaunchHook.sol` — Uniswap V4 hook (advisory rules → enforced)

Enforces the launch-protection rules B20's precompile can't do natively:

- **Anti-snipe sniper fee** — dynamic LP fee decaying `startFeePips → baseFeePips`
  over `decaySeconds` (e.g. 80% → 1% over 15s). Snipers pay; real LPs earn.
- **Sell-lock window** — optionally reverts sells (token→WETH) for `sellLockSeconds`.

### ⚠️ Status: REFERENCE ONLY — not deployed, not audited
Hooks sit in the swap path of real funds. Do **not** ship to mainnet before:
compiling with pinned versions, mining the address, writing fork tests, and an audit.

### Prerequisites
```bash
forge init && forge install uniswap/v4-core uniswap/v4-periphery
# pin exact commits in foundry.toml — the hook interface changes between versions
```

### Deploy (address must encode the permission flags)
A V4 hook only fires the callbacks encoded in the **low bits of its address**.
`OrlixLaunchHook` uses only `beforeSwap`, so mine a CREATE2 salt whose deployed
address has the `BEFORE_SWAP_FLAG` bit set:

```solidity
// script/Deploy.s.sol (sketch)
uint160 flags = uint160(Hooks.BEFORE_SWAP_FLAG);
(address hookAddr, bytes32 salt) = HookMiner.find(
    CREATE2_DEPLOYER, flags, type(OrlixLaunchHook).creationCode,
    abi.encode(POOL_MANAGER, ORCHESTRATOR)
);
OrlixLaunchHook hook = new OrlixLaunchHook{salt: salt}(IPoolManager(POOL_MANAGER), ORCHESTRATOR);
require(address(hook) == hookAddr, "flag mismatch");
```
`POOL_MANAGER` = Base Uniswap V4 PoolManager. `ORCHESTRATOR` = the Orlix deployer
wallet (the only address allowed to call `configureLaunch`).

### Integrate into the launch flow (`api/b20-skill.js`, `handlePreparePool`)
1. Create the pool with **dynamic fee** and this hook:
   - `poolKey.fee   = 0x800000` (`LPFeeLibrary.DYNAMIC_FEE_FLAG`)
   - `poolKey.hooks = <hookAddr>`
2. Right after `initializePool`, add one call:
   - `hook.configureLaunch(poolKey, startFeePips, baseFeePips, decaySeconds, sellLockSeconds)`
   Map these from the Policy Compiler's `advisory` output (e.g. "no sells 15m" →
   `sellLockSeconds = 900`; "anti-snipe" → `startFeePips = 800000, decaySeconds = 15`).
3. The rest of the launch (Permit2 approve, mint liquidity) is unchanged.

### Test plan (Base Sepolia fork) before mainnet
- Sniper fee at `t=0` == `startFeePips`; at `t≥decaySeconds` == `baseFeePips`; monotonic.
- Sell reverts inside the lock window, succeeds after.
- Buys are never blocked. `configureLaunch` is orchestrator-only and one-shot.
- Removing liquidity / normal LP flows unaffected.

---

## 2. B20 native policies (allowlist / blocklist / freeze) — needs exact ABI

The Policy Compiler already produces the intent + config. To **enforce** it we add
`initCalls` to `createB20`. Confirmed from the B20 spec:

- policy id is `uint64`; there is a **PolicyRegistry**; `ALWAYS_ALLOW = 0`,
  `ALWAYS_BLOCK = 72057594037927937` (2^56 + 1); batch cap 64.
- membership managed via `updateAllowlist(...)` / `updateBlocklist(...)`.
- freeze/seize path: deny via `TRANSFER_SENDER_POLICY` + `burnBlocked(...)`.
- gated ops call `isAuthorized` and revert `PolicyForbids`.

**Blocker — need the verbatim signatures** (docs.base.org returns 403 to fetch):
```
updateAllowlist(uint64 policyId, address[] accounts, bool allowed)   // arg order/types?
updateBlocklist(uint64 policyId, address[] accounts, bool blocked)   // arg order/types?
burnBlocked(address account, uint256 amount)                          // ?
// and the setter that binds a token scope to a policy id, e.g.:
setPolicy(uint256 scope, uint64 policyId)  // exact name + the scope constants
// scope constants: TRANSFER_SENDER_POLICY / TRANSFER_RECEIVER_POLICY / MINT_RECEIVER_POLICY ids
```
Paste these from https://docs.base.org/base-chain/specs/upgrades/beryl/b20 (the
"Policies" / interface section) and the wiring lands the same day, guarded by the
existing `ethCallSim` pre-flight so a bad config reverts in simulation, never for a user.
