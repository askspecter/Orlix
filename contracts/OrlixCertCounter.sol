// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * OrlixCertCounter — the ORLIX Certificate Counter on Robinhood Chain.
 *
 * Seal any ERC-20 (a tokenized stock like AAPL/NVDA/TSLA, USDG, or $ORLIX) into
 * a transferable BEARER DEED — an on-chain certificate NFT that owns exactly the
 * sealed amount at 1×. Hold it, gift it, or redeem it any time to unwrap the
 * underlying token. Whoever holds the certificate can redeem it.
 *
 * The certificate art + metadata are rendered fully on-chain (SVG + JSON), so it
 * displays as a real deed on OpenSea and anywhere the NFT is shown.
 *
 * Self-contained (no imports, minimal ERC-721) so it compiles cleanly in Remix.
 */

interface IERC20 {
  function transfer(address to, uint256 amount) external returns (bool);
  function transferFrom(address from, address to, uint256 amount) external returns (bool);
  function balanceOf(address account) external view returns (uint256);
}

interface IERC721Receiver {
  function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4);
}

library B64 {
  bytes internal constant T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  function encode(bytes memory data) internal pure returns (string memory) {
    if (data.length == 0) return "";
    string memory table = string(T);
    uint256 encodedLen = 4 * ((data.length + 2) / 3);
    string memory result = new string(encodedLen + 32);
    assembly {
      let tablePtr := add(table, 1)
      let resultPtr := add(result, 32)
      for { let i := 0 } lt(i, mload(data)) {} {
        i := add(i, 3)
        let input := and(mload(add(data, i)), 0xffffff)
        let out := mload(add(tablePtr, and(shr(18, input), 0x3F)))
        out := shl(8, out); out := add(out, and(mload(add(tablePtr, and(shr(12, input), 0x3F))), 0xFF))
        out := shl(8, out); out := add(out, and(mload(add(tablePtr, and(shr(6, input), 0x3F))), 0xFF))
        out := shl(8, out); out := add(out, and(mload(add(tablePtr, and(input, 0x3F))), 0xFF))
        out := shl(224, out)
        mstore(resultPtr, out)
        resultPtr := add(resultPtr, 4)
      }
      switch mod(mload(data), 3)
      case 1 { mstore(sub(resultPtr, 2), shl(240, 0x3d3d)) }
      case 2 { mstore(sub(resultPtr, 1), shl(248, 0x3d)) }
      mstore(result, encodedLen)
    }
    return result;
  }
}

