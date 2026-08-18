/* ORLIX shared connect-wallet modal
 * - EIP-6963 discovery (wallets announce their own name + icon)
 * - mobile deep-links when no wallet is injected
 * - "What is a wallet?" info, EN / ID by device language
 * Usage: ORLIX_WALLET.connect(addr => { ... })  // callback gets the account
 */
(function(){
  "use strict";
  var CHAIN={chainIdHex:"0x1237",params:{chainId:"0x1237",chainName:"Robinhood Chain",nativeCurrency:{name:"Ether",symbol:"ETH",decimals:18},rpcUrls:["https://rpc.mainnet.chain.robinhood.com/"],blockExplorerUrls:["https://robinhoodchain.blockscout.com"]}};
  var ID=(navigator.language||"en").toLowerCase().indexOf("id")===0;
  var T=ID?{
    title:"Hubungkan Dompet",installed:"Terpasang",more:"Dompet lain",whatH:"Apa itu Dompet?",
    whatP:"Dompet dipakai untuk mengirim, menerima, dan menyimpan aset digital — juga cara masuk tanpa membuat akun & kata sandi baru di tiap situs.",
    get:"Dapatkan Dompet",learn:"Pelajari lebih lanjut",open:"BUKA APP",sign:"kami hanya pernah meminta anda menandatangani",
    none:"Tidak ada dompet terdeteksi — buka lewat browser dompet, atau pilih di bawah.",connecting:"Menghubungkan…"
  }:{
    title:"Connect wallet",installed:"Installed",more:"Other wallets",whatH:"What is a Wallet?",
    whatP:"A wallet sends, receives and stores digital assets — and lets you sign in without a new account & password on every site.",
    get:"Get a Wallet",learn:"Learn more",open:"OPEN APP",sign:"we only ever ask you to sign",
    none:"No wallet detected — open in a wallet browser, or pick one below.",connecting:"Connecting…"
  };
  // mobile deep-links (open this dApp inside the wallet's browser)
  function dl(){
    var host=location.host, path=location.pathname+location.search, url=location.href;
    return [
      {name:"MetaMask",c:"#f6851b",href:"https://metamask.app.link/dapp/"+host+path},
      {name:"Coinbase",c:"#1652f0",href:"https://go.cb-w.com/dapp?cb_url="+encodeURIComponent(url)},
      {name:"Trust",c:"#3375bb",href:"https://link.trustwallet.com/open_url?url="+encodeURIComponent(url)},
      {name:"Rainbow",c:"#7b3fe4",href:"https://rnbwapp.com/dapp?url="+encodeURIComponent(url)}
    ];
  }
  var isMobile=/android|iphone|ipad|ipod/i.test(navigator.userAgent);

  // EIP-6963 discovery
  var found=[]; var seen={};
  function onAnnounce(e){var d=e.detail;if(!d||!d.info)return;var k=d.info.uuid||d.info.rdns||d.info.name;if(seen[k])return;seen[k]=1;found.push(d);renderList();}
  window.addEventListener("eip6963:announceProvider",onAnnounce);
  try{window.dispatchEvent(new Event("eip6963:requestProvider"));}catch(_){}

  var css="#ow-ov{position:fixed;inset:0;z-index:9999;background:rgba(3,4,3,.72);backdrop-filter:blur(6px);display:none;align-items:center;justify-content:center;padding:18px;font-family:'JetBrains Mono',monospace}"
    +"#ow-ov.on{display:flex}"
    +"#ow-m{width:100%;max-width:420px;background:#0b0d09;border:1px solid rgba(207,246,5,.18);border-radius:20px;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.6);color:#E9ECE2}"
    +"#ow-h{display:flex;align-items:center;justify-content:space-between;padding:18px 20px;border-bottom:1px solid rgba(255,255,255,.06)}"
    +"#ow-h b{font-size:1.05rem;font-weight:600;letter-spacing:.02em}"
    +"#ow-x{background:transparent;border:none;color:#8b917f;font-size:1.4rem;cursor:pointer;line-height:1;padding:2px 6px}"
    +"#ow-x:hover{color:#E9ECE2}"
    +".ow-lbl{font-size:.56rem;letter-spacing:.24em;color:#5a5f50;padding:16px 20px 8px;text-transform:uppercase}"
    +".ow-row{display:flex;align-items:center;gap:14px;width:100%;padding:12px 20px;background:transparent;border:none;color:#E9ECE2;cursor:pointer;text-align:left;text-decoration:none;transition:background .15s}"
    +".ow-row:hover{background:rgba(207,246,5,.06)}"
    +".ow-ic{width:40px;height:40px;border-radius:11px;flex:none;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:15px;overflow:hidden;background:#12140d}"
    +".ow-ic img{width:100%;height:100%;object-fit:cover}"
    +".ow-nm{flex:1;font-size:1rem}"
    +".ow-go{font-size:.6rem;letter-spacing:.14em;color:#CFF605;border:1px solid rgba(207,246,5,.5);border-radius:8px;padding:7px 11px}"
    +".ow-what{padding:16px 20px 4px;border-top:1px solid rgba(255,255,255,.06);margin-top:6px}"
    +".ow-what h4{font-size:.9rem;font-weight:600;margin:0 0 6px}"
    +".ow-what p{font-size:.76rem;line-height:1.55;color:#8b917f;margin:0 0 12px}"
    +".ow-btns{display:flex;gap:10px}"
    +".ow-btns a{flex:1;text-align:center;font-size:.72rem;font-weight:600;letter-spacing:.04em;color:#CFF605;border:1px solid rgba(207,246,5,.4);border-radius:10px;padding:11px;text-decoration:none}"
    +".ow-btns a:hover{background:rgba(207,246,5,.08)}"
    +"#ow-f{padding:14px 20px;border-top:1px solid rgba(255,255,255,.06);font-size:.66rem;color:#5a5f50;display:flex;align-items:center;gap:9px}"
    +"#ow-f .d{width:7px;height:7px;border-radius:50%;background:#CFF605;box-shadow:0 0 8px #CFF605}"
    +"#ow-f b{color:#8b917f;font-weight:500}";

  var ov,listEl,cb=null,busy=false;
  function build(){
    var s=document.createElement("style");s.textContent=css;document.head.appendChild(s);
    ov=document.createElement("div");ov.id="ow-ov";
    ov.innerHTML='<div id="ow-m" role="dialog" aria-modal="true">'
      +'<div id="ow-h"><b>'+T.title+'</b><button id="ow-x" aria-label="Close">×</button></div>'
      +'<div id="ow-list"></div>'
      +'<div class="ow-what"><h4>'+T.whatH+'</h4><p>'+T.whatP+'</p>'
      +'<div class="ow-btns"><a href="https://ethereum.org/wallets/find-wallet/" target="_blank" rel="noopener">'+T.get+'</a>'
      +'<a href="https://ethereum.org/wallets/" target="_blank" rel="noopener">'+T.learn+'</a></div></div>'
      +'<div id="ow-f"><span class="d"></span>orlixai.xyz <b>/ '+T.sign+'</b></div></div>';
    document.body.appendChild(ov);
    listEl=ov.querySelector("#ow-list");
    ov.addEventListener("click",function(e){if(e.target===ov)close();});
    ov.querySelector("#ow-x").addEventListener("click",close);
    renderList();
  }
  function iconFor(d){
    if(d&&d.info&&d.info.icon)return '<img src="'+d.info.icon+'" alt="">';
    return (d&&d.info&&d.info.name?d.info.name[0]:"?");
  }
  function renderList(){
    if(!listEl)return;
    var html="";
    if(found.length){
      html+='<div class="ow-lbl">'+T.installed+'</div>';
      found.forEach(function(d,i){
        html+='<button class="ow-row" data-i="'+i+'"><span class="ow-ic">'+iconFor(d)+'</span><span class="ow-nm">'+esc(d.info.name)+'</span><span class="ow-go">→</span></button>';
      });
    } else if(window.ethereum){
      html+='<div class="ow-lbl">'+T.installed+'</div>';
      html+='<button class="ow-row" data-eth="1"><span class="ow-ic">👛</span><span class="ow-nm">Browser Wallet</span><span class="ow-go">→</span></button>';
    }
    if(isMobile){
      html+='<div class="ow-lbl">'+T.more+'</div>';
      dl().forEach(function(w){
        html+='<a class="ow-row" href="'+w.href+'"><span class="ow-ic" style="background:'+w.c+';color:#fff">'+esc(w.name[0])+'</span><span class="ow-nm">'+esc(w.name)+'</span><span class="ow-go">'+T.open+'</span></a>';
      });
    }
    if(!found.length&&!window.ethereum&&!isMobile){html='<p style="padding:20px;color:#8b917f;font-size:.8rem;line-height:1.5">'+T.none+'</p>'+html;}
    listEl.innerHTML=html;
    listEl.querySelectorAll(".ow-row[data-i]").forEach(function(b){b.addEventListener("click",function(){pick(found[Number(b.dataset.i)].provider);});});
    var eb=listEl.querySelector(".ow-row[data-eth]");if(eb)eb.addEventListener("click",function(){pick(window.ethereum);});
  }
  function esc(s){return String(s).replace(/[&<>"]/g,function(x){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[x];});}

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
  function open(){if(!ov)build();found=[];seen={};try{window.dispatchEvent(new Event("eip6963:requestProvider"));}catch(_){}renderList();ov.classList.add("on");}
  function close(){if(ov)ov.classList.remove("on");}

  window.ORLIX_WALLET={
    connect:function(onAccount){
      cb=onAccount||null;
      if(!window.ethereum&&!found.length&&!isMobile){/* still open to show info */}
      open();
    },
    open:open, close:close
  };
})();
