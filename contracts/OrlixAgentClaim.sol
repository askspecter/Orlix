// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// OpenZeppelin v5 (Remix auto-resolves these npm imports)
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title ORLIX Agent — Holder Reward Claim
 * @notice One-time $ORLIX reward for ORLIX Agent NFT holders.
 *         Eligibility + amount are fixed by a snapshot Merkle root
 *         (leaf = keccak256(bytes.concat(keccak256(abi.encode(account, amount)))),
 *          matching @openzeppelin/merkle-tree "StandardMerkleTree").
 *
 *  Flow:
 *   1) Owner deploys with the $ORLIX token + snapshot merkleRoot.
 *   2) Owner funds this contract with enough $ORLIX (32 NFTs x 500,000 = 16,000,000).
 *   3) A holder calls claim(amount, proof) once and receives their $ORLIX.
 *
 *  NOTE: unaudited. Test with a small amount first.
 */
contract OrlixAgentClaim is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20  public immutable token;     // $ORLIX (0x1efd...333c)
    bytes32 public merkleRoot;          // snapshot root (account, amount-in-wei)
    bool    public paused;

    mapping(address => bool) public claimed;
    uint256 public totalClaimed;

    event Claimed(address indexed account, uint256 amount);
    event RootUpdated(bytes32 root);
    event PausedSet(bool paused);
    event Withdrawn(address indexed to, uint256 amount);

    constructor(address _token, bytes32 _root) Ownable(msg.sender) {
        require(_token != address(0), "token=0");
        token = IERC20(_token);
        merkleRoot = _root;
    }

    /// @notice Claim your one-time holder reward.
    /// @param amount reward in wei (nftCount * 500_000 * 1e18), exactly as snapshotted.
    /// @param proof  Merkle proof for (msg.sender, amount).
    function claim(uint256 amount, bytes32[] calldata proof) external nonReentrant {
        require(!paused, "paused");
        require(!claimed[msg.sender], "already claimed");

        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender, amount))));
        require(MerkleProof.verify(proof, merkleRoot, leaf), "invalid proof");

        claimed[msg.sender] = true;
        totalClaimed += amount;
        token.safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    /// @notice Verify eligibility without spending gas (view helper for the frontend).
    function canClaim(address account, uint256 amount, bytes32[] calldata proof)
        external view returns (bool)
    {
        if (claimed[account]) return false;
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(account, amount))));
        return MerkleProof.verify(proof, merkleRoot, leaf);
    }

    // ------------------------------------------------------------------ owner
    function setRoot(bytes32 _root) external onlyOwner { merkleRoot = _root; emit RootUpdated(_root); }
    function setPaused(bool _p)     external onlyOwner { paused = _p; emit PausedSet(_p); }

    /// @notice Recover leftover / unclaimed $ORLIX (or any token sent by mistake).
    function withdraw(address _token, address to, uint256 amount) external onlyOwner {
        IERC20(_token).safeTransfer(to, amount);
        emit Withdrawn(to, amount);
    }

    function tokenBalance() external view returns (uint256) { return token.balanceOf(address(this)); }
}
