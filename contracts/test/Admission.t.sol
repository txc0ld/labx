// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {PercentageFeeFixture} from "./PercentageFees.t.sol";
import {LabxRaffle} from "../src/LabxRaffle.sol";
import {MockVRF} from "./mocks/Mocks.sol";

contract AdmissionTest is PercentageFeeFixture {
    function _draft(bool escrowed) internal returns (uint256 id) {
        uint256 token = raffle.nextId();
        nft.mint(seller, token);
        vm.startPrank(seller);
        id = raffle.createRaffle(
            address(nft),
            token,
            uint64(block.timestamp + 3 days),
            keccak256("nonce"),
            keccak256("commit"),
            "Review",
            _configs()
        );
        if (escrowed) {
            nft.approve(address(raffle), token);
            raffle.escrow(id);
        }
        vm.stopPrank();
    }

    function _configs() internal pure returns (LabxRaffle.PackConfig[] memory p) {
        p = new LabxRaffle.PackConfig[](1);
        p[0] = LabxRaffle.PackConfig("Entry", 25e6, 1, 100);
    }

    function _edit(uint256 id, string memory title) internal {
        LabxRaffle.RaffleView memory r = raffle.getRaffle(id);
        vm.prank(seller);
        raffle.updateDraft(id, r.nft, r.tokenId, r.salesEnd, r.reserveNonce, r.reserveCommit, title, _configs());
    }

    function _cannotOpen(uint256 id) internal {
        bytes32 policy = raffle.openingPolicyHash();
        vm.prank(seller);
        vm.expectRevert(LabxRaffle.AdmissionRequired.selector);
        raffle.open(id);
        vm.prank(seller);
        vm.expectRevert(LabxRaffle.AdmissionRequired.selector);
        raffle.openWithPolicy(id, policy);
    }

    function test_bothSelectorsRequireCurrentAdmissionAndEditsNeverRestoreOldApproval() public {
        uint256 id = _draft(true);
        assertEq(raffle.getRaffleAdmission(id).reviewRevision, 1);
        _cannotOpen(id);
        bytes32 initial = raffle.draftReviewHash(id);
        vm.prank(alice);
        vm.expectRevert(LabxRaffle.NotOwner.selector);
        raffle.approveRaffle(id, initial);
        raffle.approveRaffle(id, initial);
        _edit(id, "Changed");
        _edit(id, "Review");
        assertEq(raffle.getRaffleAdmission(id).reviewRevision, 3);
        assertNotEq(raffle.draftReviewHash(id), initial);
        _cannotOpen(id);
        vm.expectRevert(LabxRaffle.ReviewChanged.selector);
        raffle.approveRaffle(id, initial);
        vm.expectRevert(LabxRaffle.ReviewChanged.selector);
        raffle.revokeRaffleApproval(id, initial);
        _approveAdmission(raffle, id);
        vm.prank(seller);
        raffle.open(id);
        assertTrue(raffle.getRaffleAdmission(id).approvedAtOpening);
    }

    function test_revokeStaleApprovalBumpsRevisionAndRejectsQueuedApprove() public {
        uint256 id = _draft(true);
        bytes32 initial = raffle.draftReviewHash(id);
        raffle.approveRaffle(id, initial);
        _edit(id, "Changed");
        bytes32 current = raffle.draftReviewHash(id);
        vm.expectEmit(true, true, true, true);
        emit LabxRaffle.RaffleApprovalRevoked(id, address(this), current, 3);
        raffle.revokeRaffleApproval(id, current);
        assertEq(raffle.getRaffleAdmission(id).approvedBy, address(0));
        vm.expectRevert(LabxRaffle.ReviewChanged.selector);
        raffle.approveRaffle(id, current);
        current = raffle.draftReviewHash(id);
        vm.expectRevert(LabxRaffle.AdmissionRequired.selector);
        raffle.revokeRaffleApproval(id, current);
        _cannotOpen(id);
    }

    function testFuzz_allPolicySettersIncludingIdenticalAndRestoredValuesInvalidate(uint8 field) public {
        uint256 id = _draft(true);
        _approveAdmission(raffle, id);
        bytes32 original = raffle.draftReviewHash(id);
        uint256 generation = raffle.openingPolicyGeneration();
        uint256 choice = field % 5;
        if (choice == 0) {
            raffle.setTreasury(alice);
            raffle.setTreasury(treasury);
        } else if (choice == 1) {
            raffle.setTermsHash(keccak256("changed"));
            raffle.setTermsHash(TERMS);
        } else if (choice == 2) {
            raffle.setNativePayment(true);
            raffle.setNativePayment(false);
        } else if (choice == 3) {
            raffle.setVrfConfig(keccak256("key"), 1, 500_000, 3);
            raffle.setVrfConfig(keccak256("key"), 1, 500_000, 3);
        } else {
            raffle.proposeCoordinator(address(vrf));
            assertEq(raffle.draftReviewHash(id), original);
            vm.warp(block.timestamp + 1 days);
            raffle.applyCoordinator();
            raffle.proposeCoordinator(address(vrf));
            vm.warp(block.timestamp + 1 days);
            raffle.applyCoordinator();
        }
        assertEq(raffle.openingPolicyGeneration(), generation + 2);
        _cannotOpen(id);
        _approveAdmission(raffle, id);
        bytes32 policy = raffle.openingPolicyHash();
        vm.prank(seller);
        raffle.openWithPolicy(id, policy);
    }

    function test_ownerAwayAndBackInvalidatesButPendingOwnerAndPauseDoNot() public {
        uint256 id = _draft(true);
        _approveAdmission(raffle, id);
        bytes32 original = raffle.draftReviewHash(id);
        raffle.transferOwnership(alice);
        assertEq(raffle.draftReviewHash(id), original);
        raffle.setPaused(true);
        raffle.setPaused(false);
        raffle.setEthPathEnabled(false);
        assertEq(raffle.draftReviewHash(id), original);
        vm.prank(alice);
        raffle.acceptOwnership();
        _cannotOpen(id);
        vm.prank(alice);
        raffle.transferOwnership(address(this));
        raffle.acceptOwnership();
        assertEq(raffle.ownerGeneration(), 2);
        _cannotOpen(id);
        _approveAdmission(raffle, id);
        vm.prank(seller);
        raffle.open(id);
    }

    function test_missingLostRevertingAndAbsentCodeCustodyFailClosed() public {
        uint256 id = _draft(false);
        bytes32 digest = raffle.draftReviewHash(id);
        vm.expectRevert(LabxRaffle.EscrowMissing.selector);
        raffle.approveRaffle(id, digest);
        vm.startPrank(seller);
        nft.approve(address(raffle), id);
        raffle.escrow(id);
        vm.stopPrank();
        _approveAdmission(raffle, id);
        vm.mockCall(address(nft), abi.encodeWithSelector(nft.ownerOf.selector, id), abi.encode(alice));
        digest = raffle.draftReviewHash(id);
        vm.expectRevert(LabxRaffle.EscrowFailed.selector);
        raffle.approveRaffle(id, digest);
        vm.prank(seller);
        vm.expectRevert(LabxRaffle.EscrowFailed.selector);
        raffle.open(id);
        vm.clearMockedCalls();
        vm.mockCallRevert(address(nft), abi.encodeWithSelector(nft.ownerOf.selector, id), "");
        vm.expectRevert();
        raffle.approveRaffle(id, digest);
        vm.clearMockedCalls();
        vm.etch(address(nft), "");
        digest = raffle.draftReviewHash(id);
        vm.expectRevert(LabxRaffle.EscrowFailed.selector);
        raffle.approveRaffle(id, digest);
        _cannotOpen(id);
    }

    function test_unknownExpiredAndUnapprovedDraftRecovery() public {
        vm.expectRevert(LabxRaffle.BadPhase.selector);
        raffle.approveRaffle(999, bytes32(0));
        uint256 id = _draft(true);
        bytes32 digest = raffle.draftReviewHash(id);
        vm.warp(raffle.getRaffle(id).salesEnd);
        vm.expectRevert(LabxRaffle.SalesClosed.selector);
        raffle.approveRaffle(id, digest);
        vm.prank(seller);
        raffle.cancel(id);
        vm.prank(seller);
        raffle.reclaimPrize(id);
        assertEq(nft.ownerOf(id), seller);
        vm.expectRevert(LabxRaffle.NotClaimable.selector);
        raffle.claimFee(id);
    }

    function testFuzz_postDraftMutatorsCannotInterfere(uint8 phase) public {
        uint256 id = _open(25e6);
        _buy(id, alice, 0, 1);
        uint256 selected = 1 + phase % 6;
        if (selected >= 2 && selected <= 5) {
            vm.warp(raffle.getRaffle(id).salesEnd);
            raffle.close(id);
        }
        if (selected >= 3 && selected <= 5) {
            raffle.snapshot(id, 100);
            raffle.requestRandomness(id);
        }
        if (selected >= 4 && selected <= 5) vrf.fulfill(address(raffle), raffle.getRaffle(id).vrfRequestId, 0);
        if (selected == 5) {
            vm.warp(uint256(raffle.getRaffle(id).drawnAt) + raffle.REVEAL_GRACE());
            raffle.settle(id);
        }
        if (selected == 6) {
            vm.warp(uint256(raffle.getRaffle(id).salesEnd) + raffle.DRAW_START_GRACE());
            raffle.cancel(id);
        }
        bytes32 digest = raffle.getRaffleAdmission(id).approvedReviewHash;
        vm.expectRevert(LabxRaffle.BadPhase.selector);
        raffle.approveRaffle(id, digest);
        vm.expectRevert(LabxRaffle.BadPhase.selector);
        raffle.revokeRaffleApproval(id, digest);
        raffle.setTreasury(bob);
        raffle.setTermsHash(keccak256("changed"));
        raffle.transferOwnership(bob);
        vm.prank(bob);
        raffle.acceptOwnership();
        assertTrue(raffle.getRaffleAdmission(id).approvedAtOpening);
        assertEq(raffle.getRafflePolicy(id).treasury, treasury);
        assertEq(raffle.getRafflePolicy(id).termsHash, TERMS);
    }

    function testFuzz_retainedFeesAndPrincipalRefundAreIndependent(bool feesFirst) public {
        uint256 id = _open(25e6);
        _buy(id, alice, 0, 1);
        _buy(id, bob, 0, 2);
        vm.expectRevert(LabxRaffle.BadPhase.selector);
        raffle.claimFee(id);
        vm.warp(uint256(raffle.getRaffle(id).salesEnd) + raffle.DRAW_START_GRACE());
        raffle.cancel(id);
        raffle.setTreasury(cara);
        if (feesFirst) raffle.claimFee(id);
        vm.prank(alice);
        raffle.refund(id);
        assertEq(usdc.balanceOf(alice), 25e6);
        assertEq(raffle.feeOf(id, alice), 2_500_000);
        vm.prank(alice);
        vm.expectRevert(LabxRaffle.BadPhase.selector);
        raffle.refund(id);
        vm.prank(bob);
        raffle.refund(id);
        if (!feesFirst) raffle.claimFee(id);
        assertEq(usdc.balanceOf(treasury), 5e6);
        assertEq(usdc.balanceOf(cara), 0);
        assertEq(usdc.balanceOf(address(raffle)), 0);
    }
}
