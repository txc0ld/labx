// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {LabxTestBase} from "./helpers/LabxTestBase.sol";
import {LabxRaffleHouse} from "../src/LabxRaffleHouse.sol";

/// @notice The seller's reserve (minimum pot) never appears on-chain in plaintext while a raffle is
///         live. These tests pin down the whole commit-reveal lifecycle, including the buyer-protection
///         timeout that stops a silent operator from trapping entries.
contract LabxReserveCommitRevealTest is LabxTestBase {
    bytes32 internal constant SALT = keccak256("32-bytes-of-csprng-from-the-backend");
    uint256 internal constant RESERVE = 200e6;

    // ------------------------------------------------------------------------------------------
    // The reserve is hidden and immutable
    // ------------------------------------------------------------------------------------------

    function test_onlyTheCommitmentIsStoredAtCreation() public {
        uint256 raffleId = _createRaffle(1, RESERVE, SALT);
        LabxRaffleHouse.Raffle memory raffle = raffleHouse.raffles(raffleId);

        assertEq(raffle.reserveCommitment, keccak256(abi.encode(RESERVE, SALT)));
        assertEq(raffle.reserveUsdc, 0, "no plaintext reserve on-chain while the raffle is live");
        assertFalse(raffle.reserveRevealed);
    }

    function test_commitmentHelperMatchesTheBackendComputation() public view {
        assertEq(raffleHouse.reserveCommitmentFor(RESERVE, SALT), keccak256(abi.encode(RESERVE, SALT)));
    }

    function test_thereIsNoWayToChangeTheReserveAfterCreation() public {
        _createRaffle(1, RESERVE, SALT);

        // The ABI exposes no reserve setter at all; only `createRaffle` ever writes the commitment.
        string[12] memory forbidden = [
            "setReserve(uint256,uint256)",
            "setReserveCommitment(uint256,bytes32)",
            "updateReserve(uint256,uint256)",
            "updateReserveCommitment(uint256,bytes32)",
            "setMinPot(uint256,uint256)",
            "updateMinPot(uint256,uint256)",
            "setRaffleReserve(uint256,uint256)",
            "recommitReserve(uint256,bytes32)",
            "amendReserve(uint256,uint256,bytes32)",
            "setFloor(uint256,uint256)",
            "updateFloor(uint256,uint256)",
            "overrideReserve(uint256,uint256)"
        ];
        for (uint256 i; i < forbidden.length; ++i) {
            (bool ok,) = address(raffleHouse).call(abi.encodeWithSignature(forbidden[i], uint256(0), uint256(0)));
            assertFalse(ok, forbidden[i]);
        }
    }

    function test_revealMustMatchTheCommitment() public {
        uint256 raffleId = _closedRaffleWithPot(RESERVE, SALT, TIER_SILVER);

        vm.prank(operator);
        vm.expectRevert(LabxRaffleHouse.BadReserveReveal.selector);
        raffleHouse.revealAndDraw(raffleId, RESERVE - 1, SALT); // wrong amount

        vm.prank(operator);
        vm.expectRevert(LabxRaffleHouse.BadReserveReveal.selector);
        raffleHouse.revealAndDraw(raffleId, RESERVE, keccak256("wrong-salt")); // wrong salt
    }

    function test_operatorCannotLowerTheReserveToForceADraw() public {
        // Pot of 100 USDC against a 200 USDC reserve.
        uint256 raffleId = _closedRaffleWithPot(RESERVE, SALT, TIER_SILVER);
        assertEq(raffleHouse.raffles(raffleId).pot, 100e6);

        // Claiming a smaller reserve fails the commitment check, so the draw cannot be forced.
        vm.prank(operator);
        vm.expectRevert(LabxRaffleHouse.BadReserveReveal.selector);
        raffleHouse.revealAndDraw(raffleId, 100e6, SALT);

        // Revealing the true reserve proves it was not met.
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(LabxRaffleHouse.ReserveNotMet.selector, 100e6, RESERVE));
        raffleHouse.revealAndDraw(raffleId, RESERVE, SALT);
    }

    function test_operatorCannotRaiseTheReserveToForceARefund() public {
        // Pot of 450 USDC comfortably clears the 200 USDC reserve.
        uint256 raffleId = _closedRaffleWithPot(RESERVE, SALT, TIER_PLATINUM);
        assertEq(raffleHouse.raffles(raffleId).pot, 450e6);

        vm.prank(operator);
        vm.expectRevert(LabxRaffleHouse.BadReserveReveal.selector);
        raffleHouse.revealAndRefund(raffleId, 1_000e6, SALT);

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(LabxRaffleHouse.ReserveMet.selector, 450e6, RESERVE));
        raffleHouse.revealAndRefund(raffleId, RESERVE, SALT);
    }

    // ------------------------------------------------------------------------------------------
    // The two reveal outcomes
    // ------------------------------------------------------------------------------------------

    function test_revealAndDrawWhenTheReserveIsMet() public {
        uint256 raffleId = _closedRaffleWithPot(RESERVE, SALT, TIER_GOLD); // 245 USDC pot

        vm.expectEmit(true, false, false, true, address(raffleHouse));
        emit LabxRaffleHouse.ReserveRevealed(raffleId, RESERVE, 245e6, true);
        vm.prank(operator);
        uint256 requestId = raffleHouse.revealAndDraw(raffleId, RESERVE, SALT);

        LabxRaffleHouse.Raffle memory raffle = raffleHouse.raffles(raffleId);
        assertEq(uint8(raffle.status), uint8(LabxRaffleHouse.RaffleStatus.Drawing));
        assertTrue(raffle.reserveRevealed);
        assertEq(raffle.reserveUsdc, RESERVE, "the reserve becomes public once it has been acted on");

        vrf.fulfill(requestId, 1);
        assertEq(raffleHouse.raffles(raffleId).winner, alice);
    }

    function test_revealAndRefundWhenTheReserveIsNotMet() public {
        uint256 raffleId = _closedRaffleWithPot(1_000e6, SALT, TIER_SILVER); // 100 USDC pot

        vm.expectEmit(true, false, false, true, address(raffleHouse));
        emit LabxRaffleHouse.ReserveRevealed(raffleId, 1_000e6, 100e6, false);
        vm.prank(operator);
        raffleHouse.revealAndRefund(raffleId, 1_000e6, SALT);

        LabxRaffleHouse.Raffle memory raffle = raffleHouse.raffles(raffleId);
        assertEq(uint8(raffle.status), uint8(LabxRaffleHouse.RaffleStatus.Refunding));
        assertEq(raffle.reserveUsdc, 1_000e6, "the reveal proves why the draw did not happen");
        assertEq(nft.ownerOf(1), seller, "the prize goes back to the seller");

        raffleHouse.refundEntrant(raffleId, alice);
        assertEq(membership.entriesAvailable(alice), 25, "entries return to the member's balance");
        assertEq(raffleHouse.raffles(raffleId).pot, 0);
    }

    function test_reserveCanOnlyBeRevealedOnce() public {
        uint256 raffleId = _closedRaffleWithPot(RESERVE, SALT, TIER_GOLD);

        vm.prank(operator);
        raffleHouse.revealAndDraw(raffleId, RESERVE, SALT);

        // Status has moved to Drawing, so a second reveal is rejected on status alone.
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                LabxRaffleHouse.WrongStatus.selector,
                LabxRaffleHouse.RaffleStatus.Drawing,
                LabxRaffleHouse.RaffleStatus.Closed
            )
        );
        raffleHouse.revealAndRefund(raffleId, RESERVE, SALT);
    }

    function test_redrawDoesNotRequireAnotherReveal() public {
        uint256 raffleId = _closedRaffleWithPot(RESERVE, SALT, TIER_GOLD);
        vm.prank(operator);
        uint256 requestId = raffleHouse.revealAndDraw(raffleId, RESERVE, SALT);
        vrf.fulfill(requestId, 1);

        vm.warp(raffleHouse.raffles(raffleId).claimDeadline + 1);
        vm.prank(operator);
        raffleHouse.redraw(raffleId);

        // Back to Closed with the reserve already revealed: a fresh reveal would be rejected.
        vm.prank(operator);
        vm.expectRevert(LabxRaffleHouse.ReserveAlreadyRevealed.selector);
        raffleHouse.revealAndDraw(raffleId, RESERVE, SALT);

        vm.prank(operator);
        raffleHouse.requestRedraw(raffleId);
        assertEq(uint8(raffleHouse.raffles(raffleId).status), uint8(LabxRaffleHouse.RaffleStatus.Drawing));
    }

    function test_requestRedrawRequiresAPriorReveal() public {
        uint256 raffleId = _closedRaffleWithPot(RESERVE, SALT, TIER_GOLD);
        vm.prank(operator);
        vm.expectRevert(LabxRaffleHouse.ReserveNotRevealed.selector);
        raffleHouse.requestRedraw(raffleId);
    }

    // ------------------------------------------------------------------------------------------
    // Buyer protection: the operator-timeout fallback
    // ------------------------------------------------------------------------------------------

    function test_anyoneCanForceRefundsWhenTheOperatorNeverReveals() public {
        uint256 raffleId = _closedRaffleWithPot(RESERVE, SALT, TIER_PLATINUM);

        uint64 availableAt = raffleHouse.refundTimeoutAt(raffleId);
        assertEq(availableAt, raffleHouse.raffles(raffleId).closedAt + raffleHouse.config().operatorActionWindow);

        vm.expectRevert(abi.encodeWithSelector(LabxRaffleHouse.TimeoutNotReached.selector, availableAt));
        vm.prank(carol);
        raffleHouse.forceRefundAfterTimeout(raffleId);

        vm.warp(availableAt + 1);
        vm.expectEmit(true, false, false, true, address(raffleHouse));
        emit LabxRaffleHouse.RefundStarted(raffleId, "operator-timeout");
        vm.prank(carol); // an unrelated wallet, with no role
        raffleHouse.forceRefundAfterTimeout(raffleId);

        assertEq(nft.ownerOf(1), seller);
        raffleHouse.refundEntrant(raffleId, alice);
        assertEq(membership.entriesAvailable(alice), 150);
        assertEq(
            raffleHouse.raffles(raffleId).reserveUsdc, 0, "a forced refund needs no reveal, so the reserve stays secret"
        );
    }

    function test_timeoutAlsoCoversAStalledVrfRequest() public {
        uint256 raffleId = _closedRaffleWithPot(RESERVE, SALT, TIER_GOLD);
        vm.prank(operator);
        raffleHouse.revealAndDraw(raffleId, RESERVE, SALT);

        // The coordinator never calls back (unfunded subscription, outage, ...).
        uint64 availableAt = raffleHouse.refundTimeoutAt(raffleId);
        vm.warp(availableAt + 1);
        vm.prank(carol);
        raffleHouse.forceRefundAfterTimeout(raffleId);

        assertEq(uint8(raffleHouse.raffles(raffleId).status), uint8(LabxRaffleHouse.RaffleStatus.Refunding));
        raffleHouse.refundEntrant(raffleId, alice);
        assertEq(membership.entriesAvailable(alice), 70);
    }

    function test_lateVrfCallbackCannotOverturnAForcedRefund() public {
        uint256 raffleId = _closedRaffleWithPot(RESERVE, SALT, TIER_GOLD);
        vm.prank(operator);
        uint256 requestId = raffleHouse.revealAndDraw(raffleId, RESERVE, SALT);

        vm.warp(raffleHouse.refundTimeoutAt(raffleId) + 1);
        vm.prank(carol);
        raffleHouse.forceRefundAfterTimeout(raffleId);

        vrf.fulfill(requestId, 1); // arrives after the refund; must be a no-op
        LabxRaffleHouse.Raffle memory raffle = raffleHouse.raffles(raffleId);
        assertEq(uint8(raffle.status), uint8(LabxRaffleHouse.RaffleStatus.Refunding));
        assertEq(raffle.winner, address(0));
    }

    function test_timeoutAlsoCoversAnUndeliveredWin() public {
        uint256 raffleId = _closedRaffleWithPot(RESERVE, SALT, TIER_GOLD);
        vm.prank(operator);
        uint256 requestId = raffleHouse.revealAndDraw(raffleId, RESERVE, SALT);
        vrf.fulfill(requestId, 1);

        vm.warp(raffleHouse.refundTimeoutAt(raffleId) + 1);
        vm.prank(carol);
        raffleHouse.forceRefundAfterTimeout(raffleId);
        assertEq(nft.ownerOf(1), seller);
    }

    function test_timeoutIsNotAvailableWhileTheRaffleIsStillOpen() public {
        uint256 raffleId = _createRaffle(1, RESERVE, SALT);
        assertEq(raffleHouse.refundTimeoutAt(raffleId), 0);

        vm.expectRevert(
            abi.encodeWithSelector(
                LabxRaffleHouse.WrongStatus.selector,
                LabxRaffleHouse.RaffleStatus.Open,
                LabxRaffleHouse.RaffleStatus.Closed
            )
        );
        raffleHouse.forceRefundAfterTimeout(raffleId);
    }

    function test_operatorWindowIsAdminTunable() public {
        LabxRaffleHouse.Config memory config = raffleHouse.config();
        config.operatorActionWindow = 10 days;
        vm.prank(safe);
        raffleHouse.setConfig(config);

        uint256 raffleId = _closedRaffleWithPot(RESERVE, SALT, TIER_GOLD);
        assertEq(raffleHouse.refundTimeoutAt(raffleId), raffleHouse.raffles(raffleId).closedAt + 10 days);
    }

    function testFuzz_commitmentIsOnlySatisfiedByTheExactPair(uint256 reserve, bytes32 salt, uint256 guess) public {
        reserve = bound(reserve, 1, 1_000_000e6);
        vm.assume(guess != reserve);

        uint256 raffleId = _createRaffle(1, reserve, salt);
        vm.prank(alice);
        raffleHouse.buyPackWithUsdc(raffleId, TIER_PLATINUM, 0);
        vm.warp(raffleHouse.raffles(raffleId).endsAt);
        raffleHouse.closeEntries(raffleId);

        vm.prank(operator);
        vm.expectRevert(LabxRaffleHouse.BadReserveReveal.selector);
        raffleHouse.revealAndDraw(raffleId, guess, salt);
    }

    function _closedRaffleWithPot(uint256 reserve, bytes32 salt, uint8 tierId) internal returns (uint256 raffleId) {
        raffleId = _createRaffle(1, reserve, salt);
        vm.prank(alice);
        raffleHouse.buyPackWithUsdc(raffleId, tierId, 0);
        vm.warp(raffleHouse.raffles(raffleId).endsAt);
        raffleHouse.closeEntries(raffleId);
    }
}
