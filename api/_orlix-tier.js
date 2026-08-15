// Shared $ORLIX holder tier check — JS port of x402/_shared/holder.ts
const ORLIX_CONTRACT = '0x1eFdD871f052900D88E4DC2D49BcD32Bf77e333c';
const ROBINHOOD_RPC       = 'https://rpc.mainnet.chain.robinhood.com/';

const TIERS = {
  NONE:    { discount: 0,   maxTokens: 2048, results: 5,   label: 'Standard',       minHold: '0' },
  BRONZE:  { discount: 30,  maxTokens: 4096, results: 10,  label: 'Bronze Holder',  minHold: '100,000' },
  SILVER:  { discount: 60,  maxTokens: 6144, results: 20,  label: 'Silver Holder',  minHold: '1,000,000' },
  GOLD:    { discount: 85,  maxTokens: 8192, results: 50,  label: 'Gold Holder',    minHold: '10,000,000' },
  DIAMOND: { discount: 100, maxTokens: 8192, results: 100, label: 'Diamond Holder', minHold: '100,000,000' },
};

const THRESHOLDS = [
  ['DIAMOND', 100_000_000n * 10n ** 18n],
  ['GOLD',     10_000_000n * 10n ** 18n],
  ['SILVER',    1_000_000n * 10n ** 18n],
  ['BRONZE',      100_000n * 10n ** 18n],
];

async function getOrlixTier(wallet) {
  const none = { tier: 'NONE', balance: '0', ...TIERS.NONE };
  if (!wallet || !/^0x[0-9a-f]{40}$/i.test(wallet)) return none;
  try {
    const data = '0x70a08231' + wallet.replace('0x', '').toLowerCase().padStart(64, '0');
    const r = await fetch(ROBINHOOD_RPC, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: ORLIX_CONTRACT, data }, 'latest'] }),
      signal:  AbortSignal.timeout(5000),
    });
    const d       = await r.json();
    const hex     = d.result || '0x0';
    const balance = hex === '0x' ? 0n : BigInt(hex);
    const balFmt  = (Number(balance / 10n ** 15n) / 1000).toLocaleString(undefined, { maximumFractionDigits: 0 });
    let tierKey = 'NONE';
    for (const [key, min] of THRESHOLDS) {
      if (balance >= min) { tierKey = key; break; }
    }
    return { tier: tierKey, balance: balFmt, ...TIERS[tierKey] };
  } catch {
    return none;
  }
}

function withTier(data, tier) {
  return {
    ...data,
    _orlix: {
      tier:     tier.tier,
      balance:  tier.balance + ' ORLIX',
      discount: tier.discount + '%',
      label:    tier.label,
      nextTier: tier.tier === 'DIAMOND' ? null : 'Hold more $ORLIX for bigger discounts — ca: ' + ORLIX_CONTRACT,
    },
  };
}

module.exports = { getOrlixTier, withTier };
