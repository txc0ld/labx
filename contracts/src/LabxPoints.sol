// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {LabxRoles} from "./base/LabxRoles.sol";
import {ILabxMembership} from "./interfaces/ILabxMembership.sol";

/// @title LabxPoints
/// @notice The earnable half of LABx's Alternative Method of Entry: members accumulate points from
///         bot-gated daily check-ins and convert them into free entries.
///
/// @dev The bot gate lives off-chain by necessity. A check-in is only accepted here when accompanied by
///      an EIP-712 attestation from an `ATTESTOR_ROLE` key, which the LABx API issues after it has
///      verified both a Cloudflare Turnstile (or hCaptcha) token and a wallet signature proving control
///      of the address. Attestations are single-use (nonce) and short-lived (deadline), and anyone may
///      relay one, so LABx can pay the gas on a member's behalf.
contract LabxPoints is LabxRoles, EIP712 {
    bytes32 private constant CHECK_IN_TYPEHASH =
        keccak256("CheckIn(address user,uint32 points,bytes32 nonce,uint64 deadline)");

    ILabxMembership public immutable membership;

    /// @notice Points burned per free entry minted.
    uint32 public pointsPerEntry = 100;
    /// @notice Minimum gap between two accepted check-ins for the same wallet.
    uint64 public checkInCooldown = 20 hours;
    /// @notice Upper bound on points a single attestation may award, limiting a compromised attestor key.
    uint32 public maxPointsPerCheckIn = 50;

    mapping(address user => uint256) public points;
    mapping(address user => uint64) public lastCheckInAt;
    mapping(address user => uint32) public checkInStreak;
    mapping(address user => uint256) public lifetimePoints;
    mapping(bytes32 nonce => bool) public nonceUsed;

    event CheckedIn(address indexed user, uint32 pointsAwarded, uint32 streak, uint256 balance);
    event PointsAwarded(address indexed user, uint256 amount, bytes32 reason);
    event PointsRevoked(address indexed user, uint256 amount, bytes32 reason);
    event PointsRedeemed(address indexed user, uint32 entries, uint256 pointsBurned);
    event PointsPerEntryUpdated(uint32 pointsPerEntry);
    event CheckInCooldownUpdated(uint64 cooldown);
    event MaxPointsPerCheckInUpdated(uint32 maxPoints);

    error AttestationExpired();
    error NonceUsed(bytes32 nonce);
    error InvalidAttestor();
    error CooldownActive(uint64 availableAt);
    error PointsAboveLimit(uint32 requested, uint32 limit);
    error ZeroEntries();
    error InsufficientPoints(uint256 required, uint256 balance);
    error InvalidConfig();

    constructor(address admin, address membership_) LabxRoles(admin) EIP712("LABx Points", "1") {
        if (membership_ == address(0)) revert ZeroAddress();
        membership = ILabxMembership(membership_);
    }

    // --------------------------------------------------------------------------------------------
    // Admin
    // --------------------------------------------------------------------------------------------

    function setPointsPerEntry(uint32 value) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (value == 0) revert InvalidConfig();
        pointsPerEntry = value;
        emit PointsPerEntryUpdated(value);
    }

    function setCheckInCooldown(uint64 cooldown) external onlyRole(DEFAULT_ADMIN_ROLE) {
        checkInCooldown = cooldown;
        emit CheckInCooldownUpdated(cooldown);
    }

    function setMaxPointsPerCheckIn(uint32 maxPoints) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (maxPoints == 0) revert InvalidConfig();
        maxPointsPerCheckIn = maxPoints;
        emit MaxPointsPerCheckInUpdated(maxPoints);
    }

    /// @notice Grants points outside the check-in flow (campaigns, support goodwill).
    function award(address user, uint256 amount, bytes32 reason) external onlyRole(OPERATIONS_ROLE) {
        points[user] += amount;
        lifetimePoints[user] += amount;
        emit PointsAwarded(user, amount, reason);
    }

    /// @notice Removes points obtained through abuse.
    function revoke(address user, uint256 amount, bytes32 reason) external onlyRole(OPERATIONS_ROLE) {
        uint256 balance = points[user];
        uint256 removed = amount > balance ? balance : amount;
        points[user] = balance - removed;
        emit PointsRevoked(user, removed, reason);
    }

    // --------------------------------------------------------------------------------------------
    // Check-ins
    // --------------------------------------------------------------------------------------------

    /// @notice Records a bot-gated check-in for `user` and credits points.
    function checkIn(address user, uint32 pointsAwarded, bytes32 nonce, uint64 deadline, bytes calldata attestation)
        external
    {
        if (block.timestamp > deadline) revert AttestationExpired();
        if (nonceUsed[nonce]) revert NonceUsed(nonce);
        if (pointsAwarded == 0 || pointsAwarded > maxPointsPerCheckIn) {
            revert PointsAboveLimit(pointsAwarded, maxPointsPerCheckIn);
        }

        uint64 last = lastCheckInAt[user];
        uint64 availableAt = last + checkInCooldown;
        if (last != 0 && block.timestamp < availableAt) revert CooldownActive(availableAt);

        bytes32 structHash = keccak256(abi.encode(CHECK_IN_TYPEHASH, user, pointsAwarded, nonce, deadline));
        address signer = ECDSA.recover(_hashTypedDataV4(structHash), attestation);
        if (!hasRole(ATTESTOR_ROLE, signer)) revert InvalidAttestor();

        nonceUsed[nonce] = true;

        // A check-in inside two cooldown windows continues the streak; a longer gap restarts it.
        uint32 streak = (last != 0 && block.timestamp <= last + (checkInCooldown * 2)) ? checkInStreak[user] + 1 : 1;
        checkInStreak[user] = streak;
        lastCheckInAt[user] = uint64(block.timestamp);

        uint256 balance = points[user] + pointsAwarded;
        points[user] = balance;
        lifetimePoints[user] += pointsAwarded;

        emit CheckedIn(user, pointsAwarded, streak, balance);
    }

    // --------------------------------------------------------------------------------------------
    // Redemption
    // --------------------------------------------------------------------------------------------

    /// @notice Burns points to mint free entries into the caller's platform-wide entry balance.
    /// @dev Those entries carry no pot value and expire on the same 12-month schedule as paid entries.
    function redeemForEntries(uint32 entries) external {
        if (entries == 0) revert ZeroEntries();
        uint256 cost = uint256(entries) * pointsPerEntry;
        uint256 balance = points[msg.sender];
        if (balance < cost) revert InsufficientPoints(cost, balance);

        points[msg.sender] = balance - cost;
        membership.creditFreeEntries(msg.sender, entries, "amoe-points");
        emit PointsRedeemed(msg.sender, entries, cost);
    }

    /// @notice Entries the caller could mint right now from their points balance.
    function redeemableEntries(address user) external view returns (uint32) {
        return uint32(points[user] / pointsPerEntry);
    }

    function nextCheckInAt(address user) external view returns (uint64) {
        uint64 last = lastCheckInAt[user];
        // slither-disable-next-line incorrect-equality  (0 is the "never checked in" sentinel)
        return last == 0 ? uint64(block.timestamp) : last + checkInCooldown;
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
