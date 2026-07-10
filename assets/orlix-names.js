/*!
 * orlix-names.js — client-side .b20 name resolver (reverse + forward)
 * Reads the OrlixNames registry over a read-only Base RPC. No wallet needed.
 * Degrades to a no-op if ethers isn't present or the RPC is unreachable —
 * addresses simply stay as 0x… everywhere it's used.
 *
 *   OrlixNames.reverse(addr)  -> Promise<string>  "jesse.b20" or ""
 *   OrlixNames.label(addr)    -> string           cached name.b20 or ""
 *   OrlixNames.resolve(input) -> Promise<string|null>  name/0x -> checksummed 0x
 *   OrlixNames.hydrate(root)  -> swaps [data-orlix-name][data-addr] text to name.b20
 */
(function (global) {
  'use strict';

  var NAMES_CONTRACT = "0xC1B680156ab7C4a00F6341F1454ee033dfe34f0c"; // OrlixNames on Base
  var RPC = "https://mainnet.base.org";
  var ABI = [
    "function reverse(address account) view returns (string)",
    "function resolve(string sld) view returns (address)"
  ];

  var ADDR_OK = /^0x[0-9a-fA-F]{40}$/.test(NAMES_CONTRACT);
  var contract = null, _tried = false;

  // Lazily build the read-only contract on first use, so this file can load
  // before ethers finishes (defer order) without permanently disabling itself.
  function ensure() {
    if (contract) return contract;
    if (_tried) return null;
    if (!ADDR_OK || typeof global.ethers === 'undefined') { return null; }
    _tried = true;
    try {
      var ro = new global.ethers.JsonRpcProvider(RPC);
      contract = new global.ethers.Contract(NAMES_CONTRACT, ABI, ro);
    } catch (_) { contract = null; }
    return contract;
  }
  function live() { return !!ensure(); }

  var revCache = Object.create(null);   // lowerAddr -> "name.b20" | ""  (resolved values)
  var revInflight = Object.create(null); // lowerAddr -> Promise<string>

  function normAddr(a) {
    return (a && typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a)) ? a.toLowerCase() : null;
  }

  function reverse(addr) {
    var key = normAddr(addr);
    if (!key) return Promise.resolve("");
    if (key in revCache) return Promise.resolve(revCache[key]);
    if (revInflight[key]) return revInflight[key];
    var c = ensure();
    if (!c) { return Promise.resolve(""); }  // don't cache — ethers may load later
    revInflight[key] = c.reverse(key).then(function (label) {
      var name = label ? (label + ".b20") : "";
      revCache[key] = name;
      delete revInflight[key];
      return name;
    }).catch(function () {
      revCache[key] = "";
      delete revInflight[key];
      return "";
    });
    return revInflight[key];
  }

  // Synchronous accessor — only returns a name that's already been resolved.
  function label(addr) {
    var key = normAddr(addr);
    return (key && revCache[key]) ? revCache[key] : "";
  }

  // Forward: accept a 0x address OR a .b20 name and return a checksummed 0x.
  // Returns null when a name can't be resolved.
  function resolve(input) {
    var s = (input || "").trim();
    if (!s) return Promise.resolve(null);
    if (/^0x[0-9a-fA-F]{40}$/.test(s)) {
      try { return Promise.resolve(global.ethers.getAddress(s)); }
      catch (_) { return Promise.resolve(null); }
    }
    var sld = s.toLowerCase().replace(/\.b20$/, '');
    var c = ensure();
    if (!sld || !c) return Promise.resolve(null);
    return c.resolve(sld).then(function (a) {
      return (a && a !== '0x0000000000000000000000000000000000000000') ? a : null;
    }).catch(function () { return null; });
  }

  // Scan a container for elements tagged data-orlix-name with a data-addr,
  // reverse-resolve the unique addresses, and swap in name.b20 where found.
  function hydrate(root) {
    if (!live()) return;
    root = root || global.document;
    var nodes = root.querySelectorAll('[data-orlix-name][data-addr]');
    if (!nodes.length) return;
    var seen = Object.create(null);
    nodes.forEach(function (n) {
      var a = normAddr(n.getAttribute('data-addr'));
      if (a) seen[a] = 1;
    });
    Object.keys(seen).forEach(function (a) {
      reverse(a).then(function (name) {
        if (!name) return;
        root.querySelectorAll('[data-orlix-name][data-addr]').forEach(function (n) {
          if (normAddr(n.getAttribute('data-addr')) === a && n.getAttribute('data-orlix-done') !== '1') {
            n.textContent = name;
            n.setAttribute('data-orlix-done', '1');
            n.setAttribute('title', a);
            n.style.color = 'var(--orange, #F07830)';
          }
        });
      });
    });
  }

  global.OrlixNames = { reverse: reverse, label: label, resolve: resolve, hydrate: hydrate, live: live };
})(window);
