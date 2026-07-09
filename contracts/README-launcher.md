# OrlixLauncher — one-transaction B20 launch (Base)

`OrlixLauncher.sol` does the whole launch in **one transaction / one wallet
confirmation**, RWAGMI-style:

1. creates the B20 token (`createB20`)
2. mints the full supply **into the launcher** (never the creator's wallet)
3. creates the Uniswap V4 `TOKEN/WETH` pool and seeds single-sided token liquidity
   (the LP position + its fees are owned by the creator)
4. optional creator **dev buy** (ETH → token) in the same tx

This is why RWAGMI shows one confirmation and no `+1B` in your wallet: the mint
goes straight to the pool via a contract. Our frontend can't do that with
separate wallet txs — it needs this deployed contract.

> ⚠️ **UNAUDITED / UNTESTED.** It interacts with the B20 precompile, Permit2 and
> Uniswap V4 periphery. Test on a Base fork and/or testnet with small amounts
> **before** any mainnet launch. A bug can waste gas or strand funds.

## Prerequisites

Base Foundry (the B20 precompile only exists on Base chains):

```bash
# Base's Foundry fork
curl -L https://raw.githubusercontent.com/base/foundry/main/install | bash
base-foundryup            # provides base-forge, base-cast, base-anvil
```

## Deploy

```bash
cd contracts
base-forge create OrlixLauncher.sol:OrlixLauncher \
  --rpc-url https://mainnet.base.org \
  --private-key $DEPLOYER_PK \
  --broadcast
```

Note the deployed address — call it `LAUNCHER`.

## Test on a fork first (recommended)

```bash
# fork Base mainnet locally
base-anvil --fork-url https://mainnet.base.org
# in another shell, deploy against the fork and simulate a launch()
```

Write a Foundry test that: predicts the address (`predict(variant, salt)`),
calls `launch(params)` with a tiny supply, then asserts the pool exists
(`StateView.getSlot0`) and the creator owns a position NFT.

## How the frontend will call it (once you give me `LAUNCHER`)

The backend already computes everything the contract needs (sqrtPriceX96,
tickLower/upper, liquidity, salt, b20Params). Send me the deployed `LAUNCHER`
address and I will:

- add it to `api/b20-skill.js`
- return a single `launch(...)` calldata bundle from `prepare`
- have `b20-studio.html` send exactly one `eth_sendTransaction` to `LAUNCHER`
  (value = dev-buy ETH)

Result: **one confirmation**, supply seeded straight into the pool, no `+1B`
in the wallet — matching RWAGMI.

## Addresses baked into the contract (Base mainnet)

| Role                | Address |
| ------------------- | ------- |
| B20 Factory         | `0xB20f000000000000000000000000000000000000` |
| WETH                | `0x4200000000000000000000000000000000000006` |
| Permit2             | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| V4 PositionManager  | `0x7C5f5A4bBd8fD63184577525326123B519429bDc` |
| Universal Router    | `0x6fF5693b99212Da76ad316178A184AB56D299b43` |

If any of these differ on your target network, update the constants before
deploying.
