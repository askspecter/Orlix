// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title OrlixNames — ".b20" name service + marketplace (Base)
 * @notice One identity for your wallet across the Orlix / B20 ecosystem. Register
 *         a name like `jesse.b20` by paying in $ORLIX (a slice is burned, the rest
 *         goes to the treasury). Names are ERC-721 NFTs, so they show in wallets
 *         and can be resold — a built-in marketplace lets owners list a name for a
 *         price in $ORLIX and buyers claim it on-chain in one transaction, no
 *         middleman. Names resolve to an address (and reverse-resolve back), so a
 *         `.b20` can stand in for a 0x address for fee recipients, referrals, and
 *         profiles.
 *
 * @dev    Self-contained (no imports beyond IERC20) minimal ERC-721 so it drops
 *         straight into Remix. UNAUDITED — test on a Base fork / testnet before
 *         mainnet (see contracts/README-names.md). tokenId == uint256(keccak256(name)).
 */
contract OrlixNames {
    // ── Config ──────────────────────────────────────────────────────────────
    string public constant TLD = ".b20";
    IERC20 public immutable ORLIX;              // payment token ($ORLIX on Base)
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;

    address public owner;                        // admin (pricing, treasury, fees)
    address public treasury;                     // receives the non-burned share

    // Registration price in $ORLIX by name length bucket (raw token units, 18 dec).
    // len==3 → priceLen3, len==4 → priceLen4, len>=5 → priceLen5plus.
    uint256 public priceLen3;
    uint256 public priceLen4;
    uint256 public priceLen5plus;

    uint16 public registerBurnBps = 5000;        // 50% of registration fee burned
    uint16 public marketFeeBps    = 250;         // 2.5% marketplace fee (burned)
    uint16 public constant BPS = 10000;

    // ── ERC-721 core ────────────────────────────────────────────────────────
    string  public constant name   = "Orlix Names";
    string  public constant symbol = "B20NAME";
    mapping(uint256 => address) private _ownerOf;
    mapping(address => uint256) private _balanceOf;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    // ── Naming state ────────────────────────────────────────────────────────
    mapping(uint256 => string)  public labelOf;      // tokenId → full label "jesse.b20"
    mapping(uint256 => address) public resolveOf;     // tokenId → address it points to
    mapping(address => uint256) public primaryOf;     // address → primary tokenId (reverse)
    string[] public allNames;                         // every registered label (enumeration)

    // ── Marketplace ─────────────────────────────────────────────────────────
    struct Listing { address seller; uint256 price; bool active; }
    mapping(uint256 => Listing) public listings;      // tokenId → listing
    uint256[] public listedIds;                       // ever-listed ids (filter by .active)

    // ── Events ──────────────────────────────────────────────────────────────
    event Transfer(address indexed from, address indexed to, uint256 indexed id);
    event Approval(address indexed owner, address indexed approved, uint256 indexed id);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event Registered(string label, uint256 indexed id, address indexed to, uint256 paid);
    event ResolveSet(uint256 indexed id, address target);
    event PrimarySet(address indexed account, uint256 indexed id);
    event Listed(uint256 indexed id, address indexed seller, uint256 price);
    event Unlisted(uint256 indexed id);
    event Bought(uint256 indexed id, address indexed buyer, address indexed seller, uint256 price);

    error NotOwner();
    error Taken();
    error BadName();
    error NotForSale();

    constructor(address orlixToken, address treasury_) {
        ORLIX = IERC20(orlixToken);
        owner = msg.sender;
        treasury = treasury_;
        // Defaults tuned for a low-unit-price token; admin can retune anytime.
        priceLen3     = 5_000_000 ether;
        priceLen4     = 1_000_000 ether;
        priceLen5plus =   250_000 ether;
    }

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }

    // ── Registration ─────────────────────────────────────────────────────────
    function tokenIdOf(string memory label) public pure returns (uint256) {
        return uint256(keccak256(bytes(label)));
    }

    /// @notice Full on-chain label incl. TLD, e.g. "jesse.b20".
    function fullLabel(string memory sld) public pure returns (string memory) {
        return string(abi.encodePacked(sld, ".b20"));
    }

    function priceFor(string memory sld) public view returns (uint256) {
        uint256 len = bytes(sld).length;
        if (len == 3) return priceLen3;
        if (len == 4) return priceLen4;
        return priceLen5plus;
    }

    function available(string memory sld) public view returns (bool) {
        return _ownerOf[tokenIdOf(fullLabel(sld))] == address(0);
    }

    /// @notice Register `sld` + ".b20" for msg.sender, paying in $ORLIX.
    function register(string calldata sld) external returns (uint256 id) {
        _validate(sld);
        string memory label = fullLabel(sld);
        id = tokenIdOf(label);
        if (_ownerOf[id] != address(0)) revert Taken();

        uint256 price = priceFor(sld);
        if (price > 0) {
            uint256 burnAmt = price * registerBurnBps / BPS;
            if (burnAmt > 0) require(ORLIX.transferFrom(msg.sender, BURN, burnAmt), "orlix xfer");
            uint256 rest = price - burnAmt;
            if (rest > 0) require(ORLIX.transferFrom(msg.sender, treasury, rest), "orlix xfer");
        }

        _mint(msg.sender, id);
        labelOf[id] = label;
        resolveOf[id] = msg.sender;
        allNames.push(label);
        if (primaryOf[msg.sender] == 0) { primaryOf[msg.sender] = id; emit PrimarySet(msg.sender, id); }

        emit Registered(label, id, msg.sender, price);
        emit ResolveSet(id, msg.sender);
    }

    function _validate(string calldata sld) internal pure {
        bytes memory b = bytes(sld);
        if (b.length < 3 || b.length > 32) revert BadName();
        for (uint256 i; i < b.length; i++) {
            bytes1 c = b[i];
            bool okChar = (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c == 0x2d; // a-z 0-9 -
            if (!okChar) revert BadName();
            if (c == 0x2d && (i == 0 || i == b.length - 1)) revert BadName(); // no leading/trailing '-'
        }
    }

    // ── Resolution ─────────────────────────────────────────────────────────
    function setResolve(uint256 id, address target) external {
        if (_ownerOf[id] != msg.sender) revert NotOwner();
        resolveOf[id] = target;
        emit ResolveSet(id, target);
    }

    /// @notice Set the reverse (address → name) record shown as your primary.
    function setPrimary(uint256 id) external {
        if (_ownerOf[id] != msg.sender) revert NotOwner();
        primaryOf[msg.sender] = id;
        emit PrimarySet(msg.sender, id);
    }

    /// @notice name → address. Returns address(0) if unregistered.
    function resolve(string memory sld) external view returns (address) {
        return resolveOf[tokenIdOf(fullLabel(sld))];
    }

    /// @notice address → primary label ("" if none).
    function reverse(address account) external view returns (string memory) {
        uint256 id = primaryOf[account];
        if (id == 0 || _ownerOf[id] != account) return "";
        return labelOf[id];
    }

    // ── Marketplace ──────────────────────────────────────────────────────────
    function list(uint256 id, uint256 priceOrlix) external {
        if (_ownerOf[id] != msg.sender) revert NotOwner();
        if (priceOrlix == 0) revert NotForSale();
        if (!listings[id].active) listedIds.push(id);
        listings[id] = Listing(msg.sender, priceOrlix, true);
        emit Listed(id, msg.sender, priceOrlix);
    }

    function unlist(uint256 id) external {
        if (_ownerOf[id] != msg.sender) revert NotOwner();
        listings[id].active = false;
        emit Unlisted(id);
    }

    /// @notice Buy a listed name; buyer pays $ORLIX to the seller (minus a burned fee).
    function buy(uint256 id) external {
        Listing memory L = listings[id];
        if (!L.active || _ownerOf[id] != L.seller) revert NotForSale();

        uint256 fee = L.price * marketFeeBps / BPS;
        if (fee > 0)          require(ORLIX.transferFrom(msg.sender, BURN, fee), "orlix xfer");
        uint256 toSeller = L.price - fee;
        if (toSeller > 0)     require(ORLIX.transferFrom(msg.sender, L.seller, toSeller), "orlix xfer");

        listings[id].active = false;
        _transfer(L.seller, msg.sender, id);
        // New owner points the name at themselves by default.
        resolveOf[id] = msg.sender;
        emit ResolveSet(id, msg.sender);
        emit Bought(id, msg.sender, L.seller, L.price);
    }

    // ── Enumeration (for client-side reads, no indexer needed) ───────────────
    function totalNames() external view returns (uint256) { return allNames.length; }
    function nameAt(uint256 i) external view returns (string memory) { return allNames[i]; }
    function totalListings() external view returns (uint256) { return listedIds.length; }
    function listingAt(uint256 i) external view returns (uint256 id, address seller, uint256 price, bool active, string memory label) {
        id = listedIds[i];
        Listing memory L = listings[id];
        return (id, L.seller, L.price, L.active && _ownerOf[id] == L.seller, labelOf[id]);
    }
    function ownerOfName(string memory sld) external view returns (address) {
        return _ownerOf[tokenIdOf(fullLabel(sld))];
    }

    // ── Minimal ERC-721 ──────────────────────────────────────────────────────
    function ownerOf(uint256 id) public view returns (address o) {
        o = _ownerOf[id];
        require(o != address(0), "no token");
    }
    function balanceOf(address a) external view returns (uint256) { require(a != address(0), "zero"); return _balanceOf[a]; }

    function approve(address spender, uint256 id) external {
        address o = _ownerOf[id];
        require(msg.sender == o || isApprovedForAll[o][msg.sender], "not auth");
        getApproved[id] = spender;
        emit Approval(o, spender, id);
    }
    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }
    function transferFrom(address from, address to, uint256 id) public {
        require(from == _ownerOf[id], "wrong from");
        require(to != address(0), "zero to");
        require(msg.sender == from || msg.sender == getApproved[id] || isApprovedForAll[from][msg.sender], "not auth");
        listings[id].active = false; // any transfer cancels a listing
        _transfer(from, to, id);
    }
    function safeTransferFrom(address from, address to, uint256 id) external { transferFrom(from, to, id); }
    function safeTransferFrom(address from, address to, uint256 id, bytes calldata) external { transferFrom(from, to, id); }

    function _mint(address to, uint256 id) internal {
        _ownerOf[id] = to;
        unchecked { _balanceOf[to]++; }
        emit Transfer(address(0), to, id);
    }
    function _transfer(address from, address to, uint256 id) internal {
        unchecked { _balanceOf[from]--; _balanceOf[to]++; }
        _ownerOf[id] = to;
        delete getApproved[id];
        if (primaryOf[from] == id) delete primaryOf[from];
        emit Transfer(from, to, id);
    }

    function supportsInterface(bytes4 iid) external pure returns (bool) {
        return iid == 0x80ac58cd || iid == 0x01ffc9a7 || iid == 0x5b5e139f; // ERC721, ERC165, Metadata
    }
    function tokenURI(uint256 id) external view returns (string memory) {
        require(_ownerOf[id] != address(0), "no token");
        return string(abi.encodePacked("https://orlixai.xyz/api/name-meta?id=", _toString(id)));
    }

    // ── Admin ────────────────────────────────────────────────────────────────
    function setPrices(uint256 l3, uint256 l4, uint256 l5) external onlyOwner { priceLen3 = l3; priceLen4 = l4; priceLen5plus = l5; }
    function setFees(uint16 regBurn, uint16 market) external onlyOwner { require(regBurn <= BPS && market <= BPS, "bps"); registerBurnBps = regBurn; marketFeeBps = market; }
    function setTreasury(address t) external onlyOwner { treasury = t; }
    function transferOwnership(address o) external onlyOwner { owner = o; }

    function _toString(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 j = v; uint256 len; while (j != 0) { len++; j /= 10; }
        bytes memory bstr = new bytes(len);
        while (v != 0) { len--; bstr[len] = bytes1(uint8(48 + v % 10)); v /= 10; }
        return string(bstr);
    }
}
