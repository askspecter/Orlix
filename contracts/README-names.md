# OrlixNames — `.b20` name service + marketplace

`OrlixNames.sol` powers the **Names** page (`/names`) — register `jesse.b20`,
pay in **$ORLIX**, and buy/sell names on a built-in marketplace. Names are
ERC-721 NFTs, so they show in wallets and trade on-chain in one tx.

- Register price is length-tiered (3-char premium … 5+ cheap), paid in $ORLIX;
  a configurable slice (default 50%) is **burned**, the rest goes to the
  treasury. Marketplace sales burn a small fee (default 2.5%).
- `resolve("jesse") → address` and `reverse(addr) → "jesse.b20"` let a name
  stand in for a 0x address (fee recipients, referrals, profiles).
- Enumeration view functions (`totalNames`/`nameAt`, `totalListings`/`listingAt`)
  let the frontend read everything over RPC — no indexer/API function needed.

> ⚠️ UNAUDITED. Test on a Base fork / Sepolia before mainnet. `tokenId ==
> uint256(keccak256(fullLabel))`.

## Deploy (Remix — same flow as the launcher/vault)

1. remix.ethereum.org → paste `OrlixNames.sol` → Solidity Compiler **0.8.24** → Compile.
2. Deploy & Run → **Injected Provider (MetaMask)**, Base mainnet.
3. Contract dropdown → **OrlixNames** (not `IERC20`).
4. Constructor args:
   - `orlixToken` = `0x799c28BAC95B3E0B26534D1e9A586511895EcBA3` ($ORLIX)
   - `treasury_`  = your treasury wallet (receives the non-burned share)
5. Deploy → copy the deployed address.

## Wire it into the site

Set the address in `b20-names.html` (constant `NAMES_CONTRACT`) — or the env the
page reads — then the Register / My Names / Marketplace tabs go live. Until it's
set, the page shows a "not deployed yet" state and no transactions are attempted.

## Pricing note

Defaults assume a low-unit-price token (millions of $ORLIX per name). Retune any
time with `setPrices(len3, len4, len5plus)`, `setFees(regBurnBps, marketBps)`,
and `setTreasury(addr)` — all owner-only.
