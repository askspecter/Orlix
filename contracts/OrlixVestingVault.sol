// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title OrlixVestingVault
 * @notice Generic, multi-token, multi-beneficiary vesting vault for B20 "Vested
 *         allocations" launches. A launch's vested total is minted straight into
 *         this vault as one of the atomic `createB20` initCalls (see
 *         buildInitCalls in api/b20-skill.js), then the creator calls
 *         createSchedule() once per beneficiary, in a follow-up transaction, to
 *         register the cliff + linear release curve for tokens the vault
 *         already holds.
 *
 *         Vesting is linear from `start`: nothing releases before `start + cliff`,
 *         then the claimable amount grows linearly until `start + duration`, at
 *         which point the full `totalAmount` is releasable. Anyone may call
 *         release() — tokens always land in the beneficiary's own address, never
 *         the caller's — so beneficiaries don't need gas or even need to know
 *         this contract exists for tokens to eventually be claimable by them.
 *
 * @dev    UNAUDITED / UNDEPLOYED. Test on a Base fork before pointing the Orlix
 *         frontend at a real address (see contracts/README-vesting.md). Until an
 *         address is deployed and set as B20_VESTING_VAULT, the "Vested
 *         allocations" UI stays disabled — no token is ever minted to
 *         address(0) or an unconfigured address.
 */
contract OrlixVestingVault {
    struct Schedule {
        address token;
        address beneficiary;
        uint128 totalAmount;
        uint128 released;
        uint64  start;
        uint64  cliff;      // seconds after `start` before anything unlocks
        uint64  duration;   // seconds after `start` until fully vested
        bool    revocable;
        bool    revoked;
    }

    mapping(bytes32 => Schedule) public schedules;
    mapping(bytes32 => address) public scheduleCreator;      // who registered it (only they may revoke)
    mapping(address => bytes32[]) public creatorSchedules;   // launch creator => schedule ids
    mapping(address => bytes32[]) public beneficiarySchedules; // beneficiary => schedule ids
    mapping(bytes32 => bool) private _used;                  // id collision guard

    event ScheduleCreated(bytes32 indexed id, address indexed token, address indexed beneficiary, uint256 totalAmount, uint64 start, uint64 cliff, uint64 duration, bool revocable);
    event Released(bytes32 indexed id, address indexed beneficiary, uint256 amount);
    event Revoked(bytes32 indexed id, uint256 refundedAmount);

    error InvalidSchedule();
    error NotFunded();
    error NotRevocable();
    error NotScheduleCreator();
    error NothingToRelease();

    /// @notice Register a vesting schedule for `totalAmount` of `token` that this
    ///         vault already holds (minted here atomically during the B20 launch).
    ///         Callable by anyone who has funded the vault for that token+amount —
    ///         in practice the launch creator, immediately after their token's
    ///         createB20 tx confirms.
    function createSchedule(
        address token,
        address beneficiary,
        uint128 totalAmount,
        uint64 start,
        uint64 cliffSeconds,
        uint64 durationSeconds,
        bool revocable
    ) external returns (bytes32 id) {
        if (beneficiary == address(0) || totalAmount == 0) revert InvalidSchedule();
        if (durationSeconds == 0 || cliffSeconds > durationSeconds) revert InvalidSchedule();
        if (IERC20(token).balanceOf(address(this)) < totalAmount) revert NotFunded();

        id = keccak256(abi.encode(token, beneficiary, totalAmount, start, cliffSeconds, durationSeconds, msg.sender, block.number, creatorSchedules[msg.sender].length));
        if (_used[id]) revert InvalidSchedule();
        _used[id] = true;

        schedules[id] = Schedule({
            token: token,
            beneficiary: beneficiary,
            totalAmount: totalAmount,
            released: 0,
            start: start,
            cliff: cliffSeconds,
            duration: durationSeconds,
            revocable: revocable,
            revoked: false
        });
        scheduleCreator[id] = msg.sender;
        creatorSchedules[msg.sender].push(id);
        beneficiarySchedules[beneficiary].push(id);

        emit ScheduleCreated(id, token, beneficiary, totalAmount, start, cliffSeconds, durationSeconds, revocable);
    }

    function vestedAmount(bytes32 id) public view returns (uint256) {
        Schedule storage s = schedules[id];
        if (s.beneficiary == address(0)) return 0;
        if (s.revoked) return s.released;
        if (block.timestamp <= s.start) return 0;
        uint256 elapsed = block.timestamp - s.start;
        if (elapsed < s.cliff) return 0;
        if (elapsed >= s.duration) return s.totalAmount;
        return (uint256(s.totalAmount) * elapsed) / s.duration;
    }

    function releasable(bytes32 id) public view returns (uint256) {
        uint256 vested = vestedAmount(id);
        uint256 released = schedules[id].released;
        return vested > released ? vested - released : 0;
    }

    /// @notice Anyone can trigger a release; funds always go to the beneficiary.
    function release(bytes32 id) external {
        uint256 amount = releasable(id);
        if (amount == 0) revert NothingToRelease();
        Schedule storage s = schedules[id];
        s.released += uint128(amount);
        require(IERC20(s.token).transfer(s.beneficiary, amount), 'OrlixVestingVault: transfer failed');
        emit Released(id, s.beneficiary, amount);
    }

    /// @notice Only the address that registered the schedule (the launch creator)
    ///         may revoke it, and only if it was created with revocable=true.
    ///         Already-vested (but unclaimed) tokens remain releasable to the
    ///         beneficiary; the unvested remainder is refunded to the creator.
    function revoke(bytes32 id) external {
        if (scheduleCreator[id] != msg.sender) revert NotScheduleCreator();
        Schedule storage s = schedules[id];
        if (!s.revocable || s.revoked) revert NotRevocable();

        uint256 vested = vestedAmount(id);
        uint256 refund = uint256(s.totalAmount) - vested;
        s.revoked = true;
        s.totalAmount = uint128(vested); // caps future releasable() at what had already vested

        if (refund > 0) {
            require(IERC20(s.token).transfer(msg.sender, refund), 'OrlixVestingVault: refund failed');
        }
        emit Revoked(id, refund);
    }

    function beneficiaryScheduleIds(address beneficiary) external view returns (bytes32[] memory) {
        return beneficiarySchedules[beneficiary];
    }

    function creatorScheduleIds(address creator) external view returns (bytes32[] memory) {
        return creatorSchedules[creator];
    }
}
