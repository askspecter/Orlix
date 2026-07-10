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

## 2. B20 native policies (allowlist / blocklist / freeze)

The Policy Compiler already produces the intent + config. To **enforce** it we
create a policy on the registry, set its members, and bind it to a token scope.

Facts from the B20 spec:
- policy id is `uint64`; `ALWAYS_ALLOW = 0`, `ALWAYS_BLOCK = 72057594037927937`
  (2^56 + 1); batch cap 64. Gated ops call `isAuthorized` and revert `PolicyForbids`.
- **PolicyRegistry** precompile: `0x8453000000000000000000000000000000000002`.

### Verified ABI (from `github.com/base/base-std`, `IPolicyRegistry.sol` + `IB20.sol`)

```solidity
// PolicyRegistry (0x8453…0002)
enum PolicyType { BLOCKLIST, ALLOWLIST }          // BLOCKLIST = 0, ALLOWLIST = 1
function createPolicy(address admin, PolicyType policyType) external returns (uint64 newPolicyId);
function updateAllowlist(uint64 policyId, bool allowed, address[] accounts) external;   // NOTE: (id, bool, accounts)
function updateBlocklist(uint64 policyId, bool blocked, address[] accounts) external;   // NOTE: (id, bool, accounts)

// B20 token — bind a policy id to a transfer/mint scope
function updatePolicy(bytes32 policyScope, uint64 newPolicyId) external;
// scope selectors are bytes32 VIEW getters on the token (read once, then reuse):
function TRANSFER_SENDER_POLICY()   view returns (bytes32);  // checked against `from` on transfer
function TRANSFER_RECEIVER_POLICY() view returns (bytes32);  // checked against `to`   on transfer
function TRANSFER_EXECUTOR_POLICY() view returns (bytes32);  // checked against msg.sender on transferFrom
function MINT_RECEIVER_POLICY()     view returns (bytes32);  // checked against `to`   on mint
```

> ⚠️ The earlier draft of this section had the arg order wrong
> (`updateAllowlist(uint64, address[], bool)`). The verified order is
> `(uint64 policyId, bool allowed, address[] accounts)`.

### Wiring notes / gotchas
- `createPolicy` **returns** the new `policyId`, so enforcement can't live purely
  in `createB20` initCalls (initCalls can't capture a return value). Do it as a
  short post-launch tx sequence: `createPolicy` → `updateAllowlist/Blocklist` →
  token `updatePolicy(scope, policyId)`. Read the returned id from the
  `createPolicy` receipt (or an `eth_call` simulation of it).
- The scope selectors are `bytes32` view getters — read them from the deployed
  token once and cache; they're identical for every B20 token.
- **Allowlist on a public launch breaks trading**: the Uniswap pool, router and
  every buyer would need to be allowlisted. For launchpad tokens only a
  **blocklist** (ban specific addresses) or **freeze** is safe; keep allowlist
  behind an explicit "restricted token" opt-in.
- Guard every build with the existing `ethCallSim` pre-flight so a bad config
  reverts in simulation, never for a user.
