/* ORLIX connect-wallet — Reown AppKit (WalletConnect), vanilla JS
 * -----------------------------------------------------------------------------
 * Real AppKit modal (wallet grid + "What is a Wallet?" + WalletConnect QR),
 * loaded from ESM CDN, themed to the ORLIX green terminal look.
 *
 *  >>> ONE-TIME SETUP <<<
 *  1. Create a FREE project at https://dashboard.reown.com  (takes ~1 min)
 *  2. Paste its Project ID into PROJECT_ID below.
 *  3. In the Reown dashboard, add your domains (orlixai.xyz, app.orlixai.xyz).
 *  Until PROJECT_ID is set, connect buttons fall back to a plain injected
 *  (MetaMask / browser wallet) connect so the site keeps working.
 *
 *  Public API (unchanged, used by every page):
 *    ORLIX_WALLET.connect(addr => { ... })   // callback gets the account
 *    ORLIX_WALLET.open() / ORLIX_WALLET.close()
 * -----------------------------------------------------------------------------
 */
(function () {
  "use strict";

  // ── paste your Reown project id here ─────────────────────────────────────────
  var PROJECT_ID = window.ORLIX_REOWN_PROJECT_ID || "aad6e7468a8d723a2539e4d34ffb0897";
  // ─────────────────────────────────────────────────────────────────────────────

  var APPKIT = "https://esm.sh/@reown/appkit@^1.7.0";
  var ADAPTER = "https://esm.sh/@reown/appkit-adapter-ethers@^1.7.0";

  var CHAIN_HEX = "0x1237"; // 4663
  var CHAIN_PARAMS = {
    chainId: CHAIN_HEX, chainName: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://rpc.mainnet.chain.robinhood.com/"],
    blockExplorerUrls: ["https://robinhoodchain.blockscout.com"]
  };
  // AppKit / viem-style network object
  var NET = {
    id: 4663, name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com/"] } },
    blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } }
  };

  var kitP = null, kit = null;
  var curProvider = null, curAddr = null;
  var pending = false, pendingCb = null, fired = false;

  function loadKit() {
    if (kitP) return kitP;
    kitP = (async function () {
      var core = await import(APPKIT);
      var ad = await import(ADAPTER);
      var createAppKit = core.createAppKit || (core.default && core.default.createAppKit);
      var EthersAdapter = ad.EthersAdapter || (ad.default && ad.default.EthersAdapter);
      kit = createAppKit({
        adapters: [new EthersAdapter()],
        networks: [NET],
        defaultNetwork: NET,
        projectId: PROJECT_ID,
        metadata: {
          name: "ORLIX",
          description: "AI + NFT terminal on Robinhood Chain",
          url: location.origin,
          icons: [location.origin + "/assets/nft/orlix-mark.png"]
        },
        features: { analytics: false, email: false, socials: [] },
        themeMode: "dark",
        themeVariables: {
          "--w3m-accent": "#CFF605",
          "--w3m-color-mix": "#0b0d09",
          "--w3m-color-mix-strength": 24,
          "--w3m-font-family": "'JetBrains Mono', ui-monospace, monospace",
          "--w3m-border-radius-master": "2px"
        }
      });
      // keep window.ethereum pointed at the active connection so page tx code works
      kit.subscribeProviders(function (s) {
        var p = s && (s.eip155 || s["eip155"]);
        if (p) { curProvider = p; try { window.ethereum = p; } catch (_) {} }
      });
      kit.subscribeAccount(function (s) {
        if (s && s.isConnected && s.address) { curAddr = s.address; maybeFire(); }
        else { curAddr = null; fired = false; }
      });
      return kit;
    })();
    return kitP;
  }

  function maybeFire() {
    if (pending && curAddr && !fired) {
      fired = true; pending = false;
      var cb = pendingCb; pendingCb = null;
      if (curProvider) { try { window.ethereum = curProvider; } catch (_) {} }
      if (cb) cb(curAddr);
    }
  }

  // fallback: plain injected connect (used until PROJECT_ID is set, or if the CDN fails)
  async function injectedConnect(cb) {
    var eth = window.ethereum;
    if (!eth) { try { alert("No wallet found — open in a wallet browser"); } catch (_) {} return; }
    try {
      var a = await eth.request({ method: "eth_requestAccounts" });
      if (!a || !a.length) return;
      try { await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] }); }
      catch (sw) { if (sw && sw.code === 4902) { try { await eth.request({ method: "wallet_addEthereumChain", params: [CHAIN_PARAMS] }); } catch (_) {} } }
      if (cb) cb(a[0]);
    } catch (_) {}
  }

  window.ORLIX_WALLET = {
    connect: async function (onAccount) {
      if (!PROJECT_ID) return injectedConnect(onAccount);
      pendingCb = onAccount || null; pending = true; fired = false;
      try {
        var k = await loadKit();
        if (curAddr) { maybeFire(); return; } // already connected from a previous session
        k.open();
      } catch (e) {
        console.warn("[ORLIX_WALLET] AppKit failed to load, using injected fallback:", e);
        pending = false; injectedConnect(onAccount);
      }
    },
    open: async function () {
      if (!PROJECT_ID) return injectedConnect(null);
      try { (await loadKit()).open(); } catch (e) { injectedConnect(null); }
    },
    close: async function () { try { (await loadKit()).close(); } catch (_) {} }
  };
})();
