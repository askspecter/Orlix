// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*  OrlixAgentAMM — instant NFT liquidity for ORLIX Agent  ⇄  $ORLIX
 *  ---------------------------------------------------------------------------
 *  A single constant-product (x*y=k) pool that lets anyone:
 *    • BUY  an Agent from the pool, paying $ORLIX          → buy(n, maxCost)
 *    • SELL an Agent back to the pool, receiving $ORLIX    → sell(ids, minOut)
 *  No counterparty, no listings — price is set by the pool's reserves.
 *
 *  Reserves:  x = tokenReserve ($ORLIX)   y = nftReserve (Agents held)
 *  Buy  n:   cost     = x*n/(y-n)  (+fee)   →  y falls, price rises
 *  Sell n:   proceeds = x*n/(y+n)  (-fee)   →  y rises,  price falls
 *
 *  Liquidity is seeded & managed by the owner (project-run pool, no LP tokens).
 *
 *  ⚠️  UNAUDITED. This holds user funds. Get it audited and test on a
 *      testnet before deploying to mainnet or seeding real liquidity.
 * ---------------------------------------------------------------------------
 */

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address a) external view returns (uint256);
}

interface IERC721 {
    function transferFrom(address from, address to, uint256 id) external;
    function ownerOf(uint256 id) external view returns (address);
}

