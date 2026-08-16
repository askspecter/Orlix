// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * ORLIX Agent — Holder Reward Claim (self-contained, NO imports)
 *
 * One-time $ORLIX reward for ORLIX Agent NFT holders, fixed by a snapshot Merkle root.
 * Leaf = keccak256(bytes.concat(keccak256(abi.encode(account, amount))))
 *        (matches @openzeppelin/merkle-tree "StandardMerkleTree", sorted-pair proof).
 *
 * Flow:
 *   1) Deploy with _token = $ORLIX and _root = snapshot merkle root.
 *   2) Fund this contract with $ORLIX (32 NFTs x 500,000 = 16,000,000).
 *   3) Holder calls claim(amount, proof) once and receives their $ORLIX.
 *
 * NOTE: unaudited. Test with a small amount first.
 */

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract OrlixAgentClaim {
    address public owner;
    IERC20  public immutable token;      // $ORLIX
    bytes32 public merkleRoot;           // snapshot root (account, amount-in-wei)
    bool    public paused;

    mapping(address => bool) public claimed;
    uint256 public totalClaimed;

    uint256 private _lock = 1;           // reentrancy guard

    event Claimed(address indexed account, uint256 amount);
    event RootUpdated(bytes32 root);
    event PausedSet(bool paused);
    event Withdrawn(address indexed to, uint256 amount);
    event OwnershipTransferred(address indexed from, address indexed to);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }
    modifier nonReentrant() { require(_lock == 1, "reentrant"); _lock = 2; _; _lock = 1; }

    constructor(address _token, bytes32 _root) {
        require(_token != address(0), "token=0");
        owner = msg.sender;
        token = IERC20(_token);
        merkleRoot = _root;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    /// @notice Claim your one-time holder reward.
    /// @param amount reward in wei (nftCount * 500000 * 1e18), exactly as snapshotted.
    /// @param proof  Merkle proof for (msg.sender, amount).
    function claim(uint256 amount, bytes32[] calldata proof) external nonReentrant {
        require(!paused, "paused");
        require(!claimed[msg.sender], "already claimed");
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender, amount))));
        require(_verify(proof, merkleRoot, leaf), "invalid proof");
        claimed[msg.sender] = true;
        totalClaimed += amount;
        _safeTransfer(address(token), msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    /// @notice Verify eligibility without spending gas (frontend helper).
    function canClaim(address account, uint256 amount, bytes32[] calldata proof) external view returns (bool) {
        if (claimed[account]) return false;
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(account, amount))));
        return _verify(proof, merkleRoot, leaf);
    }

    function tokenBalance() external view returns (uint256) { return token.balanceOf(address(this)); }

    // -------------------------------------------------------------- owner
    function setRoot(bytes32 _root) external onlyOwner { merkleRoot = _root; emit RootUpdated(_root); }
    function setPaused(bool _p)     external onlyOwner { paused = _p; emit PausedSet(_p); }

    /// @notice Recover leftover / mistaken tokens.
    function withdraw(address _token, address to, uint256 amount) external onlyOwner {
        _safeTransfer(_token, to, amount);
        emit Withdrawn(to, amount);
    }

    function transferOwnership(address to) external onlyOwner {
        require(to != address(0), "to=0");
        emit OwnershipTransferred(owner, to);
        owner = to;
    }

    // -------------------------------------------------------------- internal
    function _verify(bytes32[] calldata proof, bytes32 root, bytes32 leaf) internal pure returns (bool) {
        bytes32 h = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 p = proof[i];
            h = h <= p ? keccak256(abi.encodePacked(h, p)) : keccak256(abi.encodePacked(p, h));
        }
        return h == root;
    }

    function _safeTransfer(address _token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = _token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "transfer failed");
    }
}
