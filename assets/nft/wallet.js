/* ORLIX shared connect-wallet modal
 * - horizontal wallet tiles (MetaMask / Rainbow / Coinbase / Browser Wallet / Trust …)
 * - EIP-6963 discovery (installed wallets show their real icon + connect directly)
 * - mobile deep-links when a wallet isn't installed
 * - "What is a Wallet?" info, EN / ID by device language
 * Usage: ORLIX_WALLET.connect(addr => { ... })  // callback gets the account
 */
(function(){
  "use strict";
  var CHAIN={chainIdHex:"0x1237",params:{chainId:"0x1237",chainName:"Robinhood Chain",nativeCurrency:{name:"Ether",symbol:"ETH",decimals:18},rpcUrls:["https://rpc.mainnet.chain.robinhood.com/"],blockExplorerUrls:["https://robinhoodchain.blockscout.com"]}};
  var ID=(navigator.language||"en").toLowerCase().indexOf("id")===0;
  var T=ID?{
    title:"Hubungkan Dompet",whatH:"Apa itu Dompet?",
    whatP:"Sebuah dompet digunakan untuk mengirim, menerima, menyimpan, dan menampilkan aset digital. Ini juga cara baru untuk masuk, tanpa perlu membuat akun dan kata sandi baru di setiap situs web.",
    get:"Dapatkan Dompet",learn:"Pelajari lebih lanjut",sign:"kami hanya pernah meminta anda menandatangani"
  }:{
    title:"Connect wallet",whatH:"What is a Wallet?",
    whatP:"A wallet is used to send, receive, store, and display digital assets. It's also a new way to log in, without needing to create new accounts and passwords on every website.",
    get:"Get a Wallet",learn:"Learn more",sign:"we only ever ask you to sign"
  };
  var isMobile=/android|iphone|ipad|ipod/i.test(navigator.userAgent);

  /* ---- brand icons (inline SVG so they always render, no external fetch) ---- */
  var IC_MM="<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 84 84'><rect width='84' height='84' rx='22' fill='#fff'/><polygon points='17,17 35,28 29,13' fill='#E2761B'/><polygon points='67,17 49,28 55,13' fill='#E2761B'/><polygon points='42,16 64,27 57,50 42,59 27,50 20,27' fill='#F6851B'/><polygon points='42,16 42,59 27,50 20,27' fill='#E4761B'/><polygon points='32,46 42,56 52,46' fill='#fff'/><circle cx='34' cy='38' r='3.1' fill='#3b2410'/><circle cx='50' cy='38' r='3.1' fill='#3b2410'/></svg>";
  var IC_RB="<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 84 84'><rect width='84' height='84' rx='22' fill='#001E59'/><g fill='none' stroke-linecap='round'><path d='M16 63 A47 47 0 0 1 63 16' stroke='#FF4000' stroke-width='8'/><path d='M16 63 A37 37 0 0 1 53 26' stroke='#FF9901' stroke-width='8'/><path d='M16 63 A27 27 0 0 1 43 36' stroke='#FFF700' stroke-width='8'/><path d='M16 63 A17 17 0 0 1 33 46' stroke='#01DA7A' stroke-width='8'/></g><circle cx='16' cy='63' r='6' fill='#174299'/></svg>";
  var IC_CB="<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 84 84'><rect width='84' height='84' rx='22' fill='#0052FF'/><circle cx='42' cy='42' r='19' fill='#fff'/><rect x='34' y='34' width='16' height='16' rx='4' fill='#0052FF'/></svg>";
  var IC_BW="<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 84 84'><rect width='84' height='84' rx='22' fill='#0B0D09'/><rect x='17' y='26' width='50' height='34' rx='8' fill='none' stroke='#CFF605' stroke-width='3.5'/><rect x='44' y='36' width='27' height='14' rx='5' fill='#0B0D09' stroke='#CFF605' stroke-width='3.5'/><circle cx='55' cy='43' r='2.6' fill='#CFF605'/></svg>";
  var IC_TW="<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 84 84'><rect width='84' height='84' rx='22' fill='#3375BB'/><path d='M42 16 L64 25 V43 C64 55 54 62 42 67 C30 62 20 55 20 43 V25 Z' fill='#fff'/><path d='M42 24 L57 31 V43 C57 51 50 56 42 60 C34 56 27 51 27 43 V31 Z' fill='#3375BB'/></svg>";

  function known(){
    var host=location.host, path=location.pathname+location.search, url=location.href, e=encodeURIComponent;
    return [
      {key:"metamask",name:"MetaMask",icon:IC_MM,rdns:"io.metamask",match:/metamask/i,deeplink:"https://metamask.app.link/dapp/"+host+path,get:"https://metamask.io/download/"},
      {key:"rainbow",name:"Rainbow",icon:IC_RB,rdns:"me.rainbow",match:/rainbow/i,deeplink:"https://rnbwapp.com/dapp?url="+e(url),get:"https://rainbow.me/"},
      {key:"coinbase",name:"Coinbase",icon:IC_CB,rdns:"com.coinbase.wallet",match:/coinbase/i,deeplink:"https://go.cb-w.com/dapp?cb_url="+e(url),get:"https://www.coinbase.com/wallet/downloads"},
      {key:"browser",name:"Browser Wallet",icon:IC_BW,rdns:"",match:null,deeplink:"",get:"https://ethereum.org/wallets/find-wallet/"},
      {key:"trust",name:"Trust",icon:IC_TW,rdns:"com.trustwallet.app",match:/trust/i,deeplink:"https://link.trustwallet.com/open_url?url="+e(url),get:"https://trustwallet.com/download"}
    ];
  }

  // EIP-6963 discovery
  var found=[]; var seen={};
  function onAnnounce(e){var d=e.detail;if(!d||!d.info)return;var k=d.info.uuid||d.info.rdns||d.info.name;if(seen[k])return;seen[k]=1;found.push(d);renderList();}
  window.addEventListener("eip6963:announceProvider",onAnnounce);
  try{window.dispatchEvent(new Event("eip6963:requestProvider"));}catch(_){}

  var css="#ow-ov{position:fixed;inset:0;z-index:9999;background:rgba(3,4,3,.74);backdrop-filter:blur(6px);display:none;align-items:center;justify-content:center;padding:16px;font-family:'JetBrains Mono',monospace}"
    +"#ow-ov.on{display:flex}"
    +"#ow-m{width:100%;max-width:440px;background:#0b0d09;border:1px solid rgba(207,246,5,.18);border-radius:22px;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.6);color:#E9ECE2}"
    +"#ow-h{position:relative;padding:20px 20px 18px;text-align:center;border-bottom:1px solid rgba(255,255,255,.06)}"
    +"#ow-h b{font-size:1.14rem;font-weight:600;letter-spacing:.01em}"
    +"#ow-x{position:absolute;right:14px;top:14px;width:32px;height:32px;background:rgba(255,255,255,.05);border:none;border-radius:9px;color:#8b917f;font-size:1.3rem;cursor:pointer;line-height:1}"
    +"#ow-x:hover{color:#E9ECE2;background:rgba(255,255,255,.09)}"
    +"#ow-tiles{display:flex;gap:16px;overflow-x:auto;padding:22px 20px;-webkit-overflow-scrolling:touch;scrollbar-width:none}"
    +"#ow-tiles::-webkit-scrollbar{display:none}"
    +".ow-tile{flex:0 0 auto;width:84px;background:none;border:none;padding:0;cursor:pointer;color:#E9ECE2;font-family:inherit;text-align:center}"
    +".ow-ti{display:block;width:82px;height:82px;border-radius:22px;overflow:hidden;background:#12140d;margin:0 auto 11px;transition:box-shadow .16s,transform .16s}"
    +".ow-ti img{width:100%;height:100%;object-fit:cover;display:block}"
    +".ow-tile:hover .ow-ti{box-shadow:0 0 0 2px rgba(207,246,5,.55);transform:translateY(-2px)}"
    +".ow-tn{display:block;font-size:.82rem;line-height:1.22;color:#cdd2c4}"
    +".ow-what{padding:24px 26px 8px;border-top:1px solid rgba(255,255,255,.06);text-align:center}"
    +".ow-what h4{font-size:1.05rem;font-weight:600;margin:0 0 12px}"
    +".ow-what p{font-size:.82rem;line-height:1.62;color:#8b917f;margin:0}"
    +".ow-btns{display:flex;gap:12px;margin-top:18px}"
    +".ow-btns a{flex:1;text-align:center;font-size:.82rem;font-weight:600;letter-spacing:.02em;color:#CFF605;border:1px solid rgba(207,246,5,.4);border-radius:11px;padding:13px 8px;text-decoration:none;line-height:1.3}"
    +".ow-btns a:hover{background:rgba(207,246,5,.08)}"
    +"#ow-f{padding:15px 22px;border-top:1px solid rgba(255,255,255,.06);font-size:.66rem;color:#5a5f50;display:flex;align-items:center;gap:9px}"
    +"#ow-f .d{width:7px;height:7px;border-radius:50%;background:#CFF605;box-shadow:0 0 8px #CFF605;flex:none}"
    +"#ow-f b{color:#8b917f;font-weight:500}";

  var ov,tilesEl,cb=null,busy=false,currentTiles=[];
  function build(){
    var s=document.createElement("style");s.textContent=css;document.head.appendChild(s);
    ov=document.createElement("div");ov.id="ow-ov";
    ov.innerHTML='<div id="ow-m" role="dialog" aria-modal="true">'
      +'<div id="ow-h"><b>'+T.title+'</b><button id="ow-x" aria-label="Close">×</button></div>'
      +'<div id="ow-tiles"></div>'
      +'<div class="ow-what"><h4>'+T.whatH+'</h4><p>'+T.whatP+'</p>'
      +'<div class="ow-btns"><a href="https://ethereum.org/wallets/find-wallet/" target="_blank" rel="noopener">'+T.get+'</a>'
      +'<a href="https://ethereum.org/wallets/" target="_blank" rel="noopener">'+T.learn+'</a></div></div>'
      +'<div id="ow-f"><span class="d"></span>orlixai.xyz <b>/ '+T.sign+'</b></div></div>';
    document.body.appendChild(ov);
    tilesEl=ov.querySelector("#ow-tiles");
    ov.addEventListener("click",function(e){if(e.target===ov)close();});
    ov.querySelector("#ow-x").addEventListener("click",close);
    renderList();
  }
  function toSrc(icon){if(!icon)return "";if(icon.charAt(0)==="<")return "data:image/svg+xml,"+encodeURIComponent(icon);return icon;}
  function esc(s){return String(s).replace(/[&<>"]/g,function(x){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[x];});}

  function buildTiles(){
    var base=known(), usedFound={};
    base.forEach(function(t){
      if(t.key==="browser"){ if(window.ethereum) t.provider=window.ethereum; return; }
      for(var i=0;i<found.length;i++){ if(usedFound[i])continue; var d=found[i],info=d.info||{};
        if((t.rdns&&info.rdns===t.rdns)||(t.match&&t.match.test(info.name||""))){ t.provider=d.provider; if(info.icon)t.icon=info.icon; usedFound[i]=1; break; } }
    });
    found.forEach(function(d,i){ if(usedFound[i])return; var info=d.info||{}; base.push({key:"x"+i,name:info.name||"Wallet",icon:info.icon||"",provider:d.provider}); });
    base.sort(function(a,b){return (b.provider?1:0)-(a.provider?1:0);});
    return base;
  }
  function renderList(){
    if(!tilesEl)return;
    currentTiles=buildTiles();
    tilesEl.innerHTML=currentTiles.map(function(t,i){
      var src=toSrc(t.icon), ic=src?'<img src="'+src+'" alt="">':esc((t.name||"?")[0]);
      return '<button class="ow-tile" data-i="'+i+'"><span class="ow-ti">'+ic+'</span><span class="ow-tn">'+esc(t.name)+'</span></button>';
    }).join("");
    tilesEl.querySelectorAll(".ow-tile").forEach(function(b){ b.addEventListener("click",function(){ tileClick(currentTiles[Number(b.dataset.i)]); }); });
  }
  function tileClick(t){
    if(!t)return;
    if(t.provider) return pick(t.provider);
    if(isMobile && t.deeplink){ location.href=t.deeplink; return; }
    if(t.key==="browser"){ if(window.ethereum) return pick(window.ethereum); }
    if(t.get) window.open(t.get,"_blank","noopener");
  }

  async function pick(provider){
    if(busy||!provider)return;busy=true;
    try{
      try{window.ethereum=provider;}catch(_){}
      var a=await provider.request({method:"eth_requestAccounts"});
      if(!a||!a.length){busy=false;return;}
      try{await provider.request({method:"wallet_switchEthereumChain",params:[{chainId:CHAIN.chainIdHex}]});}
      catch(sw){if(sw&&sw.code===4902){try{await provider.request({method:"wallet_addEthereumChain",params:[CHAIN.params]});}catch(_){}}}
      close();busy=false;
      if(cb)cb(a[0]);
    }catch(e){busy=false;}
  }
  function open(){if(!ov)build();try{window.dispatchEvent(new Event("eip6963:requestProvider"));}catch(_){}renderList();ov.classList.add("on");}
  function close(){if(ov)ov.classList.remove("on");}

  window.ORLIX_WALLET={
    connect:function(onAccount){ cb=onAccount||null; open(); },
    open:open, close:close
  };
})();