contract OrlixAgentAMM {
    // ------------------------------------------------------------ config
    IERC20  public immutable orlix;   // $ORLIX token
    IERC721 public immutable agent;   // ORLIX Agent NFT (Phase 2)

    address public owner;
    address public feeTo;             // where trade fees go; if 0, fees stay in the pool
    uint16  public feeBps;            // trade fee in basis points (e.g. 200 = 2%)
    bool    public paused;

    uint256 public tokenReserve;      // virtual $ORLIX reserve (x)
    uint256[] private held;           // Agent token ids currently in the pool (y = held.length)

    // ------------------------------------------------------------ events
    event Buy(address indexed buyer, uint256 quantity, uint256 cost);
    event Sell(address indexed seller, uint256 quantity, uint256 proceeds);
    event LiquidityAdded(uint256 tokenAmount, uint256 nftCount);
    event LiquidityRemoved(uint256 tokenAmount, uint256 nftCount);
    event FeeSet(uint16 feeBps, address feeTo);
    event PausedSet(bool paused);
    event OwnerSet(address owner);

    // ------------------------------------------------------------ guards
    uint256 private _lock = 1;
    modifier nonReentrant() { require(_lock == 1, "reentrant"); _lock = 2; _; _lock = 1; }
    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    constructor(address _orlix, address _agent, uint16 _feeBps, address _feeTo) {
        require(_orlix != address(0) && _agent != address(0), "zero addr");
        require(_feeBps <= 1000, "fee too high"); // max 10%
        orlix  = IERC20(_orlix);
        agent  = IERC721(_agent);
        feeBps = _feeBps;
        feeTo  = _feeTo;
        owner  = msg.sender;
    }

    // ============================================================ views
    function nftReserve() public view returns (uint256) { return held.length; }
    function heldCount()  external view returns (uint256) { return held.length; }
    function heldAt(uint256 i) external view returns (uint256) { return held[i]; }

    /// @notice $ORLIX cost to BUY `n` Agents (fee included).
    function getBuyPrice(uint256 n) public view returns (uint256) {
        uint256 y = held.length;
        require(n > 0 && n < y, "bad qty");
        uint256 base = (tokenReserve * n) / (y - n);
        return base + (base * feeBps) / 10000;
    }

    /// @notice $ORLIX you receive to SELL `n` Agents (fee deducted).
    function getSellPrice(uint256 n) public view returns (uint256) {
        require(n > 0, "bad qty");
        uint256 y = held.length;
        uint256 base = (tokenReserve * n) / (y + n);
        return base - (base * feeBps) / 10000;
    }

    // ============================================================ trade
    /// @notice Buy `n` Agents from the pool. Caller must approve $ORLIX for `maxCost` first.
    ///         Agents are dispensed from the end of the inventory (LIFO).
    function buy(uint256 n, uint256 maxCost) external nonReentrant {
        require(!paused, "paused");
        uint256 y = held.length;
        require(n > 0 && n < y, "bad qty");

        uint256 base = (tokenReserve * n) / (y - n);
        uint256 fee  = (base * feeBps) / 10000;
        uint256 cost = base + fee;
        require(cost <= maxCost, "slippage");

        require(orlix.transferFrom(msg.sender, address(this), cost), "pay failed");
        tokenReserve += base;                       // fee handled below
        if (fee > 0) {
            if (feeTo != address(0)) require(orlix.transfer(feeTo, fee), "fee xfer");
            else tokenReserve += fee;               // fee stays in pool
        }

        for (uint256 i = 0; i < n; i++) {
            uint256 id = held[held.length - 1];
            held.pop();
            agent.transferFrom(address(this), msg.sender, id);
        }
        emit Buy(msg.sender, n, cost);
    }

    /// @notice Sell your Agents to the pool. Caller must approve the NFTs to this contract first.
    function sell(uint256[] calldata ids, uint256 minProceeds) external nonReentrant {
        require(!paused, "paused");
        uint256 n = ids.length;
        require(n > 0, "bad qty");

        uint256 y = held.length;
        uint256 base = (tokenReserve * n) / (y + n);
        uint256 fee  = (base * feeBps) / 10000;
        uint256 proceeds = base - fee;
        require(proceeds >= minProceeds, "slippage");
        require(proceeds <= tokenReserve, "pool dry");

        for (uint256 i = 0; i < n; i++) {
            agent.transferFrom(msg.sender, address(this), ids[i]); // pulls NFT in (needs approval)
            held.push(ids[i]);
        }

        tokenReserve -= base;
        if (fee > 0 && feeTo != address(0)) { require(orlix.transfer(feeTo, fee), "fee xfer"); }
        else { tokenReserve += fee; }               // keep fee in the pool if no feeTo
        require(orlix.transfer(msg.sender, proceeds), "payout failed");
        emit Sell(msg.sender, n, proceeds);
    }

    // ============================================================ liquidity (owner)
    /// @notice Seed the pool. Owner must approve $ORLIX (tokenAmount) and each NFT to this contract.
    function addLiquidity(uint256 tokenAmount, uint256[] calldata ids) external onlyOwner nonReentrant {
        if (tokenAmount > 0) {
            require(orlix.transferFrom(msg.sender, address(this), tokenAmount), "orlix in");
            tokenReserve += tokenAmount;
        }
        for (uint256 i = 0; i < ids.length; i++) {
            agent.transferFrom(msg.sender, address(this), ids[i]);
            held.push(ids[i]);
        }
        emit LiquidityAdded(tokenAmount, ids.length);
    }

    /// @notice Withdraw liquidity to `to`. Sends `tokenAmount` $ORLIX and the last `nftCount` Agents.
    function removeLiquidity(uint256 tokenAmount, uint256 nftCount, address to) external onlyOwner nonReentrant {
        require(to != address(0), "to=0");
        require(tokenAmount <= tokenReserve, "amt>reserve");
        require(nftCount <= held.length, "cnt>held");
        if (tokenAmount > 0) { tokenReserve -= tokenAmount; require(orlix.transfer(to, tokenAmount), "orlix out"); }
        for (uint256 i = 0; i < nftCount; i++) {
            uint256 id = held[held.length - 1];
            held.pop();
            agent.transferFrom(address(this), to, id);
        }
        emit LiquidityRemoved(tokenAmount, nftCount);
    }

    // ============================================================ admin
    function setFee(uint16 _feeBps, address _feeTo) external onlyOwner {
        require(_feeBps <= 1000, "fee too high");
        feeBps = _feeBps; feeTo = _feeTo; emit FeeSet(_feeBps, _feeTo);
    }
    function setPaused(bool _p) external onlyOwner { paused = _p; emit PausedSet(_p); }
    function transferOwnership(address _o) external onlyOwner { require(_o != address(0), "0"); owner = _o; emit OwnerSet(_o); }

    /// @notice Accept NFTs sent via safeTransferFrom (not required by buy/sell, which use transferFrom).
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
