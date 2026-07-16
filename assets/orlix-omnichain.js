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
          // LayerZero OFTAdapter (lock/unlock escrow) that makes $ORLIX omnichain.
          adapter: '0xA42df44b48857a5fa157e743bEFB5EBE71d1e0Ca',
          explorer: 'https://basescan.org',
          get dexscreener() { return 'https://dexscreener.com/base/' + this.address; },
        },
        robinhood: {
          name: 'Robinhood Chain',
          chainId: 4663,
          live: true,
          // Bridged $ORLIX OFT on Robinhood Chain (deployed & wired via LayerZero).
          address: '0x57a8BD58F4a87eFe70bcC16F139c52320bD6d8cd',
          explorer: 'https://robinhoodchain.blockscout.com',
          // Live ORLIX/WETH pool (1% fee) on Robinhood — $ORLIX is tradable.
          pool: '0x762dFbEFccba79c142F08abD3718f4476C3559d7',
          dexscreener: 'https://dexscreener.com/robinhood/0x762dFbEFccba79c142F08abD3718f4476C3559d7',
        },
      },
    },

    // LayerZero OFT wiring (from the live deployment).
    layerzero: {
      protocol: 'LayerZero OFT V2',
      // No in-app bridge widget yet — bridging currently happens at the OFT
      // contract level. Set this once a one-click bridge UI exists.
      bridgeUrl: null,
      // Track cross-chain messages / bridge activity for the OFT.
      trackerUrl: 'https://layerzeroscan.com/address/0x57a8BD58F4a87eFe70bcC16F139c52320bD6d8cd',
      baseEid: 30184,
      robinhoodEid: 30416,
      dvns: ['LayerZero Labs', 'Nethermind'],
      confirmations: 20,
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
