# Orlix — CLAUDE.md

## Project Overview
Orlix is an AI-powered multi-chain analytics and token deployment platform built on Base and Robinhood Chain. Live at orlix.xyz.

## Repository Structure
```
/
├── api/                    # Vercel serverless functions
│   ├── b20-skill.js        # B20 token deployment API
│   ├── b20-tokens.js       # Recently deployed B20 tokens
│   ├── b20.js              # B20 standard info
│   ├── b20-ai.js           # AI-assisted B20 config
│   ├── analyze.js          # Token analysis (DexScreener + Basescan)
│   ├── chat.js             # AI chat (Claude)
│   ├── search.js           # Token search
│   ├── token-search.js     # Enhanced token lookup
│   ├── bankr-tokens.js     # Bankr ecosystem tokens
│   ├── gallery.js          # NFT/media gallery
│   ├── music.js / song.js  # AI music generation
│   ├── ping.js             # Health check
│   ├── auth.js             # Authentication
│   ├── telegram.js         # Telegram integration
│   ├── x402.js             # x402 payment protocol
│   ├── x402-analyze.js     # Premium token analysis
│   ├── x402-chat.js        # Premium AI chat
│   ├── x402-market.js      # Premium market data
│   ├── x402-wallet.js      # Premium wallet analytics
│   ├── x402-b20.js         # Premium B20 deployment
│   └── x402-song.js        # Premium music generation
│
├── *.html                  # Frontend pages (vanilla HTML/CSS/JS)
│   ├── index.html          # Dashboard — Base ecosystem overview
│   ├── neural-map.html     # Base City 3D visualization (Three.js)
│   ├── b20-studio.html     # B20 token deployment UI
│   ├── app.html            # Token analytics app
│   ├── api-docs.html       # API documentation
│   ├── docs.html           # Platform docs
│   ├── changelog.html      # Version history
│   ├── token.html          # Token detail page
│   └── agentic-flow.html   # Agentic flow visualization
│
├── .github/
│   └── workflows/
│       └── sync-opensource.yml   # Auto-sync to tylerbroqs/orlixai
│
├── vercel.json             # Vercel routing + function config
└── package.json
```

## Key Technical Details

### B20 Token Standard
- Precompile address: `0x4200000000000000000000000000000000000B20`
- Networks: Base Mainnet (8453, pending), Sepolia (84532), Vibenet (84538453)
- Chain ID hex: mainnet `0x2105`, sepolia `0x14a34`, vibenet `0x509F455`
- RPC: mainnet `https://mainnet.base.org`, sepolia `https://sepolia.base.org`, vibenet `https://rpc.vibes.base.org`

### Base City (`/neural-map.html`)
- Three.js r128 (non-module, CDN)
- 15×15 grid, BLOCK=18, STREET=12, CELL=30
- MeshPhongMaterial + emissiveMap for window glow
- UnrealBloomPass disabled on mobile
- Scene layout: peninsula city — ocean wraps the front (+Z) and left (-X) sides, snowy mountains on +X/-Z, river + bridges on the +X flank
- Two ocean planes (front sea + left bay) share one wave function sampled in WORLD space so the seam at z=170 / x=-170 stays invisible
- Full moon at (600, 180, -520), `fog:false` on its material (beyond the FogExp2 falloff it vanishes otherwise); sized for the default camera pose
- UFO saucer patrols above downtown; tractor beam + underglow are night-only (toggled alongside searchlights in `toggleDayNight`)
- Intro camera: start (30,190,330) → end (15,125,275) — aerial framing that shows the whole peninsula

### Robinhood Chain Integration (added July 2026)
- Chain ID: 4663 (hex `0x1237`)
- RPC: `https://rpc.mainnet.chain.robinhood.com/`
- Explorer: `https://robinhoodchain.blockscout.com`
- Network type: Arbitrum L2, ETH native currency
- DexScreener chain ID: `'robinhood'` (used in API filters)
- Supported in: `analyze.js`, `chat.js`, `token-search.js`, `x402.js`, `x402-market.js`, `app.html`, `index.html`
- NOT supported in B20 files (B20 is Base-only)
- Multi-chain filter pattern: `p.chainId === 'base' || p.chainId === 'robinhood'`
- `analyze.js` uses a CHAINS config object with `chain` query param (defaults to `'base'`)
- `app.html` has a chain selector dropdown that passes chain param to the analyze API

### B20 Studio (`/b20-studio.html`)
- Chain ID comparison must be case-insensitive (MetaMask returns lowercase hex)
- EIP-1559 gas: always pass `maxFeePerGas` + `maxPriorityFeePerGas` from API
- Devnet gas floor: 1 gwei minimum when baseFee = 0

### Open Source Sync
- Workflow: `.github/workflows/sync-opensource.yml`
- Source: `aureliusai-code/orlix` main branch
- Target: `tylerbroqs/orlixai` main branch
- Requires secret: `TYLERBROQS_PAT` in aureliusai-code/orlix settings

## Environment Variables

```env
# AI
ANTHROPIC_API_KEY=
BANKR_LLM_KEY=

# Blockchain
BASESCAN_API_KEY=

# State
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
```

## Deployment
- Platform: Vercel (auto-deploy from main branch of aureliusai-code/orlix)
- Domain: orlix.xyz
- Function timeout: most endpoints 10s, b20-skill/telegram 30-60s

## Common Commands
```bash
# Push changes
git add -A && git commit -m "..." && git push origin main

# Check deployment
# Vercel auto-deploys on push to main
```

## Session History
- `session_01EQsBP8bax8HwLDVovqZxYx` — Added Robinhood Chain (mainnet July 1 2026) to analytics/search/chat. Files: analyze.js, chat.js, token-search.js, x-agent.js, x402.js, x402-market.js, app.html, index.html. Created video animation (later removed). B20 files NOT touched.
- `session_01Dhpc62Y19RJMuV1gFB1hmh` — Continuation of Robinhood Chain integration. Updated CLAUDE.md with persistent memory.
- `session_01RwaoCkty8pyct6jvvJenAn` — Base City scene revamp to match design mock: peninsula terrain (ocean wraps +Z and -X), river/bridges mirrored to +X flank, second ocean plane + shore/foam/reflection for the left bay, ships split across both waters, waterfront piers with lamps, bigger full moon repositioned upper-right, UFO with night-only tractor beam, aerial intro end pose. File: neural-map.html only.
