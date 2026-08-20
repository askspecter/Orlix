// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * OrlixAgentBox — an on-chain gacha for ORLIX holders on Robinhood Chain.
 *
 * Spend $ORLIX to open a Box. The contract rolls a weighted-random tier and pays
 * the tier's $ORLIX reward straight to a recipient you choose (your Agent's
 * token-bound wallet). Every open is a single transaction, fully settled and
 * verifiable on-chain: the emitted `roll` can be recomputed from the inputs
 * below, so what you pull is exactly what the contract rolled.
 *
 * Self-contained (no imports) so it compiles cleanly in Remix.
 *
 * Randomness note: the roll is seeded from the previous blockhash, prevrandao,
 * the sender/recipient and an internal nonce. On a single-sequencer Orbit L2
 * this is transparent and verifiable but not manipulation-proof against the
 * sequencer — fine for a gacha, and honest about it. Swap in a VRF later if one
 * ships on Robinhood Chain.
 */

interface IERC20 {
  function transfer(address to, uint256 amount) external returns (bool);
  function transferFrom(address from, address to, uint256 amount) external returns (bool);
  function balanceOf(address account) external view returns (uint256);
}

contract OrlixAgentBox {
  address public owner;
  IERC20  public immutable ORLIX;
  uint256 public boxPrice;      // $ORLIX (wei) charged per open
  uint256 public totalOpened;   // running count / boxId source
  bool    public paused;

  // Reward tiers as parallel arrays. weight = relative probability; payout = $ORLIX paid.
  uint256[] private _weight;
  uint256[] private _payout;
  string[]  private _name;
  uint256 public totalWeight;

  uint256 private _nonce;
  uint256 private _lock;

  event BoxOpened(
    address indexed opener,
    address indexed rewardTo,
    uint256 indexed boxId,
    uint256 tier,
    string  tierName,
    uint256 payout,
    uint256 roll
  );
  event TiersSet(uint256 count, uint256 totalWeight);
  event PriceSet(uint256 price);
  event Funded(address indexed from, uint256 amount);
  event OwnershipTransferred(address indexed from, address indexed to);

  modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }
  modifier nonReentrant() { require(_lock == 0, "reentrant"); _lock = 1; _; _lock = 0; }

  constructor(address orlix, uint256 price) {
    require(orlix != address(0), "orlix 0");
    owner = msg.sender;
    ORLIX = IERC20(orlix);
    boxPrice = price;
    emit OwnershipTransferred(address(0), msg.sender);
    emit PriceSet(price);
  }

  // ── admin ──
  function setTiers(uint256[] calldata weights, uint256[] calldata payouts, string[] calldata names) external onlyOwner {
    require(weights.length == payouts.length && weights.length == names.length && weights.length > 0, "len");
    delete _weight; delete _payout; delete _name;
    uint256 tw;
    for (uint256 i; i < weights.length; i++) {
      require(weights[i] > 0, "weight 0");
      _weight.push(weights[i]);
      _payout.push(payouts[i]);
      _name.push(names[i]);
      tw += weights[i];
    }
    totalWeight = tw;
    emit TiersSet(weights.length, tw);
  }

  function setPrice(uint256 p) external onlyOwner { boxPrice = p; emit PriceSet(p); }
  function setPaused(bool p) external onlyOwner { paused = p; }

  /// Top up the prize pool with $ORLIX (approve this contract first).
  function fund(uint256 amount) external {
    require(ORLIX.transferFrom(msg.sender, address(this), amount), "fund");
    emit Funded(msg.sender, amount);
  }

  function withdraw(address to, uint256 amount) external onlyOwner {
    require(ORLIX.transfer(to, amount), "withdraw");
  }

  function transferOwnership(address n) external onlyOwner {
    require(n != address(0), "0");
    emit OwnershipTransferred(owner, n);
    owner = n;
  }

  // ── views ──
  function poolBalance() external view returns (uint256) { return ORLIX.balanceOf(address(this)); }
  function tiersCount() external view returns (uint256) { return _weight.length; }
  function tier(uint256 i) external view returns (uint256 weight, uint256 payout, string memory name) {
    return (_weight[i], _payout[i], _name[i]);
  }

  // ── the pull ──
  /// Open a Box. Pays `boxPrice` $ORLIX (must be approved) and sends the rolled
  /// reward to `rewardTo` (your Agent's wallet, or your own address).
  function open(address rewardTo) external nonReentrant returns (uint256 pickedTier, uint256 payout) {
    require(!paused, "paused");
    require(totalWeight > 0, "no tiers");
    require(rewardTo != address(0), "rewardTo 0");

    // Charge the price into the pool.
    require(ORLIX.transferFrom(msg.sender, address(this), boxPrice), "pay");

    // Verifiable roll: recompute off-chain from these exact inputs.
    uint256 roll = uint256(keccak256(abi.encodePacked(
      blockhash(block.number - 1),
      block.prevrandao,
      block.timestamp,
      msg.sender,
      rewardTo,
      _nonce++,
      totalOpened
    ))) % totalWeight;

    // Pick the tier by cumulative weight.
    uint256 acc;
    uint256 t;
    for (uint256 i; i < _weight.length; i++) {
      acc += _weight[i];
      if (roll < acc) { t = i; break; }
    }
    pickedTier = t;
    payout = _payout[t];

    uint256 boxId = totalOpened++;

    if (payout > 0) {
      uint256 bal = ORLIX.balanceOf(address(this));
      if (payout > bal) payout = bal; // never revert on an underfunded jackpot — pay what's available
      if (payout > 0) require(ORLIX.transfer(rewardTo, payout), "reward");
    }

    emit BoxOpened(msg.sender, rewardTo, boxId, t, _name[t], payout, roll);
  }
}
