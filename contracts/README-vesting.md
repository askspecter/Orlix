# OrlixVestingVault — "Vested allocations" for B20 launches

`OrlixVestingVault.sol` backs the **Vested allocations** section of B20 Studio's
Create wizard (mirrors o1.exchange's launchpad). One vault serves *every* B20
token launched through Orlix — it is not redeployed per token.

Flow:

1. At launch, the vested total (sum of all vested-allocation rows) is minted
   straight into the vault as one more `initCall` inside the same atomic
   `createB20` transaction (see `buildInitCalls` in `api/b20-skill.js`) — it
   never passes through the creator's wallet.
2. Right after the launch confirms, the creator signs one follow-up tx per
   beneficiary calling `createSchedule(token, beneficiary, amount, start,
   cliffSeconds, durationSeconds, revocable)` for tokens the vault already
   holds. This mirrors the existing two-step pattern used for pool creation
   (`prepare_pool` / `createPool()` in `b20-studio.html`).
3. Vesting is linear from `start`: nothing unlocks before `start + cliff`,
   then the claimable amount grows linearly until `start + duration`.
   `release(id)` is callable by anyone but always pays the beneficiary.

> ⚠️ **UNAUDITED / UNDEPLOYED.** This contract is not live anywhere yet. Until
> it is deployed and its address is set as `B20_VESTING_VAULT`, the "Vested
> allocations" UI in B20 Studio stays disabled (validated server-side too —
> `parseConfig` rejects `vested_allocations` if the env var is unset) so no
> token is ever minted to an unconfigured address. Test on a Base fork with
> small amounts before pointing production at a mainnet deployment.

## Prerequisites

Base Foundry (same as `OrlixLauncher.sol` — see `README-launcher.md`):

```bash
curl -L https://raw.githubusercontent.com/base/foundry/main/install | bash
base-foundryup            # provides base-forge, base-cast, base-anvil
```

## Test on a fork first (recommended)

```bash
base-anvil --fork-url https://mainnet.base.org
```

Write a Foundry test that: mints a mock/real B20 token to the vault, calls
`createSchedule(...)`, warps time past the cliff and past full duration, and
asserts `releasable()` and `release()` behave linearly and pay the correct
beneficiary. Also test `revoke()` refunds only the unvested remainder.

## Deploy

```bash
cd contracts
base-forge create OrlixVestingVault.sol:OrlixVestingVault \
  --rpc-url https://mainnet.base.org \
  --private-key $DEPLOYER_PK \
  --broadcast
```

Note the deployed address — call it `VAULT`.

## Wiring it into Orlix (once you give me `VAULT`)

Set the environment variable:

```env
B20_VESTING_VAULT=0x...   # the deployed OrlixVestingVault address
```

`api/b20-skill.js` already has all the plumbing gated behind this variable:

- `handleInfo` reports `vestingVault: { address, configured }` — the frontend
  reads this to enable/disable the "Vested allocations" builder in the Create
  wizard.
- `parseConfig` accepts `vested_allocations: [{ address, percent, cliff_days,
  duration_days }]`, validates the total against the insider-allocation cap,
  and rejects the request outright if the vault isn't configured.
- `buildInitCalls` mints the vested total to the vault in the same tx as
  `createB20`.
- A new `prepare_vesting` action builds one `createSchedule` tx per
  beneficiary for the frontend to sign sequentially right after the launch
  confirms (same UX as `prepare_pool` → `createPool()`).

No other code changes are needed on my end once the vault is deployed — just
set the env var and redeploy the Vercel functions.
