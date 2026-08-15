# Orlix — Robinhood Chain Intelligence Platform

Orlix is an open-source, AI-powered analytics platform for **Robinhood Chain**. It provides
real-time on-chain data, token analytics, wallet monitoring, and a multi-model AI terminal —
all running against Robinhood Chain (chain ID `4663`).

**Live:** [orlix.xyz](https://orlix.xyz)

---

## What's Inside

### Pages

| Page | URL | Description |
|------|-----|-------------|
| Home | `/` | Cinematic landing — the Orlix terminal, on Robinhood Chain |
| Dashboard | `/dashboard` | Classic overview — models, onchain reads, wallet monitor |
| App | `/app` | AI terminal: chat, token analytics, wallet tracking, onchain reads |
| API Docs | `/docs/api` | Documentation for the public API endpoints |
| Docs | `/docs` | Platform documentation |
| Changelog | `/changelog` | Platform updates and version history |

---

### API Endpoints

All endpoints are deployed as Vercel serverless functions under `/api/`.

#### Analytics
- **`/api/search`** — Token search on Robinhood Chain (DexScreener)
- **`/api/token-search`** — Enhanced token lookup with metadata
- **`/api/bankr-tokens`** — Token list from the Bankr ecosystem

#### AI & Chat
- **`/api/chat`** — Multi-model AI chat with live web, GitHub, DexScreener, and
  Robinhood Chain onchain read tools (balances, gas, transactions, blocks, ERC-20 info)
- **`/api/x402`** — x402 pay-per-use premium endpoints (chat, market)

#### Utility
- **`/api/ping`** — Health check
- **`/api/gallery`** — Media gallery

---

## Robinhood Chain

- **Chain ID:** `4663` (hex `0x1237`)
- **RPC:** `https://rpc.mainnet.chain.robinhood.com/`
- **Explorer:** `https://robinhoodchain.blockscout.com`
- **Native currency:** ETH · **Type:** Arbitrum L2
- **DexScreener chain id:** `robinhood`

---

## Deployment

- **Platform:** Vercel (auto-deploy from `main`)
- **Domain:** orlix.xyz

## License

Open source. See repository for details.
