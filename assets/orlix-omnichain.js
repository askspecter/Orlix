/* Orlix Omnichain — single source of truth for $ORLIX across chains.
 *
 * $ORLIX is going omnichain via LayerZero OFT (Base ↔ Robinhood Chain).
 * When the Bankr agent finishes deploy + wire + bridge, plug the new Robinhood
 * Chain contract address into robinhood.address below and redeploy — every
 * page that reads this config (bridge hub, badges, analytics) flips to LIVE
 * automatically. That is the ONLY edit needed to go live.
 */
(function () {
  var CFG = {
    token: {
      symbol: 'ORLIX',
      name: 'Orlix',
      chains: {
        base: {
          name: 'Base',
          chainId: 8453,
          live: true,
          // Canonical $ORLIX on Base (matches app.html / x402.js / _orlix-tier.js).
          address: '0x799c28BAC95B3E0B26534D1e9A586511895EcBA3',
          explorer: 'https://basescan.org',
          get dexscreener() { return 'https://dexscreener.com/base/' + this.address; },
        },
        robinhood: {
          name: 'Robinhood Chain',
          chainId: 4663,
          live: false,
          // ► PLUG THE BRIDGED OFT CONTRACT ADDRESS HERE (then set live:true). ◄
          address: null,
          explorer: 'https://robinhoodchain.blockscout.com',
          // Set to a real pool URL once liquidity exists on Robinhood.
          dexscreener: null,
        },
      },
    },

    // LayerZero OFT wiring — fill from the Bankr deploy output when available.
    layerzero: {
      protocol: 'LayerZero OFT V2',
      // Where users go to bridge $ORLIX between chains. Update to the specific
      // OFT bridge UI (or leave as LayerZeroScan) once the route is known.
      bridgeUrl: 'https://layerzeroscan.com',
      baseEid: null,
      robinhoodEid: null,
    },

    // True once $ORLIX has a real deployment on the destination chain.
    isLive: function () {
      var r = this.token.chains.robinhood;
      return !!(r.address && r.live);
    },
  };

  if (typeof window !== 'undefined') window.OrlixOmnichain = CFG;
  if (typeof module !== 'undefined' && module.exports) module.exports = CFG;
})();
