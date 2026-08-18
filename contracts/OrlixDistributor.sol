// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*  OrlixDistributor — fee distributions to activated ORLIX Agents
 *  ---------------------------------------------------------------------------
 *  Trade fees (or any $ORLIX) deposited here are split evenly across every
 *  *activated* Agent. Holders activate their Agents to start earning, then
 *  pull their share whenever they like. Standard dividend-per-NFT accounting:
 *  O(1) deposit, O(1) claim, no loops over holders.
 *
 *    activate(id)      owner opts an Agent in — earns from this point on
 *    deposit(amount)   adds $ORLIX, split across all activated Agents
 *    claim(id)         current owner pulls that Agent's accrued $ORLIX
 *
 *  Rewards accrue to the Agent (tokenId); whoever owns it at claim time is paid.
 *
 *  ⚠️  UNAUDITED. Holds user funds. Test on the Agent NFT before real value.
 * ---------------------------------------------------------------------------
 */

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address a) external view returns (uint256);
}

interface IERC721 {
    function ownerOf(uint256 tokenId) external view returns (address);
}

contract OrlixDistributor {
    IERC20  public immutable orlix;   // $ORLIX token
    IERC721 public immutable agent;   // ORLIX Agent NFT (Phase 2)
    address public owner;

    uint256 private constant ACC = 1e18;
    uint256 public accPerAgent;       // scaled cumulative $ORLIX per activated Agent
    uint256 public activatedCount;    // how many Agents are currently activated
    uint256 public totalDistributed;  // lifetime $ORLIX deposited for distribution
    uint256 public totalClaimed;      // lifetime $ORLIX claimed

    mapping(uint256 => bool)    public activated;   // tokenId => activated?
    mapping(uint256 => uint256) private rewardDebt; // tokenId => scaled checkpoint
    mapping(uint256 => uint256) private credited;   // tokenId => harvested, unclaimed $ORLIX

    uint256 private _lock = 1;
    modifier nonReentrant() { require(_lock == 1, "reentrant"); _lock = 2; _; _lock = 1; }
    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    event Activated(uint256 indexed tokenId, address indexed owner);
    event Deactivated(uint256 indexed tokenId, address indexed owner);
    event Deposited(address indexed from, uint256 amount, uint256 activatedCount);
    event Claimed(uint256 indexed tokenId, address indexed to, uint256 amount);

    constructor(address _orlix, address _agent) {
        require(_orlix != address(0) && _agent != address(0), "zero addr");
        orlix = IERC20(_orlix);
        agent = IERC721(_agent);
        owner = msg.sender;
    }

    // ============================================================ views
    /// @notice $ORLIX currently claimable for `tokenId` (harvested + pending).
    function claimable(uint256 tokenId) public view returns (uint256) {
        uint256 pending = activated[tokenId] ? (accPerAgent - rewardDebt[tokenId]) / ACC : 0;
        return credited[tokenId] + pending;
    }

    // ============================================================ deposit
    /// @notice Add `amount` $ORLIX, split evenly across all activated Agents.
    ///         Caller must approve this contract for `amount` first.
    function deposit(uint256 amount) external nonReentrant {
        require(amount > 0, "amount=0");
        require(activatedCount > 0, "no activated agents");
        require(orlix.transferFrom(msg.sender, address(this), amount), "pay failed");
        accPerAgent += (amount * ACC) / activatedCount;
        totalDistributed += amount;
        emit Deposited(msg.sender, amount, activatedCount);
    }

    // ============================================================ activate
    function activate(uint256 tokenId) public {
        require(msg.sender == agent.ownerOf(tokenId), "not owner");
        require(!activated[tokenId], "already active");
        activated[tokenId] = true;
        rewardDebt[tokenId] = accPerAgent; // start earning from now
        activatedCount++;
        emit Activated(tokenId, msg.sender);
    }

    function deactivate(uint256 tokenId) public {
        require(msg.sender == agent.ownerOf(tokenId), "not owner");
        require(activated[tokenId], "not active");
        _harvest(tokenId);
        activated[tokenId] = false;
        activatedCount--;
        emit Deactivated(tokenId, msg.sender);
    }

    function activateMany(uint256[] calldata ids) external {
        for (uint256 i = 0; i < ids.length; i++) activate(ids[i]);
    }

    // ============================================================ claim
    function claim(uint256 tokenId) public nonReentrant returns (uint256 amt) {
        address o = agent.ownerOf(tokenId);
        require(msg.sender == o, "not owner");
        _harvest(tokenId);
        amt = credited[tokenId];
        require(amt > 0, "nothing to claim");
        credited[tokenId] = 0;
        totalClaimed += amt;
        require(orlix.transfer(o, amt), "payout failed");
        emit Claimed(tokenId, o, amt);
    }

    /// @notice Claim several Agents you own in one tx.
    function claimMany(uint256[] calldata ids) external nonReentrant returns (uint256 total) {
        for (uint256 i = 0; i < ids.length; i++) {
            uint256 tokenId = ids[i];
            address o = agent.ownerOf(tokenId);
            require(msg.sender == o, "not owner");
            _harvest(tokenId);
            uint256 amt = credited[tokenId];
            if (amt > 0) {
                credited[tokenId] = 0;
                total += amt;
                emit Claimed(tokenId, o, amt);
            }
        }
        require(total > 0, "nothing to claim");
        totalClaimed += total;
        require(orlix.transfer(msg.sender, total), "payout failed");
    }

    // ============================================================ internal
    function _harvest(uint256 tokenId) internal {
        if (activated[tokenId]) {
            credited[tokenId] += (accPerAgent - rewardDebt[tokenId]) / ACC;
            rewardDebt[tokenId] = accPerAgent;
        }
    }

    // ============================================================ admin
    function transferOwnership(address to) external onlyOwner { require(to != address(0), "0"); owner = to; }
}
