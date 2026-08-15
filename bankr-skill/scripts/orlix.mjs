#!/usr/bin/env node

import fs from "fs";
import os from "os";
import path from "path";

const ORLIX_API   = "https://orlixai.xyz/api";
const BANKR_API   = "https://api.bankr.bot";
const CHAIN_ID    = 8453;

// ─── helpers ────────────────────────────────────────────────────────────────

function die(msg) {
  console.error("ERROR:", msg);
  process.exit(1);
}

function findDeep(obj, predicate) {
  if (predicate(obj)) return obj;
  if (Array.isArray(obj)) {
    for (const v of obj) { const r = findDeep(v, predicate); if (r !== undefined) return r; }
  }
  if (obj && typeof obj === "object") {
    for (const v of Object.values(obj)) { const r = findDeep(v, predicate); if (r !== undefined) return r; }
  }
}

function loadBankrKey() {
  if (process.env.BANKR_API_KEY) return process.env.BANKR_API_KEY;
  const p = process.env.BANKR_CONFIG || path.join(os.homedir(), ".bankr", "config.json");
  if (!fs.existsSync(p)) die(`Bankr config not found at ${p}. Run: bankr login email YOUR_EMAIL`);
  const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
  const key = findDeep(cfg, x => typeof x === "string" && (x.startsWith("bk_") || x.startsWith("bankr_")));
  if (!key) die(`Could not find Bankr API key in ${p}`);
  return key;
}

