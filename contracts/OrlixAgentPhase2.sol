// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * ORLIX Agent — Phase 2 (Burn-to-Mint) · self-contained, NO imports
 *
 *  - ERC-721 collection (minimal, Solmate-style core).
 *  - To mint, the caller BURNS 300,000 $ORLIX per NFT (sent to 0x…dEaD).
 *  - Max 5 per wallet. Token IDs 33..1111 (continues after the 32 Phase-1 agents).
 *  - Metadata via baseURI: tokenURI(id) = baseURI + id + ".json".
 *
 *  Minter must first approve() this contract on the $ORLIX token for the cost.
 *  NOTE: unaudited. Test on a small scale first.
 */

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
}

interface IERC721Receiver {
    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4);
}

contract OrlixAgentPhase2 {
    // ------------------------------------------------------------ metadata
    string public name = "ORLIX Agent";
    string public symbol = "AGENT";
    string public baseURI;                       // e.g. ipfs://<CID>/  (contract appends "<id>.json")

    // ------------------------------------------------------------ mint config
    IERC20  public immutable orlix;              // $ORLIX token
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant BURN_PER_MINT = 300000 ether;   // 300,000 * 1e18
    uint256 public constant MAX_PER_WALLET = 5;
    uint256 public immutable maxTokenId;         // last mintable id (1111)
    uint256 public immutable firstTokenId;       // 33

    uint256 public nextId;                       // next token id to mint
    uint256 public totalMinted;
    uint256 public totalBurned;                  // $ORLIX burned via mint
    bool    public mintOpen;
    address public owner;

    mapping(address => uint256) public mintedBy;

    // ------------------------------------------------------------ ERC721 core
    mapping(uint256 => address) internal _ownerOf;
    mapping(address => uint256) internal _balanceOf;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    // ------------------------------------------------------------ events
    event Transfer(address indexed from, address indexed to, uint256 indexed id);
    event Approval(address indexed owner, address indexed spender, uint256 indexed id);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event Minted(address indexed to, uint256 quantity, uint256 orlixBurned);
    event MintOpenSet(bool open);
    event BaseURISet(string uri);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    constructor(address _orlix, string memory _baseURI, uint256 _firstId, uint256 _maxId) {
        require(_orlix != address(0), "orlix=0");
        require(_maxId >= _firstId, "bad range");
        orlix = IERC20(_orlix);
        baseURI = _baseURI;
        firstTokenId = _firstId;
        maxTokenId = _maxId;
        nextId = _firstId;
        owner = msg.sender;
    }

    // ============================================================ MINT
    /// @notice Mint `quantity` agents, burning 300,000 $ORLIX each.
    /// @dev Caller must approve() this contract on $ORLIX for BURN_PER_MINT * quantity first.
    function mint(uint256 quantity) external {
        require(mintOpen, "mint closed");
        require(quantity > 0, "qty=0");
        require(mintedBy[msg.sender] + quantity <= MAX_PER_WALLET, "wallet limit");
        require(nextId + quantity - 1 <= maxTokenId, "sold out");

        uint256 cost = BURN_PER_MINT * quantity;

        // effects first (reentrancy-safe)
        mintedBy[msg.sender] += quantity;
        totalMinted += quantity;
        totalBurned += cost;
        uint256 startId = nextId;
        nextId += quantity;

        // interactions: burn $ORLIX, then mint
        require(orlix.transferFrom(msg.sender, BURN, cost), "orlix transfer failed");
        for (uint256 i = 0; i < quantity; i++) {
            _safeMint(msg.sender, startId + i);
        }
        emit Minted(msg.sender, quantity, cost);
    }

    /// @notice How much $ORLIX to approve for `quantity` mints.
    function costFor(uint256 quantity) external pure returns (uint256) { return BURN_PER_MINT * quantity; }
    function remaining() external view returns (uint256) { return maxTokenId + 1 - nextId; }

    // ============================================================ owner
    function setMintOpen(bool _open) external onlyOwner { mintOpen = _open; emit MintOpenSet(_open); }
    function setBaseURI(string calldata _uri) external onlyOwner { baseURI = _uri; emit BaseURISet(_uri); }
    function transferOwnership(address to) external onlyOwner { require(to != address(0), "to=0"); owner = to; }
    /// @notice Owner mint (e.g. team/giveaways) without burning — optional.
    function ownerMint(address to, uint256 quantity) external onlyOwner {
        require(nextId + quantity - 1 <= maxTokenId, "sold out");
        uint256 startId = nextId; nextId += quantity; totalMinted += quantity;
        for (uint256 i = 0; i < quantity; i++) _safeMint(to, startId + i);
    }

    // ============================================================ ERC721
    function tokenURI(uint256 id) public view returns (string memory) {
        require(_ownerOf[id] != address(0), "NOT_MINTED");
        return string(abi.encodePacked(baseURI, _toString(id), ".json"));
    }
    function ownerOf(uint256 id) public view returns (address o) { require((o = _ownerOf[id]) != address(0), "NOT_MINTED"); }
    function balanceOf(address a) public view returns (uint256) { require(a != address(0), "ZERO"); return _balanceOf[a]; }

    function approve(address spender, uint256 id) public {
        address o = _ownerOf[id];
        require(msg.sender == o || isApprovedForAll[o][msg.sender], "NOT_AUTHORIZED");
        getApproved[id] = spender; emit Approval(o, spender, id);
    }
    function setApprovalForAll(address operator, bool approved) public {
        isApprovedForAll[msg.sender][operator] = approved; emit ApprovalForAll(msg.sender, operator, approved);
    }
    function transferFrom(address from, address to, uint256 id) public {
        require(from == _ownerOf[id], "WRONG_FROM");
        require(to != address(0), "INVALID_RECIPIENT");
        require(msg.sender == from || isApprovedForAll[from][msg.sender] || msg.sender == getApproved[id], "NOT_AUTHORIZED");
        unchecked { _balanceOf[from]--; _balanceOf[to]++; }
        _ownerOf[id] = to; delete getApproved[id];
        emit Transfer(from, to, id);
    }
    function safeTransferFrom(address from, address to, uint256 id) public {
        transferFrom(from, to, id);
        require(to.code.length == 0 || IERC721Receiver(to).onERC721Received(msg.sender, from, id, "") == IERC721Receiver.onERC721Received.selector, "UNSAFE_RECIPIENT");
    }
    function safeTransferFrom(address from, address to, uint256 id, bytes calldata data) public {
        transferFrom(from, to, id);
        require(to.code.length == 0 || IERC721Receiver(to).onERC721Received(msg.sender, from, id, data) == IERC721Receiver.onERC721Received.selector, "UNSAFE_RECIPIENT");
    }
    function supportsInterface(bytes4 id) public pure returns (bool) {
        return id == 0x01ffc9a7 || id == 0x80ac58cd || id == 0x5b5e139f; // ERC165, ERC721, ERC721Metadata
    }

    function _safeMint(address to, uint256 id) internal {
        require(to != address(0), "INVALID_RECIPIENT");
        require(_ownerOf[id] == address(0), "ALREADY_MINTED");
        unchecked { _balanceOf[to]++; }
        _ownerOf[id] = to;
        emit Transfer(address(0), to, id);
        require(to.code.length == 0 || IERC721Receiver(to).onERC721Received(msg.sender, address(0), id, "") == IERC721Receiver.onERC721Received.selector, "UNSAFE_RECIPIENT");
    }

    function _toString(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 j = v; uint256 len; while (j != 0) { len++; j /= 10; }
        bytes memory b = new bytes(len);
        while (v != 0) { len--; b[len] = bytes1(uint8(48 + v % 10)); v /= 10; }
        return string(b);
    }
}
