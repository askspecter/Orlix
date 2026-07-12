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
│   ├── x402.js             # x402 payment protocol
│   ├── x402-analyze.js     # Premium token analysis
│   ├── x402-chat.js        # Premium AI chat
│   ├── x402-market.js      # Premium market data
│   ├── x402-wallet.js      # Premium wallet analytics
│   ├── x402-b20.js         # Premium B20 deployment
│   └── x402-song.js        # Premium music generation
│
├── *.html                  # Frontend pages (vanilla HTML/CSS/JS)
│   ├── index.html          # Cinematic homepage (Awwwards-style scroll film)
│   ├── dashboard.html      # Dashboard — Base ecosystem overview (old index, served at /dashboard)
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
- Factory address: `0xB20f000000000000000000000000000000000000`
- Activation Registry: `0x8453000000000000000000000000000000000001`
- Network: Base Mainnet only (chain ID 8453, hex `0x2105`) — LIVE since Beryl hardfork (2026-07-09 22:00 UTC)
- RPC: mainnet `https://mainnet.base.org`
- Deploy via: `createB20(variant, salt, params, initCalls)` — requires Base Foundry (`base-forge`, `base-cast`, `base-anvil`)
- Docs: https://docs.base.org/apps/guides/launch-a-b20-token

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

### Arbitrum Integration (added July 2026)
- Arbitrum One: chain 42161, RPC `https://arb1.arbitrum.io/rpc`, explorer `https://arbiscan.io`, DexScreener id `'arbitrum'`
- **Analytics/search** (DexScreener): `chat.js` (dexscreener_search/token), `_token-search.js`, `x402.js`, `app.html`
  - Multi-chain via set/label map, not chained ternaries:
    - `chat.js`: `SUPPORTED_CHAINS = new Set(['base','robinhood','arbitrum'])` + `CHAIN_LABELS`
    - `_token-search.js`: `SUPPORTED` set gates the `?chain=` query param
    - `x402.js`: `validPair()` allows base/robinhood/arbitrum
- **Onchain reads** (`chat.js` base_get_*/base_erc20_info tools): now chain-aware via a `chain` input param.
  - `CHAINS` config (base/arbitrum/robinhood: id, name, rpc, explorer, bridge) + `chainOf(input)` helper
  - `rpc(method, params, url)` takes an RPC url (defaults BASE_RPC); each tool resolves `chainOf(input)` and uses `c.rpc`/`c.name`/`c.id`
  - Tool schemas expose `chain: enum['base','arbitrum','robinhood']`; **write-actions (uniswap swap, B20 deploy) stay Base-only**
- **UI**: `app.html` has `#pgChainSel` dropdown (Base/Arbitrum/Robinhood), persisted in `localStorage['orlix-pg-chain']`, injected into the chat system prompt as the default chain for onchain tool calls
- Marketing copy updated: `index.html`, `dashboard.html` now say "Base · Robinhood · Arbitrum"
- To add another chain later: add to `SUPPORTED_CHAINS`/`CHAIN_LABELS`/`CHAINS` + `#pgChainSel` option
- NOTE: `/api/analyze` no longer exists (consolidated out under Vercel's 12-fn limit); the app's live multi-chain path is the AI chat's DexScreener + onchain tools. `token.html` stays Base-only.

### Cinematic Homepage (`/index.html`, added July 2026)
- Awwwards-style scroll film: preloader → hero → manifesto → horizontal "reel" → 3D depth descent → finale → film credits
- Stack: GSAP 3.12 + ScrollTrigger + Lenis (self-hosted in `assets/cinematic/vendor/`), Motion (vanilla Framer Motion sibling, dynamic import with hand-rolled spring fallback), raw WebGL fragment shader backdrop (`gl.js` — eclipse rim-light: black field, ember arc glows hugging corners + hairline diagonals, mouse light, scroll-driven grade ember→violet; NOT smoke/clouds, per owner request)
- Modules in `assets/cinematic/js/`: app.js (orchestrator), scenes.js (all ScrollTrigger scenes), gl.js, cursor.js, preloader.js, menu.js, tilt.js, magnetic.js, utils.js
- Terminal-agent theme: ALL type is JetBrains Mono (400/500/600, self-hosted latin subset in `assets/cinematic/fonts/`) — no display face. Boot-sequence preloader, shell-prompt hero with typewriter, terminal-window card chrome, scramble/decode text effects (utils.js), CRT scanlines
- Gotchas: ScrollTriggers below the reel pin must be created AFTER the pin (chapter indicator/progress are created last in scenes.js); don't combine CSS `translateY(%)` initial states with GSAP `yPercent` (px component gets baked in — set initial state via gsap.set instead)
- Old dashboard preserved: `dashboard.html`, routed at `/dashboard` via vercel.json
- Degrades gracefully: prefers-reduced-motion → static layout; missing vendor JS → plain readable page; noscript CSS unwinds pinned scenes

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
MIMO_API_KEY=          # Mimo (api.xiaomimimo.com) — primary chat engine
VENICE_API_KEY=        # Venice (api.venice.ai) — uncensored, open-source, no data retention

# Blockchain
BASESCAN_API_KEY=

# B20 Agent Deploy (custodial, Turnkey-signed) — /api/b20-skill?action=agent_deploy
TURNKEY_API_PUBLIC_KEY=   # P-256 API key public (from Turnkey dashboard)
TURNKEY_API_PRIVATE_KEY=  # P-256 API key private (shown once — save it)
TURNKEY_ORGANIZATION_ID=  # Turnkey org / sub-org id
TURNKEY_SIGN_WITH=        # signer wallet ETH address (fund with ETH on Base for gas)
B20_AGENT_ALLOWLIST=      # comma-separated agent keys allowed to deploy (fail-closed)
B20_AGENT_DAILY_LIMIT=    # optional, max deploys per rolling 24h (default 25) — gas-drain cap

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
- `session_01RKMQuccsPyPAroZDB3eV6g` — Built cinematic Awwwards-style homepage (new index.html + assets/cinematic/). Old dashboard moved to dashboard.html (/dashboard route added to vercel.json). Self-hosted GSAP/ScrollTrigger/Lenis/Motion + Syne/JetBrains Mono fonts. Branch: claude/orlix-cinematic-website-f8zbid.
- `session_01HPyQG1dNFKzZQeCRpX34pW` — Added Venice (api.venice.ai) as an uncensored LLM provider. New `venice-*` route in chat.js (OpenAI-compatible, streaming + non-streaming, `VENICE_API_KEY`) + "Venice Uncensored" (`venice-uncensored`) added to the PROVIDERS model dropdown in app.html. Router in chat.js now: mimo→xiaomimimo, venice→venice.ai, claude→bankr(Anthropic+MCP), else→bankr(OpenAI). Branch: claude/b20-mau-orlix-status-6ny1wr.
