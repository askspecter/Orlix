// /api/b20 — B20 token standard info + token list on Base
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// Mainnet activation delayed by Base — no fixed date yet
const BERYL_MAINNET_TS = null;

const KNOWN_B20 = [];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (req.method !== 'GET') { res.writeHead(405, CORS); return res.end(JSON.stringify({ error: 'Method not allowed' })); }

  const action = req.query.action || 'info';
  const now = Date.now();
  const mainnetLive = false; // Delayed by Base — Activation Registry not yet enabled on mainnet

  res.writeHead(200, CORS);

  if (action === 'info') {
    return res.end(JSON.stringify({
      standard: 'B20',
      network: 'Base',
      upgrade: 'Beryl',
      mainnetDate: null,
      mainnetLive,
      mainnetNote: 'B20 activates on Base mainnet at the scheduled Activation Registry time.',
      variants: [
        {
          name: 'Asset',
          description: 'General-purpose variant. Configurable decimals, issuer metadata, rebasing support.',
          useCases: ['onchain-native tokens', 'real-world assets', 'governance tokens'],
        },
        {
          name: 'Stablecoin',
          description: 'Focused variant for fiat-backed assets. Fixed 6 decimals, currency code field.',
          useCases: ['fiat-backed stablecoins', 'regulated assets'],
        },
      ],
      features: [
        'ERC-20 compatible — drop-in for wallets, DEXes, indexers',
        'ERC-2612 permits — approve without separate transaction',
        'Role-based access control — mint, burn, pause, metadata',
        'Supply cap — fixed at 1 billion (1B) per token',
        'Transfer policies — granular sender/receiver/executor control',
        'Freeze & seize — burn balance of blocked address',
        'Transfer memos — payment IDs and compliance tags',
      ],
      comingSoon: [
        'Pay gas in your own B20 token — no ETH required',
        'Virtual deposit addresses',
        'Indexed balances and history from Base Node RPC',
        '~50% cheaper transfers',
      ],
      docs: 'https://docs.base.org/base-chain/specs/upgrades/beryl/b20',
    }));
  }

  if (action === 'tokens') {
    return res.end(JSON.stringify({
      tokens: KNOWN_B20,
      total: KNOWN_B20.length,
      mainnetLive: false,
      message: 'B20 activates on Base mainnet at the scheduled Activation Registry time.',
      ts: now,
    }));
  }

  res.end(JSON.stringify({ error: 'Unknown action. Use ?action=info or ?action=tokens' }));
};
