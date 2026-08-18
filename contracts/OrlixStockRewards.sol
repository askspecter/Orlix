// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*  OrlixStockRewards — fee-funded stock rewards to activated ORLIX Agents
 *  ---------------------------------------------------------------------------
 *  Same dividend-per-NFT accounting as OrlixDistributor, with two differences:
 *    • the reward token is a tokenized stock (or any ERC-20), set at deploy
 *    • claims are paid into the Agent's ERC-6551 token-bound wallet, not the
 *      owner's EOA — so the stock accumulates INSIDE the NFT.
 *
 *  Flow: fees are used to buy `rewardToken` (off-chain, via the Stock Desk),
 *  the owner deposit()s it here, and it splits evenly across activated Agents.
 *  Anyone can claim on an Agent's behalf — it always lands in that Agent's wallet.
 *
 *  Deploy one per reward stock (e.g. one for AAPLx). No keeper, no on-chain swap.
 *  ⚠️  UNAUDITED. Holds reward tokens transiently. Test before real value.
 * ---------------------------------------------------------------------------
 */

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IERC721 {
    function ownerOf(uint256 tokenId) external view returns (address);
}

interface IERC6551Registry {
    function account(address implementation, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId)
        external view returns (address);
}

contract OrlixStockRewards {
    IERC20  public immutable rewardToken;   // the tokenized stock paid out
    IERC721 public immutable agent;         // ORLIX Agent NFT
    IERC6551Registry public immutable registry;
    address public immutable accountImpl;
    uint256 public immutable accountChainId;
    address public owner;

    uint256 private constant ACC = 1e18;
    uint256 public accPerAgent;
    uint256 public activatedCount;
    uint256 public totalDistributed;
    uint256 public totalClaimed;

    mapping(uint256 => bool)    public activated;
    mapping(uint256 => uint256) private rewardDebt;
    mapping(uint256 => uint256) private credited;

    uint256 private _lock = 1;
    modifier nonReentrant() { require(_lock == 1, "reentrant"); _lock = 2; _; _lock = 1; }
    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    event Activated(uint256 indexed tokenId, address indexed owner);
    event Deactivated(uint256 indexed tokenId, address indexed owner);
    event Deposited(address indexed from, uint256 amount, uint256 activatedCount);
    event Claimed(uint256 indexed tokenId, address indexed wallet, uint256 amount);

    constructor(address _rewardToken, address _agent, address _registry, address _accountImpl, uint256 _accountChainId) {
        require(_rewardToken != address(0) && _agent != address(0) && _registry != address(0), "zero addr");
        rewardToken = IERC20(_rewardToken);
        agent = IERC721(_agent);
        registry = IERC6551Registry(_registry);
        accountImpl = _accountImpl;
        accountChainId = _accountChainId;
        owner = msg.sender;
    }

    /// @notice The token-bound wallet that rewards for `tokenId` are paid into.
    function walletOf(uint256 tokenId) public view returns (address) {
        return registry.account(accountImpl, bytes32(0), accountChainId, address(agent), tokenId);
    }

    function claimable(uint256 tokenId) public view returns (uint256) {
        uint256 pending = activated[tokenId] ? (accPerAgent - rewardDebt[tokenId]) / ACC : 0;
        return credited[tokenId] + pending;
    }

    /// @notice Add reward tokens, split evenly across activated Agents.
    function deposit(uint256 amount) external nonReentrant {
        require(amount > 0, "amount=0");
        require(activatedCount > 0, "no activated agents");
        require(rewardToken.transferFrom(msg.sender, address(this), amount), "pay failed");
        accPerAgent += (amount * ACC) / activatedCount;
        totalDistributed += amount;
        emit Deposited(msg.sender, amount, activatedCount);
    }

    function activate(uint256 tokenId) public {
        require(msg.sender == agent.ownerOf(tokenId), "not owner");
        require(!activated[tokenId], "already active");
        activated[tokenId] = true;
        rewardDebt[tokenId] = accPerAgent;
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

    /// @notice Claim an Agent's stock rewards into its token-bound wallet.
    ///         Permissionless — always pays the Agent's wallet, never the caller.
    function claim(uint256 tokenId) public nonReentrant returns (uint256 amt) {
        _harvest(tokenId);
        amt = credited[tokenId];
        require(amt > 0, "nothing to claim");
        credited[tokenId] = 0;
        totalClaimed += amt;
        address wallet = walletOf(tokenId);
        require(rewardToken.transfer(wallet, amt), "payout failed");
        emit Claimed(tokenId, wallet, amt);
    }

    function claimMany(uint256[] calldata ids) external nonReentrant returns (uint256 total) {
        for (uint256 i = 0; i < ids.length; i++) {
            uint256 tokenId = ids[i];
            _harvest(tokenId);
            uint256 amt = credited[tokenId];
            if (amt > 0) {
                credited[tokenId] = 0;
                total += amt;
                address wallet = walletOf(tokenId);
                require(rewardToken.transfer(wallet, amt), "payout failed");
                emit Claimed(tokenId, wallet, amt);
            }
        }
        require(total > 0, "nothing to claim");
        totalClaimed += total;
    }

    function _harvest(uint256 tokenId) internal {
        if (activated[tokenId]) {
            credited[tokenId] += (accPerAgent - rewardDebt[tokenId]) / ACC;
            rewardDebt[tokenId] = accPerAgent;
        }
    }

    function transferOwnership(address to) external onlyOwner { require(to != address(0), "0"); owner = to; }
}
