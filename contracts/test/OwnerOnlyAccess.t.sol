// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {PercentageFeeFixture} from "./PercentageFees.t.sol";
import {LabxRaffle} from "../src/LabxRaffle.sol";
import {MockVRF} from "./mocks/Mocks.sol";

/// Pins who may change the deployment's settings and how that authority moves between owners.
contract OwnerOnlyAccessTest is PercentageFeeFixture {
    function _draft() internal returns (uint256 id) {
        uint256 token = raffle.nextId();
        nft.mint(seller, token);
        LabxRaffle.PackConfig[] memory packs = new LabxRaffle.PackConfig[](1);
        packs[0] = LabxRaffle.PackConfig("Entry", 25e6, 1, 100);
        vm.startPrank(seller);
        id = raffle.createRaffle(
            address(nft),
            token,
            uint64(block.timestamp + 3 days),
            keccak256("nonce"),
            keccak256("commit"),
            "Review",
            packs
        );
        nft.approve(address(raffle), token);
        raffle.escrow(id);
        vm.stopPrank();
    }

    function testFuzz_onlyTheOwnerChangesSettings(address caller) public {
        vm.assume(caller != address(this));
        uint256 id = _draft();
        bytes32 review = raffle.draftReviewHash(id);
        raffle.approveRaffle(id, review);
        address coordinator = address(new MockVRF());
        raffle.proposeCoordinator(coordinator);
        vm.warp(block.timestamp + 1 days);

        vm.startPrank(caller);
        vm.expectRevert(LabxRaffle.NotOwner.selector);
        raffle.transferOwnership(caller);
        vm.expectRevert(LabxRaffle.NotOwner.selector);
        raffle.setPaused(true);
        vm.expectRevert(LabxRaffle.NotOwner.selector);
        raffle.setTreasury(caller);
        vm.expectRevert(LabxRaffle.NotOwner.selector);
        raffle.setTermsHash(keccak256("other terms"));
        vm.expectRevert(LabxRaffle.NotOwner.selector);
        raffle.setVrfConfig(keccak256("key"), 1, 500_000, 3);
        vm.expectRevert(LabxRaffle.NotOwner.selector);
        raffle.setNativePayment(true);
        vm.expectRevert(LabxRaffle.NotOwner.selector);
        raffle.proposeCoordinator(coordinator);
        vm.expectRevert(LabxRaffle.NotOwner.selector);
        raffle.applyCoordinator();
        vm.expectRevert(LabxRaffle.NotOwner.selector);
        raffle.setEthPathEnabled(false);
        vm.expectRevert(LabxRaffle.NotOwner.selector);
        raffle.approveRaffle(id, review);
        vm.expectRevert(LabxRaffle.NotOwner.selector);
        raffle.revokeRaffleApproval(id, review);
        vm.stopPrank();

        assertEq(raffle.owner(), address(this));
        assertEq(raffle.treasury(), treasury);
        assertEq(raffle.pendingCoordinator(), coordinator);
    }

    function testFuzz_onlyTheNamedPendingOwnerAccepts(address caller) public {
        vm.assume(caller != alice);
        raffle.transferOwnership(alice);
        vm.prank(caller);
        vm.expectRevert(LabxRaffle.NotPendingOwner.selector);
        raffle.acceptOwnership();
        assertEq(raffle.owner(), address(this));
    }

    function test_thePreviousOwnerLosesEverySettingOnceTheNextOwnerAccepts() public {
        raffle.transferOwnership(alice);
        // Still the owner until the next owner accepts, and the pending owner has no authority yet.
        raffle.setPaused(true);
        vm.prank(alice);
        vm.expectRevert(LabxRaffle.NotOwner.selector);
        raffle.setPaused(false);

        vm.prank(alice);
        raffle.acceptOwnership();
        vm.expectRevert(LabxRaffle.NotOwner.selector);
        raffle.setPaused(false);
        vm.expectRevert(LabxRaffle.NotOwner.selector);
        raffle.transferOwnership(address(this));
        vm.expectRevert(LabxRaffle.NotPendingOwner.selector);
        raffle.acceptOwnership();
    }

    /// Observed behavior, not a stated requirement: a proposal made by the previous owner stays pending, and the next owner can apply it.
    function test_aCoordinatorProposalOutlivesAnOwnershipChange() public {
        address coordinator = address(new MockVRF());
        raffle.proposeCoordinator(coordinator);
        raffle.transferOwnership(alice);
        vm.prank(alice);
        raffle.acceptOwnership();
        assertEq(raffle.pendingCoordinator(), coordinator);

        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(LabxRaffle.NotOwner.selector);
        raffle.applyCoordinator();
        vm.prank(alice);
        raffle.applyCoordinator();
        assertEq(raffle.pendingCoordinator(), address(0));
    }
}
