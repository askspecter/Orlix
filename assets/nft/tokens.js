/* ORLIX token icons — self-contained inline-SVG badges (no external assets).
 * window.tokenIcon(symbol, size) -> SVG string. window.ORLIX_TOKEN_MAP for names/colors. */
(function(){
  var MAP={
    AAPL:{n:"Apple",c:"#B4B8BC"}, MSFT:{n:"Microsoft",c:"#00A4EF"}, NVDA:{n:"NVIDIA",c:"#76B900"},
    AMZN:{n:"Amazon",c:"#FF9900"}, GOOGL:{n:"Alphabet",c:"#4285F4"}, META:{n:"Meta",c:"#0866FF"},
    TSLA:{n:"Tesla",c:"#E82127"}, PLTR:{n:"Palantir",c:"#7A8794"}, AMD:{n:"AMD",c:"#ED1C24"},
    GME:{n:"GameStop",c:"#E31837"}, SPCX:{n:"SpaceX",c:"#4B7BEC"},
    USDG:{n:"USDG",c:"#2775CA"}, ORLIX:{n:"ORLIX",c:"#CFF605"}, PONS:{n:"Pons",c:"#A78BFA"},
    HMM:{n:"HMM",c:"#F5C518"}, YOLO:{n:"YOLO",c:"#FF6B6B"}, WETH:{n:"WETH",c:"#8A92B2"}, ETH:{n:"Ether",c:"#8A92B2"}
  };
  function base(sym){
    var s=String(sym||"").replace(/^\$/,"");
    if(/x$/.test(s)&&MAP[s.slice(0,-1).toUpperCase()])s=s.slice(0,-1); // AAPLx -> AAPL
    return s.toUpperCase();
  }
  function contrast(hex){var c=hex.replace('#','');var r=parseInt(c.slice(0,2),16),g=parseInt(c.slice(2,4),16),b=parseInt(c.slice(4,6),16);return (0.299*r+0.587*g+0.114*b)>148?'#0a0c07':'#ffffff';}
  function esc(s){return String(s).replace(/[&<>"]/g,function(x){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[x]});}
  window.ORLIX_TOKEN_MAP=MAP;
  window.tokenName=function(sym){var m=MAP[base(sym)];return m?m.n:sym;};
  // generated monogram badge (fallback only)
  window.tokenIcon=function(sym,size){
    size=size||22;var b=base(sym);var m=MAP[b];var bg=m?m.c:'#3a4030';var fg=contrast(bg);
    var label=b.length>4?b.slice(0,4):b;var fs=label.length<=2?15:label.length===3?12:10;
    return '<svg width="'+size+'" height="'+size+'" viewBox="0 0 40 40" style="flex:none;border-radius:'+(size*0.28)+'px;vertical-align:middle">'
      +'<rect width="40" height="40" rx="11" fill="'+bg+'"/>'
      +'<text x="20" y="20" dy="0.34em" text-anchor="middle" font-family="JetBrains Mono,monospace" font-weight="700" font-size="'+fs+'" fill="'+fg+'">'+esc(label)+'</text></svg>';
  };
  // official token logos, keyed by contract address
  var SPECIAL={
    "0x5fc5360d0400a0fd4f2af552add042d716f1d168":"https://assets.coingecko.com/coins/images/51281/standard/GDN_USDG_Token_200x200.png?1730484111", // USDG
    "0x1efdd871f052900d88e4dc2d49bcd32bf77e333c":"/assets/nft/orlix-mark.png" // $ORLIX
  };
  window.tokenLogoUrl=function(addr){if(!addr)return null;var a=String(addr).toLowerCase();return SPECIAL[a]||("https://cdn.robinhood.com/ncw_assets/logos/"+a+".png")};
  // real logo <img> by address, with monogram fallback on error
  window.tokenImg=function(sym,size,addr){
    size=size||22;var mono=window.tokenIcon(sym,size);
    if(!addr)return mono;
    var url=window.tokenLogoUrl(addr);
    var fb="data:image/svg+xml;utf8,"+encodeURIComponent(mono);
    return '<img src="'+url+'" width="'+size+'" height="'+size+'" loading="lazy" alt="'+esc(sym||"")+'" style="border-radius:50%;object-fit:cover;vertical-align:middle;flex:none;background:#0b0d09" onerror="this.onerror=null;this.src=\''+fb+'\'">';
  };
})();