contract OrlixCertCounter {
  // ── ERC-721 core ──
  string public constant name = "ORLIX Stock Certificate";
  string public constant symbol = "ORLIXCERT";
  uint256 public totalSupply;      // number ever minted (ids are 1-based)
  address public owner;
  IERC20  public immutable ORLIX;  // fee token
  uint256 public sealFee;          // optional $ORLIX fee per seal (owner-set)

  mapping(uint256 => address) private _ownerOf;
  mapping(address => uint256) private _balanceOf;
  mapping(uint256 => address) private _approved;
  mapping(address => mapping(address => bool)) private _operator;

  struct Cert { address token; uint96 decimals; uint256 amount; string sym; uint64 sealedAt; bool redeemed; }
  mapping(uint256 => Cert) public certs;

  uint256 private _lock;
  modifier nonReentrant(){ require(_lock==0,"reentrant"); _lock=1; _; _lock=0; }
  modifier onlyOwner(){ require(msg.sender==owner,"not owner"); _; }

  event Sealed(uint256 indexed id, address indexed to, address indexed token, uint256 amount, string sym);
  event Redeemed(uint256 indexed id, address indexed to, address indexed token, uint256 amount);
  event Transfer(address indexed from, address indexed to, uint256 indexed id);
  event Approval(address indexed owner, address indexed approved, uint256 indexed id);
  event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

  constructor(address orlix, uint256 fee){ owner=msg.sender; ORLIX=IERC20(orlix); sealFee=fee; }

  // ── admin ──
  function setSealFee(uint256 f) external onlyOwner { sealFee=f; }
  function transferOwnership(address n) external onlyOwner { require(n!=address(0),"0"); owner=n; }
  function withdrawFees(address to, uint256 amount) external onlyOwner { require(ORLIX.transfer(to,amount),"wd"); }

  // ── seal / redeem ──
  /// Seal `amount` of `token` into a new bearer-deed certificate, owned by you.
  function seal(address token, uint256 amount) external nonReentrant returns (uint256 id) {
    require(token!=address(0) && amount>0, "bad input");
    if (sealFee>0) require(ORLIX.transferFrom(msg.sender, address(this), sealFee), "fee");
    // pull the token (must be approved) — measure actual received (fee-on-transfer safe)
    uint256 before = IERC20(token).balanceOf(address(this));
    require(IERC20(token).transferFrom(msg.sender, address(this), amount), "pull");
    uint256 got = IERC20(token).balanceOf(address(this)) - before;
    require(got>0, "nothing received");
    id = ++totalSupply;
    certs[id] = Cert({token:token, decimals:uint96(_tryDecimals(token)), amount:got, sym:_trySymbol(token), sealedAt:uint64(block.timestamp), redeemed:false});
    _mint(msg.sender, id);
    emit Sealed(id, msg.sender, token, got, certs[id].sym);
  }

  /// Redeem a certificate you hold — burns it and returns the sealed token.
  function redeem(uint256 id) external nonReentrant {
    require(_ownerOf[id]==msg.sender, "not holder");
    Cert storage c = certs[id];
    require(!c.redeemed, "redeemed");
    c.redeemed = true;
    _burn(id);
    require(IERC20(c.token).transfer(msg.sender, c.amount), "return");
    emit Redeemed(id, msg.sender, c.token, c.amount);
  }

  // ── views ──
  function ownerOf(uint256 id) public view returns (address o){ o=_ownerOf[id]; require(o!=address(0),"no token"); }
  function balanceOf(address a) external view returns (uint256){ require(a!=address(0),"zero"); return _balanceOf[a]; }
  function getApproved(uint256 id) external view returns (address){ return _approved[id]; }
  function isApprovedForAll(address o, address op) external view returns (bool){ return _operator[o][op]; }
  function getCert(uint256 id) external view returns (address token, uint256 amount, string memory sym, uint8 decimals, uint64 sealedAt, bool redeemed){
    Cert storage c=certs[id]; return (c.token, c.amount, c.sym, uint8(c.decimals), c.sealedAt, c.redeemed);
  }

  // ── ERC-721 transfers ──
  function approve(address to, uint256 id) external { address o=_ownerOf[id]; require(msg.sender==o||_operator[o][msg.sender],"auth"); _approved[id]=to; emit Approval(o,to,id); }
  function setApprovalForAll(address op, bool ok) external { _operator[msg.sender][op]=ok; emit ApprovalForAll(msg.sender,op,ok); }
  function transferFrom(address from, address to, uint256 id) public { _transfer(from,to,id); }
  function safeTransferFrom(address from, address to, uint256 id) external { _transfer(from,to,id); _checkRecv(from,to,id,""); }
  function safeTransferFrom(address from, address to, uint256 id, bytes calldata data) external { _transfer(from,to,id); _checkRecv(from,to,id,data); }

  function _transfer(address from, address to, uint256 id) internal {
    require(_ownerOf[id]==from, "wrong from"); require(to!=address(0),"to zero");
    require(msg.sender==from||_operator[from][msg.sender]||_approved[id]==msg.sender, "not auth");
    delete _approved[id];
    unchecked { _balanceOf[from]--; _balanceOf[to]++; }
    _ownerOf[id]=to; emit Transfer(from,to,id);
  }
  function _mint(address to, uint256 id) internal { _ownerOf[id]=to; unchecked{_balanceOf[to]++;} emit Transfer(address(0),to,id); }
  function _burn(uint256 id) internal { address o=_ownerOf[id]; unchecked{_balanceOf[o]--;} delete _ownerOf[id]; delete _approved[id]; emit Transfer(o,address(0),id); }
  function _checkRecv(address from, address to, uint256 id, bytes memory data) internal {
    if (to.code.length>0) { require(IERC721Receiver(to).onERC721Received(msg.sender,from,id,data)==IERC721Receiver.onERC721Received.selector,"bad receiver"); }
  }
  function supportsInterface(bytes4 iid) external pure returns (bool){ return iid==0x80ac58cd||iid==0x5b5e139f||iid==0x01ffc9a7; }

  // ── low-level metadata reads ──
  function _trySymbol(address t) internal view returns (string memory){
    (bool ok, bytes memory d) = t.staticcall(abi.encodeWithSignature("symbol()"));
    if (ok && d.length>0){ if(d.length==32){ return _bytes32ToStr(bytes32(d)); } return abi.decode(d,(string)); }
    return "TOKEN";
  }
  function _tryDecimals(address t) internal view returns (uint256){
    (bool ok, bytes memory d) = t.staticcall(abi.encodeWithSignature("decimals()"));
    if (ok && d.length>=32) return abi.decode(d,(uint256));
    return 18;
  }
  function _bytes32ToStr(bytes32 x) internal pure returns (string memory){
    uint256 n; while(n<32 && x[n]!=0) n++;
    bytes memory b=new bytes(n); for(uint256 i;i<n;i++) b[i]=x[i]; return string(b);
  }

  // ── on-chain metadata (bearer deed) ──
  function tokenURI(uint256 id) external view returns (string memory){
    require(_ownerOf[id]!=address(0),"no token");
    Cert storage c=certs[id];
    string memory amt = _amountStr(c.amount, uint8(c.decimals));
    string memory svg = _svg(amt, c.sym, id);
    string memory json = string(abi.encodePacked(
      '{"name":"ORLIX Certificate #', _u(id), ' - ', amt, ' ', c.sym,
      '","description":"A bearer deed on the ORLIX Certificate Counter. The holder owns ', amt, ' ', c.sym,
      ', redeemable for the underlying Robinhood Chain token. Not affiliated with any referenced company.",',
      '"attributes":[{"trait_type":"Asset","value":"', c.sym, '"},{"trait_type":"Amount","value":"', amt, '"}],',
      '"image":"data:image/svg+xml;base64,', B64.encode(bytes(svg)), '"}'
    ));
    return string(abi.encodePacked("data:application/json;base64,", B64.encode(bytes(json))));
  }

  function _svg(string memory amt, string memory sym, uint256 id) internal pure returns (string memory){
    return string(abi.encodePacked(
      '<svg xmlns="http://www.w3.org/2000/svg" width="700" height="440" viewBox="0 0 700 440">',
      '<rect width="700" height="440" fill="#eaf1ef"/><rect x="12" y="12" width="676" height="416" fill="none" stroke="#1f7a6b" stroke-width="3" rx="10"/>',
      '<rect x="22" y="22" width="656" height="396" fill="none" stroke="#1f7a6b" stroke-opacity="0.4" rx="7"/>',
      '<text x="350" y="70" font-family="Georgia,serif" font-size="20" letter-spacing="3" fill="#1f6a5e" text-anchor="middle">THE ORLIX STONK EXCHANGE</text>',
      '<text x="350" y="95" font-family="Georgia,serif" font-size="11" letter-spacing="4" fill="#5a7a74" text-anchor="middle">BEARER DEED &#183; ROBINHOOD CHAIN &#183; No. ', _u(id), '</text>',
      '<text x="350" y="180" font-family="Georgia,serif" font-size="16" letter-spacing="6" fill="#2b5c54" text-anchor="middle">THE BEARER OWNS</text>',
      '<text x="350" y="250" font-family="Georgia,serif" font-size="58" font-weight="bold" fill="#0d2b28" text-anchor="middle">', amt, ' ', sym, '</text>',
      '<rect x="270" y="285" width="160" height="30" rx="4" fill="#1f7a6b"/><text x="350" y="305" font-family="Georgia,serif" font-size="13" letter-spacing="2" fill="#eafff9" text-anchor="middle">SEALED CERTIFICATE</text>',
      '<circle cx="600" cy="360" r="34" fill="none" stroke="#1f7a6b" stroke-width="2"/><text x="600" y="365" font-family="Georgia,serif" font-size="14" font-weight="bold" fill="#1f6a5e" text-anchor="middle">ORLIX</text>',
      '<text x="40" y="400" font-family="Georgia,serif" font-size="9" fill="#5a7a74">Redeems for Robinhood Chain ', sym, ' tokens &#183; sealed until redeemed &#183; not issued by or affiliated with any referenced company</text>',
      '</svg>'
    ));
  }

  function _amountStr(uint256 amount, uint8 dec) internal pure returns (string memory){
    uint256 unit = 10 ** dec;
    uint256 whole = amount / unit;
    uint256 frac4 = (amount % unit) * 10000 / unit; // 4 dp
    if (frac4 == 0) return _u(whole);
    bytes memory f = bytes(_u(frac4));
    // left-pad frac to 4 digits
    bytes memory pad = new bytes(4);
    uint256 lead = 4 - f.length;
    for (uint256 i; i<4; i++) pad[i] = i<lead ? bytes1("0") : f[i-lead];
    // trim trailing zeros
    uint256 end = 4; while(end>0 && pad[end-1]==bytes1("0")) end--;
    bytes memory ft = new bytes(end); for(uint256 j; j<end; j++) ft[j]=pad[j];
    return string(abi.encodePacked(_u(whole), ".", ft));
  }
  function _u(uint256 v) internal pure returns (string memory){
    if(v==0) return "0"; uint256 t=v; uint256 n; while(t>0){n++;t/=10;} bytes memory b=new bytes(n);
    while(v>0){ n--; b[n]=bytes1(uint8(48+v%10)); v/=10; } return string(b);
  }
}
