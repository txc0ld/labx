// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {LabxTestBase} from "./helpers/LabxTestBase.sol";
import {LabxPoints} from "../src/LabxPoints.sol";
import {LabxRaffleHouse} from "../src/LabxRaffleHouse.sol";
import {LabxAmoeGateway} from "../src/LabxAmoeGateway.sol";

/// @notice Both halves of the Alternative Method of Entry: earnable points that convert to entries, and
///         the low-key one-per-person free entry.
contract LabxAmoeTest is LabxTestBase {
    bytes32 internal constant SALT = keccak256("salt");

    // ------------------------------------------------------------------------------------------
    // Points check-ins
    // ------------------------------------------------------------------------------------------

    function test_checkInRequiresAnAttestorSignature() public {
        uint64 deadline = uint64(_now() + 1 hours);
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("CheckIn(address user,uint32 points,bytes32 nonce,uint64 deadline)"),
                alice,
                uint32(10),
                keccak256("n1"),
                deadline
            )
        );
        bytes memory forged = _sign(0xBAD, points.domainSeparator(), structHash);

        vm.expectRevert(LabxPoints.InvalidAttestor.selector);
        points.checkIn(alice, 10, keccak256("n1"), deadline, forged);
    }

    function test_relayedCheckInCreditsPoints() public {
        uint64 deadline = uint64(_now() + 1 hours);
        bytes memory sig = _signCheckIn(alice, 10, keccak256("n1"), deadline);

        // Relayed by an unrelated wallet: LABx pays the gas after verifying captcha + wallet signature.
        vm.prank(bob);
        points.checkIn(alice, 10, keccak256("n1"), deadline, sig);

        assertEq(points.points(alice), 10);
        assertEq(points.checkInStreak(alice), 1);
        assertEq(points.lifetimePoints(alice), 10);
    }

    function test_checkInNonceIsSingleUse() public {
        uint64 deadline = uint64(_now() + 10 days);
        bytes memory sig = _signCheckIn(alice, 10, keccak256("n1"), deadline);
        points.checkIn(alice, 10, keccak256("n1"), deadline, sig);

        vm.warp(_now() + 1 days);
        vm.expectRevert(abi.encodeWithSelector(LabxPoints.NonceUsed.selector, keccak256("n1")));
        points.checkIn(alice, 10, keccak256("n1"), deadline, sig);
    }

    function test_checkInCooldownIsEnforced() public {
        uint64 deadline = uint64(_now() + 10 days);
        points.checkIn(alice, 10, keccak256("n1"), deadline, _signCheckIn(alice, 10, keccak256("n1"), deadline));

        uint64 availableAt = points.nextCheckInAt(alice);
        bytes memory second = _signCheckIn(alice, 10, keccak256("n2"), deadline);
        vm.expectRevert(abi.encodeWithSelector(LabxPoints.CooldownActive.selector, availableAt));
        points.checkIn(alice, 10, keccak256("n2"), deadline, second);

        vm.warp(availableAt);
        points.checkIn(alice, 10, keccak256("n2"), deadline, second);
        assertEq(points.checkInStreak(alice), 2);
    }

    function test_streakResetsAfterALongGap() public {
        uint64 deadline = uint64(_now() + 365 days);
        points.checkIn(alice, 10, keccak256("n1"), deadline, _signCheckIn(alice, 10, keccak256("n1"), deadline));

        vm.warp(_now() + 10 days);
        points.checkIn(alice, 10, keccak256("n2"), deadline, _signCheckIn(alice, 10, keccak256("n2"), deadline));
        assertEq(points.checkInStreak(alice), 1, "a long gap restarts the streak");
    }

    function test_attestationCannotAwardMoreThanTheCap() public {
        uint64 deadline = uint64(_now() + 1 hours);
        uint32 tooMany = points.maxPointsPerCheckIn() + 1;
        bytes memory sig = _signCheckIn(alice, tooMany, keccak256("n1"), deadline);

        vm.expectRevert(
            abi.encodeWithSelector(LabxPoints.PointsAboveLimit.selector, tooMany, points.maxPointsPerCheckIn())
        );
        points.checkIn(alice, tooMany, keccak256("n1"), deadline, sig);
    }

    function test_expiredAttestationIsRejected() public {
        uint64 deadline = uint64(_now() + 1 hours);
        bytes memory sig = _signCheckIn(alice, 10, keccak256("n1"), deadline);
        vm.warp(deadline + 1);
        vm.expectRevert(LabxPoints.AttestationExpired.selector);
        points.checkIn(alice, 10, keccak256("n1"), deadline, sig);
    }

    // ------------------------------------------------------------------------------------------
    // Points -> free entries
    // ------------------------------------------------------------------------------------------

    function test_pointsRedeemIntoZeroValueEntries() public {
        vm.prank(operator);
        points.award(alice, 250, "campaign");
        assertEq(points.redeemableEntries(alice), 2);

        vm.prank(alice);
        points.redeemForEntries(2);

        assertEq(points.points(alice), 50);
        (uint32 paid, uint32 free, uint256 value) = membership.entriesBreakdown(alice);
        assertEq(paid, 0);
        assertEq(free, 2);
        assertEq(value, 0, "AMOE entries carry no pot value");
    }

    function test_redeemRevertsWithoutEnoughPoints() public {
        vm.prank(operator);
        points.award(alice, 99, "campaign");
        vm.expectRevert(abi.encodeWithSelector(LabxPoints.InsufficientPoints.selector, 100, 99));
        vm.prank(alice);
        points.redeemForEntries(1);
    }

    function test_redeemedEntriesWinOnEqualWeightWithPaidEntries() public {
        uint256 raffleId = _createRaffle(1, 0, SALT);

        vm.prank(operator);
        points.award(alice, 500, "campaign");
        vm.prank(alice);
        points.redeemForEntries(5);

        vm.prank(alice);
        raffleHouse.enterWithEntries(raffleId, 5);

        LabxRaffleHouse.Raffle memory raffle = raffleHouse.raffles(raffleId);
        assertEq(raffle.totalEntries, 5, "five free entries weigh the same as five purchased ones");
        assertEq(raffle.pot, 0);

        vm.warp(raffle.endsAt);
        raffleHouse.closeEntries(raffleId);
        vm.prank(operator);
        uint256 requestId = raffleHouse.revealAndDraw(raffleId, 0, SALT);
        vrf.fulfill(requestId, 123);

        assertEq(raffleHouse.raffles(raffleId).winner, alice, "a free-entry holder can win outright");
    }

    function test_operatorCanRevokeAbusivePoints() public {
        vm.prank(operator);
        points.award(alice, 500, "campaign");
        vm.prank(operator);
        points.revoke(alice, 600, "sybil");
        assertEq(points.points(alice), 0, "revoking more than the balance clears it rather than reverting");
    }

    function test_pointsToEntryRateIsAdminConfigurable() public {
        vm.prank(safe);
        points.setPointsPerEntry(10);
        vm.prank(operator);
        points.award(alice, 100, "campaign");
        assertEq(points.redeemableEntries(alice), 10);
    }

    // ------------------------------------------------------------------------------------------
    // Direct free entry
    // ------------------------------------------------------------------------------------------

    function test_directFreeEntryIsEqualWeightAndValueless() public {
        uint256 raffleId = _createRaffle(1, 0, SALT);
        uint64 deadline = uint64(_now() + 1 hours);

        // Three different people each take their single free entry.
        amoe.claimFreeEntry(raffleId, alice, keccak256("a"), deadline, _signFreeEntry(alice, raffleId, keccak256("a"), deadline));
        amoe.claimFreeEntry(raffleId, bob, keccak256("b"), deadline, _signFreeEntry(bob, raffleId, keccak256("b"), deadline));
        amoe.claimFreeEntry(raffleId, carol, keccak256("c"), deadline, _signFreeEntry(carol, raffleId, keccak256("c"), deadline));

        LabxRaffleHouse.Raffle memory raffle = raffleHouse.raffles(raffleId);
        assertEq(raffle.totalEntries, 3);
        assertEq(raffle.pot, 0);
    }

    function test_freeEntryStillRequiresAcceptedTerms() public {
        uint256 raffleId = _createRaffle(1, 0, SALT);
        address stranger = makeAddr("stranger");
        uint64 deadline = uint64(_now() + 1 hours);

        bytes memory attestation = _signFreeEntry(stranger, raffleId, keccak256("s"), deadline);
        vm.expectRevert();
        amoe.claimFreeEntry(raffleId, stranger, keccak256("s"), deadline, attestation);
    }

    function test_freeEntryRefundsAsAFreeLedgerEntry() public {
        uint256 raffleId = _createRaffle(1, 10_000e6, SALT);
        uint64 deadline = uint64(_now() + 1 hours);
        amoe.claimFreeEntry(
            raffleId, alice, keccak256("a"), deadline, _signFreeEntry(alice, raffleId, keccak256("a"), deadline)
        );

        vm.warp(raffleHouse.raffles(raffleId).endsAt);
        raffleHouse.closeEntries(raffleId);
        vm.prank(operator);
        raffleHouse.revealAndRefund(raffleId, 10_000e6, SALT);

        raffleHouse.refundEntrant(raffleId, alice);
        (uint32 paid, uint32 free,) = membership.entriesBreakdown(alice);
        assertEq(paid, 0);
        assertEq(free, 1);
        assertEq(membership.batchAt(alice, 0).expiresAt, uint64(_now()) + 365 days);
    }
}
