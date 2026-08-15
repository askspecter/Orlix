// Orlix X402 — Wallet Analyzer
// ETH balance, ORLIX holdings, recent txns on Base. Holders get AI portfolio summary.

import { getOrlixTier, withTier } from '../_shared/holder';

const ROBINHOOD_RPC       = 'https://rpc.mainnet.chain.robinhood.com/';
const ORLIX_CONTRACT = '0x1eFdD871f052900D88E4DC2D49BcD32Bf77e333c';

async function rpc(method: string, params: unknown[] = []) {
  const r = await fetch(ROBINHOOD_RPC, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal:  AbortSignal.timeout(8000),
  });
  const d: any = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d.result;
}

async function getErc20Balance(token: string, wallet: string): Promise<string> {
  const data = '0x70a08231' + wallet.replace('0x', '').toLowerCase().padStart(64, '0');
  const hex  = await rpc('eth_call', [{ to: token, data }, 'latest']);
  return hex && hex !== '0x' ? BigInt(hex).toString() : '0';
}

async function getRecentTxns(wallet: string, limit: number) {
  // Use DexScreener to find recent token swaps involving this wallet
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${wallet}`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return [];
    const d: any = await r.json();
    return (d.pairs || []).slice(0, limit).map((p: any) => ({
      pair:    `${p.baseToken?.symbol}/${p.quoteToken?.symbol}`,
      dex:     p.dexId,
      price:   p.priceUsd,
      volume1h:p.volume?.h1 || 0,
    }));
  } catch { return []; }
}

export default async function handler(req: Request) {
  const url    = new URL(req.url);
  const target = (url.searchParams.get('address') || url.searchParams.get('wallet') || '').trim().toLowerCase();
  const caller = url.searchParams.get('caller') || target; // caller wallet for tier check

  if (!target || !/^0x[0-9a-f]{40}$/i.test(target)) {
    return new Response(JSON.stringify({
      error:   'address required',
      usage:   'GET /wallet?address=0xWallet&caller=0xYourWallet',
      example: '/wallet?address=0xd4d2a64d506c98b118c039d9c3eaf5442bf3e1b8&caller=0xYourWallet',
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const tier = await getOrlixTier(caller);

  const [ethHex, orlixRaw, chainIdHex, blockHex, gasPriceHex] = await Promise.all([
    rpc('eth_getBalance',  [target, 'latest']),
    getErc20Balance(ORLIX_CONTRACT, target),
    rpc('eth_chainId',    []),
    rpc('eth_blockNumber',[]),
    rpc('eth_gasPrice',   []),
  ]);

  const ethWei      = BigInt(ethHex || '0x0');
  const ethBalance  = (Number(ethWei) / 1e18).toFixed(6);
  const orlixWei    = BigInt(orlixRaw || '0');
  const orlixBalance= (Number(orlixWei) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 0 });
  const chainId     = parseInt(chainIdHex, 16);
  const blockNum    = parseInt(blockHex, 16);
  const gasPriceGwei= (parseInt(gasPriceHex, 16) / 1e9).toFixed(4);

  // Tier check for the wallet being analyzed
  const walletTier  = await getOrlixTier(target);

  // Holders get recent activity (DexScreener token swaps)
  const txLimit    = tier.results;
  const recentSwaps= tier.tier !== 'NONE' ? await getRecentTxns(target, Math.min(txLimit, 10)) : [];

  // Holders with LLM key get AI portfolio summary
  let aiSummary = '';
  const llmKey  = process.env.ORLIX_LLM_KEY || process.env.BANKR_LLM_KEY || '';
  if (tier.tier !== 'NONE' && llmKey) {
    const prompt = `Wallet ${target} on Base: ${ethBalance} ETH, ${orlixBalance} ORLIX. Holder tier: ${walletTier.label}. Block: ${blockNum}. Gas: ${gasPriceGwei} gwei. Write a 2-sentence wallet profile. Be specific. No emojis.`;
    const r      = await fetch('https://llm.bankr.bot/v1/messages', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': llmKey, 'anthropic-version': '2023-06-01' },
      body:    JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 200, system: 'You are a blockchain analyst.', messages: [{ role: 'user', content: prompt }] }),
      signal:  AbortSignal.timeout(10000),
    });
    const d: any = await r.json();
    aiSummary    = d.content?.[0]?.text || '';
  }

  return withTier({
    address: target,
    network: { name: 'Base Mainnet', chainId, latestBlock: blockNum, gasPriceGwei },
    balances: {
      eth:   { raw: ethWei.toString(), formatted: ethBalance + ' ETH' },
      orlix: { raw: orlixWei.toString(), formatted: orlixBalance + ' ORLIX', tier: walletTier.label },
    },
    recentSwaps: recentSwaps.length ? recentSwaps : (tier.tier === 'NONE' ? 'Hold $ORLIX to unlock recent activity' : []),
    aiSummary:   aiSummary || (tier.tier === 'NONE' ? 'Hold $ORLIX to unlock AI wallet analysis' : ''),
    basescan:   `https://basescan.org/address/${target}`,
    timestamp:  new Date().toISOString(),
    poweredBy:  'Orlix AI — orlixai.xyz',
  }, tier);
}