async function orlixGet(action) {
  const res = await fetch(`${ORLIX_API}/b20-skill?action=${action}`);
  if (!res.ok) die(`Orlix API error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function orlixPost(body) {
  const res = await fetch(`${ORLIX_API}/b20-skill`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) die(`Orlix API error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function orlixAnalyze(address) {
  const res = await fetch(`${ORLIX_API}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, chain: "base" }),
  });
  if (!res.ok) die(`Orlix analyze error ${res.status}: ${await res.text()}`);
  return res.json();
}

const ALLOWED_BANKR_ENDPOINTS = new Set(["/wallet/me", "/wallet/submit"]);

async function bankr(method, endpoint, body) {
  if (!ALLOWED_BANKR_ENDPOINTS.has(endpoint)) die(`Blocked unexpected Bankr endpoint: ${endpoint}`);
  const url = new URL(endpoint, `${BANKR_API}/`);
  if (url.protocol !== "https:" || url.origin !== BANKR_API || url.pathname !== endpoint)
    die(`Blocked untrusted Bankr URL: ${url}`);
  const res = await fetch(url, {
    method,
    headers: { "X-API-Key": loadBankrKey(), "Content-Type": "application/json", Accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) die(`Bankr API error ${res.status}: ${JSON.stringify(data).slice(0, 800)}`);
  return data;
}

async function bankrWallet() {
  const me = await bankr("GET", "/wallet/me");
  const addr = findDeep(me, x => typeof x === "string" && /^0x[0-9a-fA-F]{40}$/.test(x));
  if (!addr) die(`Could not find EVM wallet in /wallet/me: ${JSON.stringify(me).slice(0, 400)}`);
  return addr;
}

function printSep() { console.log("─".repeat(50)); }

// ─── commands ────────────────────────────────────────────────────────────────

async function cmdInfo() {
  const data = await orlixGet("info");
  printSep();
  console.log("Orlix B20 — Base Chain Info");
  printSep();
  if (data.chain) {
    console.log(`network:      ${data.chain.network}`);
    console.log(`chainId:      ${data.chain.chainId}`);
    console.log(`block:        ${data.chain.blockNumber}`);
    console.log(`base fee:     ${data.chain.baseFeeGwei} gwei`);
  }
  if (data.b20) {
    console.log(`factory:      ${data.b20.factory}`);
    console.log(`standard:     ${data.b20.standard}`);
    console.log(`status:       ${data.b20.status}`);
  }
  if (data.gas?.summary) {
    const g = data.gas.summary;
    console.log(`max fee:      ${g.maxFeePerGas}`);
    console.log(`priority fee: ${g.maxPriorityFeePerGas}`);
    console.log(`deploy cost:  ${g.estimatedDeployCost}`);
  }
  printSep();
}

async function cmdGas() {
  const data = await orlixGet("gas");
  printSep();
  console.log("Orlix B20 — Base Gas Prices");
  printSep();
  if (data.gas) {
    const g = data.gas;
    console.log(`base fee:     ${g.baseFeeGwei} gwei`);
    console.log(`max fee:      ${g.maxFeeGwei} gwei`);
    console.log(`tip (p50):    ${g.tipP50Gwei} gwei`);
    console.log(`tip (p75):    ${g.tipP75Gwei} gwei`);
    console.log(`deploy cost:  ${g.estimatedDeployCostEth} ETH`);
  }
  printSep();
}

async function cmdBalance(args) {
  if (!args[0]) die("usage: balance <0xADDRESS> [0xTOKEN]");
  const body = { action: "balance", address: args[0] };
  if (args[1]) body.token = args[1];
  const data = await orlixPost(body);
  printSep();
  console.log(`Orlix B20 — Balance for ${args[0]}`);
  printSep();
  if (data.eth) {
    console.log(`ETH balance:  ${data.eth.ether} ETH`);
    console.log(`              (${data.eth.wei} wei)`);
  }
  if (data.token) {
    console.log(`token balance: ${data.token.formatted} ${data.token.symbol}`);
  }
  printSep();
}

async function cmdTokenInfo(args) {
  if (!args[0]) die("usage: token-info <0xTOKEN> [0xHOLDER]");
  const body = { action: "token_info", address: args[0] };
  if (args[1]) body.holder = args[1];
  const data = await orlixPost(body);
  printSep();
  console.log(`Orlix B20 — Token Info: ${args[0]}`);
  printSep();
  if (data.token) {
    console.log(`name:         ${data.token.name}`);
    console.log(`symbol:       ${data.token.symbol}`);
    console.log(`decimals:     ${data.token.decimals}`);
    console.log(`total supply: ${data.token.totalSupply}`);
  }
  if (data.holder) {
    console.log(`holder bal:   ${data.holder.formatted} ${data.token?.symbol || ""}`);
  }
  printSep();
}

async function cmdValidate(args) {
  // parse: name symbol [--variant asset|stablecoin] [--decimals N] [--admin 0x...] [--blocklist] [--allowlist] [--freeze]
  const params = parseTokenArgs(args);
  const data = await orlixPost({ action: "validate", ...params });
  printSep();
  console.log("Orlix B20 — Validate Config");
  printSep();
  if (data.validation) {
    console.log(`valid:        ${data.validation.valid}`);
    if (data.validation.errors?.length) {
      console.log("errors:");
      for (const e of data.validation.errors) console.log(`  · ${e}`);
    }
  }
  if (data.chainCheck) {
    const c = data.chainCheck;
    console.log(`admin balance: ${c.adminEther} ETH`);
    console.log(`deploy cost:   ${c.deployEstimateEth} ETH`);
    console.log(`can afford:    ${c.canAffordDeploy}`);
  }
  printSep();
}

async function cmdPrepare(args) {
  const params = parseTokenArgs(args);
  const dry = args.includes("--dry-run");
  const submit = args.includes("--submit");

  const data = await orlixPost({ action: "prepare", ...params });
  printSep();
  console.log("Orlix B20 — Prepare Deployment Tx");
  printSep();

  if (!data.ok) die(data.error || "prepare failed");

  const c = data.chain;
  const tx = data.deployment?.tx;
  const summary = data.txSummary;

  console.log(`name:         ${data.config?.name}`);
  console.log(`symbol:       ${data.config?.symbol}`);
  console.log(`variant:      ${data.config?.variant}`);
  console.log(`decimals:     ${data.config?.decimals}`);
  console.log(`supply cap:   ${data.config?.supply_cap}`);
  console.log("");
  console.log(`network:      ${c?.network} (chainId ${c?.chainId})`);
  console.log(`block:        ${c?.blockNumber}`);
  console.log(`admin ETH:    ${c?.adminBalance?.ether} ETH`);
  console.log("");
  if (summary) {
    console.log(`max fee:      ${summary.maxFeePerGas}`);
    console.log(`priority fee: ${summary.maxPriorityFee}`);
    console.log(`est. cost:    ${summary.estimatedCost}`);
    console.log(`nonce:        ${summary.nonce}`);
  }
  console.log("");
  console.log(`factory:      ${data.deployment?.factory}`);
  printSep();

  if (dry || !submit) {
    console.log("");
    console.log("Unsigned EIP-1559 tx (sign and broadcast when B20 activates):");
    console.log(JSON.stringify(tx, null, 2));
    return;
  }

  // Submit via Bankr wallet
  const wallet = await bankrWallet();
  console.log(`submitting via Bankr wallet: ${wallet}`);
  console.log("NOTE: B20 deploy will only succeed after Base Beryl activates.");

  const result = await bankr("POST", "/wallet/submit", {
    transaction: {
      to: tx.to,
      chainId: CHAIN_ID,
      value: "0",
      data: tx.data,
    },
    description: `Deploy B20 token ${data.config?.symbol} via Orlix`,
    waitForConfirmation: true,
  });

  const hash = result.transactionHash || result.txHash || result.hash;
  if (!hash) die(`No tx hash: ${JSON.stringify(result).slice(0, 400)}`);
  console.log(`tx: https://basescan.org/tx/${hash}`);
  console.log(`status: ${result.status || "unknown"}`);
  printSep();
}

async function cmdReceipt(args) {
  if (!args[0]) die("usage: receipt <0xTX_HASH> [mainnet|sepolia]");
  const data = await orlixPost({ action: "receipt", tx_hash: args[0], network: args[1] || "mainnet" });
  printSep();
  console.log(`Orlix B20 — Receipt: ${args[0]}`);
  printSep();
  if (data.receipt) {
    const r = data.receipt;
    console.log(`status:        ${r.status}`);
    console.log(`block:         ${r.blockNumber}`);
    console.log(`gas used:      ${r.gasUsed}`);
    if (r.tokenAddress) console.log(`token address: ${r.tokenAddress}`);
  }
  printSep();
}

async function cmdAnalyze(args) {
  if (!args[0]) die("usage: analyze <0xTOKEN_ADDRESS>");
  console.log(`Analyzing ${args[0]} on Base...`);
  const data = await orlixAnalyze(args[0]);
  printSep();
  console.log(`Orlix Token Analyzer: ${args[0]}`);
  printSep();
  if (data.verdict)   console.log(`verdict:      ${data.verdict}`);
  if (data.price)     console.log(`price:        ${data.price}`);
  if (data.marketCap) console.log(`market cap:   ${data.marketCap}`);
  if (data.liquidity) console.log(`liquidity:    ${data.liquidity}`);
  if (data.fdv)       console.log(`FDV:          ${data.fdv}`);
  if (data.priceChange) {
    console.log(`1h change:    ${data.priceChange.h1}`);
    console.log(`24h change:   ${data.priceChange.h24}`);
  }
  if (data.liquidityRatio) console.log(`liq/mcap:     ${data.liquidityRatio}`);
  if (data.aiAnalysis) {
    console.log("");
    console.log("AI analysis:");
    console.log(data.aiAnalysis);
  }
  printSep();
}

// ─── arg parser ──────────────────────────────────────────────────────────────

function parseTokenArgs(args) {
  const params = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--name")      { params.name = args[++i]; }
    else if (a === "--symbol")   { params.symbol = args[++i]; }
    else if (a === "--variant")  { params.variant = args[++i]; }
    else if (a === "--decimals") { params.decimals = parseInt(args[++i]); }
    else if (a === "--supply")   { params.supply_cap = args[++i]; }
    else if (a === "--admin")    { params.admin = args[++i]; }
    else if (a === "--network")  { params.network = args[++i]; }
    else if (a === "--uri")      { params.contract_uri = args[++i]; }
    else if (a === "--allowlist")  { (params.policies = params.policies || {}).allowlist = true; }
    else if (a === "--blocklist")  { (params.policies = params.policies || {}).blocklist = true; }
    else if (a === "--freeze")     { (params.policies = params.policies || {}).freeze = true; }
    else if (a === "--adminless")  { params.adminless = true; }
  }
  return params;
}

// ─── main ────────────────────────────────────────────────────────────────────

const cmd  = process.argv[2];
const args = process.argv.slice(3);

const HELP = `
Orlix AI skill — Personal AI OS on Base

Commands:
  info                       Live Base chain status + gas prices
  gas                        EIP-1559 gas breakdown
  balance <addr> [token]     ETH + optional ERC-20 balance
  token-info <addr> [holder] Read any ERC-20 on Base
  validate  [--name ..] ..   Validate B20 config (live balance check)
  prepare   [--name ..] ..   Build deployment tx (real gas + nonce)
    --submit                 Sign + broadcast via Bankr wallet
    --dry-run                Print unsigned tx without broadcasting
  receipt <hash> [network]   Check tx status + deployed token address
  analyze <addr>             AI token risk analysis on Base

B20 token flags (for validate / prepare):
  --name <str>        Token name (max 64 chars)
  --symbol <str>      Token symbol (max 11 chars)
  --variant <str>     asset | stablecoin  (default: asset)
  --decimals <n>      6–18 (default: 18; fixed at 6 for stablecoin)
  --supply <n>        Supply cap (0 = uncapped)
  --admin <0x...>     Admin wallet address
  --network <str>     mainnet | sepolia  (default: mainnet)
  --allowlist         Enable allowlist policy
  --blocklist         Enable blocklist policy
  --freeze            Enable freeze policy
  --adminless         No admin — irreversible

Examples:
  node orlix.mjs info
  node orlix.mjs gas
  node orlix.mjs balance 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045
  node orlix.mjs token-info 0x1eFdD871f052900D88E4DC2D49BcD32Bf77e333c
  node orlix.mjs analyze 0x1eFdD871f052900D88E4DC2D49BcD32Bf77e333c
  node orlix.mjs validate --name "My Token" --symbol MTK --admin 0xYOUR_WALLET
  node orlix.mjs prepare --name "My Token" --symbol MTK --decimals 18 --supply 10000000 --admin 0xYOUR_WALLET --blocklist
  node orlix.mjs prepare --name "OrUSD" --symbol OUSD --variant stablecoin --supply 100000000 --admin 0xYOUR_WALLET --allowlist --submit
  node orlix.mjs receipt 0xTX_HASH
`.trim();

try {
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(HELP);
  } else if (cmd === "info")         { await cmdInfo(); }
  else if (cmd === "gas")            { await cmdGas(); }
  else if (cmd === "balance")        { await cmdBalance(args); }
  else if (cmd === "token-info")     { await cmdTokenInfo(args); }
  else if (cmd === "validate")       { await cmdValidate(args); }
  else if (cmd === "prepare")        { await cmdPrepare(args); }
  else if (cmd === "receipt")        { await cmdReceipt(args); }
  else if (cmd === "analyze")        { await cmdAnalyze(args); }
  else { die(`Unknown command: ${cmd}\nRun: node orlix.mjs help`); }
} catch (e) {
  die(e?.message || String(e));
}
