# $ORLIX Omnichain — deployment record

**Live since:** 2026-07-16 · **Path 1** (canonical bridge, no Robinhood pool yet)
**Protocol:** LayerZero OFT V2 · 2-DVN (LayerZero Labs + Nethermind), 20 confirmations

## Contracts

| Role | Chain | Address |
| --- | --- | --- |
| Canonical $ORLIX (ERC-20) | Base (8453) | `0x799c28BAC95B3E0B26534D1e9A586511895EcBA3` |
| OFTAdapter (lock/unlock escrow) | Base (8453) | `0xA42df44b48857a5fa157e743bEFB5EBE71d1e0Ca` |
| $ORLIX OFT (name "Orlix AI", 18 dec) | Robinhood Chain (4663) | `0x57a8BD58F4a87eFe70bcC16F139c52320bD6d8cd` |

Owner of both new contracts = project wallet.

## LayerZero wiring

- Endpoint IDs: Base **30184** ↔ Robinhood **30416**
- Peers set both directions: base `0xdcfc5c04…bc8ad`, rh `0x1527008054…32e0f`
- 2-DVN + executor config on all 4 legs:
  base send `0x58248d68…`, base recv `0x74b164ee…`, rh send `0x7f146804…`, rh recv `0x0387083d…`

## Deploy / first-bridge transactions

| Action | Tx |
| --- | --- |
| Deploy OFTAdapter (Base) | `0x9e51b2694d671eab31fd9656fad16d32d67b3751e3d5959cabd1aa82f72788bb` |
| Deploy OFT (Robinhood) | `0x19d54dd729fd8bf380cc53a1c4ea302cc8ae7a69b2756d26c1443b87ffe50629` |
| Approve (Base) | `0x750901abfae20024b99db59f6418ec024192fe7a90caa4ef876a27692aeb1a27` |
| Send 60,000,000 ORLIX (Base→RH) | `0x2f9ae091ce5aa34794ca06b1c1478a54066282dc6a0b7b144cea351612c8e6bc` |

LayerZero tracker: https://layerzeroscan.com/tx/0x2f9ae091ce5aa34794ca06b1c1478a54066282dc6a0b7b144cea351612c8e6bc

## Liquidity pool (Robinhood Chain) — LIVE

- Pool: `0x762dFbEFccba79c142F08abD3718f4476C3559d7` — ORLIX/WETH, **1% fee tier**
- WETH quote: `0x0bd7d308f8e1639fab988df18a8011f41eacad73`
- Starting price: **$4.7708e-7 / ORLIX** (matched to live Base spot), range ±50% (ticks 216800–225200)
- Seeded two-sided, value-matched (~$26.75/side): **0.0142 WETH + ~55.56M ORLIX** (of the 60M bridged; ~4.44M left in wallet)
- Create+init+mint tx: `0x21f5238644182ea4852458444640bfac790af21bfff5bf812027bf585d932da8`
- LP position held as an NPM NFT in the project wallet (fees accrue there).
- Chart: https://dexscreener.com/robinhood/0x762dFbEFccba79c142F08abD3718f4476C3559d7

## Status

- ✅ Canonical bridge live both directions (move $ORLIX Base ↔ Robinhood via adapter/OFT).
- ✅ 60,000,000 ORLIX bridged to the project wallet on Robinhood Chain.
- ✅ ORLIX/WETH pool live — **$ORLIX is tradable on Robinhood Chain.**
- ◻ Pool is intentionally shallow (~$53 total). Deepen later by adding liquidity
  (non-destructive) when the Robinhood wallet has more ETH.

## App integration

The live addresses are wired into [`assets/orlix-omnichain.js`](../assets/orlix-omnichain.js),
which drives the [bridge hub](../bridge.html) at **bridge.orlixai.xyz**.
