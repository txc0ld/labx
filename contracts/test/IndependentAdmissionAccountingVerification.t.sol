// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {PercentageFeeFixture} from "./PercentageFees.t.sol";
import {LabxRaffle} from "../src/LabxRaffle.sol";
import {MockERC721} from "./mocks/Mocks.sol";

contract AlternateMockERC721 is MockERC721 {
    function implementationMarker() external pure returns (bytes32) {
        return keccak256("alternate-test-runtime");
    }
}

contract IndependentAdmissionAccountingVerificationTest is PercentageFeeFixture {
    function _draftAndEscrow() internal returns (uint256 id) {
        uint256 tokenId = raffle.nextId();
        nft.mint(seller, tokenId);
        LabxRaffle.PackConfig[] memory packs = new LabxRaffle.PackConfig[](2);
        packs[0] = LabxRaffle.PackConfig("First", 25e6, 1, 1000);
        packs[1] = LabxRaffle.PackConfig("Second", 51, 1, 1000);
        vm.startPrank(seller);
        id = raffle.createRaffle(
            address(nft),
            tokenId,
            uint64(block.timestamp + 1 days),
            keccak256("independent-nonce"),
            keccak256("independent-commit"),
            "Independent admission",
            packs
        );
        nft.approve(address(raffle), tokenId);
        raffle.escrow(id);
        vm.stopPrank();
    }

    function _assertBacked(uint256 first, uint256 second, uint256 surplus) internal view {
        LabxRaffle.RaffleView memory a = raffle.getRaffle(first);
        LabxRaffle.RaffleView memory b = raffle.getRaffle(second);
        assertEq(
            usdc.balanceOf(address(raffle)), a.principalEscrow + a.feeEscrow + b.principalEscrow + b.feeEscrow + surplus
        );
    }

    function test_nftRuntimeChangeInvalidatesAdmissionEvenWhenCustodyStillAnswersCorrectly() public {
        uint256 id = _draftAndEscrow();
        bytes32 approvedHash = raffle.draftReviewHash(id);
        raffle.approveRaffle(id, approvedHash);

        AlternateMockERC721 alternate = new AlternateMockERC721();
        vm.etch(address(nft), address(alternate).code);
        assertEq(nft.ownerOf(id), address(raffle));
        assertNotEq(raffle.draftReviewHash(id), approvedHash);

        vm.prank(seller);
        vm.expectRevert(LabxRaffle.AdmissionRequired.selector);
        raffle.open(id);

        _approveAdmission(raffle, id);
        bytes32 policyHash = raffle.openingPolicyHash();
        vm.prank(seller);
        raffle.openWithPolicy(id, policyHash);
        assertTrue(raffle.getRaffleAdmission(id).approvedAtOpening);
    }

    function test_postOpenOwnerPolicyAndNftRuntimeChangesDoNotAddAnotherAdmissionGate() public {
        uint256 id = _open(25e6);
        LabxRaffle.RafflePolicy memory pinned = raffle.getRafflePolicy(id);

        raffle.setTreasury(cara);
        raffle.setTermsHash(keccak256("future-terms"));
        raffle.setNativePayment(!pinned.nativePayment);
        raffle.transferOwnership(bob);
        vm.prank(bob);
        raffle.acceptOwnership();
        AlternateMockERC721 alternate = new AlternateMockERC721();
        vm.etch(address(nft), address(alternate).code);

        _buy(id, alice, 0, 1);
        _draw(id);
        vrf.fulfill(address(raffle), raffle.getRaffle(id).vrfRequestId, 0);
        vm.warp(block.timestamp + raffle.REVEAL_GRACE());
        raffle.settle(id);
        raffle.claimFee(id);
        vm.prank(seller);
        raffle.claimProceeds(id);
        vm.prank(alice);
        raffle.claimPrize(id);

        assertEq(usdc.balanceOf(treasury), 3e6);
        assertEq(usdc.balanceOf(cara), 0);
        assertEq(usdc.balanceOf(seller), 24_500_000);
        assertEq(nft.ownerOf(id), alice);
        assertEq(raffle.getRafflePolicy(id).termsHash, pinned.termsHash);
        assertEq(raffle.getRafflePolicy(id).treasury, pinned.treasury);
    }

    function testFuzz_cancelledBlockedTreasuryCannotBlockRefundsOrConsumeOtherRaffleBacking(
        uint32 aliceQty,
        uint32 bobQty,
        bool feeFirst
    ) public {
        aliceQty = uint32(bound(aliceQty, 1, 20));
        bobQty = uint32(bound(bobQty, 1, 20));
        uint256 cancelled = _open(124_999_999);
        uint256 openRaffle = _open(51);
        _buy(cancelled, alice, 0, aliceQty);
        _buy(cancelled, bob, 0, bobQty);
        _buy(openRaffle, cara, 1, 1);
        uint256 surplus = 13;
        usdc.mint(address(raffle), surplus);
        _assertBacked(cancelled, openRaffle, surplus);

        vm.warp(uint256(raffle.getRaffle(cancelled).salesEnd) + raffle.DRAW_START_GRACE());
        raffle.cancel(cancelled);
        uint256 retainedFee = raffle.getRaffle(cancelled).feeEscrow;
        bytes memory failure = abi.encodeWithSignature("Error(string)", "treasury blocked");
        vm.mockCallRevert(address(usdc), abi.encodeWithSelector(usdc.transfer.selector, treasury, retainedFee), failure);
        vm.expectRevert(failure);
        raffle.claimFee(cancelled);
        _assertBacked(cancelled, openRaffle, surplus);

        vm.clearMockedCalls();
        if (feeFirst) raffle.claimFee(cancelled);
        vm.prank(alice);
        raffle.refund(cancelled);
        _assertBacked(cancelled, openRaffle, surplus);
        if (!feeFirst) raffle.claimFee(cancelled);
        vm.prank(bob);
        raffle.refund(cancelled);
        _assertBacked(cancelled, openRaffle, surplus);

        assertGt(raffle.feeOf(cancelled, alice), 0);
        assertGt(raffle.feeOf(cancelled, bob), 0);
        vm.prank(alice);
        vm.expectRevert(LabxRaffle.BadPhase.selector);
        raffle.refund(cancelled);
        assertEq(raffle.getRaffleAccounting(cancelled).buyerFees, retainedFee);
    }
}
