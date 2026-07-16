# Orlix Omnichain — $ORLIX across chains (LayerZero OFT)

$ORLIX goes multi-chain with the **LayerZero OFT** standard: one canonical
token, one supply, kept in sync across Base and Robinhood Chain. No wrapped
copies, no fragmented liquidity.

## Model: OFT Adapter (existing token)

$ORLIX already exists on Base (`0x799c28BAC95B3E0B26534D1e9A586511895EcBA3`),
so we use an **OFT Adapter** rather than a native OFT:

```
        Base                                  Robinhood Chain
  ┌───────────────┐   LayerZero message   ┌───────────────────┐
  │ $ORLIX (ERC20)│                        │  OrlixOFT (ERC20) │
  │      ▲        │                        │        ▲          │
  │  lock│unlock  │  ◄──────────────────►  │  mint │ burn      │
  │ ┌────┴──────┐ │                        │ (OFT, LZ-native)  │
  │ │OFT Adapter│ │                        └───────────────────┘
  │ └───────────┘ │
  └───────────────┘
```

- **Base:** deploy an `OFTAdapter` that wraps the existing $ORLIX ERC-20. It
  **locks** $ORLIX on send and **unlocks** on receive.
- **Robinhood Chain:** deploy a native `OFT` (an ERC-20 that **mints** on receive
  and **burns** on send). This is the bridged $ORLIX.
- **Wire:** `setPeer(dstEid, peerAddress)` on both sides so each knows the other.
- **Bridge:** `send(...)` on the source locks/burns and emits a LayerZero message;
  the destination unlocks/mints. Total supply across chains stays constant.

## Implementation

Use the audited LayerZero V2 reference contracts — do not hand-roll:

```
npm i @layerzerolabs/oft-evm @layerzerolabs/lz-evm-protocol-v2
```

- Base adapter → extend `OFTAdapter` (constructor takes the $ORLIX token address
  and the Base LayerZero **Endpoint**).
- Robinhood token → extend `OFT` (constructor takes name/symbol and the Robinhood
  LayerZero **Endpoint**).

Both constructors need the LayerZero **EndpointV2 address** for their chain and,
for wiring, the counterpart chain's **EID (endpoint id)**.

## Values to fill before deploy

| Item | Base | Robinhood Chain |
| --- | --- | --- |
| LayerZero EndpointV2 address | `0x____` | `0x____` ← **must confirm LayerZero supports Robinhood Chain** |
| Endpoint ID (EID) | `____` | `____` |
| $ORLIX token address | `0x799c28BAC95B3E0B26534D1e9A586511895EcBA3` | (OFT deployed here) |

> ⚠️ The hard dependency is a **LayerZero endpoint on Robinhood Chain**. Confirm
> the EndpointV2 address + EID from the LayerZero deployments list before wiring.
> If LayerZero does not support Robinhood Chain, use Robinhood's native bridge or
> another messaging layer (CCIP / Hyperlane / Wormhole) instead.

## Deploy → wire → bridge (order)

1. Deploy `OFTAdapter` on Base (points at existing $ORLIX).
2. Deploy `OrlixOFT` on Robinhood Chain.
3. `setPeer` on Base → Robinhood EID + OFT address.
4. `setPeer` on Robinhood → Base EID + Adapter address.
5. `send()` from Base to bridge the initial supply.
6. (Later, when the Robinhood wallet is funded with ETH) seed a real two-sided
   `ORLIX/WETH` pool. A single-sided token-only pool traps buyers — avoid it for
   the flagship token.

## Going live in the Orlix app

Once the Robinhood OFT is deployed and wired, the **only** app edit needed is in
[`assets/orlix-omnichain.js`](../assets/orlix-omnichain.js): set
`token.chains.robinhood.address` to the new contract and `live: true` (and fill
the LayerZero `bridgeUrl` / EIDs). The [`/bridge`](../bridge.html) hub, badges,
and status flip to **Live** automatically.
